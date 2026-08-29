import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { amountMinor, createdAt, idColumn, updatedAt } from "@adminigloo/db";
import type { CartLineMetadata, DiscountKind } from "./cart.js";

/**
 * text, not pgEnum, matching `tenants.kind`: a value added to a Postgres enum
 * can never be removed, so 'partially-refunded' added in haste is permanent.
 * The union gives the compile-time check without the one-way door.
 */
export type OrderStatus =
  | "pending"
  | "paid"
  | "fulfilled"
  | "cancelled"
  | "refunded";

/**
 * A postal address, snapshotted onto the order.
 *
 * Stored as jsonb rather than a foreign key to an address book ON PURPOSE. An
 * order must record where the parcel was actually sent. With a reference, a
 * customer editing their saved address after shipping rewrites the packing slip
 * of an order already in a van, and the returns team then argues with a courier
 * about an address that never existed at ship time.
 *
 * Every field is optional and untyped beyond `string`: address formats are not
 * universal, `region` is a state in the US and absent in most of Europe, and
 * validating shapes here would reject real addresses. Validate at the boundary,
 * where the error can name the field.
 */
export interface OrderAddress {
  readonly name?: string;
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postalCode?: string;
  /** ISO 3166-1 alpha-2, uppercase. Not enforced here — Stripe rejects the rest. */
  readonly country?: string;
  readonly phone?: string;
}

export const orders = pgTable(
  "orders",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /**
     * The human-facing number from `formatOrderNumber`. Not the primary key:
     * it is public, printed and spoken, and a primary key that appears on a
     * receipt is a primary key somebody will eventually try to enumerate.
     */
    orderNumber: text("order_number").notNull(),
    /**
     * NULL for guest checkout. No foreign key to `users` for the same reason
     * `tenant_members.user_id` has none: this package must install without the
     * auth schema present, and users are soft-deleted so a cascade never fires.
     *
     * Guests are a first-class case, not an edge case. Requiring a user row
     * either blocks guest checkout outright or creates ghost accounts Clerk
     * knows nothing about, which then cannot sign in to see their own order.
     */
    userId: text("user_id"),
    /** Where the receipt goes. NOT NULL even for signed-in buyers: the address
     * on the account can change, and the confirmation was sent to this one. */
    email: text("email").notNull(),
    status: text("status").$type<OrderStatus>().notNull().default("pending"),

    subtotalMinor: amountMinor("subtotal_minor"),
    shippingMinor: amountMinor("shipping_minor"),
    taxMinor: amountMinor("tax_minor"),
    /** Positive: the amount taken OFF, matching `cartTotals().discount`. */
    discountMinor: amountMinor("discount_minor"),
    /**
     * Stored, not derived on read. `subtotal - discount + shipping + tax` is
     * cheap to recompute and wrong to recompute: this column is what the
     * customer was charged, and a later change to the rounding rule in
     * `applyDiscount` must not silently restate a completed order.
     */
    totalMinor: amountMinor("total_minor"),
    /**
     * Lowercase, matching Stripe's own representation, so nothing has to
     * normalise case at the boundary. A stored 'USD' beside a Stripe 'usd'
     * turns every currency equality check into a latent bug.
     */
    currency: text("currency").notNull().default("usd"),

    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripeCheckoutSessionId: text("stripe_checkout_session_id"),

    shippingAddress: jsonb("shipping_address").$type<OrderAddress>(),
    billingAddress: jsonb("billing_address").$type<OrderAddress>(),

    /**
     * When the customer paid, taken from the Stripe event — NOT when this row
     * was written. Separate from `created_at` because a webhook redelivered
     * three days into a retry schedule writes the row three days late, and
     * `created_at` would date the order to the recovery rather than to the sale.
     * NULL while the order is still `pending`.
     */
    placedAt: timestamp("placed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** Order numbers are per-tenant; see `formatOrderNumber` on why not global. */
    uniqueIndex("orders_tenant_order_number_idx").on(t.tenantId, t.orderNumber),

    /**
     * *** THIS INDEX IS THE IDEMPOTENCY MECHANISM FOR ORDER CREATION. ***
     *
     * Not a convention, not a check-then-insert: a UNIQUE constraint, so the
     * second writer gets a constraint violation instead of a second order.
     *
     * trailcards creates orders from BOTH `checkout.session.completed` AND
     * `payment_intent.succeeded`, with each handler first querying whether the
     * other one already ran. Two writers for one invariant, and the guard is a
     * read followed by a write with no lock between them: both handlers read
     * "no order yet" inside the same few milliseconds — which is exactly how
     * Stripe delivers those two events — and both insert. The interleaving is
     * rare enough to survive every manual test and common enough to reach
     * production, where it charges once and ships twice.
     *
     * With this index the race resolves in Postgres: `INSERT … ON CONFLICT
     * (stripe_payment_intent_id) DO NOTHING`, and whichever handler loses reads
     * back the row the winner wrote. Keeping both handlers is then fine — they
     * stop being two writers and become two triggers for one idempotent write.
     *
     * NULLs are distinct in a Postgres unique index, which is wanted: an order
     * still in `pending` with no PaymentIntent yet does not collide with every
     * other pending order.
     */
    uniqueIndex("orders_stripe_payment_intent_idx").on(t.stripePaymentIntentId),

    /**
     * And the session id, for the same reason — because the PaymentIntent index
     * above has a hole exactly where it is needed most.
     *
     * NULLs being distinct means it only fires once `stripe_payment_intent_id`
     * is set. For delayed-notification payment methods (SEPA debit, Bacs,
     * bank transfers) `checkout.session.completed` arrives with
     * `session.payment_intent` populated but unpaid, and for some flows not
     * populated at all — so the handler writes NULL, the unique index above
     * permits any number of NULLs, and the duplicate it exists to stop goes
     * straight through. The session id is known at that moment in every flow.
     */
    uniqueIndex("orders_stripe_checkout_session_idx").on(t.stripeCheckoutSessionId),

    /** The admin order list: one tenant, newest first. */
    index("orders_tenant_placed_idx").on(t.tenantId, t.placedAt),
    /**
     * Support's only handle on a guest order. `user_id` is NULL for guests, so
     * without this the "where's my order" lookup is a sequential scan on the
     * one code path that has an impatient human waiting on it.
     */
    index("orders_email_idx").on(t.email),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: idColumn(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /**
     * The caller's catalogue identifier. No foreign key: this package owns no
     * product table, and a real storefront's catalogue lives in the app or in a
     * CMS. A restrict would make a discontinued product undeletable; a cascade
     * would delete the line item and leave the order's totals unexplained.
     */
    productRef: text("product_ref").notNull(),
    variantRef: text("variant_ref"),
    /**
     * Copied from the catalogue at purchase time, alongside the price below.
     * Joining for the name at render time means renaming "Alpine Trail Card" to
     * "Alpine Trail Card v2" retroactively changes what a two-year-old receipt
     * says was bought — and receipts are the thing people produce during
     * chargebacks.
     */
    name: text("name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPriceMinor: amountMinor("unit_price_minor"),
    /** `unit_price_minor * quantity`, stored for the same reason as `orders.total_minor`. */
    totalMinor: amountMinor("total_minor"),
    metadata: jsonb("metadata").$type<CartLineMetadata>(),
  },
  (t) => [
    /**
     * The database refuses a non-positive quantity, not just `validateCart`.
     *
     * `validateCart` runs on the checkout path. Orders are also written by
     * webhook handlers, admin tools and back-fill scripts, and every one of
     * those is a path where nobody remembers to call the validator. A quantity
     * of 0 makes `total_minor` zero and the order's own total no longer equal
     * the sum of its lines — which surfaces months later as an accounting
     * discrepancy with no way left to tell which line was wrong.
     */
    check("order_items_quantity_positive", sql`${t.quantity} > 0`),
    index("order_items_order_idx").on(t.orderId),
  ],
);

/**
 * Shipments, plural, as their own table rather than columns on `orders`.
 *
 * Partial fulfilment is the normal case, not the exception: a two-item order
 * where one item is backordered ships twice, with two tracking numbers. Held as
 * `orders.tracking_number`, the second shipment overwrites the first, and the
 * customer chasing the parcel that already arrived gets the tracking for the
 * one that has not shipped yet.
 */
export const orderShipments = pgTable(
  "order_shipments",
  {
    id: idColumn(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Free text, e.g. "usps", "dhl". Carriers are added faster than migrations ship. */
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    /**
     * NULL means "created but not handed to the carrier" — a label bought is
     * not a parcel gone. A boolean `shipped` could not tell the customer when,
     * and "when did it ship" is the entire content of the email they are about
     * to send.
     */
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("order_shipments_order_idx").on(t.orderId)],
);

export const discountCodes = pgTable(
  "discount_codes",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** Stored in the form `normaliseDiscountCode` produces: uppercase, no spaces. */
    code: text("code").notNull(),
    kind: text("kind").$type<DiscountKind>().notNull(),
    /**
     * Overloaded by `kind`: whole percent for 'percent', minor units for
     * 'fixed'. `integer` rather than `bigint` because a percent is never large
     * and a fixed discount over ~21.4 million minor units is a data-entry
     * error, not a promotion. `computeDiscountMinor` widens to bigint on the
     * way out, so no money arithmetic downstream is ever done in `number`.
     *
     * Whole percent, not basis points: a stored 1000 that means 10.00% is
     * unreadable to whoever is looking at this table at 2am during an incident,
     * and half-percent promotions have never once been asked for. If they are,
     * that is a new `kind`, not a reinterpretation of this column.
     */
    value: integer("value").notNull(),
    /**
     * 0 means no minimum. NOT NULL with a default so no caller has to branch —
     * a nullable minimum makes `subtotal < min` compare against NULL, which in
     * SQL is NULL rather than false, and the row silently drops out of the
     * eligibility query it was supposed to pass.
     */
    minSubtotalMinor: amountMinor("min_subtotal_minor").default(0n),
    /** NULL means unlimited. */
    maxRedemptions: integer("max_redemptions"),
    /**
     * Incremented by the redemption write, not counted from `orders`. Counting
     * would need a scan on every checkout, and the count has to be taken under
     * the same lock that decides eligibility or a code capped at 100 goes to
     * 103 during a launch.
     */
    timesRedeemed: integer("times_redeemed").notNull().default(0),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    /**
     * The off switch, separate from the window. Pulling a code mid-campaign
     * must not require rewriting `ends_at`, because the end date is a record of
     * what was promised and support reads it back to customers.
     */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * Per tenant, deliberately NOT globally unique.
     *
     * A global unique on `code` leaks one client's promo namespace into
     * another's: the second tenant to try "SUMMER20" gets a constraint error
     * that tells them somebody else already has it, and every failed create is
     * a probe. Worse, it makes the obvious codes first-come-first-served across
     * unrelated businesses on one platform.
     *
     * Unqualified by `is_active` on purpose. A switched-off code keeps its name
     * reserved; freeing it would let a new promotion inherit the redemption
     * history and the printed cards of a retired one.
     */
    uniqueIndex("discount_codes_tenant_code_idx").on(t.tenantId, t.code),
  ],
);

export const commerceSchema = {
  orders,
  orderItems,
  orderShipments,
  discountCodes,
};

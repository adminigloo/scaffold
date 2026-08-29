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
     * THE IDEMPOTENCY KEY FOR ORDER CREATION. NOT NULL, always. See
     * `orderWriteStatements` in ./orders.ts for the protocol
     * this column is half of.
     *
     * For a Checkout order this is `checkoutSessionKey(session.id)` — the
     * Checkout Session id, which is known at `checkout.session.completed` in
     * every flow, delayed-notification included. For an admin-entered order or
     * a migration back-fill it is whatever that path can reproduce on a rerun.
     *
     * NOT NULL is the entire mechanism. A unique index over a nullable column
     * cannot stop duplicates in the case that matters, because Postgres treats
     * NULLs as distinct and `ON CONFLICT` therefore never fires on one.
     */
    idempotencyKey: text("idempotency_key").notNull(),
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
     * *** THE IDEMPOTENCY MECHANISM FOR ORDER CREATION. ***
     *
     * Not a convention, not a check-then-insert: a UNIQUE constraint over two
     * NOT NULL columns, so the second writer gets a constraint violation
     * instead of a second order. `orderWriteStatements.create` conflicts on
     * exactly this pair; nothing else in the package may insert into `orders`.
     *
     * WHAT THIS REPLACED, AND WHY THE OLD VERSION COULD NOT WORK.
     *
     * The previous mechanism was `ON CONFLICT (stripe_payment_intent_id)`,
     * written by BOTH `checkout.session.completed` and
     * `payment_intent.succeeded`. Stripe does not order those two deliveries,
     * and the statement failed in both directions:
     *
     *   - PaymentIntent first: it inserts a row with no session id (a
     *     PaymentIntent does not carry one), the session event then conflicts,
     *     and `DO NOTHING` DISCARDS the session id — plus the line items, the
     *     email and the addresses that only the session event carries. The
     *     order exists and the receipt cannot be built.
     *   - Delayed-notification methods (SEPA debit, Bacs, bank transfer): the
     *     session handler writes `stripe_payment_intent_id = NULL`, NULLs are
     *     distinct in a Postgres unique index, so the conflict target cannot
     *     fire and the PaymentIntent event inserts a SECOND row. Charged once,
     *     shipped twice — the exact failure the index existed to prevent.
     *
     * THE PROTOCOL, CANONICAL. Full reasoning in ./orders.ts.
     *
     *   1. `checkout.session.completed` is the SINGLE order-CREATING writer.
     *      It is the only event carrying the line items, the email and the
     *      addresses, and it carries `payment_status`, so it never needs the
     *      PaymentIntent event to know the money arrived.
     *   2. `payment_intent.succeeded` and
     *      `checkout.session.async_payment_succeeded` REPAIR a row — attach the
     *      PaymentIntent id, move `pending` to `paid`, stamp `placed_at` — and
     *      NEVER insert one. A repair matching no row is a no-op, because a
     *      PaymentIntent event can only precede its session event when the
     *      PaymentIntent already existed at session-completion time, in which
     *      case the session event that follows creates the row already `paid`
     *      and with the id.
     *   3. The conflict target is this index, and it fires in every ordering
     *      including when the PaymentIntent id is not yet known.
     *
     * Per-tenant rather than global for the reason
     * `discount_codes_tenant_code_idx` gives: the key is caller-supplied on the
     * admin and back-fill paths, and a global unique would make one tenant's
     * `"import-batch-1"` collide with another's.
     */
    uniqueIndex("orders_tenant_idempotency_key_idx").on(
      t.tenantId,
      t.idempotencyKey,
    ),

    /**
     * An ASSERTION, not a conflict target: one PaymentIntent belongs to at most
     * one order. If a repair is ever keyed wrongly and tries to attach a
     * PaymentIntent already on another order, this raises instead of quietly
     * marking a second order paid against one charge.
     *
     * PARTIAL ON PURPOSE, and not only to keep the index small. A bare
     * `ON CONFLICT (stripe_payment_intent_id)` cannot infer a partial index —
     * Postgres answers "no unique or exclusion constraint matching the ON
     * CONFLICT specification" — so a route that reintroduces the old broken
     * statement fails loudly on its first execution instead of silently
     * duplicating orders for delayed-notification payments six months later.
     */
    uniqueIndex("orders_stripe_payment_intent_idx")
      .on(t.stripePaymentIntentId)
      .where(sql`${t.stripePaymentIntentId} is not null`),

    /**
     * The same assertion for the session id, and partial for the same reason.
     *
     * Mostly redundant with the idempotency key while the key IS the session id
     * — deliberately kept, because the admin and back-fill paths choose their
     * own key, and this is what stops one of them writing a session id that
     * already belongs to a Checkout order onto a second row.
     */
    uniqueIndex("orders_stripe_checkout_session_idx")
      .on(t.stripeCheckoutSessionId)
      .where(sql`${t.stripeCheckoutSessionId} is not null`),

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

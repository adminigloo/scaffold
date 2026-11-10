import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, isNull, like, lt, or, sql } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import { grantConfigSchemas } from "__SCOPE__/catalog";
import type { GrantKind } from "__SCOPE__/catalog";
import { productGrants, products, productVariants } from "__SCOPE__/catalog/schema";
import { subscriptionEntitlementWindow, type SubscriptionStatus } from "__SCOPE__/billing";
import { entitlements } from "__SCOPE__/billing/schema";
import { formatOrderNumber } from "__SCOPE__/commerce";
import { orderItems, orderShipments, orders } from "__SCOPE__/commerce/schema";
import { walletLedger } from "__SCOPE__/wallet/schema";
import { creditWallet, refundWallet } from "__SCOPE__/wallet/server";
import { auditEntry, defineAuditedActions } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { db, type Db } from "@/db";

/**
 * THE ONE PLACE A PURCHASE BECOMES AN ORDER.
 *
 * `payment_intent.succeeded` calls it. The "Simulate purchase" button calls it.
 * Nothing else may write an `orders` row, and that single shared call site is
 * the entire reason a deployment with no Stripe keys can be exercised end to
 * end and then start taking real money the day the keys arrive, with no
 * rewrite: the only thing that changes is WHO calls this function.
 *
 * The alternative — a simulated path that writes its own order — is the failure
 * this module exists to prevent. Two writers drift, and they drift in the one
 * direction nobody tests: the simulated one is exercised every day during
 * development, the real one is exercised for the first time by a paying
 * customer.
 *
 * WHAT NEVER COMES FROM A CALLER: the price, the currency, the product name.
 * All three are read from the `product_variants` row named by `variantId`. The
 * caller supplies an identity — which variant, how many, whose, under what
 * reference — and nothing that decides what anything costs.
 *
 * THIS MODULE NEVER IMPORTS STRIPE. Not the client, not the SDK types. It is
 * called from a Stripe webhook, but nothing about booking an order depends on
 * Stripe existing — which is exactly what lets the simulated path run the same
 * code rather than a copy of it.
 */

// ---------------------------------------------------------------------------
// Identity of a purchase
// ---------------------------------------------------------------------------

/**
 * Which path produced this order.
 *
 * Not cosmetic. "Was this real money?" is the first question anyone asks about
 * a suspicious order, and it has to be answerable from stored rows six months
 * later by someone who has never read this file.
 */
export type FulfilmentSource = "stripe" | "simulated";

/**
 * Namespace on `orders.idempotency_key`.
 *
 * __SCOPE__/commerce keys order creation on `(tenant_id, idempotency_key)` and
 * warns that two unrelated systems free to choose that string will eventually
 * choose the same one — which is why it prefixes its own Checkout keys with
 * `checkout_session:`. This prefix keeps fulfilment's namespace disjoint from
 * that one, and from `payment_element:` in ./routers/checkout.ts, at the value
 * level rather than by convention.
 */
export const FULFILMENT_KEY_PREFIX = "fulfilment:";

/** A reference for a payment Stripe took. Always the PaymentIntent id. */
const STRIPE_REFERENCE_PATTERN = /^pi_[A-Za-z0-9_]+$/;

/**
 * A reference for a purchase nobody paid for.
 *
 * `sim_` rather than a bare UUID so the distinction survives into
 * `orders.idempotency_key`, where a support engineer reading the table sees it
 * without needing the audit log or this file. A random UUID body because the
 * reference is the handle `/checkout/success` reads the order by, and a
 * guessable one would be a way to read a stranger's order.
 */
const SIMULATED_REFERENCE_PATTERN = /^sim_[0-9a-f-]{36}$/;

export function simulatedReference(): string {
  return `sim_${randomUUID()}`;
}

/** Reads back which path wrote an order, from the order row alone. */
export function sourceOfReference(reference: string): FulfilmentSource | null {
  if (STRIPE_REFERENCE_PATTERN.test(reference)) return "stripe";
  if (SIMULATED_REFERENCE_PATTERN.test(reference)) return "simulated";
  return null;
}

// ---------------------------------------------------------------------------
// Eligibility — the guard BOTH purchase paths go through
// ---------------------------------------------------------------------------

/**
 * The cap on quantity. Not a business rule — a blast radius.
 *
 * Lives here rather than in the checkout router because `simulate` has to
 * enforce the identical bound. A second copy of the number is a second chance
 * for the two paths to disagree about what is purchasable, which is the exact
 * class of divergence this module exists to make impossible.
 */
export const MAX_QUANTITY = 999;

/**
 * Stripe rejects an amount over eight digits, on every currency it supports.
 *
 * Applied to the SIMULATED path too, even though no Stripe call follows it. The
 * property being defended is "a simulated purchase can never produce an order a
 * real purchase would have refused", and an order for an amount Stripe cannot
 * charge is exactly such an order.
 */
export const STRIPE_MAX_AMOUNT_MINOR = 99_999_999n;

/** The variant row every purchase path prices itself from. */
export interface PurchasableVariant {
  readonly variantId: string;
  readonly variantName: string;
  readonly priceMinor: bigint;
  readonly currency: string;
  readonly interval: "month" | "year" | null;
  /** NULL is untracked, 0 is genuinely sold out. Never collapse the two. */
  readonly inventory: number | null;
  readonly stripePriceId: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly productSlug: string;
  readonly tenantId: string;
  readonly productStatus: "draft" | "active" | "archived";
  readonly productDeleted: boolean;
}

/** Why a variant cannot be bought right now. */
export type PurchaseRefusalCode =
  | "not_for_sale"
  | "sold_out"
  | "insufficient_stock"
  | "quantity_too_large"
  | "amount_too_large"
  // A `credits` grant fills the BUYER's balance, and a guest has none.
  | "account_required";

export class PurchaseRefusedError extends Error {
  /**
   * `readonly name` as an OWN property, matching the packages: pnpm can install
   * two physical copies of a module and `instanceof` is false across them,
   * while the name survives.
   */
  readonly name = "PurchaseRefusedError";
  constructor(
    readonly code: PurchaseRefusalCode,
    message: string,
  ) {
    super(message);
  }
}

export class VariantNotFoundError extends Error {
  readonly name = "VariantNotFoundError";
  constructor(readonly variantId: string) {
    super(
      `Variant "${variantId}" does not exist. A payment cannot be booked ` +
        `against a variant that was hard-deleted between checkout and ` +
        `fulfilment — the order would have no price and no name.`,
    );
  }
}

/**
 * Load a variant by id, WITHOUT filtering on saleability.
 *
 * The status and the soft-delete marker come back as fields instead, because
 * the two callers need opposite things from them. A purchase ATTEMPT must
 * refuse a draft product. FULFILMENT of a payment already taken must not — a
 * product unpublished ninety seconds after a customer paid would otherwise take
 * their money and record nothing, while Stripe redelivered the webhook for
 * three days and the order never appeared.
 */
export async function loadVariantForPurchase(
  variantId: string,
  handle: Db | Tx = db,
): Promise<PurchasableVariant | null> {
  const [row] = await handle
    .select({
      variantId: productVariants.id,
      variantName: productVariants.name,
      priceMinor: productVariants.priceMinor,
      currency: productVariants.currency,
      interval: productVariants.interval,
      inventory: productVariants.inventory,
      stripePriceId: productVariants.stripePriceId,
      productId: products.id,
      productName: products.name,
      productSlug: products.slug,
      tenantId: products.tenantId,
      productStatus: products.status,
      deletedAt: products.deletedAt,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(productVariants.id, variantId))
    .limit(1);

  if (!row) return null;
  const { deletedAt, ...rest } = row;
  return { ...rest, productDeleted: deletedAt !== null };
}

/**
 * THE ELIGIBILITY BOUNDARY. Every purchase ATTEMPT goes through this — the
 * Payment Element one and the simulated one, from the same function.
 *
 * Written as one exported function rather than as two copies of five `if`
 * statements, because the requirement is not "simulate checks the same things
 * today". It is "simulate cannot come to a different answer than createIntent,
 * ever, including after somebody adds a sixth rule and remembers only one call
 * site". A shared function is the only spelling of that which survives contact
 * with a future edit.
 *
 * NOT called by `fulfilPurchase`. See `loadVariantForPurchase` for why refusing
 * at fulfilment time is a way to take money and deliver nothing.
 */
export function assertPurchasable(
  variant: PurchasableVariant,
  quantity: number,
): void {
  if (variant.productStatus !== "active" || variant.productDeleted) {
    // Deliberately one message for "draft", "archived" and "deleted". The
    // difference between them is information about an unreleased catalog, and a
    // storefront that distinguishes them is a storefront that can be probed.
    throw new PurchaseRefusedError(
      "not_for_sale",
      "That product is no longer for sale.",
    );
  }

  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new PurchaseRefusedError(
      "quantity_too_large",
      "Quantity must be a whole number of at least one.",
    );
  }

  if (quantity > MAX_QUANTITY) {
    throw new PurchaseRefusedError(
      "quantity_too_large",
      `The most that can be bought in one order is ${MAX_QUANTITY}.`,
    );
  }

  // NULL is untracked, not zero. `inventory === 0` is genuinely sold out;
  // treating NULL as zero would refuse to sell every digital product.
  if (variant.inventory !== null && variant.inventory < quantity) {
    throw variant.inventory === 0
      ? new PurchaseRefusedError("sold_out", "That option has sold out.")
      : new PurchaseRefusedError(
          "insufficient_stock",
          `Only ${variant.inventory} left.`,
        );
  }

  if (variant.priceMinor * BigInt(quantity) > STRIPE_MAX_AMOUNT_MINOR) {
    throw new PurchaseRefusedError(
      "amount_too_large",
      "That quantity exceeds the largest payment Stripe will accept.",
    );
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Two keys, not one key with the source in metadata.
 *
 * `action` is an indexed column and `metadata` is jsonb nobody indexes. "Show
 * me every order that was granted without a payment" has to be a cheap, obvious
 * query — it is the question an auditor, an accountant and an incident
 * responder all arrive with — and it must not require knowing that a jsonb
 * field called `source` exists. Same argument `catalogAuditedActions` makes for
 * splitting `published` from `archived`.
 */
export const fulfilmentAuditedActions = {
  "commerce.order.fulfilled": {
    label: "Recorded a paid order and applied everything the product grants",
  },
  "commerce.order.simulated": {
    label:
      "Recorded a SIMULATED order — no money moved. Only reachable while " +
      "Stripe is unconfigured on this deployment",
    /**
     * Flagged sensitive so it lands in the compliance slice — the partial index
     * on `is_sensitive` — rather than in the general firehose. A financial
     * record created with no payment behind it is precisely what that report is
     * for, and the flag is stamped at write time so it stays true about this
     * row even if someone later reclassifies the action.
     */
    sensitive: true,
  },
  /**
   * create-app 0.44: a refund made in Stripe came back by the webhook. Sensitive
   * for the same reason a simulated order is: money moved and a grant was taken
   * back, and the compliance slice is where both are asked about.
   */
  "commerce.order.refunded": {
    label: "Recorded a refund from Stripe and took back the refunded share of what the order granted",
    sensitive: true,
  },
  "commerce.order.disputed": {
    label: "Recorded a dispute from Stripe and took back what the order granted",
    sensitive: true,
  },
} as const satisfies Record<string, { label: string; sensitive?: boolean }>;

export const fulfilmentAuditRegistry = defineAuditedActions(
  fulfilmentAuditedActions,
);

const AUDIT_ACTION_FOR: Record<
  FulfilmentSource,
  "commerce.order.fulfilled" | "commerce.order.simulated"
> = {
  stripe: "commerce.order.fulfilled",
  simulated: "commerce.order.simulated",
};

// ---------------------------------------------------------------------------
// fulfilPurchase
// ---------------------------------------------------------------------------

/**
 * A Drizzle transaction handle, derived from the app's own db handle so the two
 * cannot drift when the driver changes.
 */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface FulfilPurchaseInput {
  readonly variantId: string;
  readonly quantity: number;
  /** Our `users.id`. NULL for a guest purchase — see `orders.user_id`. */
  readonly userId: string | null;
  readonly tenantId: string;
  /** `pi_…` for a Stripe payment, `sim_…` for a simulated one. */
  readonly reference: string;
  readonly source: FulfilmentSource;
  /**
   * The Stripe subscription a RECURRING product's first payment started
   * (`sub_…`), or null for a one-time sale. Kept on the order line so the
   * subscription's later events can window what this order granted — ended
   * when the subscription ends, not kept for ever (review B4).
   */
  readonly subscriptionId?: string | null;
}

/** What a grant actually did, so a caller can show it to the buyer. */
export type AppliedGrant =
  | {
      readonly kind: "entitlement";
      readonly feature: string;
      readonly limit: number | null;
    }
  | { readonly kind: "license_key"; readonly licenseKey: string }
  | { readonly kind: "ship"; readonly shipmentId: string }
  | {
      readonly kind: "credits";
      readonly unit: string;
      /** What this order added: the grant's amount times the quantity. */
      readonly amount: number;
      /** The buyer's balance of `unit` after it. */
      readonly balance: number;
    }
  | { readonly kind: "none" };

export interface FulfilmentResult {
  readonly orderId: string;
  readonly orderNumber: string;
  /**
   * FALSE means this reference had already been fulfilled and nothing was
   * written this time. Not an error — it is the normal answer to a redelivered
   * webhook, and a caller should treat it as success.
   *
   * `grants` is empty on a duplicate: the grants were applied by the call that
   * created the order, and re-deriving them here would invite a caller to
   * re-apply them.
   */
  readonly created: boolean;
  readonly totalMinor: bigint;
  readonly currency: string;
  readonly grants: readonly AppliedGrant[];
}

export class InvalidFulfilmentReferenceError extends Error {
  readonly name = "InvalidFulfilmentReferenceError";
  constructor(reference: string, source: FulfilmentSource) {
    super(
      `"${reference}" is not a valid ${source} fulfilment reference. A Stripe ` +
        `fulfilment must be keyed on the PaymentIntent id (pi_…) and a ` +
        `simulated one on simulatedReference() (sim_…). The reference becomes ` +
        `orders.idempotency_key, so a malformed or empty one either collapses ` +
        `every order onto a single row or makes a redelivery create a second.`,
    );
  }
}

/**
 * How many times a per-tenant order-number collision is retried.
 *
 * The sequence is `count(*) + 1` for the tenant, read inside the transaction.
 * Two purchases committing in the same instant read the same count, produce the
 * same order number, and the second loses to `orders_tenant_order_number_idx` —
 * which is the correct outcome, because the number is printed on a receipt and
 * two customers must never share one. Retrying the whole transaction is safe
 * precisely because the loser's insert rolled back, so the retry re-reads a
 * count that now includes the winner.
 */
const ORDER_NUMBER_ATTEMPTS = 5;

/**
 * The order-number prefix on receipts. 1-8 uppercase alphanumerics.
 *
 * A constant rather than a lookup, because `STOREFRONT_TENANT_ID` is the
 * firm-wide sentinel and has no tenant row to read a prefix from. A project
 * that gives each customer their own storefront should derive this from the
 * tenant — and should do it HERE, so there is one answer.
 */
export const ORDER_NUMBER_PREFIX = "ORD";

/**
 * Turn "this variant was paid for" into an order plus everything it grants.
 *
 * IDEMPOTENT ON `reference`, and idempotent by CONSTRAINT rather than by a
 * read-then-write. The insert is
 * `ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`, and an
 * empty RETURNING means somebody else already booked this reference, so nothing
 * further happens. A `SELECT … then INSERT` would pass every test and then
 * double-book the first time Stripe redelivered an event to two instances at
 * once, which is a normal Tuesday and not an edge case.
 *
 * EVERYTHING RUNS IN ONE TRANSACTION. The order, its line, its grants and the
 * audit row commit together or not at all. Without that, a grant that throws
 * leaves a committed order behind, the webhook 500s, Stripe redelivers, the
 * insert now conflicts, and the retry skips the grants forever — a customer
 * charged for an entitlement they never receive, with an order row saying they
 * did.
 */
export async function fulfilPurchase(
  input: FulfilPurchaseInput,
): Promise<FulfilmentResult> {
  const reference = input.reference.trim();
  const pattern =
    input.source === "stripe"
      ? STRIPE_REFERENCE_PATTERN
      : SIMULATED_REFERENCE_PATTERN;
  if (!pattern.test(reference)) {
    throw new InvalidFulfilmentReferenceError(input.reference, input.source);
  }

  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    throw new PurchaseRefusedError(
      "quantity_too_large",
      `Quantity must be a whole number of at least one, got ${input.quantity}.`,
    );
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await db.transaction((tx) => bookOrder(tx, { ...input, reference }));
    } catch (error) {
      if (attempt >= ORDER_NUMBER_ATTEMPTS || !isOrderNumberCollision(error)) {
        throw error;
      }
    }
  }
}

async function bookOrder(
  tx: Tx,
  input: FulfilPurchaseInput,
): Promise<FulfilmentResult> {
  const variant = await loadVariantForPurchase(input.variantId, tx);
  if (!variant) throw new VariantNotFoundError(input.variantId);

  // FROM THE DATABASE ROW, never from the input object. If the amount could
  // arrive as an argument, every price in the catalog would be advisory and a
  // webhook payload would be the thing that decided them.
  const unitPriceMinor = variant.priceMinor;
  const totalMinor = unitPriceMinor * BigInt(input.quantity);
  const currency = variant.currency;

  const email = input.userId === null ? null : await emailOf(tx, input.userId);

  const idempotencyKey = `${FULFILMENT_KEY_PREFIX}${input.reference}`;
  const placedAt = new Date();
  const orderNumber = formatOrderNumber({
    prefix: ORDER_NUMBER_PREFIX,
    sequence: await nextOrderSequence(tx, input.tenantId),
    date: placedAt,
  });

  const [inserted] = await tx
    .insert(orders)
    .values({
      tenantId: input.tenantId,
      idempotencyKey,
      orderNumber,
      userId: input.userId,
      // NOT NULL on the column. An empty string is the honest value for a buyer
      // we hold no address for: it says "no receipt destination" rather than
      // inventing one that a mail send would silently fail against.
      email: email ?? "",
      // Both paths book `paid`. A simulated purchase landing as `pending` would
      // park a completed order in the chase-this-customer queue forever, since
      // no payment event is ever coming to move it — and the whole point is
      // that downstream code cannot tell the two apart.
      status: "paid",
      subtotalMinor: totalMinor,
      shippingMinor: 0n,
      taxMinor: 0n,
      discountMinor: 0n,
      totalMinor,
      currency,
      // ONLY for a real payment. Writing `sim_…` here would make the column
      // lie: every join, dashboard and refund tool reading it believes it names
      // an object in Stripe. The partial unique index over it stays what
      // __SCOPE__/commerce designed it to be — an assertion that one
      // PaymentIntent belongs to at most one order — while
      // `(tenant_id, idempotency_key)` does the idempotency for both paths.
      stripePaymentIntentId: input.source === "stripe" ? input.reference : null,
      placedAt,
    })
    .onConflictDoNothing({ target: [orders.tenantId, orders.idempotencyKey] })
    .returning({ id: orders.id });

  if (!inserted) {
    // Somebody already booked this reference. Decisive, exactly as in
    // `decideSessionWrite`: an empty RETURNING is not "maybe", it is "the row is
    // not ours". Read it back only to report its identity.
    const [existing] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        totalMinor: orders.totalMinor,
        currency: orders.currency,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, input.tenantId),
          eq(orders.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    if (!existing) {
      // The insert conflicted and the read found nothing. Not reachable inside
      // one transaction; reachable the day this stops being one. Loud, because
      // silently returning a fabricated result would report a booked order that
      // does not exist.
      throw new Error(
        `fulfilPurchase: order "${idempotencyKey}" conflicted on insert but ` +
          `could not be read back. Refusing to report a fulfilment that may ` +
          `not have happened.`,
      );
    }

    return {
      orderId: existing.id,
      orderNumber: existing.orderNumber,
      created: false,
      totalMinor: existing.totalMinor,
      currency: existing.currency,
      grants: [],
    };
  }

  const orderId = inserted.id;

  const grantRows = await tx
    .select({
      id: productGrants.id,
      kind: productGrants.kind,
      config: productGrants.config,
    })
    .from(productGrants)
    .where(eq(productGrants.variantId, variant.variantId));

  const applied: AppliedGrant[] = [];
  const lineMetadata: Record<string, string> = {};
  if (input.subscriptionId) lineMetadata["subscriptionId"] = input.subscriptionId;

  for (const grant of grantRows) {
    const result = await applyGrant(tx, {
      grantId: grant.id,
      kind: grant.kind,
      config: grant.config,
      variant,
      quantity: input.quantity,
      tenantId: input.tenantId,
      orderId,
      reference: input.reference,
      userId: input.userId,
    });
    applied.push(result);
    if (result.kind === "license_key") {
      // Stored on the ORDER LINE, not in a table of its own. The key belongs to
      // the line that bought it: it is on the receipt, it survives the product
      // being archived, and it needs no migration in a scaffold whose grant
      // kinds a project is expected to extend.
      lineMetadata["licenseKey"] = result.licenseKey;
    }
    if (result.kind === "credits") {
      // On the line too, so the receipt and /account/orders can say "25 crowns"
      // without joining the ledger. Keyed by unit: one variant can carry two
      // credits grants (crowns AND a bonus of something else).
      lineMetadata[`credits:${result.unit}`] = String(result.amount);
    }
  }

  await tx.insert(orderItems).values({
    orderId,
    // Plain text with no foreign key, by __SCOPE__/commerce's design: a catalog
    // change must never rewrite or delete a completed order.
    productRef: variant.productId,
    variantRef: variant.variantId,
    // Copied at purchase time. Joining for the name at render time means
    // renaming a product retroactively changes what an old receipt says.
    name: `${variant.productName} — ${variant.variantName}`,
    quantity: input.quantity,
    unitPriceMinor,
    totalMinor,
    metadata: Object.keys(lineMetadata).length > 0 ? lineMetadata : null,
  });

  await tx.insert(auditLog).values(
    auditEntry(fulfilmentAuditRegistry, {
      action: AUDIT_ACTION_FOR[input.source],
      // The buyer, not null. A webhook is not a person, but the person this row
      // is ABOUT is the one whose money moved, and "what did this user do" is
      // the query the actor index exists for. `source` is in the metadata too,
      // for a reader who has the row and not the registry.
      actor: input.userId === null ? null : { userId: input.userId },
      scope: "tenant",
      tenantId: input.tenantId,
      resourceType: "order",
      resourceId: orderId,
      metadata: {
        source: input.source,
        reference: input.reference,
        orderNumber,
        variantId: variant.variantId,
        productSlug: variant.productSlug,
        quantity: input.quantity,
        // Serialised: this object goes through `redactValue` and lands in jsonb,
        // and JSON.stringify throws on a bigint rather than encoding one.
        totalMinor: totalMinor.toString(),
        currency,
        grants: applied.map((grant) => grant.kind),
      },
    }),
  );

  return {
    orderId,
    orderNumber,
    created: true,
    totalMinor,
    currency,
    grants: applied,
  };
}

// ---------------------------------------------------------------------------
// A recurring product's grants follow its subscription (review B4)
// ---------------------------------------------------------------------------

export interface ProductSubscriptionState {
  /** `sub_…`: the subscription a recurring product's checkout started. */
  readonly subscriptionId: string;
  /** Already mapped through `mapStripeSubscriptionStatus`. */
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
  /** When this state was read — a live read of Stripe, so it is the newest there is. */
  readonly at: Date;
}

/**
 * Make the entitlements a RECURRING product granted follow its subscription.
 *
 * THE GAP THIS CLOSES (review B4). A recurring product's purchase granted its
 * entitlement once, with no end, and its cancellation was never applied: the
 * webhook skipped every product subscription ("not a plan — the order path
 * owns it"), and the order path never looked again. So a subscriber who
 * cancelled kept what they had bought for ever.
 *
 * The window is the plan's own (`subscriptionEntitlementWindow`): renewing,
 * no end; scheduled to cancel, the end of the paid period; a failed payment,
 * the 14-day grace; unpaid, now. A cancelled one ends NOW — the row is kept
 * (with its `used_value`, for the receipt the account area shows) and simply
 * stops counting. Only `grant` rows of the orders this subscription paid for
 * are touched: the order line remembers the subscription (`subscriptionId`).
 *
 * Returns how many grant rows were moved.
 */
export async function windowProductGrants(state: ProductSubscriptionState): Promise<number> {
  const lines = await db
    .select({ tenantId: orders.tenantId, idempotencyKey: orders.idempotencyKey })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(sql`${orderItems.metadata} ->> 'subscriptionId' = ${state.subscriptionId}`);
  if (lines.length === 0) return 0;

  const window = subscriptionEntitlementWindow({
    status: state.status,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    currentPeriodEnd: state.currentPeriodEnd,
    at: state.at,
  });
  // Ended: stops counting now, row kept. Otherwise the window's own deadline.
  const expiresAt = window.holds ? window.expiresAt : state.at;

  let moved = 0;
  for (const line of lines) {
    const reference = referenceOfKey(line.idempotencyKey);
    if (reference === null) continue;
    const updated = await db
      .update(entitlements)
      .set({ expiresAt, updatedAt: new Date() })
      .where(
        and(
          eq(entitlements.tenantId, line.tenantId),
          eq(entitlements.source, "grant"),
          sql`split_part(${entitlements.sourceRef}, ':', 1) = ${reference}`,
        ),
      )
      .returning({ id: entitlements.id });
    moved += updated.length;
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Refunds and disputes (create-app 0.44)
// ---------------------------------------------------------------------------

/**
 * A refund Stripe reported (`charge.refunded`). `refundedMinor` is Stripe's
 * RUNNING total for the charge, `amount_refunded`, not this one refund's
 * amount: two partial refunds arrive as two events carrying 500 and then 1000,
 * possibly the other way round, and a running total is what makes both orders
 * of delivery come out the same.
 */
export interface ShopRefund {
  readonly paymentIntentId: string;
  readonly refundedMinor: number;
  readonly currency: string;
}

/** A dispute Stripe reported (`charge.dispute.created`). */
export interface ShopDispute {
  readonly paymentIntentId: string;
  readonly disputeId: string;
  readonly currency: string;
}

export type ShopRefundOutcome =
  /** Not an order this shop booked: a plan's invoice, a store order, another app's charge. */
  | { readonly outcome: "ignored"; readonly why: string }
  /** Already recorded at this running total (or this dispute): nothing moved. */
  | { readonly outcome: "duplicate"; readonly orderId: string }
  | {
      readonly outcome: "refunded" | "disputed";
      readonly orderId: string;
      /** The whole order is refunded (or disputed): every grant was ended, not just a share. */
      readonly whole: boolean;
      readonly creditsTaken: readonly { readonly unit: string; readonly taken: number }[];
      readonly entitlementsEnded: number;
      readonly licencesRevoked: number;
    };

/**
 * The part of `granted` that a running refund of `refundedMinor` out of
 * `totalMinor` takes back, ROUNDED DOWN. Half of 25 credits refunded is 12, not
 * 13: the customer keeps the odd one rather than losing one they paid for.
 *
 * In bigint, because `granted × refunded` passes 2^53 on an order worth a few
 * million cents of a pack of a few billion credits, and a float rounding the
 * product would round the refund with it.
 */
export function refundedShare(granted: number, totalMinor: bigint, refundedMinor: bigint): number {
  if (granted <= 0 || totalMinor <= 0n || refundedMinor <= 0n) return 0;
  const refunded = refundedMinor > totalMinor ? totalMinor : refundedMinor;
  return Number((BigInt(granted) * refunded) / totalMinor);
}

interface RefundableOrder {
  readonly id: string;
  readonly tenantId: string;
  readonly orderNumber: string;
  readonly idempotencyKey: string;
  readonly userId: string | null;
  readonly totalMinor: bigint;
  readonly refundedMinor: bigint;
  readonly currency: string;
  readonly flag: string | null;
}

/**
 * The shop order a PaymentIntent paid for, LOCKED for the rest of the
 * transaction. The lock is what makes two refund events at different running
 * totals safe: without it both read the same "refunded so far", both compute
 * their share from it, and the credits between the two totals are taken twice.
 *
 * Found by the shop's own idempotency key, so a refund on anything this module
 * did not book (a plan's invoice, a company's store order) matches nothing.
 */
async function lockOrderForPayment(tx: Tx, paymentIntentId: string): Promise<RefundableOrder | null> {
  const [row] = await tx
    .select({
      id: orders.id,
      tenantId: orders.tenantId,
      orderNumber: orders.orderNumber,
      idempotencyKey: orders.idempotencyKey,
      userId: orders.userId,
      totalMinor: orders.totalMinor,
      refundedMinor: orders.refundedMinor,
      currency: orders.currency,
      flag: orders.flag,
    })
    .from(orders)
    .where(eq(orders.idempotencyKey, `${FULFILMENT_KEY_PREFIX}${paymentIntentId}`))
    .limit(1)
    .for("update");
  return row ?? null;
}

/** `%` and `_` are LIKE wildcards, and every PaymentIntent id has an underscore. */
function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, "\\$&")}:%`;
}

/**
 * Take back credits this order granted: `owed(granted)` of each grant, from the
 * buyer's balance, never below zero. Credits already spent stay spent; the
 * wallet records what it could take (possibly nothing) under `ref`, so a retry
 * of the same step takes nothing more.
 */
async function takeBackCredits(
  tx: Tx,
  order: RefundableOrder,
  reference: string,
  step: { readonly ref: (grantId: string) => string; readonly owed: (granted: number) => number; readonly note: string },
): Promise<{ unit: string; taken: number }[]> {
  if (order.userId === null) return []; // a guest can't have bought credits
  const grants = await tx
    .select({ unit: walletLedger.unit, delta: walletLedger.delta, ref: walletLedger.ref })
    .from(walletLedger)
    .where(
      and(
        eq(walletLedger.holderId, order.userId),
        eq(walletLedger.reason, "grant"),
        like(walletLedger.ref, likePrefix(reference)),
      ),
    );
  const taken: { unit: string; taken: number }[] = [];
  for (const grant of grants) {
    const owed = step.owed(grant.delta);
    if (owed <= 0) continue;
    // `ref` was written by applyGrant as `<reference>:<grantId>`.
    const grantId = grant.ref.slice(reference.length + 1);
    const moved = await refundWallet(tx, {
      holderId: order.userId,
      unit: grant.unit,
      amount: owed,
      ref: step.ref(grantId),
      note: step.note,
    });
    if (moved.applied) taken.push({ unit: grant.unit, taken: moved.taken });
  }
  return taken;
}

/** End now what the order's `entitlement` grants still hold. The rows are kept: they are the record. */
async function endOrderEntitlements(tx: Tx, tenantId: string, reference: string, now: Date): Promise<number> {
  const ended = await tx
    .update(entitlements)
    .set({ expiresAt: now, updatedAt: now })
    .where(
      and(
        eq(entitlements.tenantId, tenantId),
        eq(entitlements.source, "grant"),
        sql`split_part(${entitlements.sourceRef}, ':', 1) = ${reference}`,
        or(isNull(entitlements.expiresAt), gt(entitlements.expiresAt, now)),
      ),
    )
    .returning({ id: entitlements.id });
  return ended.length;
}

/**
 * A licence key can't be un-shown: the buyer has it. What a refund CAN do is
 * say so on the line, as `licenseRevokedAt`, so anything that checks keys (an
 * activation endpoint, a download gate) can refuse this one. The key stays on
 * the receipt it was printed on.
 */
async function revokeOrderLicences(tx: Tx, orderId: string, now: Date): Promise<number> {
  const revoked = await tx
    .update(orderItems)
    .set({
      metadata: sql`coalesce(${orderItems.metadata}, '{}'::jsonb) || ${JSON.stringify({ licenseRevokedAt: now.toISOString() })}::jsonb`,
    })
    .where(
      and(
        eq(orderItems.orderId, orderId),
        sql`${orderItems.metadata} ->> 'licenseKey' is not null`,
        sql`${orderItems.metadata} ->> 'licenseRevokedAt' is null`,
      ),
    )
    .returning({ id: orderItems.id });
  return revoked.length;
}

/**
 * A REFUND MADE IN STRIPE comes back to the order (create-app 0.44).
 *
 * The order's `refunded_minor` follows Stripe's running total, and all of it
 * makes the order `refunded`; a part refund leaves it `paid` with the amount
 * shown, as __SCOPE__/commerce defines both columns. Then, per grant kind:
 *
 *   credits      the refunded SHARE of what this order credited is taken back
 *                from the buyer (rounded down, never below zero): half the
 *                money back is half the pack back.
 *   entitlement  a WHOLE refund ends it now; a part refund leaves it, because
 *                half a seat is not a thing and a part refund is usually a
 *                goodwill gesture on a purchase that stands.
 *   license_key  a WHOLE refund marks the line `licenseRevokedAt` (above).
 *   ship         nothing: whether a parcel already sent comes back is the
 *                business's call, made in the warehouse, not here.
 *
 * IDEMPOTENT ON THE RUNNING TOTAL: only the event that moves `refunded_minor`
 * up does anything, so a redelivery, or an older total arriving late, is a
 * duplicate. Everything is one transaction, with the audit row. On an order
 * already disputed only the money is recorded: the dispute took the grants.
 *
 * Refunding is done in Stripe's dashboard (or its API), never from this app:
 * the money path stays where the money is, and this function only records what
 * Stripe says happened.
 */
export async function refundPurchase(refund: ShopRefund): Promise<ShopRefundOutcome> {
  return db.transaction(async (tx) => {
    const order = await lockOrderForPayment(tx, refund.paymentIntentId);
    if (!order) return { outcome: "ignored", why: "not an order this shop booked" };
    if (refund.currency.toLowerCase() !== order.currency.toLowerCase()) {
      return { outcome: "ignored", why: `a refund in ${refund.currency} on an order paid in ${order.currency}` };
    }

    const total = order.totalMinor;
    const reported = BigInt(Math.max(0, Math.trunc(refund.refundedMinor)));
    const next = reported > total ? total : reported;
    const previous = order.refundedMinor;
    // Never backwards: only a larger running total moves anything.
    if (next <= previous) return { outcome: "duplicate", orderId: order.id };
    const whole = next >= total;
    const now = new Date();

    await tx
      .update(orders)
      .set({ refundedMinor: next, ...(whole ? { status: "refunded" as const } : {}), updatedAt: now })
      .where(and(eq(orders.id, order.id), lt(orders.refundedMinor, next)));

    const reference = referenceOfKey(order.idempotencyKey) ?? refund.paymentIntentId;
    // A dispute already took back everything the order granted (below), so a
    // refund after one records the money and takes nothing: taking the credits
    // again would take them out of whatever the buyer has bought since.
    const afterDispute = order.flag !== null;
    const creditsTaken = afterDispute
      ? []
      : await takeBackCredits(tx, order, reference, {
          ref: (grantId) => `${reference}:${grantId}:refund:${next}`,
          owed: (granted) => refundedShare(granted, total, next) - refundedShare(granted, total, previous),
          note: `Refunded in Stripe: ${next} of ${total} ${order.currency} on order ${order.orderNumber}`,
        });
    const entitlementsEnded = whole && !afterDispute ? await endOrderEntitlements(tx, order.tenantId, reference, now) : 0;
    const licencesRevoked = whole && !afterDispute ? await revokeOrderLicences(tx, order.id, now) : 0;

    await tx.insert(auditLog).values(
      auditEntry(fulfilmentAuditRegistry, {
        action: "commerce.order.refunded",
        // The buyer, as on the booking: the person this row is about.
        actor: order.userId === null ? null : { userId: order.userId },
        scope: "tenant",
        tenantId: order.tenantId,
        resourceType: "order",
        resourceId: order.id,
        metadata: {
          reference,
          orderNumber: order.orderNumber,
          refundedMinor: next.toString(),
          previousMinor: previous.toString(),
          totalMinor: total.toString(),
          currency: order.currency,
          whole,
          afterDispute,
          creditsTaken,
          entitlementsEnded,
          licencesRevoked,
        },
      }),
    );
    return { outcome: "refunded", orderId: order.id, whole, creditsTaken, entitlementsEnded, licencesRevoked };
  });
}

/**
 * A DISPUTE IS TREATED AS A FULL REFUND OF WHAT THE ORDER GRANTED.
 *
 * When a customer's bank disputes a payment, Stripe pulls the money back at
 * once and holds it until the dispute is decided. Leaving the credits,
 * entitlements and licence keys in place for those weeks would let a buyer
 * spend what they are simultaneously asking their bank to return. So the order
 * is flagged `disputed` (__SCOPE__/commerce's own flag) and every grant is
 * ended exactly as a whole refund ends it. The order's money columns don't
 * move: no refund happened, and `refunded_minor` stays Stripe's refund total.
 *
 * A dispute the business WINS doesn't hand the grants back automatically: by
 * then the buyer may hold a new pack, and a person should decide. Staff restore
 * credits with the adjustment on /admin/credits.
 *
 * Idempotent on the flag: a second `charge.dispute.created` for an order
 * already flagged is a duplicate.
 */
export async function disputePurchase(dispute: ShopDispute): Promise<ShopRefundOutcome> {
  return db.transaction(async (tx) => {
    const order = await lockOrderForPayment(tx, dispute.paymentIntentId);
    if (!order) return { outcome: "ignored", why: "not an order this shop booked" };
    if (order.flag === "disputed" || order.flag === "dispute_lost") return { outcome: "duplicate", orderId: order.id };
    const now = new Date();

    await tx.update(orders).set({ flag: "disputed", flaggedAt: now, updatedAt: now }).where(eq(orders.id, order.id));

    const reference = referenceOfKey(order.idempotencyKey) ?? dispute.paymentIntentId;
    const total = order.totalMinor;
    const refundedBefore = order.refundedMinor;
    const creditsTaken = await takeBackCredits(tx, order, reference, {
      ref: (grantId) => `${reference}:${grantId}:dispute:${dispute.disputeId}`,
      // Everything a refund hasn't already taken back.
      owed: (granted) => granted - refundedShare(granted, total, refundedBefore),
      note: `Disputed at the customer's bank (${dispute.disputeId}) on order ${order.orderNumber}`,
    });
    const entitlementsEnded = await endOrderEntitlements(tx, order.tenantId, reference, now);
    const licencesRevoked = await revokeOrderLicences(tx, order.id, now);

    await tx.insert(auditLog).values(
      auditEntry(fulfilmentAuditRegistry, {
        action: "commerce.order.disputed",
        actor: order.userId === null ? null : { userId: order.userId },
        scope: "tenant",
        tenantId: order.tenantId,
        resourceType: "order",
        resourceId: order.id,
        metadata: {
          reference,
          orderNumber: order.orderNumber,
          disputeId: dispute.disputeId,
          currency: dispute.currency,
          creditsTaken,
          entitlementsEnded,
          licencesRevoked,
        },
      }),
    );
    return { outcome: "disputed", orderId: order.id, whole: true, creditsTaken, entitlementsEnded, licencesRevoked };
  });
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

interface ApplyGrantInput {
  readonly grantId: string;
  readonly kind: GrantKind;
  readonly config: Readonly<Record<string, unknown>>;
  readonly variant: PurchasableVariant;
  readonly quantity: number;
  readonly tenantId: string;
  readonly orderId: string;
  readonly reference: string;
  /** The buyer. NULL for a guest, which a `credits` grant refuses. */
  readonly userId: string | null;
}

/**
 * Move one grant from a variant to its effect. THE SEAM __SCOPE__/catalog
 * describes: commerce reads `ship` and gets a packing slip, billing reads
 * `entitlement` and gets a row, and nothing in between knows which kind of
 * business this project is.
 *
 * Every config is re-parsed with `grantConfigSchemas` rather than destructured.
 * The column is jsonb and a row written under last year's shape is still a row;
 * an unchecked `config.feature` writes an entitlement named `undefined`, which
 * resolves to nothing and looks exactly like a customer who was never granted
 * anything.
 */
async function applyGrant(
  tx: Tx,
  input: ApplyGrantInput,
): Promise<AppliedGrant> {
  switch (input.kind) {
    case "entitlement": {
      const config = grantConfigSchemas.entitlement.parse(input.config);
      const perUnit = config.limit ?? null;
      // NULL is unlimited, and unlimited times three is still unlimited —
      // multiplying would turn it into a number. A finite limit DOES scale:
      // three ten-seat packs is thirty seats, and a customer who paid for three
      // getting ten is the complaint this line prevents.
      const limitValue = perUnit === null ? null : perUnit * input.quantity;

      await tx
        .insert(entitlements)
        .values({
          tenantId: input.tenantId,
          feature: config.feature,
          limitValue,
          source: "grant",
          // The purchase AND the grant. Two grants on one variant can name the
          // same feature (a base allowance and a bonus), and keying on the
          // reference alone would collapse them into one row via the unique
          // index — silently halving what the customer bought.
          sourceRef: `${input.reference}:${input.grantId}`,
        })
        // Targetless. `entitlements` carries exactly one unique index and it is
        // over a `coalesce(source_ref, '')` EXPRESSION, which Drizzle's `target`
        // array cannot spell — and naming the columns without the expression
        // produces a statement Postgres refuses outright. "If this row already
        // exists, leave it alone" is the whole requirement, and that is what a
        // bare DO NOTHING says. Crucially it must not DO UPDATE: `used_value` on
        // an existing row is consumption already recorded, and an upsert would
        // reset it.
        .onConflictDoNothing();

      return { kind: "entitlement", feature: config.feature, limit: limitValue };
    }

    case "license_key": {
      grantConfigSchemas.license_key.parse(input.config);
      // Generated inside the transaction that books the order, so a rolled-back
      // fulfilment leaves no key behind — and a duplicate call never reaches
      // here, because the order insert short-circuits above it.
      return { kind: "license_key", licenseKey: generateLicenseKey() };
    }

    case "ship": {
      grantConfigSchemas.ship.parse(input.config);
      const [shipment] = await tx
        .insert(orderShipments)
        // Carrier, tracking and `shipped_at` all NULL. A label bought is not a
        // parcel gone, and the NULL `shipped_at` is what says so — the row
        // exists so the warehouse queue has something to pick up, not to claim
        // anything moved.
        .values({ orderId: input.orderId })
        .returning({ id: orderShipments.id });
      if (!shipment) {
        throw new Error("fulfilPurchase: shipment insert returned no rows");
      }
      return { kind: "ship", shipmentId: shipment.id };
    }

    case "credits": {
      const config = grantConfigSchemas.credits.parse(input.config);
      if (input.userId === null) {
        // Refused, and the whole booking with it: this throws inside the
        // transaction, so no order is left behind claiming credits nobody
        // holds. The storefront asks for an account before checkout
        // (`variantGrantsCredits`), so reaching here means something called
        // this function without a buyer — a webhook for an intent this app did
        // not create. Stripe then redelivers, and the event waits in the
        // failed queue for a person, which is the right place for money that
        // can't be attributed to anyone.
        throw new PurchaseRefusedError(
          "account_required",
          "Credits go into the buyer's account, and this purchase has no buyer.",
        );
      }
      // Three packs of 25 is 75: the amount scales with the quantity, like an
      // entitlement's limit.
      const amount = config.amount * input.quantity;
      const credited = await creditWallet(tx, {
        // THE BUYER, NOT THE TENANT. `tenantId` here is the storefront's
        // (whose catalog this is), and credits belong to the person who paid.
        holderId: input.userId,
        unit: config.unit,
        amount,
        // The purchase AND the grant, as an entitlement's source_ref: two
        // credits grants on one variant are two credits, and a redelivered
        // payment never reaches here (the order insert short-circuits above)
        // — but if it did, the wallet's own unique index would hold the line.
        ref: `${input.reference}:${input.grantId}`,
        note: `${input.variant.productName} — ${input.variant.variantName}${input.quantity > 1 ? ` × ${input.quantity}` : ""}`,
      });
      return { kind: "credits", unit: config.unit, amount, balance: credited.balance };
    }

    case "none":
      // A real answer, not a placeholder — a donation or an off-platform ticket
      // grants nothing here. Parsed anyway, so a config that has grown fields
      // nobody reads is still rejected at the boundary.
      grantConfigSchemas.none.parse(input.config);
      return { kind: "none" };
  }
}

/**
 * Whether buying this variant puts credits in someone's account.
 *
 * The checkout asks BEFORE any money moves, so a guest is told to sign in
 * rather than charged for credits fulfilment then refuses to book. Read from
 * the grant rows, never from the product's name or metadata, because the
 * grant is what fulfilment acts on.
 */
export async function variantGrantsCredits(variantId: string, handle: Db | Tx = db): Promise<boolean> {
  const [row] = await handle
    .select({ id: productGrants.id })
    .from(productGrants)
    .where(and(eq(productGrants.variantId, variantId), eq(productGrants.kind, "credits")))
    .limit(1);
  return row !== undefined;
}

/**
 * Crockford base32, four groups of five: `A7K2M-9PQRT-3XZ4B-6HJN8`.
 *
 * The alphabet excludes I, L, O and U. The first three because they are
 * indistinguishable from 1 and 0 in most fonts and a licence key is read off a
 * screen and retyped; U because it turns random strings into words nobody wants
 * printed on an invoice.
 *
 * 100 bits drawn from `randomUUID`, which is CSPRNG-backed. Not a signed token:
 * it is a bearer string, so whatever redeems it must LOOK IT UP rather than
 * verify it.
 */
function generateLicenseKey(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const hex = (randomUUID() + randomUUID()).replace(/-/g, "");
  let out = "";
  for (let index = 0; index < 20; index += 1) {
    // Two hex digits (0-255) folded into 32 symbols. The fold is uniform
    // because 256 is a multiple of 32, so no symbol is over-represented.
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    out += ALPHABET[byte % ALPHABET.length];
    if (index % 5 === 4 && index !== 19) out += "-";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading an order back
// ---------------------------------------------------------------------------

export interface FulfilledOrderLine {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: bigint;
  readonly totalMinor: bigint;
  readonly licenseKey: string | null;
}

export interface FulfilledOrderView {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  /**
   * THE FOUR COLUMNS EVERY ORDER WRITES AND NOTHING USED TO READ.
   *
   * `bookOrder` writes subtotal, discount, tax and shipping on every single
   * order, and `/checkout/success` prints only the total — so a customer
   * querying a charge was shown one number with no way to see what it was made
   * of. They are carried on the view rather than recomputed at render time for
   * the reason __SCOPE__/commerce gives on the column itself: the stored
   * figures are what the customer was charged, and re-deriving them would let a
   * later change to the rounding rule silently restate a completed order.
   */
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly shippingMinor: bigint;
  readonly totalMinor: bigint;
  readonly currency: string;
  readonly placedAt: Date | null;
  readonly userId: string | null;
  /**
   * The fulfilment reference this order was booked under, recovered from
   * `orders.idempotency_key` rather than stored a second time.
   *
   * NULL when the key carries another writer's namespace — __SCOPE__/commerce
   * defines `CHECKOUT_SESSION_KEY_PREFIX` for exactly that reason — which is
   * why it is nullable rather than an assertion. A row this module did not
   * write is still an order, and a reader that threw on one would take a whole
   * order history down for a single foreign row.
   *
   * The account area joins entitlements on it: `applyGrant` writes
   * `entitlements.source_ref` as `<reference>:<grantId>`, so this is the only
   * handle connecting a grant back to the purchase that paid for it.
   */
  readonly reference: string | null;
  /** Derived from the reference, not from a column of its own. */
  readonly source: FulfilmentSource | null;
  readonly lines: readonly FulfilledOrderLine[];
}

/**
 * The columns every order view is built from, written once.
 *
 * Three readers select exactly this list, and a hand-copied select in each of
 * them is three chances for one screen to be missing a column the others show.
 * That is not hypothetical: the money breakdown was already in the row
 * `/checkout/success` had fetched, and was not in the shape it read it through.
 */
const ORDER_VIEW_COLUMNS = {
  id: orders.id,
  orderNumber: orders.orderNumber,
  status: orders.status,
  idempotencyKey: orders.idempotencyKey,
  subtotalMinor: orders.subtotalMinor,
  discountMinor: orders.discountMinor,
  taxMinor: orders.taxMinor,
  shippingMinor: orders.shippingMinor,
  totalMinor: orders.totalMinor,
  currency: orders.currency,
  placedAt: orders.placedAt,
  userId: orders.userId,
} as const;

/** One row of `ORDER_VIEW_COLUMNS`, before its lines are attached. */
interface OrderRow {
  readonly id: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly idempotencyKey: string;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly taxMinor: bigint;
  readonly shippingMinor: bigint;
  readonly totalMinor: bigint;
  readonly currency: string;
  readonly placedAt: Date | null;
  readonly userId: string | null;
}

/**
 * The inverse of the key `bookOrder` writes. NULL when the prefix is not ours.
 *
 * Exported because the account area needs a reference to reach an order's
 * entitlements, and spelling `slice(FULFILMENT_KEY_PREFIX.length)` at the call
 * site is a second copy of a rule that lives here — one that would keep
 * compiling and start returning nonsense the day the prefix changes.
 */
export function referenceOfKey(idempotencyKey: string): string | null {
  return idempotencyKey.startsWith(FULFILMENT_KEY_PREFIX)
    ? idempotencyKey.slice(FULFILMENT_KEY_PREFIX.length)
    : null;
}

function viewFrom(
  row: OrderRow,
  lines: readonly FulfilledOrderLine[],
): FulfilledOrderView {
  const reference = referenceOfKey(row.idempotencyKey);
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    subtotalMinor: row.subtotalMinor,
    discountMinor: row.discountMinor,
    taxMinor: row.taxMinor,
    shippingMinor: row.shippingMinor,
    totalMinor: row.totalMinor,
    currency: row.currency,
    placedAt: row.placedAt,
    userId: row.userId,
    reference,
    source: reference === null ? null : sourceOfReference(reference),
    lines,
  };
}

/**
 * Every line of several orders, in one round trip.
 *
 * A second query rather than a join, matching `loadStorefrontProducts`: a join
 * multiplies the order row by its line count and every caller then has to
 * regroup it, which with `noUncheckedIndexedAccess` on is where the undefined
 * checks pile up. A query PER ORDER would be the other failure — an order
 * history of forty rows issuing forty-one statements.
 */
async function linesByOrder(
  orderIds: readonly string[],
): Promise<Map<string, FulfilledOrderLine[]>> {
  const byOrder = new Map<string, FulfilledOrderLine[]>();
  // An empty `inArray` is a syntax error in some drivers and an always-false
  // predicate in others. Neither is worth discovering from the account page of
  // somebody who has bought nothing, which is the most common page there is.
  if (orderIds.length === 0) return byOrder;

  const rows = await db
    .select({
      orderId: orderItems.orderId,
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceMinor: orderItems.unitPriceMinor,
      totalMinor: orderItems.totalMinor,
      metadata: orderItems.metadata,
    })
    .from(orderItems)
    .where(inArray(orderItems.orderId, [...orderIds]));

  for (const row of rows) {
    const list = byOrder.get(row.orderId) ?? [];
    list.push({
      name: row.name,
      quantity: row.quantity,
      unitPriceMinor: row.unitPriceMinor,
      totalMinor: row.totalMinor,
      licenseKey: row.metadata?.["licenseKey"] ?? null,
    });
    byOrder.set(row.orderId, list);
  }
  return byOrder;
}

/**
 * The order a reference produced, whichever path produced it.
 *
 * ONE reader for both paths, called by `/checkout/success` with either a
 * PaymentIntent id or a `sim_` reference. That the same function answers both is
 * the observable proof that the two paths converged — had they not, this
 * function would need a branch, and the branch is where the divergence would
 * live.
 *
 * KEYED ON A REFERENCE AND NOT ON A PERSON, which is why the account area does
 * not use it. The Stripe path has to work for a buyer with no session, so
 * ownership there is proved by the client secret in the return URL. The
 * user-scoped readers below are the same read with the opposite proof, and they
 * are separate functions because collapsing them would put that difference
 * inside an `if` on a value the caller supplies.
 */
export async function readOrderByReference(input: {
  readonly tenantId: string;
  readonly reference: string;
}): Promise<FulfilledOrderView | null> {
  const idempotencyKey = `${FULFILMENT_KEY_PREFIX}${input.reference}`;

  const [order] = await db
    .select(ORDER_VIEW_COLUMNS)
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, input.tenantId),
        eq(orders.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (!order) return null;
  const lines = await linesByOrder([order.id]);
  return viewFrom(order, lines.get(order.id) ?? []);
}

/**
 * How many of one person's orders the account area renders at once.
 *
 * A cap rather than paging, and declared here rather than in a page, because
 * this is the module that knows an order is a row plus its lines. A consumer
 * storefront reaches it after two hundred purchases; a project whose customers
 * buy daily should add a cursor HERE, so `/account` and `/account/orders`
 * cannot come to disagree about what "all of them" means.
 */
export const ACCOUNT_ORDER_LIMIT = 200;

/**
 * EVERY ORDER THIS PERSON PLACED. The reader the account area is built on.
 *
 * USER-SCOPED, with the tenant as a second predicate rather than the first.
 * `orders.tenant_id` on a storefront purchase is `STOREFRONT_TENANT_ID`, which
 * is `FIRM_WIDE` — every customer of the shop shares it. Selecting by tenant
 * alone would hand each buyer the whole shop's order history; selecting by the
 * buyer's own organisation would match nothing at all, because their orders
 * were never booked there. `orders.user_id` is the only column that records
 * whose purchase this was, so it is what the predicate is built from, and the
 * tenant narrows it to one storefront for the day a project gives each customer
 * their own.
 *
 * A NULL `user_id` — a guest purchase — matches nobody, because SQL equality
 * against NULL is never true. That is the correct outcome rather than an
 * oversight: a guest order has no account to show it in, and the fix is an
 * emailed tokenised link, not a looser predicate here.
 *
 * Newest first by `placed_at`, falling back to `created_at`. `placed_at` is
 * when the customer paid and `created_at` is when the row was written; a
 * webhook redelivered three days into a retry schedule makes those very
 * different instants, and ordering on the write time would file a recovered
 * order at the top of a history it belongs in the middle of.
 */
export async function listOrdersForUser(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly limit?: number;
}): Promise<readonly FulfilledOrderView[]> {
  const rows = await db
    .select(ORDER_VIEW_COLUMNS)
    .from(orders)
    .where(and(eq(orders.tenantId, input.tenantId), eq(orders.userId, input.userId)))
    .orderBy(desc(orders.placedAt), desc(orders.createdAt))
    .limit(input.limit ?? ACCOUNT_ORDER_LIMIT);

  const lines = await linesByOrder(rows.map((row) => row.id));
  return rows.map((row) => viewFrom(row, lines.get(row.id) ?? []));
}

/**
 * One of a person's orders, by the number printed on their receipt.
 *
 * THE OWNERSHIP PREDICATE IS IN THE SQL, never in an `if` after the read. A
 * page that fetches by order number and then compares `order.userId` is one
 * deleted early-return away from rendering a stranger's purchase, and that
 * early return is exactly the line a refactor removes as redundant. Here there
 * is no row to leak: "no such order" and "not yours" are the same empty result,
 * which is also what stops the route being an oracle for which order numbers
 * exist.
 *
 * BY ORDER NUMBER RATHER THAN BY `orders.id`. The number is what the customer
 * has — it is on the receipt, in the confirmation and in the sentence they read
 * out to support — so it is the handle a support conversation can use.
 * `formatOrderNumber` warns that the number is not an authorisation token, and
 * it is not being used as one: the user predicate is the authorisation, and the
 * number is only an address.
 */
export async function readOrderForUser(input: {
  readonly tenantId: string;
  readonly userId: string;
  readonly orderNumber: string;
}): Promise<FulfilledOrderView | null> {
  const [order] = await db
    .select(ORDER_VIEW_COLUMNS)
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, input.tenantId),
        eq(orders.orderNumber, input.orderNumber),
        eq(orders.userId, input.userId),
      ),
    )
    .limit(1);

  if (!order) return null;
  const lines = await linesByOrder([order.id]);
  return viewFrom(order, lines.get(order.id) ?? []);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function emailOf(tx: Tx, userId: string): Promise<string | null> {
  const [row] = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

/**
 * The next per-tenant order number.
 *
 * PER TENANT, never global — `formatOrderNumber` spells out the disclosure: the
 * number tells a competitor about the one storefront they bought from, and a
 * global counter would hand every customer a read on total platform volume.
 *
 * `count(*)` rather than a Postgres sequence because a sequence is not
 * transactional: a rolled-back fulfilment would burn a number and leave a
 * visible gap in the receipt series, which is the first thing an accountant asks
 * about. The cost is the collision handled by `ORDER_NUMBER_ATTEMPTS`.
 */
async function nextOrderSequence(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ used: sql<number>`count(*)::int` })
    .from(orders)
    .where(eq(orders.tenantId, tenantId));
  return (row?.used ?? 0) + 1;
}

/**
 * Was this a lost race for an order number, or something that must not be
 * retried?
 *
 * Narrow on purpose. A 23505 on `orders_stripe_payment_intent_idx` means one
 * PaymentIntent is being booked onto a second order — a duplicate charge or a
 * mis-keyed write — and retrying that would only lose the evidence more slowly.
 * Only the order-number index is a benign collision.
 *
 * Duck-typed rather than `instanceof`: the driver's error class is not exported
 * as a stable value, and pnpm can install two copies of it.
 */
function isOrderNumberCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === "23505" &&
    typeof candidate.constraint === "string" &&
    candidate.constraint.includes("order_number")
  );
}

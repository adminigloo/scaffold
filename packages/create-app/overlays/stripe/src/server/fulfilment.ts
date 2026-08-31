import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import { grantConfigSchemas } from "__SCOPE__/catalog";
import type { GrantKind } from "__SCOPE__/catalog";
import { productGrants, products, productVariants } from "__SCOPE__/catalog/schema";
import { entitlements } from "__SCOPE__/billing/schema";
import { formatOrderNumber } from "__SCOPE__/commerce";
import { orderItems, orderShipments, orders } from "__SCOPE__/commerce/schema";
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
  | "amount_too_large";

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
    });
    applied.push(result);
    if (result.kind === "license_key") {
      // Stored on the ORDER LINE, not in a table of its own. The key belongs to
      // the line that bought it: it is on the receipt, it survives the product
      // being archived, and it needs no migration in a scaffold whose grant
      // kinds a project is expected to extend.
      lineMetadata["licenseKey"] = result.licenseKey;
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

    case "none":
      // A real answer, not a placeholder — a donation or an off-platform ticket
      // grants nothing here. Parsed anyway, so a config that has grown fields
      // nobody reads is still rejected at the boundary.
      grantConfigSchemas.none.parse(input.config);
      return { kind: "none" };
  }
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
// Reading an order back — the one function both success paths use
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
  readonly totalMinor: bigint;
  readonly currency: string;
  readonly placedAt: Date | null;
  readonly userId: string | null;
  /** Derived from the stored reference, not from a column of its own. */
  readonly source: FulfilmentSource | null;
  readonly lines: readonly FulfilledOrderLine[];
}

/**
 * The order a reference produced, whichever path produced it.
 *
 * ONE reader for both paths, called by `/checkout/success` with either a
 * PaymentIntent id or a `sim_` reference. That the same function answers both is
 * the observable proof that the two paths converged — had they not, this
 * function would need a branch, and the branch is where the divergence would
 * live.
 */
export async function readOrderByReference(input: {
  readonly tenantId: string;
  readonly reference: string;
}): Promise<FulfilledOrderView | null> {
  const idempotencyKey = `${FULFILMENT_KEY_PREFIX}${input.reference}`;

  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      totalMinor: orders.totalMinor,
      currency: orders.currency,
      placedAt: orders.placedAt,
      userId: orders.userId,
    })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, input.tenantId),
        eq(orders.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  if (!order) return null;

  const lines = await db
    .select({
      name: orderItems.name,
      quantity: orderItems.quantity,
      unitPriceMinor: orderItems.unitPriceMinor,
      totalMinor: orderItems.totalMinor,
      metadata: orderItems.metadata,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  return {
    ...order,
    source: sourceOfReference(input.reference),
    lines: lines.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      totalMinor: line.totalMinor,
      licenseKey: line.metadata?.["licenseKey"] ?? null,
    })),
  };
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

import type Stripe from "stripe";
import type { StripeClient } from "./client.js";

/**
 * Publishing a plan row to Stripe, so there is something to charge against.
 *
 * THE PLAN RECORD IS AUTHORITATIVE AND STRIPE IS A CACHE OF IT. `plans` says
 * what a tier costs; Stripe needs a Product and a Price object before it will
 * take money for one, and `plans.stripe_product_id` / `stripe_price_id` are
 * where those two ids are remembered. Nothing in the scaffold created them,
 * which is why a subscription checkout had nothing to bill: the catalogue was
 * complete and the payment engine had never been told about it.
 *
 * WHY A LOOKUP KEY AND NOT A SEARCH. Stripe Prices carry a `lookup_key` that is
 * unique across the account, and `plans.key` — `pro:month:usd` — is already the
 * unique name of exactly one (tier, interval, currency). Using it as the lookup
 * key means the mapping between our catalogue and Stripe's is stated in Stripe
 * rather than only in our column, so a database restored from an old backup, a
 * fresh environment, or an operator who cleared the cached ids all converge on
 * the SAME Price instead of minting a second one. Searching by amount and
 * interval would match the wrong object the first time two tiers cost the same.
 *
 * A PRICE IS IMMUTABLE, which is the fact everything below is shaped by. Amount,
 * currency and interval cannot be edited once created, so "the plan's price
 * changed" is always a NEW Price — and the old one must keep working, because
 * live subscriptions bill against it. `transfer_lookup_key` moves the name to
 * the new object and leaves the old one intact and unnamed, which is exactly
 * the behaviour wanted: new checkouts get the new amount, existing subscribers
 * are untouched until somebody deliberately migrates them.
 */

export interface EnsurePlanPriceInput {
  /** `plans.key` — `<tier>:<interval>:<currency>`. Becomes the Price lookup key. */
  readonly planKey: string;
  /** The tier this row projects from. One Stripe Product per tier, not per row. */
  readonly tierKey: string;
  /** `plans.name`, shown on Stripe's invoices and hosted checkout. */
  readonly name: string;
  readonly description: string | null;
  readonly interval: "month" | "year" | "once";
  /** Minor units, as `plans.price_minor` holds them. */
  readonly unitAmountMinor: bigint;
  readonly currency: string;
  /** `plans.stripe_product_id`, when we have already made one. */
  readonly cachedProductId: string | null;
  /** `plans.stripe_price_id`, when we have already made one. */
  readonly cachedPriceId: string | null;
}

export interface EnsuredPlanPrice {
  readonly productId: string;
  readonly priceId: string;
  /** True when this call created the Price. Drives what the sync reports. */
  readonly created: boolean;
  /** True when the cached ids were already correct and nothing was written. */
  readonly unchanged: boolean;
}

export class PlanPriceMismatchError extends Error {
  readonly name = "PlanPriceMismatchError";
  constructor(planKey: string, reason: string) {
    super(
      `Plan "${planKey}" cannot be published to Stripe: ${reason} The plan ` +
        `record is the source of truth and a Stripe Price is immutable, so the ` +
        `only safe repair is a new Price — which is what this function does ` +
        `when the amount changes, and what it refuses to guess at otherwise.`,
    );
  }
}

/** Stripe rejects an amount over eight digits, on every currency it supports. */
const STRIPE_MAX_AMOUNT_MINOR = 99_999_999n;

/**
 * The Stripe Product and Price this plan row bills against, created if absent.
 *
 * IDEMPOTENT THREE WAYS OVER, because it is reachable from a checkout that a
 * customer may double-click and from a staff button somebody may hold down:
 *
 *   the cached price   is verified against the record before it is trusted. An
 *                      id that names a Price with a different amount is a
 *                      catalogue that has been repriced since it was synced, and
 *                      the answer is a new Price rather than an edit — Stripe
 *                      does not permit the edit, and a silent mismatch would
 *                      charge yesterday's amount for today's plan.
 *   the lookup key     finds a Price this account already holds for this plan
 *                      key, so a cleared cache re-attaches instead of duplicating.
 *   idempotency keys   cover the double-click window, where neither of the two
 *                      reads above has seen the other request's write yet.
 *
 * A ZERO-AMOUNT PRICE IS LEGAL AND DELIBERATE. A free tier is 0, never absent —
 * `plans.price_minor` says so for the same reason — and Stripe will happily
 * hold a subscription at zero, which is how a free plan gets a real
 * subscription row with real entitlements instead of a special case everywhere.
 */
export async function ensurePlanPrice(
  client: StripeClient,
  input: EnsurePlanPriceInput,
): Promise<EnsuredPlanPrice> {
  if (input.unitAmountMinor < 0n) {
    throw new PlanPriceMismatchError(input.planKey, "its amount is negative.");
  }
  if (input.unitAmountMinor > STRIPE_MAX_AMOUNT_MINOR) {
    throw new PlanPriceMismatchError(
      input.planKey,
      `its amount exceeds the largest Stripe accepts (${STRIPE_MAX_AMOUNT_MINOR}).`,
    );
  }

  const amount = Number(input.unitAmountMinor);
  const currency = input.currency.toLowerCase();
  const productId = await ensureProduct(client, input);

  // 1. The cached id, verified rather than trusted. A Price whose amount,
  //    currency or interval no longer matches the record is a repricing, and a
  //    repricing is a new object.
  if (input.cachedPriceId !== null) {
    const cached = await retrievePrice(client, input.cachedPriceId);
    if (cached !== null && matches(cached, amount, currency, input.interval, productId)) {
      return { productId, priceId: cached.id, created: false, unchanged: true };
    }
  }

  // 2. The lookup key. Survives a cleared cache, a restored backup and a fresh
  //    environment pointed at the same Stripe account.
  const named = await client.stripe.prices.list({
    lookup_keys: [input.planKey],
    active: true,
    limit: 1,
  });
  const existing = named.data[0];
  if (existing && matches(existing, amount, currency, input.interval, productId)) {
    return { productId, priceId: existing.id, created: false, unchanged: false };
  }

  // 3. Create. `transfer_lookup_key` takes the name off whatever held it, so the
  //    old Price keeps billing the subscribers already on it and stops being
  //    the answer to "what does this plan cost now".
  const created = await client.stripe.prices.create(
    {
      product: productId,
      unit_amount: amount,
      currency,
      lookup_key: input.planKey,
      transfer_lookup_key: true,
      ...(input.interval === "once"
        ? {}
        : { recurring: { interval: input.interval } }),
      metadata: { planKey: input.planKey, tierKey: input.tierKey },
    },
    // Keyed on everything that makes the Price what it is. Two concurrent
    // requests for the same plan at the same amount replay one object; a
    // request after a genuine repricing derives a different key and creates the
    // new one, which is the behaviour a shared constant key would prevent.
    { idempotencyKey: `plan_price:${input.planKey}:${currency}:${amount}:${input.interval}` },
  );

  return { productId, priceId: created.id, created: true, unchanged: false };
}

/**
 * One Stripe Product per TIER, not per plan row.
 *
 * A tier priced monthly and yearly in two currencies is four Prices and one
 * thing the customer is buying, and Stripe's own model agrees: a Product holds
 * the name and the description, a Price holds the amount. Four Products would
 * put four "Pro"s in the dashboard and four line items in the reporting.
 */
async function ensureProduct(
  client: StripeClient,
  input: EnsurePlanPriceInput,
): Promise<string> {
  const fields = {
    name: input.name,
    ...(input.description === null ? {} : { description: input.description }),
    metadata: { tierKey: input.tierKey },
  } satisfies Stripe.ProductUpdateParams;

  if (input.cachedProductId !== null) {
    try {
      // Updated rather than merely retrieved: the record owns the name and the
      // description, so a tier renamed in `src/plans.ts` and deployed must show
      // the new name on the next invoice rather than the name it had when
      // somebody first ran the sync.
      const updated = await client.stripe.products.update(input.cachedProductId, fields);
      return updated.id;
    } catch (error) {
      // A cached id that no longer resolves — a test-mode account replaced, a
      // Product archived by hand — falls through to creation. Anything else is
      // a real failure and must not be swallowed into a duplicate Product.
      if (!isMissingResource(error)) throw error;
    }
  }

  const created = await client.stripe.products.create(fields, {
    idempotencyKey: `plan_product:${input.tierKey}`,
  });
  return created.id;
}

async function retrievePrice(
  client: StripeClient,
  priceId: string,
): Promise<Stripe.Price | null> {
  try {
    return await client.stripe.prices.retrieve(priceId);
  } catch (error) {
    if (isMissingResource(error)) return null;
    throw error;
  }
}

function matches(
  price: Stripe.Price,
  amount: number,
  currency: string,
  interval: "month" | "year" | "once",
  productId: string,
): boolean {
  if (!price.active) return false;
  if (price.unit_amount !== amount) return false;
  if (price.currency !== currency) return false;
  if (typeof price.product === "string" ? price.product !== productId : price.product.id !== productId) {
    return false;
  }
  return interval === "once"
    ? price.recurring === null
    : price.recurring?.interval === interval;
}

/**
 * Duck-typed rather than `instanceof Stripe.errors.StripeInvalidRequestError`,
 * matching `isIdempotencyConflict` in the generated checkout router: pnpm can
 * install two copies of the SDK, and `code` is a documented field on every
 * StripeError as well as on the raw API response.
 */
function isMissingResource(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "resource_missing"
  );
}

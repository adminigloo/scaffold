import type Stripe from "stripe";
import type { ProductStatus, VariantInterval } from "./schema.js";

/**
 * Decide what has to happen in Stripe for one variant. Makes no calls.
 *
 * *** STRIPE PRICES ARE IMMUTABLE. ***
 *
 * You cannot change the amount, the currency or the recurring interval of an
 * existing Price. The API does not reject the attempt — `prices.update` accepts
 * `active`, `nickname` and `metadata` and SILENTLY IGNORES everything else — so
 * a sync written as "patch the price" returns 200, writes a fresh
 * `updated_at`, logs nothing, and leaves every subscriber on the old amount
 * forever. The only correct move is to create a new Price and archive the old
 * one.
 *
 * That single fact is why this module is a PLANNER and not a client. The
 * decision — is this a product update, a new price, or nothing at all — is the
 * correctness-bearing part, and here it is a pure function over plain data that
 * a test can exercise with no Stripe account, no network and no fixtures. The
 * executor that takes a plan and calls the API is ten lines of `switch` and has
 * no judgement in it.
 *
 * Every step carries a `reason` in plain English so an admin UI can say "the
 * price changed from $19.00 to $24.00, so a new Stripe price will be created
 * and the old one archived" before anyone presses the button. Silently
 * re-creating prices is how a team discovers, at renewal, that half their
 * subscribers are on an orphaned price.
 */

/**
 * `unit_amount` is a JSON number. Our money is bigint minor units, so the
 * handoff has one place it can go wrong and this is it — mirroring
 * @adminigloo/commerce's `StripeAmountRangeError`.
 */
export class StripeAmountOutOfRangeError extends Error {
  readonly name = "StripeAmountOutOfRangeError";
  constructor(minor: bigint, variantId: string) {
    super(
      `Price ${minor} on variant "${variantId}" cannot be sent to Stripe. ` +
        `unit_amount is a JSON number, so a bigint outside ` +
        `0..${Number.MAX_SAFE_INTEGER} either loses precision on the way out ` +
        `or is rejected outright. An amount this size is a unit-conversion bug ` +
        `upstream, not a real price.`,
    );
  }
}

/** The product fields that reach Stripe. */
export interface SyncProduct {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly status: ProductStatus;
}

/** The variant fields that reach Stripe. */
export interface SyncVariant {
  readonly id: string;
  readonly priceMinor: bigint;
  readonly currency: string;
  /** NULL/absent for a one-time price. */
  readonly interval?: VariantInterval | null;
}

/**
 * What Stripe currently holds, as last read or as cached on the variant row.
 *
 * Passed in rather than fetched, for the same reason nothing here calls the
 * API: a planner that fetches cannot be tested without a network, and the
 * fetching is the boring half.
 */
export interface CachedStripeProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
}

export interface CachedStripePrice {
  readonly id: string;
  readonly unitAmountMinor: bigint;
  readonly currency: string;
  /** NULL when the cached price is one-time (`recurring` is null in Stripe). */
  readonly interval: VariantInterval | null;
}

export interface StripeCache {
  readonly product?: CachedStripeProduct | null;
  readonly price?: CachedStripePrice | null;
}

/**
 * Which immutable field forced a new price. `product` is in the list because a
 * Price's product is immutable too: a price cannot be moved to a different
 * Stripe product, so a missing product cache means the price has to be redone
 * as well.
 */
export type PriceField = "amount" | "currency" | "interval" | "product";

export type SyncStep =
  | {
      readonly action: "create-product";
      readonly reason: string;
      readonly params: Stripe.ProductCreateParams;
    }
  | {
      readonly action: "update-product";
      readonly reason: string;
      readonly productId: string;
      /** Only the fields that actually differ. */
      readonly params: Stripe.ProductUpdateParams;
    }
  | {
      readonly action: "create-price";
      readonly reason: string;
      /**
       * NULL means the `create-product` step in this same plan runs first and
       * supplies the id. Steps are in execution order, so an executor can just
       * carry the id forward — but the null is explicit rather than implied,
       * because an executor that silently posts a price with no `product` gets
       * a 400 that names nothing useful.
       */
      readonly productId: string | null;
      readonly params: Stripe.PriceCreateParams;
    }
  | {
      readonly action: "archive-price-and-create";
      readonly reason: string;
      /** `prices.update(id, { active: false })` — the ONLY legal edit. */
      readonly archivePriceId: string;
      readonly productId: string | null;
      readonly params: Stripe.PriceCreateParams;
      /** What changed, for the admin UI and for the audit line. */
      readonly changed: readonly PriceField[];
    }
  | { readonly action: "noop"; readonly reason: string };

export interface SyncPlan {
  /** In execution order. Never empty — see `isNoop`. */
  readonly steps: readonly SyncStep[];
  /**
   * Nothing to do. The plan still carries a single `noop` step rather than an
   * empty array, so a UI listing "what will happen" has something to render and
   * a caller cannot mistake "already in sync" for "the planner returned
   * nothing", which is what an empty array would look like after a bug.
   */
  readonly isNoop: boolean;
}

export interface PlanStripeSyncInput {
  readonly product: SyncProduct;
  readonly variant: SyncVariant;
  readonly cached?: StripeCache;
}

export function planStripeSync(input: PlanStripeSyncInput): SyncPlan {
  const { product, variant } = input;
  const cachedProduct = input.cached?.product ?? null;
  const cachedPrice = input.cached?.price ?? null;

  const steps: SyncStep[] = [];

  // ---- product ------------------------------------------------------------
  const wantActive = stripeActiveFor(product.status);
  const wantDescription = product.description ?? null;

  if (cachedProduct === null) {
    steps.push({
      action: "create-product",
      reason:
        `"${product.name}" has no Stripe product yet, so one is created ` +
        `first — a price has to belong to a product.`,
      params: {
        name: product.name,
        active: wantActive,
        ...(wantDescription !== null && wantDescription !== ""
          ? { description: wantDescription }
          : {}),
        // Lets a webhook, a reconciliation script or a human in the dashboard
        // get from a Stripe object back to the row that produced it. Without
        // it, test-mode and live-mode products are indistinguishable copies.
        metadata: { catalogProductId: product.id },
      },
    });
  } else {
    const params: Stripe.ProductUpdateParams = {};
    const changed: string[] = [];

    if (cachedProduct.name !== product.name) {
      params.name = product.name;
      changed.push("name");
    }
    if (cachedProduct.description !== wantDescription) {
      // The empty string is how Stripe unsets a description; the field is typed
      // `Emptyable<string>` and will not take null.
      params.description = wantDescription ?? "";
      changed.push("description");
    }
    if (cachedProduct.active !== wantActive) {
      params.active = wantActive;
      changed.push("availability");
    }

    if (changed.length > 0) {
      steps.push({
        action: "update-product",
        reason:
          `The product's ${formatList(changed)} changed. This is a plain ` +
          `update: nothing about the PRICE is affected, and no customer's ` +
          `charge changes.`,
        productId: cachedProduct.id,
        params,
      });
    }
  }

  // ---- price ---------------------------------------------------------------
  const productId = cachedProduct?.id ?? null;
  const wantCurrency = normaliseCurrency(variant.currency);
  const wantInterval = variant.interval ?? null;
  const priceParams = buildPriceParams(product, variant, productId, wantCurrency, wantInterval);

  if (cachedPrice === null) {
    steps.push({
      action: "create-price",
      reason:
        `No Stripe price is cached for this variant, so one is created. ` +
        `Nothing is archived, because there is nothing to archive.`,
      productId,
      params: priceParams,
    });
  } else {
    const changed: PriceField[] = [];
    if (cachedPrice.unitAmountMinor !== variant.priceMinor) changed.push("amount");
    // Compared on the NORMALISED value. A case-sensitive compare treats a
    // hand-typed 'USD' as different from Stripe's 'usd' and archives and
    // re-creates the price on every single sync run — a new Stripe price per
    // run, each one orphaning the last, and subscriptions scattered across all
    // of them.
    if (normaliseCurrency(cachedPrice.currency) !== wantCurrency) changed.push("currency");
    if (cachedPrice.interval !== wantInterval) changed.push("interval");
    // A price's product is immutable as well, so a price we cannot tie to a
    // known Stripe product cannot be kept.
    if (productId === null) changed.push("product");

    if (changed.length > 0) {
      steps.push({
        action: "archive-price-and-create",
        reason:
          `The ${formatList(changed.map(priceFieldLabel))} changed, and a Stripe price is ` +
          `immutable — the API accepts an update and ignores those fields ` +
          `without erroring. So a new price is created and ${cachedPrice.id} ` +
          `is archived. Existing subscriptions stay on the old price and keep ` +
          `renewing at the old amount until they are explicitly migrated; ` +
          `new checkouts use the new one.`,
        archivePriceId: cachedPrice.id,
        productId,
        params: priceParams,
        changed,
      });
    }
  }

  if (steps.length === 0) {
    return {
      steps: [
        {
          action: "noop",
          reason:
            "Stripe already matches this variant: same name, same amount, " +
            "same currency, same interval. Nothing is created or archived.",
        },
      ],
      isNoop: true,
    };
  }

  return { steps, isNoop: false };
}

/**
 * Whether Stripe should consider the product purchasable.
 *
 * `draft` maps to ACTIVE in Stripe, deliberately. Draft is our concept, not
 * Stripe's: what makes a draft unbuyable is that our own checkout builds its
 * line items from this catalog and filters on `status`, so a draft never
 * reaches a session. Mapping draft to inactive instead would mean every
 * publish needs a Stripe round trip that can fail — and Stripe refuses to
 * create a price against an archived product, so the sync would have to
 * un-archive, create and re-archive in the right order or leave the product
 * half-synced.
 *
 * `archived` DOES reach Stripe, because an archived product's prices may
 * already be sitting in a payment link somebody pasted into Slack, and our own
 * status column cannot stop that one.
 */
function stripeActiveFor(status: ProductStatus): boolean {
  return status !== "archived";
}

function buildPriceParams(
  product: SyncProduct,
  variant: SyncVariant,
  productId: string | null,
  currency: string,
  interval: VariantInterval | null,
): Stripe.PriceCreateParams {
  return {
    currency,
    // NO CONVERSION. `priceMinor` is minor units and Stripe's `unit_amount` is
    // minor units, so the value passes through unchanged. That is what makes
    // zero-decimal currencies work: for JPY the minor unit IS the yen, and a
    // "× 100 to get cents" step here charges every Japanese customer a
    // hundredfold.
    unit_amount: toStripeAmount(variant.priceMinor, variant.id),
    ...(productId !== null ? { product: productId } : {}),
    ...(interval !== null ? { recurring: { interval } } : {}),
    metadata: {
      catalogProductId: product.id,
      catalogVariantId: variant.id,
    },
  };
}

function toStripeAmount(minor: bigint, variantId: string): number {
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StripeAmountOutOfRangeError(minor, variantId);
  }
  return Number(minor);
}

/** Stripe's spelling, and `product_variants.currency`'s: trimmed, lowercase. */
function normaliseCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}

/**
 * `changed` is machine-readable; the reason string is not. "product" on its own
 * would read as "the product changed", which points an admin at the wrong
 * thing — what changed is which Stripe product the price hangs off.
 */
function priceFieldLabel(field: PriceField | string): string {
  return field === "product" ? "Stripe product it belongs to" : field;
}

/** "amount", "amount and currency", "amount, currency and interval". */
function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

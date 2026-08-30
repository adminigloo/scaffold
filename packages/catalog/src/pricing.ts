/**
 * Display maths for the catalog. No database, no network, no Stripe.
 *
 * EVERY AMOUNT IS A bigint IN MINOR UNITS, matching @adminigloo/commerce. Not a
 * number, not a decimal string, not "dollars with two places". The conversion
 * to something a human reads happens exactly once, here, at the very end — and
 * it happens without the value ever passing through a `number`.
 */

/**
 * The shape `defaultVariant` and `priceRange` need, and nothing more.
 *
 * Structural rather than the Drizzle row type on purpose: these functions run
 * in a React component rendering a price, and importing the row type would put
 * `./schema.js` — and therefore drizzle-orm/pg-core — on the barrel's import
 * graph. It also means an unsaved variant in a builder form, which has no id
 * and no timestamps yet, can be priced with the same code that prices a saved
 * one.
 */
export interface VariantPricing {
  readonly priceMinor: bigint;
  readonly isDefault?: boolean;
}

export interface PriceRange {
  readonly min: bigint;
  readonly max: bigint;
  /**
   * Every variant costs the same, so the UI renders "$12" rather than
   * "from $12". A caller computing this itself as `min === max` is fine until
   * one of them starts comparing formatted strings, at which point "$12.00" and
   * "$12" disagree.
   */
  readonly single: boolean;
}

/**
 * A bigint amount in minor units, as a human-readable currency string.
 *
 * THE VALUE NEVER BECOMES A NUMBER. The obvious implementation —
 * `Number(amountMinor) / 100` — is wrong twice over:
 *
 *   1. It loses precision above 2^53. Unreachable for one card game order, and
 *      immediately reachable for a tenant's annual revenue in a zero-decimal
 *      currency, which is the same bigint flowing through the same function.
 *   2. THE 100 IS WRONG FOR SOME CURRENCIES. JPY has no minor unit at all: the
 *      minor unit IS the yen, so 1000 minor units is ¥1,000 and dividing by a
 *      hundred renders it as ¥10. That is the classic bug, it renders a
 *      hundredfold error as a plausible price, and it is silent. BHD and KWD go
 *      the other way with three decimal places.
 *
 * So the exponent comes from CLDR via `Intl`, the split is done in bigint
 * arithmetic, and `Intl` is asked to format only the MAJOR part — the fraction
 * digits are then substituted into the parts it produced. Going through
 * `formatToParts` rather than a string replace is what keeps it locale-correct:
 * the decimal separator is "," in most of Europe, and the currency symbol is a
 * suffix in some locales and a prefix in others.
 *
 * Throws `RangeError` (from Intl) on a currency code that is not three letters.
 * Deliberately not caught: a bad code is a bug in the catalog row, and
 * swallowing it renders an amount with no currency at all, which is worse than
 * a stack trace.
 */
export function formatMinor(
  amountMinor: bigint,
  currency: string,
  locale?: string,
): string {
  // Our columns store Stripe's lowercase form; Intl canonicalises anyway, but
  // being explicit means a hand-entered "USD" and a stored "usd" cannot format
  // differently.
  const code = currency.trim().toUpperCase();

  // Ask CLDR how many minor digits this currency actually has, BEFORE pinning
  // the fraction digits below. `minimumFractionDigits` rather than the maximum
  // because it is the count the currency is always written with: JPY 0, USD 2,
  // BHD 3.
  const resolved = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
  }).resolvedOptions();
  // Both fields are optional in the type because ECMA-402 only guarantees them
  // for some styles. For `style: "currency"` they are always populated from
  // CLDR; the final `2` is the CLDR default for an unknown code and exists so
  // an engine that omits them renders a price rather than `NaN`.
  const digits =
    resolved.minimumFractionDigits ?? resolved.maximumFractionDigits ?? 2;

  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const divisor = 10n ** BigInt(digits);
  const major = abs / divisor;
  // Left-padded, because 5 remaining cents is ".05" and not ".5". Empty for a
  // zero-decimal currency, where there is no fraction part to substitute into.
  const fraction =
    digits === 0 ? "" : (abs % divisor).toString().padStart(digits, "0");

  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  const parts = formatter.formatToParts(negative ? -major : major);

  let out = "";
  for (const part of parts) {
    out += part.type === "fraction" ? fraction : part.value;
  }

  // -50 cents has a major part of 0, and `-0n` is `0n`, so Intl saw a positive
  // zero and emitted no sign. Without this the UI shows a 50-cent refund as a
  // 50-cent charge. The sign character is taken from the formatter rather than
  // hardcoded as "-", because several locales use U+2212 MINUS SIGN.
  if (negative && !parts.some((p) => p.type === "minusSign")) {
    out = minusSignFor(formatter) + out;
  }

  return out;
}

/**
 * The variant a product page should select when it opens.
 *
 * The order is: the one flagged `isDefault`, else the cheapest, else the first.
 * TOTAL AND DETERMINISTIC — it never throws and never returns a different
 * answer for the same input, because the alternative is a product page that
 * preselects a different variant on the server than it does on the client and
 * hydrates into the wrong price.
 *
 * THE TIEBREAK IS INPUT ORDER, in both branches. Two variants flagged default
 * is a validation problem (`multiple-default-variants`) and this function still
 * has to answer, so it takes the first flagged one. Two variants at the same
 * lowest price is perfectly legal — a red and a blue deck at £19 — and it takes
 * whichever the caller listed first. Callers that want that to mean something
 * should sort by `sortOrder` before calling; sorting in here would silently
 * override a hand-arranged order.
 *
 * Generic in the caller's row type so the answer is the caller's own object,
 * not a copy: a page needs the variant's id and name, and re-finding it by
 * price is how the wrong one ends up in the cart.
 */
export function defaultVariant<T extends VariantPricing>(
  variants: readonly T[],
): T | undefined {
  let cheapest: T | undefined;

  for (const variant of variants) {
    if (variant.isDefault === true) return variant;
    // Strictly less-than, so an equal price leaves the earlier one in place.
    if (cheapest === undefined || variant.priceMinor < cheapest.priceMinor) {
      cheapest = variant;
    }
  }

  return cheapest;
}

/**
 * The cheapest and dearest price across a product's variants, for "from $12".
 *
 * Returns null for a product with no variants rather than a zero range. A range
 * of 0..0 renders as "Free", which is a specific and wrong claim about a
 * product that simply has no price yet — and an active product with no variants
 * is already reported by `validateProduct`.
 *
 * Says nothing about currency, deliberately. Mixing currencies inside one
 * product is a validation problem, not something to paper over here by picking
 * one; a caller formatting this range must take the currency from a variant it
 * has already validated.
 */
export function priceRange(variants: readonly VariantPricing[]): PriceRange | null {
  const first = variants[0];
  if (first === undefined) return null;

  let min = first.priceMinor;
  let max = first.priceMinor;

  for (const variant of variants) {
    if (variant.priceMinor < min) min = variant.priceMinor;
    if (variant.priceMinor > max) max = variant.priceMinor;
  }

  return { min, max, single: min === max };
}

function minusSignFor(formatter: Intl.NumberFormat): string {
  const sign = formatter
    .formatToParts(-1n)
    .find((part) => part.type === "minusSign");
  return sign ? sign.value : "-";
}

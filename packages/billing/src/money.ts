/**
 * Plan prices as people read them (billing 0.6).
 *
 * HERE AS WELL AS IN @adminigloo/catalog, on purpose. A project that sells
 * plans and no products (`--model subscription`) installs billing and stripe
 * and nothing of the shop, and every screen that shows a plan's price needs
 * this. The two are the same rules: the value never becomes a number, and the
 * number of decimals comes from CLDR (JPY none, USD two, BHD three), so 1000
 * yen is ¥1,000 and never ¥10.
 */

/**
 * A bigint amount in minor units, as a currency string: `500n, "usd"` is
 * "$5.00". Every decimal the currency has, always — for a total, an invoice
 * line or a refund. Throws `RangeError` (from Intl) on a currency code that
 * isn't three letters.
 */
export function formatMinor(amountMinor: bigint, currency: string, locale?: string): string {
  return format(amountMinor, currency, locale, false);
}

/**
 * A PRICE on a plans page: whole units when there's nothing after the point.
 * `1000n, "usd"` is "$10", `1250n` is "$12.50", `0n` is "$0" (the page says
 * "Free" for a free tier itself). "$10.00/mo" reads like an invoice; "$10/mo"
 * is how a price is written.
 */
export function formatPrice(amountMinor: bigint, currency: string, locale?: string): string {
  return format(amountMinor, currency, locale, true);
}

function format(amountMinor: bigint, currency: string, locale: string | undefined, trimWhole: boolean): string {
  const code = currency.trim().toUpperCase();
  const resolved = new Intl.NumberFormat(locale, { style: "currency", currency: code }).resolvedOptions();
  const digits = resolved.minimumFractionDigits ?? resolved.maximumFractionDigits ?? 2;

  const negative = amountMinor < 0n;
  const abs = negative ? -amountMinor : amountMinor;
  const divisor = 10n ** BigInt(digits);
  const major = abs / divisor;
  const remainder = abs % divisor;
  // Whole units: no fraction digits at all, so "$10" rather than "$10.00".
  const shown = trimWhole && remainder === 0n ? 0 : digits;
  const fraction = shown === 0 ? "" : remainder.toString().padStart(digits, "0");

  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: shown,
    maximumFractionDigits: shown,
  });
  const parts = formatter.formatToParts(negative ? -major : major);
  let out = "";
  for (const part of parts) out += part.type === "fraction" ? fraction : part.value;
  // -50 cents has a major part of 0 and `-0n` is `0n`: Intl saw a positive zero.
  if (negative && !parts.some((part) => part.type === "minusSign")) {
    const sign = formatter.formatToParts(-1n).find((part) => part.type === "minusSign");
    out = (sign ? sign.value : "-") + out;
  }
  return out;
}

/**
 * Money on the store's screens: minor units (cents) in, words out — and the
 * owner's typed price ("12.50") in, minor units out, by string arithmetic
 * (never floating point: 0.1 + 0.2 is not 0.3, and a price is not a guess).
 */

/** How many minor units a currency has after the point (2 for dollars, 0 for yen). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatMoney(minor: number, currency: string, locale = "en-US"): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(minor / 10 ** currencyDigits(currency));
  } catch {
    return `${minor} ${currency.toUpperCase()}`;
  }
}

/** "12.5" → 1250 (USD); "1,200" → null (a comma is ambiguous); "" → null. */
export function parseMoneyInput(text: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  const clean = text.trim().replace(/^[$€£¥]/, "").trim();
  const match = (digits === 0 ? /^(\d{1,9})$/ : /^(\d{1,9})(?:\.(\d{1,4}))?$/).exec(clean);
  if (!match || (match[2] ?? "").length > digits) return null;
  const whole = Number(match[1]);
  const fraction = digits === 0 ? 0 : Number((match[2] ?? "").padEnd(digits, "0") || "0");
  const minor = whole * 10 ** digits + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** 1250 → "12.50", for the price box. */
export function moneyInputValue(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (digits === 0) return String(minor);
  const whole = Math.floor(minor / 10 ** digits);
  const fraction = String(minor % 10 ** digits).padStart(digits, "0");
  return `${whole}.${fraction}`;
}

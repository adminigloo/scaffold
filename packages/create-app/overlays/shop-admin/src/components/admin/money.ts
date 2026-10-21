/**
 * Money in, money out. The one place a typed amount becomes a bigint.
 *
 * A PLAIN `.ts` MODULE, not part of VariantEditor.tsx, for two concrete
 * reasons:
 *
 *   1. A server component seeds the form with `minorToMajorInput`. Every export
 *      of a `"use client"` module is a client reference, and calling one on the
 *      server throws — so the conversion cannot live behind that boundary.
 *   2. tsconfig sets `jsx: "preserve"` (Next compiles JSX itself), and esbuild
 *      refuses to transform a `.tsx` file under that setting. A unit test
 *      importing these functions out of a component file fails to parse before
 *      it runs a single assertion, so the one thing in the builder that turns a
 *      keystroke into a charge would be the one thing untested.
 */

/**
 * `unit_amount` in Stripe is a JSON number, so anything above
 * `Number.MAX_SAFE_INTEGER` either loses precision on the way out or is
 * rejected outright — see `StripeAmountOutOfRangeError`. Refusing it at the
 * keyboard means the admin gets a sentence instead of a failed sync three steps
 * later.
 */
const MAX_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

export type MoneyProblemCode =
  | "empty"
  | "not-a-number"
  | "comma-decimal"
  | "too-many-decimals"
  | "negative"
  | "too-large"
  | "unknown-currency";

export type MoneyParse =
  | { readonly ok: true; readonly minor: bigint }
  | { readonly ok: false; readonly code: MoneyProblemCode; readonly message: string };

/**
 * How many decimal places this currency is written with, from CLDR.
 *
 * NOT a hardcoded 2. JPY has no minor unit at all — the minor unit IS the yen —
 * so "1000" is ¥1,000 and a `× 100` here charges a hundredfold. BHD and KWD go
 * the other way with three. Same source `formatMinor` reads, so the field the
 * admin types into and the price the customer sees cannot disagree.
 *
 * Returns null rather than throwing for a code Intl refuses, because the caller
 * is a text input someone is halfway through typing into.
 */
export function minorUnitDigits(currency: string): number | null {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Za-z]{3}$/.test(code)) return null;
  try {
    const resolved = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
    }).resolvedOptions();
    // Both fields are optional in the type because ECMA-402 only guarantees
    // them for some styles; for `style: "currency"` they are always populated.
    // The final 2 is CLDR's default for an unknown code.
    return resolved.minimumFractionDigits ?? resolved.maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
}

/** Digits, a single dot, digits. No sign, no grouping, no currency symbol. */
const MONEY_PATTERN = /^(\d+)(?:\.(\d*))?$/;

/**
 * Turn what the admin typed into minor units, or say why it cannot be.
 *
 * THIS IS THE ONLY PLACE THE CONVERSION HAPPENS. Never `Number(input) * 100`:
 * that is wrong for JPY (no minor unit), wrong for BHD (three places), and
 * wrong for "0.07" in binary floating point, where `0.07 * 100` is
 * 7.000000000000001 and `Math.round` only hides it until the amount is bigger.
 * The digits are counted as TEXT and concatenated, so no float is ever
 * involved.
 *
 * "12.99" -> 1299n. "12.9" -> 1290n. "12" -> 1200n. "12." -> 1200n.
 * "12.999" -> refused, because a third of a cent is not an amount anyone can be
 * charged and silently rounding it changes the price the admin agreed to.
 * "" -> refused: an empty price field is unfinished, and treating it as free is
 * how a paid product ships at zero.
 */
export function parseMoneyInput(raw: string, currency: string): MoneyParse {
  const digits = minorUnitDigits(currency);
  if (digits === null) {
    return {
      ok: false,
      code: "unknown-currency",
      message: `"${currency}" is not a three-letter currency code, so there is no way to know how many decimal places this price has.`,
    };
  }

  const text = raw.trim();

  if (text === "") {
    return {
      ok: false,
      code: "empty",
      message: "Enter a price. Free is 0 — blank is unfinished.",
    };
  }

  if (text.startsWith("-")) {
    return {
      ok: false,
      code: "negative",
      message:
        "A price cannot be negative. Free is 0; a negative amount is a discount, which belongs on a discount code rather than on a product.",
    };
  }

  if (text.includes(",")) {
    // Refused rather than guessed. "1,5" is one and a half in most of Europe
    // and fifteen with the comma read as grouping, and picking wrong is a
    // tenfold pricing error that looks entirely plausible in the table.
    return {
      ok: false,
      code: "comma-decimal",
      message: 'Use a dot for the decimal point and no thousands separators — "1234.50", not "1,234.50".',
    };
  }

  const match = MONEY_PATTERN.exec(text);
  if (!match) {
    return {
      ok: false,
      code: "not-a-number",
      message: `"${raw}" is not an amount. Digits and at most one dot, with no currency symbol.`,
    };
  }

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";

  if (fraction.length > digits) {
    return {
      ok: false,
      code: "too-many-decimals",
      message:
        digits === 0
          ? `${currency.toUpperCase()} has no minor unit, so it takes whole numbers only — "${text}" cannot be charged.`
          : `${currency.toUpperCase()} is written with ${digits} decimal place${digits === 1 ? "" : "s"}, so "${text}" is not an amount that can be charged.`,
    };
  }

  // Concatenated as text, then parsed once. `BigInt("1299")` is exact for any
  // length of input, which is the whole reason the value never becomes a
  // number on the way through.
  const minor = BigInt(whole + fraction.padEnd(digits, "0"));

  if (minor > MAX_MINOR) {
    return {
      ok: false,
      code: "too-large",
      message: `That is larger than Stripe can accept as a unit amount (${MAX_MINOR} minor units). An amount this size is usually a unit-conversion mistake rather than a real price.`,
    };
  }

  return { ok: true, minor };
}

/**
 * The inverse, for seeding the input field. Plain and un-localised on purpose:
 * this string goes back into a text box that `parseMoneyInput` reads, and it
 * only understands a dot. The pretty version is `formatMinor`, which is what
 * every DISPLAYED price uses.
 */
export function minorToMajorInput(minor: bigint, currency: string): string {
  const digits = minorUnitDigits(currency) ?? 2;
  if (digits === 0) return minor.toString();
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const divisor = 10n ** BigInt(digits);
  const whole = (abs / divisor).toString();
  // Left-padded: 5 remaining cents is ".05", not ".5".
  const fraction = (abs % divisor).toString().padStart(digits, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Stock, or "untracked".
 *
 * NULL MEANS UNTRACKED, 0 MEANS SOLD OUT, and they are different answers the UI
 * does different things with. A blank box is untracked — collapsing it to 0
 * would make every digital product in the catalog read as sold out.
 */
export function parseInventoryInput(
  raw: string,
): { readonly ok: true; readonly value: number | null } | { readonly ok: false; readonly message: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      message: "Stock is a whole number, or blank for untracked. 0 means sold out.",
    };
  }
  return { ok: true, value: Number(text) };
}


import type { InvoiceStatusWire, MoneyFormatWire, PaymentMethodWire } from "./types.js";

/**
 * Money and dates as a person reads and types them. A person types dollars
 * and a percent; the wire carries cents and basis points. The conversion is
 * `Math.round`, and a value that isn't a number is refused HERE, before
 * anything is sent: "twelve" must never reach the server as 0.
 */

export const DEFAULT_FORMAT: MoneyFormatWire = { currency: "USD", locale: "en-US", timeZone: "UTC" };

/** Cents as money in the business's currency and locale ("$1,234.56"). */
export function formatMoney(cents: number, format: MoneyFormatWire = DEFAULT_FORMAT, locale?: string): string {
  const value = Number.isFinite(cents) ? cents / 100 : 0;
  try {
    return new Intl.NumberFormat(locale ?? format.locale, { style: "currency", currency: format.currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${format.currency}`;
  }
}

/** An instant as a date in the business's zone ("Nov 2, 2026"). Bad input → "". */
export function formatDate(instant: string | null | undefined, format: MoneyFormatWire = DEFAULT_FORMAT, locale?: string): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale ?? format.locale, { timeZone: format.timeZone, dateStyle: "medium" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export type Parsed = { ok: true; value: number } | { ok: false; message: string };

/**
 * "1,234.56", "$12", "12.5" → cents. Commas and a leading currency sign are
 * allowed; anything else that isn't a plain non-negative number is refused
 * with a sentence for the field.
 */
export function parseDollars(text: string, options: { allowZero?: boolean } = {}): Parsed {
  const cleaned = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
  if (cleaned === "") return { ok: false, message: "Enter an amount." };
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return { ok: false, message: "Enter an amount in dollars, like 125 or 125.50." };
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents)) return { ok: false, message: "Enter an amount in dollars, like 125 or 125.50." };
  if (cents === 0 && options.allowZero === false) return { ok: false, message: "Enter an amount above zero." };
  if (cents > 100_000_000_000) return { ok: false, message: "That's too much for one invoice." };
  return { ok: true, value: cents };
}

/** "8.25" or "8.25%" → 825 basis points. Empty → 0. */
export function parsePercent(text: string): Parsed {
  const cleaned = text.trim().replace(/%$/, "").trim();
  if (cleaned === "") return { ok: true, value: 0 };
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return { ok: false, message: "Enter a percent, like 8.25." };
  const bp = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(bp) || bp > 1_000_000) return { ok: false, message: "Enter a percent, like 8.25." };
  return { ok: true, value: bp };
}

/** A whole quantity, at least 1. */
export function parseQuantity(text: string): Parsed {
  const cleaned = text.trim();
  if (!/^\d+$/.test(cleaned)) return { ok: false, message: "Use a whole number, like 1 or 3." };
  const n = Number(cleaned);
  if (n < 1) return { ok: false, message: "At least 1." };
  if (n > 100_000) return { ok: false, message: "That's too many." };
  return { ok: true, value: n };
}

/** Cents as the text of a dollars input ("125.50"). */
export function dollarsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Basis points as a percent people read: 825 → "8.25%", 800 → "8%". */
export function percentText(bp: number): string {
  const value = bp / 100;
  return `${Number.isInteger(value) ? value.toFixed(0) : String(Number(value.toFixed(2)))}%`;
}

export const STATUS_WORDS: Readonly<Record<InvoiceStatusWire, string>> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  partial: "Partly paid",
  paid: "Paid",
  void: "Void",
  overdue: "Overdue",
};

export const STATUS_TONE: Readonly<Record<InvoiceStatusWire, "ok" | "warn" | "danger" | "accent" | "muted">> = {
  draft: "muted",
  sent: "accent",
  viewed: "accent",
  partial: "warn",
  paid: "ok",
  void: "muted",
  overdue: "danger",
};

export const METHOD_WORDS: Readonly<Record<PaymentMethodWire, string>> = {
  card: "Card",
  cash: "Cash",
  check: "Check",
  ach: "Bank transfer",
  other: "Other",
};

/** How a note can already name each method, at its start ("Check #1042" names a check). */
const METHOD_NAMES: Readonly<Record<PaymentMethodWire, readonly string[]>> = {
  card: ["card", "credit card", "debit card"],
  cash: ["cash"],
  check: ["check", "cheque", "chk"],
  ach: ["bank transfer", "ach"],
  other: ["other"],
};

/**
 * A payment's method and its note on one line, never saying the method twice
 * (polish 3): a note that already starts with the method reads alone —
 * "Check #1042", not "Check · Check #1042" — and any other note follows the
 * method: "Cash · Paid at the door". No note: the method alone.
 */
export function paymentWords(method: PaymentMethodWire, reference: string | null | undefined): string {
  const word = METHOD_WORDS[method] ?? METHOD_WORDS.other;
  const note = (reference ?? "").trim();
  if (note === "") return word;
  const lower = note.toLowerCase();
  const names = [word.toLowerCase(), ...(METHOD_NAMES[method] ?? [])];
  const named = names.some((name) => lower.startsWith(name) && !/[a-z0-9]/.test(lower.charAt(name.length)));
  return named ? note : `${word} · ${note}`;
}

/** The move a staff member picks, in words. */
export const MOVE_WORDS: Readonly<Record<"draft" | "sent" | "viewed" | "void", string>> = {
  draft: "Back to draft",
  sent: "Mark as sent",
  viewed: "Mark as viewed",
  void: "Void",
};

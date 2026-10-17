import { DEFAULT_INVOICING_DETAILS, type InvoicingDetails } from "./settings.js";
import type { MoneyFormatWire } from "./wire.js";

/**
 * The business on an invoice (Tenancy 2a, 10.4): the company's basics (from
 * the host's company profile) and its invoice details (from the settings
 * fragment). Declared here, structurally (D4): invoicing never imports
 * tenancy. In a companies project the generated wiring maps
 * `companyProfile(id)` plus `readInvoicingDetails(profile.settings.invoicing)`;
 * a single business passes constants.
 */
export interface InvoicingBusiness extends InvoicingDetails {
  readonly name: string;
  readonly timeZone: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  /** ISO 4217, default "USD"; BCP 47, default "en-US". */
  readonly currency?: string;
  readonly locale?: string;
}

/** The business with every gap filled: what the handlers and the email actually use. */
export interface ResolvedInvoicingBusiness extends Required<InvoicingDetails> {
  readonly name: string;
  readonly timeZone: string;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly currency: string;
  readonly locale: string;
}

function validZone(zone: string | null | undefined): string | null {
  if (typeof zone !== "string" || zone.trim() === "") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return null;
  }
}

function validCurrency(currency: string | undefined): string {
  if (typeof currency !== "string" || !/^[A-Za-z]{3}$/.test(currency)) return "USD";
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(0);
    return currency.toUpperCase();
  } catch {
    return "USD";
  }
}

function validLocale(locale: string | undefined): string {
  if (typeof locale !== "string" || locale.trim() === "") return "en-US";
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? "en-US";
  } catch {
    return "en-US";
  }
}

/**
 * Fill the gaps: without a business (no seam, or it answered null) the name
 * is "", the zone UTC, USD in en-US, and the fragment's defaults. A zone,
 * currency or locale the runtime can't use falls back the same way, so a
 * typo in a profile can never throw out of `Intl` in the middle of a request.
 */
export function resolveInvoicingBusiness(business: InvoicingBusiness | null | undefined): ResolvedInvoicingBusiness {
  const b = business ?? null;
  const dueDays =
    typeof b?.dueDays === "number" && Number.isInteger(b.dueDays) && b.dueDays >= 0 && b.dueDays <= 365
      ? b.dueDays
      : DEFAULT_INVOICING_DETAILS.dueDays;
  return {
    name: typeof b?.name === "string" ? b.name : "",
    timeZone: validZone(b?.timeZone) ?? "UTC",
    contactEmail: b?.contactEmail ?? null,
    contactPhone: b?.contactPhone ?? null,
    logoUrl: b?.logoUrl ?? null,
    brandColor: b?.brandColor ?? null,
    currency: validCurrency(b?.currency),
    locale: validLocale(b?.locale),
    paymentInstructions: b?.paymentInstructions ?? null,
    dueDays,
    footer: b?.footer ?? null,
    depositPercent:
      typeof b?.depositPercent === "number" && Number.isInteger(b.depositPercent) && b.depositPercent >= 0 && b.depositPercent <= 100
        ? b.depositPercent
        : 0,
    allowPartialPayments: b?.allowPartialPayments === true,
  };
}

export function moneyFormatOf(business: ResolvedInvoicingBusiness): MoneyFormatWire {
  return { currency: business.currency, locale: business.locale, timeZone: business.timeZone };
}

// --- Dates in the business's zone ----------------------------------------------
// Code does the maths: the widget sends a calendar date, the server decides
// the instant, in the zone of the business that issues the invoice.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is "YYYY-MM-DD" a real calendar date (not Feb 30)? */
export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The zone's UTC offset at `instant`, in ms (local wall clock minus UTC). */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return wall - (instant - (((instant % 1000) + 1000) % 1000));
}

/** The instant a wall-clock moment (date + ms into the day) happens in `timeZone`. */
function wallClockInstant(date: string, msIntoDay: number, timeZone: string): Date {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`not a date: ${date}`);
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + msIntoDay;
  // Two passes: the offset at the first guess can differ from the offset at
  // the answer when the guess lands on the other side of a DST change.
  const first = local - offsetMs(local, timeZone);
  return new Date(local - offsetMs(first, timeZone));
}

/** 23:59:59.999 of `date` in `timeZone`: the last moment an invoice due that day is still on time. */
export function endOfDayInZone(date: string, timeZone: string): Date {
  return wallClockInstant(date, 24 * 3_600_000 - 1, timeZone);
}

/** Today's calendar date in `timeZone`, "YYYY-MM-DD". */
export function todayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDays(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`not a date: ${date}`);
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return next.toISOString().slice(0, 10);
}

/**
 * When a new invoice is due: the end of the given calendar date in the
 * business's zone, or, with no date, today there plus the business's usual
 * `dueDays`, at the same end-of-day moment.
 */
export function invoiceDueInstant(dueDate: string | null | undefined, business: ResolvedInvoicingBusiness, now: Date): Date {
  const date = dueDate ?? addDays(todayInZone(now, business.timeZone), business.dueDays);
  return endOfDayInZone(date, business.timeZone);
}

/** A due date as a customer reads it, in the business's zone and locale: "Nov 2, 2026". */
export function formatDueDate(instant: Date, business: ResolvedInvoicingBusiness): string {
  try {
    return new Intl.DateTimeFormat(business.locale, { timeZone: business.timeZone, dateStyle: "medium" }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** Cents as money in the business's currency and locale. */
export function formatMoney(cents: number, business: Pick<ResolvedInvoicingBusiness, "currency" | "locale">): string {
  try {
    return new Intl.NumberFormat(business.locale, { style: "currency", currency: business.currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${business.currency}`;
  }
}

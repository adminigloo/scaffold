import { z } from "zod";

/**
 * RECORDING HISTORY WITH ITS REAL DATES (invoicing 0.7): a business moving
 * its past invoices and payments in enters each one with the day it really happened. Staff
 * and server paths only — no public route takes a date.
 *
 * The rules, the same in every package that takes a past date: a real date,
 * not in the future, not before 2000
 * (a typo, never a record), and never before the record it belongs to. The
 * row keeps WHEN it happened (its usual dates) and, beside them, when and by
 * whom it was entered (`entered_at`, `entered_by`), so nobody mistakes an
 * import for something done on that day.
 *
 * A DAY IS THE COMPANY'S DAY. "2025-06-14" means that calendar day where the
 * business is (`timeZone`), not midnight in London: it is saved as noon there
 * (so every screen in that zone shows the 14th), "today" is today there (a
 * morning entry in Tokyo is not "in the future"), and the 14th is never moved
 * before the record it belongs to or past the moment it was typed in. A full
 * timestamp ("2025-06-14T15:00:00Z") is taken as the instant it names.
 */
export const HISTORY_EARLIEST = new Date(Date.UTC(2000, 0, 1));

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NOT_A_DATE = "Enter the date it happened, like 2025-06-14.";
const IN_THE_FUTURE = "That date is in the future. Enter the day it really happened.";
const BEFORE_2000 = "That date is before 2000. Check the year.";

function usableZone(zone: string | null | undefined): string {
  if (typeof zone !== "string" || zone.trim() === "") return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    return zone;
  } catch {
    return "UTC";
  }
}

/** The calendar day of `instant` in `zone`, "YYYY-MM-DD". */
function dayIn(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The zone's offset from UTC at `instantMs`, in ms. */
function offsetMs(instantMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return wall - (instantMs - (((instantMs % 1000) + 1000) % 1000));
}

/** Noon of calendar day `day` in `zone` (two passes, for a day a DST change falls on). */
function noonIn(day: string, zone: string): Date {
  const m = DATE_ONLY.exec(day)!;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const first = local - offsetMs(local, zone);
  return new Date(local - offsetMs(first, zone));
}

function isCalendarDay(day: string): boolean {
  const m = DATE_ONLY.exec(day);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

type NotBefore = { readonly at: Date; readonly what: string } | null | undefined;

/** The instant a past date names, or the sentence that refuses it. */
function readHistoryDate(value: unknown, now: Date, notBefore: NotBefore, timeZone: string | null | undefined): Date | string {
  const zone = usableZone(timeZone);
  const tooEarly = notBefore ? `That's before ${notBefore.what} (${dayIn(notBefore.at, zone)}).` : "That's too early.";
  if (typeof value === "string" && DATE_ONLY.test(value.trim())) {
    // A calendar day, judged as days in the company's zone.
    const day = value.trim();
    if (!isCalendarDay(day)) return NOT_A_DATE;
    if (day > dayIn(now, zone)) return IN_THE_FUTURE;
    if (day < "2000-01-01") return BEFORE_2000;
    if (notBefore && day < dayIn(notBefore.at, zone)) return tooEarly;
    let at = noonIn(day, zone);
    // Today before noon is "now", and the day the record began is never
    // stamped before the record itself: both stay on the same calendar day.
    if (at.getTime() > now.getTime()) at = new Date(now.getTime());
    if (notBefore && at.getTime() < notBefore.at.getTime()) at = new Date(notBefore.at.getTime());
    return at;
  }
  const parsed = z.coerce.date().safeParse(value);
  if (!parsed.success || Number.isNaN(parsed.data.getTime())) return NOT_A_DATE;
  const at = parsed.data;
  if (at.getTime() > now.getTime()) return IN_THE_FUTURE;
  if (at.getTime() < HISTORY_EARLIEST.getTime()) return BEFORE_2000;
  if (notBefore && at.getTime() < notBefore.at.getTime()) return tooEarly;
  return at;
}

/**
 * The zod type for a past date entered from records, checked against `now`
 * (and `notBefore`, the record it belongs to, when given). Takes a Date or an
 * ISO string ("2025-06-14", a day in `timeZone` — the company's, UTC when not
 * given — or "2025-06-14T15:00:00Z", that instant).
 */
export function historyDateSchema(now: Date, notBefore?: NotBefore, timeZone?: string | null) {
  return z.unknown().transform((value, ctx): Date => {
    const read = readHistoryDate(value, now, notBefore, timeZone);
    if (typeof read === "string") {
      ctx.addIssue({ code: "custom", message: read });
      return z.NEVER;
    }
    return read;
  });
}

/** Parse a past date for `field`, throwing the ZodError the handlers already answer as 400 `invalid` with that field named. */
export function parseHistoryDate(
  value: unknown,
  now: Date,
  field: string,
  notBefore?: NotBefore,
  timeZone?: string | null,
): Date {
  const parsed = historyDateSchema(now, notBefore, timeZone).safeParse(value);
  if (parsed.success) return parsed.data;
  throw new z.ZodError(parsed.error.issues.map((issue) => ({ ...issue, path: [field, ...issue.path] })));
}

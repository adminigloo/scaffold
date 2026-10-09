/** Small pure helpers shared by every builder. No Node APIs: these run on the edge too. */

export type DateInput = Date | string | number;

/** Collapse runs of whitespace (newlines included) to one space and trim. */
export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)? ?([Zz]|[+-]\d{2}(?::?\d{2})?)?$/;

function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

/** A W3C/ISO 8601 date string, or why the value is not one ("is not a date", "has no time zone…"). */
export type DateCheck = { iso: string } | { problem: string };

/**
 * A date as a W3C (ISO 8601) string, the form JSON-LD, `<lastmod>` and Open
 * Graph all read:
 *
 *   - a `Date` or epoch milliseconds: written in UTC (`…Z`);
 *   - a date-only string ("2026-10-01"): kept as written, if the day exists
 *     ("2026-02-30" does not, though `Date.parse` would roll it to March 2);
 *   - a date-time string WITH a time zone ("2026-10-01T19:00:00-06:00", "…Z",
 *     Postgres' "2026-10-01 19:00:00+00"): kept with its own offset, which is
 *     what Google wants for an event's local start time;
 *   - a date-time string WITHOUT one ("2026-10-01T19:00") is refused: `new
 *     Date()` reads it in the server's own zone, so the same event would start
 *     at 19:00Z on Vercel and 01:00Z the next day on a laptop in Utah.
 *
 * Anything else is not a date.
 */
export function checkDate(value: DateInput): DateCheck {
  if (value instanceof Date || typeof value === "number") {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? { iso: date.toISOString() } : { problem: "is not a date" };
  }
  const notADate = { problem: "is not a date: write 2026-10-01, or a date-time with a time zone such as 2026-10-01T19:00:00-06:00" };
  if (typeof value !== "string") return notADate;
  const text = value.trim();
  const day = DATE_PARTS.exec(text);
  if (day) {
    return isCalendarDay(Number(day[1]), Number(day[2]), Number(day[3])) ? { iso: text } : { problem: `is not a real calendar date (${text})` };
  }
  const parts = DATE_TIME.exec(text);
  if (!parts) return notADate;
  const [, year, month, date, hour, minute, second, fraction, zone] = parts as unknown as [string, string, string, string, string, string, string | undefined, string | undefined, string | undefined];
  if (!isCalendarDay(Number(year), Number(month), Number(date))) return { problem: `is not a real calendar date (${text})` };
  if (Number(hour) > 23 || Number(minute) > 59 || (second !== undefined && Number(second) > 59)) return { problem: `has a time out of range (${text})` };
  if (zone === undefined) {
    return { problem: `has no time zone (${text}), so each server would read it in its own zone: add Z or an offset such as -06:00` };
  }
  let offset = "Z";
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
    if (hours > 23 || minutes > 59) return { problem: `has a time zone out of range (${text})` };
    offset = `${zone[0]}${digits.slice(0, 2)}:${String(minutes).padStart(2, "0")}`;
  }
  const iso = `${year}-${month}-${date}T${hour}:${minute}${second !== undefined ? `:${second}${fraction ?? ""}` : ""}${offset}`;
  return Number.isFinite(Date.parse(iso)) ? { iso } : notADate;
}

/** `checkDate`'s string, or null for a value that is not one (the caller names the field). */
export function toIsoDate(value: DateInput): string | null {
  const check = checkDate(value);
  return "iso" in check ? check.iso : null;
}

/** Milliseconds since the epoch for a value `toIsoDate` accepted. */
export function dateMillis(iso: string): number {
  return DATE_ONLY.test(iso) ? Date.parse(`${iso}T00:00:00Z`) : Date.parse(iso);
}

/** "Jane O'Neil" → "jane-o-neil". Stable, ASCII, used for @id fragments. */
export function slugify(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

/**
 * Drop `undefined`, `null`, empty strings and empty arrays, recursively, and
 * then any object left empty. This is why a node never carries
 * `"sameAs": []` (trailcards shipped exactly that). `0`, `false` and `"0"`
 * are values and stay.
 */
export function compact<T>(value: T): T {
  return compactValue(value) as T;
}

function compactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(compactValue).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value instanceof Date || value instanceof URL) return value;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = compactValue(entry);
      if (next !== undefined) out[key] = next;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

export function asArray<T>(value: T | readonly T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

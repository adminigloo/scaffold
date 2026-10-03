/**
 * iCalendar INPUT — reading a host's real calendar so the booking page never
 * offers a time they are already busy.
 *
 * The founder's decision (2026-10-02): conflicts come from Google Calendar's
 * "secret address in iCal format", not OAuth. So this is a small, careful
 * RFC 5545 reader for exactly what such a feed contains: VEVENTs with
 * DTSTART/DTEND/DURATION in UTC, in a named zone (TZID), floating, or as
 * all-day dates; RRULE (DAILY / WEEKLY / MONTHLY, plus plain YEARLY) with
 * INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS and WKST;
 * RDATE; EXDATE; RECURRENCE-ID overrides; STATUS:CANCELLED and
 * TRANSP:TRANSPARENT (Google's "Show me as: Free", and the default for its
 * all-day events) ignored.
 *
 * VTIMEZONE BLOCKS ARE IGNORED ON PURPOSE. They restate rules the runtime's
 * Intl database already has, usually less accurately (a VTIMEZONE frozen in
 * 2007 knows nothing of later rule changes). A TZID is resolved by NAME with
 * Intl; Outlook's Windows names ("Mountain Standard Time") go through a small
 * map; a TZID still unknown is read in the calendar's own X-WR-TIMEZONE (or
 * the host's zone without one). Floating times and all-day dates are the
 * viewer's local time by definition, and the viewer is the host whose day is
 * being computed, so they read in the host's zone.
 *
 * Recurrences are expanded ONLY across the window asked for, on the event's
 * own wall clock (so a weekly 9:00 Denver meeting stays at 9:00 through DST),
 * and the total is capped: a hostile or broken feed must not be able to make
 * one slot request allocate a million intervals.
 */

import type { Interval } from "./engine.js";
import {
  addDays,
  dateIn,
  isValidTimeZone,
  startOfDayIn,
  zonedWallClockToUtc,
  type DateString,
} from "./zone.js";

export class IcsParseError extends Error {
  readonly name = "IcsParseError";
}

export interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  name: string;
  properties: IcsProperty[];
  components: IcsComponent[];
}

/** Undo RFC 5545 line folding: a line starting with a space or tab continues the previous one. */
export function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw.length > 0) {
      out.push(raw);
    }
  }
  return out;
}

/** `NAME;P1=a;P2="b:c":value` → parts. Colons and semicolons inside DQUOTEs are data. */
export function parseContentLine(line: string): IcsProperty | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') inQuote = !inQuote;
    else if (char === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segments: string[] = [];
  let current = "";
  inQuote = false;
  for (const char of head) {
    if (char === '"') inQuote = !inQuote;
    if (char === ";" && !inQuote) {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  const name = (segments.shift() ?? "").trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const segment of segments) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toUpperCase();
    params[key] = segment.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

/** The component tree. Unbalanced END lines are tolerated; content outside any component is dropped. */
export function parseIcsComponents(text: string): IcsComponent[] {
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  for (const line of unfoldLines(text)) {
    const property = parseContentLine(line);
    if (!property) continue;
    if (property.name === "BEGIN") {
      const component: IcsComponent = { name: property.value.trim().toUpperCase(), properties: [], components: [] };
      const parent = stack[stack.length - 1];
      if (parent) parent.components.push(component);
      else roots.push(component);
      stack.push(component);
    } else if (property.name === "END") {
      const name = property.value.trim().toUpperCase();
      // Pop to the matching BEGIN; a stray END for something not open is ignored.
      const index = stack.map((component) => component.name).lastIndexOf(name);
      if (index >= 0) stack.length = index;
    } else {
      stack[stack.length - 1]?.properties.push(property);
    }
  }
  return roots;
}

/** Unescape a TEXT value (only used for UID/STATUS-like fields here). */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

/**
 * How a time value is anchored. A DATE is a whole day; a zoned time is a wall
 * clock in a named zone (UTC is just a zone); a floating time is a wall clock
 * with no zone at all, read in the calendar owner's.
 */
type Frame = { kind: "date" } | { kind: "zone"; zone: string } | { kind: "floating" };

interface IcsTime {
  date: DateString;
  /** Seconds since that date's midnight on the frame's wall clock. */
  seconds: number;
  frame: Frame;
}

/**
 * Outlook and Exchange name zones the Windows way. The common ones, mapped to
 * the IANA zone Windows itself documents as their primary equivalent.
 */
const WINDOWS_ZONES: Record<string, string> = {
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "US Eastern Standard Time": "America/Indianapolis",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "Canada Central Standard Time": "America/Regina",
  "Mexico Standard Time": "America/Mexico_City",
  "SA Pacific Standard Time": "America/Bogota",
  "E. South America Standard Time": "America/Sao_Paulo",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Israel Standard Time": "Asia/Jerusalem",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "Nepal Standard Time": "Asia/Kathmandu",
  "SE Asia Standard Time": "Asia/Bangkok",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "W. Australia Standard Time": "Australia/Perth",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Chatham Islands Standard Time": "Pacific/Chatham",
  UTC: "UTC",
  "Coordinated Universal Time": "UTC",
};

/** A TZID parameter → a zone Intl can use, or null when nothing recognisable is in it. */
export function resolveTzid(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const cleaned = tzid.trim().replace(/^"|"$/g, "");
  if (isValidTimeZone(cleaned)) return cleaned;
  const windows = WINDOWS_ZONES[cleaned];
  if (windows && isValidTimeZone(windows)) return windows;
  // "/mozilla.org/20050126_1/America/New_York", "/citadel.org/…/Europe/Paris":
  // the tail is an IANA name with a vendor prefix bolted on.
  const tail = /([A-Za-z]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(cleaned)?.[1];
  if (tail && isValidTimeZone(tail)) return tail;
  return null;
}

/** One DATE or DATE-TIME value under its property's parameters. */
function parseTimeValue(value: string, params: Record<string, string>, fallbackZone: string): IcsTime | null {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    return { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, seconds: 0, frame: { kind: "date" } };
  }
  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(trimmed);
  if (!dateTime) return null;
  const [, y, mo, d, h, mi, s, z] = dateTime;
  const seconds = Number(h) * 3600 + Number(mi) * 60 + Math.min(59, Number(s));
  if (Number(h) > 23 || Number(mi) > 59) return null;
  const date = `${y}-${mo}-${d}`;
  if (z) return { date, seconds, frame: { kind: "zone", zone: "UTC" } };
  if (params["TZID"] !== undefined) {
    // An unrecognisable TZID is still a zoned wall clock — read in the owner's zone.
    return { date, seconds, frame: { kind: "zone", zone: resolveTzid(params["TZID"]) ?? fallbackZone } };
  }
  return { date, seconds, frame: { kind: "floating" } };
}

/** A property value that may carry several comma-separated times (EXDATE, RDATE). */
function parseTimeList(property: IcsProperty, fallbackZone: string): IcsTime[] {
  if ((property.params["VALUE"] ?? "").toUpperCase() === "PERIOD") return [];
  return property.value
    .split(",")
    .map((part) => parseTimeValue(part, property.params, fallbackZone))
    .filter((time): time is IcsTime => time !== null);
}

/** The absolute instant of a time. Dates are their midnight; floating reads in `floatingZone`. */
function resolveTime(time: IcsTime, floatingZone: string): number {
  if (time.frame.kind === "date") return startOfDayIn(time.date, floatingZone).getTime();
  const zone = time.frame.kind === "zone" ? time.frame.zone : floatingZone;
  // UTC needs no zone database — and it is most of a busy feed's values.
  if (zone === "UTC") return Date.parse(`${time.date}T00:00:00Z`) + time.seconds * 1000;
  return zonedWallClockToUtc(time.date, Math.floor(time.seconds / 60), zone).getTime() + (time.seconds % 60) * 1000;
}

/** The zone a frame's wall clock runs in, for reading an instant back as a date. */
function frameZone(frame: Frame, floatingZone: string): string {
  return frame.kind === "zone" ? frame.zone : floatingZone;
}

interface IcsDuration {
  /** Nominal days (weeks folded in) — added on the wall clock, so a "1 day" event across DST is still a day. */
  days: number;
  /** Exact seconds. */
  seconds: number;
}

/** ISO-8601 / RFC 5545 duration: P1W, P2D, PT1H30M, P1DT2H, -PT15M. */
export function parseIcsDuration(value: string): IcsDuration | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!match || value.trim().toUpperCase() === "P" || /T$/i.test(value.trim())) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const days = (Number(match[2] ?? 0) * 7 + Number(match[3] ?? 0)) * sign;
  const seconds = (Number(match[4] ?? 0) * 3600 + Number(match[5] ?? 0) * 60 + Number(match[6] ?? 0)) * sign;
  return { days, seconds };
}

// ---------------------------------------------------------------------------
// Recurrence rules
// ---------------------------------------------------------------------------

const WEEKDAY_CODES: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface RecurrenceRule {
  freq: Frequency;
  interval: number;
  count: number | null;
  until: IcsTime | null;
  /** `n` is the ordinal (1 = first, -1 = last) within the month/year; null = every such weekday. */
  byDay: Array<{ n: number | null; weekday: number }>;
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  /** Week start for WEEKLY intervals > 1 (default Monday, per RFC 5545). */
  weekStart: number;
}

/** null for a rule this reader does not expand (an unsupported FREQ) — the event then counts once. */
export function parseRrule(value: string, fallbackZone: string): RecurrenceRule | null {
  const parts = new Map<string, string>();
  for (const pair of value.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) parts.set(pair.slice(0, eq).trim().toUpperCase(), pair.slice(eq + 1).trim());
  }
  const freq = (parts.get("FREQ") ?? "").toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const ints = (key: string): number[] =>
    (parts.get(key) ?? "")
      .split(",")
      .map((part) => Number.parseInt(part, 10))
      .filter((n) => Number.isFinite(n) && n !== 0);
  const byDay = (parts.get("BYDAY") ?? "")
    .split(",")
    .map((part) => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(part.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      n: match[1] ? Number.parseInt(match[1], 10) : null,
      weekday: WEEKDAY_CODES[(match[2] ?? "").toUpperCase()] ?? 0,
    }));
  const interval = Number.parseInt(parts.get("INTERVAL") ?? "1", 10);
  const count = parts.has("COUNT") ? Number.parseInt(parts.get("COUNT") ?? "", 10) : null;
  const untilRaw = parts.get("UNTIL");
  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 1,
    count: count !== null && Number.isFinite(count) && count > 0 ? count : null,
    until: untilRaw ? parseTimeValue(untilRaw, {}, fallbackZone) : null,
    byDay,
    byMonthDay: ints("BYMONTHDAY"),
    byMonth: ints("BYMONTH").filter((m) => m >= 1 && m <= 12),
    bySetPos: ints("BYSETPOS"),
    weekStart: WEEKDAY_CODES[(parts.get("WKST") ?? "MO").toUpperCase()] ?? 1,
  };
}

function ymd(date: DateString): { y: number; m: number; d: number } {
  return { y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)), d: Number(date.slice(8, 10)) };
}

function fmt(y: number, m: number, d: number): DateString {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function weekdayOf(date: DateString): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function diffDays(a: DateString, b: DateString): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function startOfWeek(date: DateString, weekStart: number): DateString {
  return addDays(date, -((weekdayOf(date) - weekStart + 7) % 7));
}

/** Apply BYSETPOS to one period's sorted candidates. */
function setPos(candidates: DateString[], positions: number[]): DateString[] {
  if (positions.length === 0) return candidates;
  const picked = new Set<DateString>();
  for (const pos of positions) {
    const index = pos > 0 ? pos - 1 : candidates.length + pos;
    const value = candidates[index];
    if (value !== undefined) picked.add(value);
  }
  return [...picked].sort();
}

/** The days of one month a MONTHLY (or YEARLY-with-BYMONTH) rule produces, sorted. */
function monthCandidates(y: number, m: number, rule: RecurrenceRule, anchorDay: number): DateString[] {
  const length = daysInMonth(y, m);
  let days: number[];
  if (rule.byMonthDay.length > 0) {
    days = rule.byMonthDay.map((n) => (n > 0 ? n : length + n + 1)).filter((n) => n >= 1 && n <= length);
  } else if (rule.byDay.length > 0) {
    days = Array.from({ length }, (_, i) => i + 1);
  } else {
    // Default: the DTSTART's day of month. A month without it (the 31st in
    // April) is SKIPPED, per RFC 5545 — never clamped to the 30th.
    days = anchorDay <= length ? [anchorDay] : [];
  }
  if (rule.byDay.length > 0) {
    days = days.filter((day) => {
      const weekday = weekdayOf(fmt(y, m, day));
      return rule.byDay.some((entry) => {
        if (entry.weekday !== weekday) return false;
        if (entry.n === null) return true;
        const ordinal = entry.n > 0 ? Math.ceil(day / 7) : -Math.ceil((length - day + 1) / 7);
        return ordinal === entry.n;
      });
    });
  }
  return setPos(
    [...new Set(days)].sort((a, b) => a - b).map((day) => fmt(y, m, day)),
    rule.bySetPos,
  );
}

/**
 * Candidate DATES of a rule in order, from the period containing `fromDate`
 * (fast-forwarded — callers only pass a later `fromDate` when COUNT is unset,
 * since COUNT must count from the first instance) to the first period starting
 * after `limitDate`. Time of day is the DTSTART's; BYHOUR/BYMINUTE are not
 * supported, and a feed that uses them is read as their DTSTART time.
 */
function* ruleDates(
  dtDate: DateString,
  rule: RecurrenceRule,
  fromDate: DateString,
  limitDate: DateString,
  maxPeriods: number,
): Generator<DateString> {
  const start = ymd(dtDate);
  const months = rule.byMonth;
  const inMonths = (date: DateString) => months.length === 0 || months.includes(ymd(date).m);
  let period = 0;
  if (fromDate > dtDate) {
    const from = ymd(fromDate);
    if (rule.freq === "DAILY") period = Math.floor(diffDays(dtDate, fromDate) / rule.interval);
    else if (rule.freq === "WEEKLY")
      period = Math.floor(
        diffDays(startOfWeek(dtDate, rule.weekStart), startOfWeek(fromDate, rule.weekStart)) / 7 / rule.interval,
      );
    else if (rule.freq === "MONTHLY")
      period = Math.floor((from.y * 12 + from.m - (start.y * 12 + start.m)) / rule.interval);
    else period = Math.floor((from.y - start.y) / rule.interval);
    period = Math.max(0, period);
  }
  const weekdays = rule.byDay.length > 0 ? [...new Set(rule.byDay.map((entry) => entry.weekday))] : [weekdayOf(dtDate)];
  for (let steps = 0; steps < maxPeriods; steps++, period++) {
    let periodStart: DateString;
    let candidates: DateString[];
    if (rule.freq === "DAILY") {
      periodStart = addDays(dtDate, period * rule.interval);
      const weekday = weekdayOf(periodStart);
      const day = ymd(periodStart).d;
      const length = daysInMonth(ymd(periodStart).y, ymd(periodStart).m);
      const dayOk =
        rule.byMonthDay.length === 0 || rule.byMonthDay.some((n) => (n > 0 ? n : length + n + 1) === day);
      const weekdayOk = rule.byDay.length === 0 || rule.byDay.some((entry) => entry.weekday === weekday);
      candidates = dayOk && weekdayOk ? [periodStart] : [];
    } else if (rule.freq === "WEEKLY") {
      periodStart = addDays(startOfWeek(dtDate, rule.weekStart), period * rule.interval * 7);
      candidates = weekdays
        .map((weekday) => addDays(periodStart, (weekday - rule.weekStart + 7) % 7))
        .sort();
      candidates = setPos(candidates, rule.bySetPos);
    } else if (rule.freq === "MONTHLY") {
      const index = start.y * 12 + (start.m - 1) + period * rule.interval;
      const y = Math.floor(index / 12);
      const m = (index % 12) + 1;
      periodStart = fmt(y, m, 1);
      candidates = monthCandidates(y, m, rule, start.d);
    } else {
      const y = start.y + period * rule.interval;
      periodStart = fmt(y, 1, 1);
      if (rule.byDay.length > 0 && months.length === 0) {
        // "The 20th Monday of the year" — not something a busy feed carries.
        // Read the series as its first instance only.
        return;
      }
      const monthsOfYear = months.length > 0 ? months : [start.m];
      const yearRule = { ...rule, bySetPos: [] };
      candidates = setPos(
        monthsOfYear.flatMap((m) => monthCandidates(y, m, yearRule, start.d)).sort(),
        rule.bySetPos,
      );
    }
    if (periodStart > limitDate) return;
    for (const candidate of candidates) {
      if (candidate < dtDate || !inMonths(candidate)) continue;
      yield candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Events → busy intervals
// ---------------------------------------------------------------------------

interface ParsedEvent {
  uid: string;
  start: IcsTime;
  end: IcsTime | null;
  duration: IcsDuration | null;
  rrule: RecurrenceRule | null;
  rdates: IcsTime[];
  exdates: IcsTime[];
  recurrenceId: IcsTime | null;
  cancelled: boolean;
  transparent: boolean;
}

export interface ParsedCalendar {
  /** X-WR-TIMEZONE, when the feed names a valid zone (Google always does). */
  calendarZone: string | null;
  events: ParsedEvent[];
}

/**
 * Parse a feed once; expand it per request. Throws IcsParseError for a body
 * that is not a calendar at all — Google answers a revoked secret address
 * with an HTML page, and that must read as "sync failing", not "no events".
 */
export function parseIcsCalendar(text: string, options: { fallbackZone?: string } = {}): ParsedCalendar {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new IcsParseError("not an iCalendar document (no BEGIN:VCALENDAR)");
  const roots = parseIcsComponents(text);
  const calendars = roots.filter((component) => component.name === "VCALENDAR");
  if (calendars.length === 0) throw new IcsParseError("no VCALENDAR component");
  const fallback = options.fallbackZone ?? "UTC";
  let calendarZone: string | null = null;
  const events: ParsedEvent[] = [];
  for (const calendar of calendars) {
    const wr = calendar.properties.find((property) => property.name === "X-WR-TIMEZONE")?.value.trim();
    if (!calendarZone && wr) calendarZone = resolveTzid(wr);
    const zoneForUnknown = calendarZone ?? fallback;
    for (const component of calendar.components) {
      if (component.name !== "VEVENT") continue;
      const prop = (name: string) => component.properties.find((property) => property.name === name);
      const dtstart = prop("DTSTART");
      if (!dtstart) continue;
      const start = parseTimeValue(dtstart.value, dtstart.params, zoneForUnknown);
      if (!start) continue;
      const dtend = prop("DTEND");
      const durationProp = prop("DURATION");
      const rruleProp = prop("RRULE");
      const recurrence = prop("RECURRENCE-ID");
      events.push({
        uid: unescapeText(prop("UID")?.value.trim() ?? ""),
        start,
        end: dtend ? parseTimeValue(dtend.value, dtend.params, zoneForUnknown) : null,
        duration: durationProp ? parseIcsDuration(durationProp.value) : null,
        rrule: rruleProp ? parseRrule(rruleProp.value, zoneForUnknown) : null,
        rdates: component.properties
          .filter((property) => property.name === "RDATE")
          .flatMap((property) => parseTimeList(property, zoneForUnknown)),
        exdates: component.properties
          .filter((property) => property.name === "EXDATE")
          .flatMap((property) => parseTimeList(property, zoneForUnknown)),
        recurrenceId: recurrence ? parseTimeValue(recurrence.value, recurrence.params, zoneForUnknown) : null,
        cancelled: (prop("STATUS")?.value.trim().toUpperCase() ?? "") === "CANCELLED",
        transparent: (prop("TRANSP")?.value.trim().toUpperCase() ?? "") === "TRANSPARENT",
      });
    }
  }
  return { calendarZone, events };
}

export interface ExpandBusyOptions {
  from: Date;
  to: Date;
  /** The host's zone: floating times and dates are read in the feed's X-WR-TIMEZONE, else this. */
  timezone: string;
  /** Total intervals produced before expansion stops. Default 5,000. */
  maxInstances?: number;
}

/** Merge overlapping or touching intervals; sorted. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [];
  for (const interval of sorted) {
    const last = out[out.length - 1];
    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) last.end = interval.end;
    } else {
      out.push({ start: interval.start, end: interval.end });
    }
  }
  return out;
}

const MAX_PERIODS_PER_RULE = 100_000;

/**
 * Busy intervals in [from, to) for a parsed calendar: every opaque,
 * non-cancelled instance — master occurrences minus EXDATEs minus the
 * instances a RECURRENCE-ID override replaced, plus the overrides themselves
 * (each judged on its own STATUS and TRANSP: moving one instance of a series,
 * or marking just that one "free", is exactly what overrides are for).
 */
export function expandBusy(calendar: ParsedCalendar, options: ExpandBusyOptions): Interval[] {
  const fromMs = options.from.getTime();
  const toMs = options.to.getTime();
  // Floating times and all-day dates mean "the viewer's local time" (RFC 5545
  // §3.3.5), and the viewer here is the host whose day is being computed — so
  // the HOST's zone, not the feed's X-WR-TIMEZONE (which only stands in for
  // TZIDs nobody can resolve, at parse time).
  const floating = options.timezone;
  const cap = options.maxInstances ?? 5_000;
  const out: Interval[] = [];
  if (toMs <= fromMs) return out;

  // Overrides, keyed by UID → the instants (and, for all-day series, dates) they replace.
  const overridden = new Map<string, Set<number>>();
  for (const event of calendar.events) {
    if (!event.recurrenceId) continue;
    const set = overridden.get(event.uid) ?? new Set<number>();
    set.add(resolveTime(event.recurrenceId, floating));
    overridden.set(event.uid, set);
  }

  const push = (start: number, end: number): boolean => {
    if (out.length >= cap) return false;
    if (end > fromMs && start < toMs && end > start) out.push({ start: new Date(start), end: new Date(end) });
    return true;
  };

  for (const event of calendar.events) {
    if (out.length >= cap) break;
    if (event.cancelled || event.transparent) continue;
    const startMs = resolveTime(event.start, floating);
    const zone = frameZone(event.start.frame, floating);

    // How long one instance lasts, given where it starts on the wall clock.
    const exactMs =
      event.end && event.start.frame.kind !== "date" ? resolveTime(event.end, floating) - startMs : null;
    const nominalDays =
      event.end && event.start.frame.kind === "date" ? Math.max(0, diffDays(event.start.date, event.end.date)) : null;
    const endFor = (date: DateString, instanceStart: number): number => {
      if (event.start.frame.kind === "date") {
        // DTEND on a DATE is exclusive; a missing or same-day DTEND is one day.
        if (nominalDays !== null) return startOfDayIn(addDays(date, nominalDays > 0 ? nominalDays : 1), floating).getTime();
        if (event.duration) {
          return startOfDayIn(addDays(date, event.duration.days), floating).getTime() + event.duration.seconds * 1000;
        }
        return startOfDayIn(addDays(date, 1), floating).getTime();
      }
      if (exactMs !== null) return instanceStart + exactMs;
      if (event.duration) {
        // Nominal days on the wall clock, then exact time: P1DT1H from 09:00
        // the day before a DST change still ends at 10:00 the next day.
        const shifted =
          event.duration.days === 0
            ? instanceStart
            : resolveTime({ date: addDays(date, event.duration.days), seconds: event.start.seconds, frame: event.start.frame }, floating);
        return shifted + event.duration.seconds * 1000;
      }
      return instanceStart; // zero-length: busy for no time at all
    };

    // A standalone event, or an override of one instance. (RDATE without an
    // RRULE is still a recurrence: DTSTART plus the listed dates.)
    if (event.recurrenceId || (!event.rrule && event.rdates.length === 0)) {
      if (!push(startMs, endFor(event.start.date, startMs))) break;
      continue;
    }

    const excludedInstants = new Set<number>();
    const excludedDates = new Set<DateString>();
    for (const exdate of event.exdates) {
      if (exdate.frame.kind === "date") excludedDates.add(exdate.date);
      excludedInstants.add(resolveTime(exdate, floating));
    }
    const replaced = overridden.get(event.uid);
    const skip = (instant: number): boolean =>
      excludedInstants.has(instant) ||
      (excludedDates.size > 0 && excludedDates.has(dateIn(new Date(instant), zone))) ||
      (replaced?.has(instant) ?? false);

    const emitted = new Set<number>();
    const emitInstant = (date: DateString, instant: number): boolean => {
      if (emitted.has(instant)) return true;
      emitted.add(instant);
      if (skip(instant)) return true;
      return push(instant, endFor(date, instant));
    };
    const emit = (date: DateString): boolean =>
      emitInstant(date, resolveTime({ date, seconds: event.start.seconds, frame: event.start.frame }, floating));

    if (!event.rrule) {
      if (!emit(event.start.date)) break;
    } else {
      const rule = event.rrule;
      // Look back far enough that an instance starting before `from` but still
      // running into it is found: the longest an instance can last, plus a day.
      const spanMs = Math.max(0, endFor(event.start.date, startMs) - startMs);
      const lookback = dateIn(new Date(fromMs - spanMs - 86_400_000), zone);
      const limitDate = addDays(dateIn(new Date(toMs), zone), 1);
      const untilMs = rule.until && rule.until.frame.kind !== "date" ? resolveTime(rule.until, floating) : null;
      const untilDate = rule.until && rule.until.frame.kind === "date" ? rule.until.date : null;
      let produced = 0;
      // DTSTART is always the first instance (RFC 5545 §3.8.5.3), whether or
      // not it matches the rule; COUNT counts it.
      const dates = [event.start.date];
      const fromDate = rule.count === null ? lookback : event.start.date;
      let stopped = false;
      const consider = (date: DateString): boolean => {
        if (untilDate !== null && date > untilDate) return false;
        const instant = resolveTime({ date, seconds: event.start.seconds, frame: event.start.frame }, floating);
        if (untilMs !== null && instant > untilMs) return false;
        if (instant >= toMs) return false;
        produced++;
        if (rule.count !== null && produced > rule.count) return false;
        if (!emit(date)) {
          stopped = true;
          return false;
        }
        return true;
      };
      for (const date of dates) if (!consider(date)) break;
      if (!stopped && (rule.count === null || produced < rule.count)) {
        for (const date of ruleDates(event.start.date, rule, fromDate, limitDate, MAX_PERIODS_PER_RULE)) {
          if (date === event.start.date) continue; // already counted as the first instance
          if (!consider(date)) break;
        }
      }
      if (stopped) break;
    }
    // RDATEs: extra instances, each at its OWN time when it carries one.
    for (const rdate of event.rdates) {
      const ok =
        rdate.frame.kind === "date" && event.start.frame.kind !== "date"
          ? emit(rdate.date)
          : emitInstant(
              rdate.frame.kind === "date" ? rdate.date : dateIn(new Date(resolveTime(rdate, floating)), zone),
              resolveTime(rdate, floating),
            );
      if (!ok) break;
    }
  }
  return mergeIntervals(out);
}

/** Parse and expand in one call. */
export function parseIcsBusy(text: string, options: ExpandBusyOptions): Interval[] {
  return expandBusy(parseIcsCalendar(text, { fallbackZone: options.timezone }), options);
}

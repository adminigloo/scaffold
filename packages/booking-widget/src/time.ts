import type { Slot } from "./types.js";

/**
 * Time-zone and calendar math for the picker — pure, `Intl` only, no date
 * library, and `now` always passed in so every rule is testable.
 *
 * THE ONE RULE: the server speaks in UTC instants; everything a person reads is
 * cut from the instant in the zone they are VIEWING. A 10:30 PM Denver slot is
 * 12:30 AM the next day in New York, so it belongs on the next day's tile and in
 * the morning group there. The scheduler this was ported from printed the
 * host's wall-clock strings, which is why its zone selector changed nothing on
 * screen — re-cutting from the instant is the fix, and the reason nothing below
 * takes a wall-clock time as input.
 *
 * Calendar dates ('YYYY-MM-DD') are zone-free labels once cut, so date
 * arithmetic on them runs in UTC where every day is 24 hours long.
 */

/** "YYYY-MM-DD" — a calendar date in some zone, already cut. */
export type DateString = string;

export type PartOfDay = "morning" | "afternoon" | "evening";

export const PART_OF_DAY_LABELS: Record<PartOfDay, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

const PART_ORDER: readonly PartOfDay[] = ["morning", "afternoon", "evening"];

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** True when the runtime's Intl knows this IANA zone. */
export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The browser's own zone, or UTC when the runtime will not say. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * The zone the widget opens in: an explicit prop, else the viewer's browser,
 * else the host's — the first one the runtime actually knows. A bad prop
 * (a typo in a buyer's embed) degrades to the viewer's zone instead of
 * throwing inside a render.
 */
export function resolveInitialZone(
  preferred: string | undefined,
  browser: string,
  host: string | undefined,
): string {
  for (const zone of [preferred, browser, host]) {
    if (zone && isValidTimeZone(zone)) return zone;
  }
  return "UTC";
}

/**
 * A short fallback list for runtimes without `Intl.supportedValuesOf` (Safari
 * before 15.4). Broad enough that most viewers find their own city.
 */
const FALLBACK_ZONES = [
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Halifax",
  "America/Sao_Paulo",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Johannesburg",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/**
 * Every zone the selector offers: the runtime's full IANA list when it has one,
 * plus `include` (the viewer's zone and the host's), deduplicated. `include`
 * matters because supportedValuesOf returns CANONICAL ids — a browser reporting
 * "Asia/Calcutta" would otherwise find its own zone missing from the list.
 */
export function listTimeZones(include: readonly string[] = []): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
      .supportedValuesOf;
    if (typeof supported === "function") zones = supported("timeZone");
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = [...FALLBACK_ZONES];
  const out = new Set<string>(zones);
  for (const zone of include) if (zone && isValidTimeZone(zone)) out.add(zone);
  return [...out];
}

/** "America/Argentina/Buenos_Aires" → "Buenos Aires"; "UTC" → "UTC". */
export function zoneCity(zone: string): string {
  const last = zone.split("/").pop() ?? zone;
  return last.replace(/_/g, " ");
}

/** "America/Denver" → "America"; "UTC" → "Other". For grouping the selector. */
export function zoneRegion(zone: string): string {
  const slash = zone.indexOf("/");
  return slash === -1 ? "Other" : zone.slice(0, slash);
}

/**
 * Same instant, whatever the ISO spelling. A server may echo
 * "…T15:00:00.000Z" for a slot listed as "…T15:00:00Z"; string equality would
 * then un-highlight the very time the visitor just held.
 */
export function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  return Number.isFinite(ta) && ta === Date.parse(b);
}

// ---------------------------------------------------------------------------
// Instants → wall clock
// ---------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      // h23, not hour12:false — the latter renders midnight as "24" in some
      // engines, which would file a 00:15 slot under the previous evening.
      hourCycle: "h23",
    });
    partsFormatters.set(zone, formatter);
  }
  return formatter;
}

export interface ZonedParts {
  /** The calendar date in that zone. */
  date: DateString;
  /** Minutes since that zone's midnight, 0..1439. */
  minuteOfDay: number;
}

/** An instant's calendar date and minute-of-day on the clock in `zone`. */
export function zonedParts(instant: Date, zone: string): ZonedParts {
  const parts = partsFormatter(zone).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  const hour = Number(get("hour")) % 24;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minuteOfDay: hour * 60 + Number(get("minute")),
  };
}

/**
 * The zone's offset from UTC at `instant`, in minutes (Denver in summer: -360).
 * Computed from the wall clock rather than read from a `timeZoneName` string,
 * because those strings differ between ICU versions and a label built from
 * them would read differently on a server render than in the browser.
 */
export function zoneOffsetMinutes(instant: Date, zone: string): number {
  const { date, minuteOfDay } = zonedParts(instant, zone);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return Math.round((wallAsUtc - truncated) / 60_000);
}

/** -360 → "UTC−6"; 330 → "UTC+5:30"; 0 → "UTC". */
export function formatUtcOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes < 0 ? "−" : "+";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}

/** The selector's option text: "Denver (UTC−6)". */
export function zoneOptionLabel(zone: string, at: Date): string {
  return `${zoneCity(zone)} (${formatUtcOffset(zoneOffsetMinutes(at, zone))})`;
}

/**
 * The short name a person recognises — "MDT", "GMT+1" — at `at`, so a November
 * date reads MST rather than claiming daylight time. Empty when the runtime
 * will not say; callers treat it as decoration.
 */
export function zoneAbbreviation(zone: string, at: Date, locale = "en-US"): string {
  try {
    const parts = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" }).formatToParts(at);
    return parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/**
 * The line under the picker: "Mountain Time (Denver)". The generic name comes
 * from Intl's `longGeneric` where the runtime has it; when it only has a
 * "GMT-6"-style answer (or none), the city with its offset says more.
 */
export function zoneDisplayName(zone: string, at: Date, locale = "en-US"): string {
  const city = zoneCity(zone);
  try {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: zone,
      timeZoneName: "longGeneric",
    } as Intl.DateTimeFormatOptions).formatToParts(at);
    const generic = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    if (generic && !/^(GMT|UTC)[+−-]/.test(generic) && generic !== city) {
      return `${generic} (${city})`;
    }
  } catch {
    /* older runtime — fall through */
  }
  const offset = formatUtcOffset(zoneOffsetMinutes(at, zone));
  return city === offset ? offset : `${city} time (${offset})`;
}

// ---------------------------------------------------------------------------
// Formatting what a person reads
// ---------------------------------------------------------------------------

/** "9:30 AM" on the clock in `zone`. */
export function formatTime(instant: Date, zone: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(instant);
}

/** Noon UTC on a cut date — a Date that formats as that date in the UTC zone. */
function dateAnchor(date: DateString): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** "Tuesday, October 6" for a cut date. */
export function formatLongDate(date: DateString, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(dateAnchor(date));
}

/** The pieces of a date-strip tile: { weekday: "Tue", day: "6", month: "Oct" }. */
export function formatDayTile(date: DateString, locale = "en-US"): { weekday: string; day: string; month: string } {
  const anchor = dateAnchor(date);
  const fmt = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...options }).format(anchor);
  return { weekday: fmt({ weekday: "short" }), day: fmt({ day: "numeric" }), month: fmt({ month: "short" }) };
}

/** "Tuesday, October 6 at 9:30 AM" on the clock in `zone`. */
export function formatWhen(instant: Date, zone: string, locale = "en-US"): string {
  const { date } = zonedParts(instant, zone);
  return `${formatLongDate(date, locale)} at ${formatTime(instant, zone, locale)}`;
}

/** "9:30 – 10:00 AM"-style range, kept simple: "9:30 AM – 10:00 AM". */
export function formatTimeRange(start: Date, end: Date, zone: string, locale = "en-US"): string {
  return `${formatTime(start, zone, locale)} – ${formatTime(end, zone, locale)}`;
}

/** "30 minutes", "1 hour", "1 hour 30 minutes". */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourLabel = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hourLabel : `${hourLabel} ${rest} minutes`;
}

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

export function addDays(date: DateString, days: number): DateString {
  const next = new Date(dateAnchor(date).getTime() + days * DAY_MS);
  return next.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: DateString, b: DateString): number {
  return Math.round((dateAnchor(b).getTime() - dateAnchor(a).getTime()) / DAY_MS);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Part of day for a minute-of-day on the viewer's clock. Presentation only: a
 * 9-to-5 day on a 15-minute grid is 29 buttons, and 29 flat buttons read worse
 * than three labelled rows.
 */
export function partOfDay(minuteOfDay: number): PartOfDay {
  if (minuteOfDay < 12 * 60) return "morning";
  if (minuteOfDay < 17 * 60) return "afternoon";
  return "evening";
}

/** A slot cut into the viewer's zone. `start`/`end` stay the wire's ISO strings. */
export interface LocalSlot extends Slot {
  date: DateString;
  minuteOfDay: number;
  part: PartOfDay;
}

/** Cut one slot into `zone`. */
export function localizeSlot(slot: Slot, zone: string): LocalSlot {
  const { date, minuteOfDay } = zonedParts(new Date(slot.start), zone);
  return { ...slot, date, minuteOfDay, part: partOfDay(minuteOfDay) };
}

export interface SlotDay {
  date: DateString;
  slots: LocalSlot[];
}

/**
 * Slots re-cut into the viewer's days, chronological, duplicates dropped (a
 * multi-host union, or two overlapping fetch windows, can return the same
 * instant twice — two identical buttons would read as a bug).
 */
export function groupSlotsByDay(slots: readonly Slot[], zone: string): SlotDay[] {
  const seen = new Set<number>();
  const sorted = slots
    .filter((slot) => {
      const t = Date.parse(slot.start);
      if (!Number.isFinite(t) || seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const days = new Map<DateString, LocalSlot[]>();
  for (const slot of sorted) {
    const local = localizeSlot(slot, zone);
    const list = days.get(local.date) ?? [];
    list.push(local);
    days.set(local.date, list);
  }
  return [...days.entries()].map(([date, list]) => ({ date, slots: list }));
}

export interface PartGroup {
  part: PartOfDay;
  label: string;
  slots: LocalSlot[];
}

/** One day's slots as Morning / Afternoon / Evening, empty groups omitted. */
export function groupByPartOfDay(slots: readonly LocalSlot[]): PartGroup[] {
  return PART_ORDER.map((part) => ({
    part,
    label: PART_OF_DAY_LABELS[part],
    slots: slots.filter((slot) => slot.part === part),
  })).filter((group) => group.slots.length > 0);
}

export interface StripDay {
  date: DateString;
  count: number;
}

/**
 * The date strip: every day from today (on the viewer's clock) to the end of
 * what can be booked, so weekends and fully booked days show as dimmed tiles
 * rather than vanishing — a strip that skips from Friday to Monday looks like
 * it lost the weekend.
 *
 * Where it ends: `lastDay` when the caller knows it (the type's horizon, from
 * a server that sends `horizonDays` — see lastBookableDay), else the last day
 * that has a time, padded to at least `minDays`. Never past either: trailing
 * tiles beyond the horizon would only be days nobody can pick. A time that
 * lands after `lastDay` (a pool host in another zone) still gets its tile.
 */
export function buildDateStrip(
  days: readonly SlotDay[],
  today: DateString,
  minDays = 7,
  lastDay?: DateString | null,
): StripDay[] {
  const counts = new Map(days.map((day) => [day.date, day.slots.length]));
  const lastSlotDay = days.length > 0 ? days[days.length - 1]!.date : today;
  const first = days.length > 0 && days[0]!.date < today ? days[0]!.date : today;
  const last = lastDay ? (lastDay > lastSlotDay ? lastDay : lastSlotDay) : lastSlotDay;
  const span = lastDay ? Math.max(daysBetween(first, last) + 1, 1) : Math.max(daysBetween(first, last) + 1, minDays);
  const strip: StripDay[] = [];
  // Bounded: a corrupt slot list must not become an unbounded render.
  for (let i = 0; i < Math.min(span, 400); i += 1) {
    const date = addDays(first, i);
    strip.push({ date, count: counts.get(date) ?? 0 });
  }
  return strip;
}

/**
 * Where the strip starts: the first day that has a time, or today if that is
 * earlier. Leading days with nothing open are dropped rather than dimmed: on
 * a Friday afternoon with a day's notice, "today, Sat, Sun" took the first
 * three of the four tiles a phone shows, all of them dead. Dimmed days stay
 * BETWEEN open ones (a weekend in the middle still reads as a weekend).
 */
export function stripStartDay(days: readonly SlotDay[], today: DateString): DateString {
  const first = days[0]?.date;
  return first && first > today ? first : today;
}

/**
 * The button text for each of one day's times, keyed by the slot's ISO
 * start. Normally just "1:30 AM"; on a fall-back night the repeated hour
 * produces two buttons with the SAME text in the host's zone, so every
 * label that repeats gets the zone's short name — "1:30 AM MDT" and
 * "1:30 AM MST" — and the two instants can be told apart.
 */
export function timeLabels(slots: readonly Slot[], zone: string, locale = "en-US"): Map<string, string> {
  const plain = slots.map((slot) => [slot.start, formatTime(new Date(slot.start), zone, locale)] as const);
  const counts = new Map<string, number>();
  for (const [, label] of plain) counts.set(label, (counts.get(label) ?? 0) + 1);
  return new Map(
    plain.map(([start, label]) => {
      if ((counts.get(label) ?? 0) < 2) return [start, label];
      const abbreviation = zoneAbbreviation(zone, new Date(start), locale);
      return [start, abbreviation ? `${label} ${abbreviation}` : label];
    }),
  );
}

/**
 * Which tile is open: the one the visitor chose while it still has times, else
 * the day holding the picked time (after a refetch, or when the visitor comes
 * back to the picker), else the first day with any. A zone change re-points
 * `current` at the picked time's new date before this runs — see Picker.
 */
export function chooseDay(
  days: readonly SlotDay[],
  current: DateString | null,
  pickedStart: string | null,
  zone: string,
): DateString | null {
  if (current && days.some((day) => day.date === current)) return current;
  if (pickedStart) {
    const picked = zonedParts(new Date(pickedStart), zone).date;
    if (days.some((day) => day.date === picked)) return picked;
  }
  return days[0]?.date ?? null;
}

// ---------------------------------------------------------------------------
// The horizon
// ---------------------------------------------------------------------------

/**
 * The instant a calendar date begins in `zone`. Two passes over the zone's
 * offset, so a date whose midnight sits on the other side of a DST change
 * from the first guess still lands right. The one wall-clock → instant step
 * in this file, and only for the horizon's boundary, which the server defines
 * as a midnight in the host's zone; nothing a person picks goes through it.
 */
export function startOfDateIn(date: DateString, zone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - zoneOffsetMinutes(new Date(wall), zone) * 60_000;
  return wall - zoneOffsetMinutes(new Date(first), zone) * 60_000;
}

/**
 * The first instant past a type's horizon — midnight in the HOST's zone,
 * `horizonDays` days after the host's today — the same boundary the server's
 * engine stops offering starts at.
 */
export function horizonEndMs(nowMs: number, horizonDays: number, hostZone: string): number {
  const hostToday = zonedParts(new Date(nowMs), hostZone).date;
  return startOfDateIn(addDays(hostToday, Math.max(0, horizonDays)), hostZone);
}

/**
 * The last date, on the VIEWER's clock, that can hold a bookable start: the
 * date of the instant just before the horizon ends. A host in Denver with a
 * 21-day horizon closes at Denver midnight, which a viewer in New York reads
 * as 2 AM — so their strip honestly includes that last short day.
 */
export function lastBookableDay(nowMs: number, horizonDays: number, hostZone: string, viewerZone: string): DateString {
  return zonedParts(new Date(horizonEndMs(nowMs, horizonDays, hostZone) - 1), viewerZone).date;
}

// ---------------------------------------------------------------------------
// Fetch windows
// ---------------------------------------------------------------------------

/**
 * The server answers at most 31 days per slots call. 30 keeps every request
 * inside that cap whatever rounding the server applies to the boundary.
 */
export const SLOT_WINDOW_DAYS = 30;

/** The [from, to) instants of the `index`-th fetch window starting at `originMs`. */
export function slotWindow(originMs: number, index: number, days = SLOT_WINDOW_DAYS): { from: string; to: string } {
  const from = originMs + index * days * DAY_MS;
  return { from: new Date(from).toISOString(), to: new Date(from + days * DAY_MS).toISOString() };
}

/**
 * Whether a "later dates" fetch is worth offering, for a server that does not
 * say how far ahead a type books (with `horizonDays` the answer is exact — see
 * useSlots). Inferred: when the last time on offer sits within two days of the
 * window's end, availability probably runs past it; when it stops well short,
 * the horizon was reached (the default 21-day horizon never shows the button).
 */
export function mayHaveLaterSlots(slots: readonly Slot[], windowEndIso: string): boolean {
  if (slots.length === 0) return false;
  const last = Math.max(...slots.map((slot) => Date.parse(slot.start)).filter(Number.isFinite));
  return Date.parse(windowEndIso) - last <= 2 * DAY_MS;
}

// ---------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------

/** The server's hold length (spec: 10 minutes). */
export const HOLD_MS = 10 * 60_000;

/** A server answer further out than this is a skewed clock, not a long hold. */
const HOLD_SANITY_MS = 15 * 60_000;

/**
 * When the hold ends, on THIS browser's clock.
 *
 * `expiresAt` is the server's clock. A browser running a few minutes fast or
 * slow would show a countdown that is wrong by that much — or "expired" the
 * instant it was granted. So the server's answer is used as a DURATION measured
 * from when the response arrived, accepted only when it is plausible (between
 * zero and fifteen minutes away); otherwise the nominal ten minutes stands. A
 * slightly early countdown is harmless — booking after it still succeeds while
 * the time is free — a late one is what would mislead.
 */
export function holdDeadline(expiresAtIso: string, receivedAtMs: number, nominalMs = HOLD_MS): number {
  const remaining = Date.parse(expiresAtIso) - receivedAtMs;
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > HOLD_SANITY_MS) {
    return receivedAtMs + nominalMs;
  }
  return receivedAtMs + remaining;
}

/** "9:05" for the visible countdown; never negative. */
export function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * What the screen-reader live region says. It changes only at a few
 * thresholds, so the countdown is announced four times in ten minutes instead
 * of six hundred.
 */
export function holdAnnouncement(remainingMs: number): string {
  if (remainingMs <= 0) return "Your hold on this time has run out.";
  if (remainingMs <= 60_000) return "Less than a minute left on your hold.";
  if (remainingMs <= 2 * 60_000) return "2 minutes left on your hold.";
  if (remainingMs <= 5 * 60_000) return "5 minutes left on your hold.";
  return "This time is held for you while you fill in your details.";
}

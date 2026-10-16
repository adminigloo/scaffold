/**
 * How a visit's time is written in words, in the visit's own zone. Pure.
 *
 * MOVED HERE FROM comms.ts (Tenancy 2b-1, contract 9.1) so the emails, the
 * alerts (`alerts.ts`) and the file records (`files.ts`) write a time the same
 * way: an office email and the bell's alert about the same visit must never
 * disagree about when it is. comms.ts imports them from here, unchanged.
 *
 *   formatWhen   "Monday, November 2, 2026, 9:00 – 10:00 AM MST"
 *   formatShort  "Mon, Nov 2, 9:00 AM MST"
 */

export function formatWhen(startsAt: Date, endsAt: Date, timeZone: string, locale: string): string {
  const format = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  });
  return format.formatRange(startsAt, endsAt);
}

export function formatShort(instant: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(instant);
}

/**
 * `formatShort`, but never throws: a zone or locale the runtime doesn't know
 * (a row written by a host with a typo, a stripped-down ICU) falls back to
 * en-US in UTC. An alert or a file label is never worth an exception.
 */
export function formatShortSafe(instant: Date, timeZone: string, locale: string): string {
  try {
    return formatShort(instant, timeZone, locale);
  } catch {
    return formatShort(instant, "UTC", "en-US");
  }
}

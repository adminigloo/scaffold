/**
 * Time zones as an owner knows them (scheduling-widget's list, copied): the
 * US zones by the name people say ("Mountain Time (Denver)"), first, and then
 * every IANA zone the browser knows under "Other time zones". Nobody should
 * have to know that Salt Lake City is "America/Denver".
 */

export interface ZoneChoice {
  /** The IANA name stored. */
  readonly zone: string;
  /** What the owner reads. */
  readonly label: string;
}

export const US_TIME_ZONES: readonly ZoneChoice[] = [
  { zone: "America/New_York", label: "Eastern Time (New York)" },
  { zone: "America/Chicago", label: "Central Time (Chicago)" },
  { zone: "America/Denver", label: "Mountain Time (Denver)" },
  { zone: "America/Phoenix", label: "Mountain Time, no daylight saving (Phoenix)" },
  { zone: "America/Los_Angeles", label: "Pacific Time (Los Angeles)" },
  { zone: "America/Anchorage", label: "Alaska Time (Anchorage)" },
  { zone: "Pacific/Honolulu", label: "Hawaii Time (Honolulu)" },
];

/** Every IANA zone the browser knows (Intl.supportedValuesOf), or a short list where it can't say. */
export function allTimeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof supported === "function") return supported("timeZone");
  } catch {
    /* fall through */
  }
  return ["UTC", "Europe/London", "Europe/Paris", "Australia/Sydney", ...US_TIME_ZONES.map((z) => z.zone)];
}

/** "America/Denver" → "Mountain Time (Denver)"; any other zone reads as a place (see zoneOptionLabel). */
export function zoneLabel(zone: string): string {
  return US_TIME_ZONES.find((z) => z.zone === zone)?.label ?? zoneOptionLabel(zone);
}

/** The zone's own name in words ("Argentina Standard Time"), where the browser knows it. */
function genericName(zone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(new Date(Date.UTC(2026, 0, 15)));
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? null;
    // "GMT-03:00" says nothing a person can recognise; leave it out.
    return name && !/^GMT[+-]/.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * An IANA zone as a person reads it (review R2 T1BO-10): "America/Argentina/
 * Buenos_Aires" → "Buenos Aires, Argentina (Argentina Standard Time)",
 * "Africa/Asmera" → "Asmera (East Africa Time)". Never the raw id with slashes.
 */
export function zoneOptionLabel(zone: string): string {
  const us = US_TIME_ZONES.find((z) => z.zone === zone);
  if (us) return us.label;
  const parts = zone.split("/").map((p) => p.replace(/_/g, " "));
  const place = parts.length > 2 ? `${parts[parts.length - 1]}, ${parts.slice(1, -1).join(", ")}` : (parts[parts.length - 1] ?? zone);
  const generic = genericName(zone);
  return generic && generic !== place ? `${place} (${generic})` : place;
}

/** Every zone the browser knows except `skip`, as readable choices sorted by place. */
export function otherTimeZoneChoices(skip: ReadonlySet<string>): ZoneChoice[] {
  return allTimeZones()
    .filter((zone) => !skip.has(zone))
    .map((zone) => ({ zone, label: zoneOptionLabel(zone) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

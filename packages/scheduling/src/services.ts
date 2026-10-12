/**
 * What a customer books: a SERVICE, not a duration. Pure, no DB.
 *
 * 0.3 asked the visitor for `durationMinutes` and the host's code decided the
 * skill. A business owner thinks in services ("Free estimate", "Window clean,
 * up to 20 windows"), each with its own length and, sometimes, a crew skill.
 * The list lives in `scheduling_settings.services`; a visit's `service_type`
 * holds the key.
 */

export interface SchedulingService {
  /** /^[a-z0-9][a-z0-9-]{0,39}$/, unique within the tenant. Stored on each visit, so keep it stable. */
  key: string;
  /** 1–80: what the customer reads ("Free estimate"). */
  name: string;
  /** 15–720, a multiple of 5. */
  durationMinutes: number;
  /** Up to 300 characters, shown under the name on the booking page. */
  description?: string | null;
  /** Up to 60: only crews with this skill (or with no skills listed) are offered. */
  requiredSkill?: string | null;
}

export const SERVICE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * A key a person can read, for a visit whose service is no longer in the list
 * (renamed or removed since it was booked): "window-clean" → "Window clean".
 * A staff visit booked before services existed has "visit" → "Visit".
 */
export function humanizeServiceKey(key: string): string {
  const words = key.replace(/[-_]+/g, " ").trim();
  if (!words) return "Visit";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The tenant's service with this key, or null. */
export function findService(
  services: readonly SchedulingService[],
  key: string | null | undefined,
): SchedulingService | null {
  if (!key) return null;
  return services.find((service) => service.key === key) ?? null;
}

/** The name shown for a visit's service: the settings' name for the key, else the key humanized. */
export function serviceNameFor(services: readonly SchedulingService[], key: string | null | undefined): string {
  return findService(services, key)?.name ?? humanizeServiceKey(key ?? "visit");
}

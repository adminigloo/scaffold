import { haversineDistance, type LatLng } from "./math.js";

export type { LatLng } from "./math.js";

export interface DriveTime {
  durationMinutes: number;
  distanceMiles: number;
}

/**
 * The seam between the scheduler and a maps API. Ship the keyless Haversine
 * default so the engine works out of the box (the demo path); inject a real
 * provider — `createGoogleMapsProvider`, or your own — when a key exists.
 * Choosing the provider by whether a key is present (`selectMapsProvider`),
 * not a boolean flag, is the house configuration-not-flags rule, and it's why
 * drive-time scoring degrades gracefully instead of switching off.
 */
export interface MapsProvider {
  /**
   * False for a provider that can't geocode at all, like the keyless Haversine
   * default. Omitted means it can, and then a null from `geocode` is taken at
   * its word: `requestPublicBooking` refuses an address the provider can't
   * place (`address_unresolved`) rather than booking a visit with no
   * coordinates, which every later drive check would skip.
   */
  readonly geocodes?: boolean;
  /**
   * True when drive times are straight-line ESTIMATES (Haversine at an
   * assumed speed) rather than a road router's answer. The crew's route and
   * the staff suggestions say "estimate" when it is set, so nobody plans a day
   * around a number that ignores the canyon road.
   */
  readonly estimates?: boolean;
  /**
   * Address → coordinates. Null means "no such place": the provider looked
   * and found nothing. It MAY THROW (`MapsProviderError`) for "couldn't ask"
   * — a timeout, a quota, a revoked key — which callers treat differently: a
   * customer's request is booked without coordinates rather than refused for
   * an outage that isn't their fault.
   */
  geocode(address: string): Promise<LatLng | null>;
  /** Travel time and distance between two points, or null when it couldn't be had. Never throws. */
  driveTime(origin: LatLng, dest: LatLng): Promise<DriveTime | null>;
}

export type MapsProviderErrorKind = "timeout" | "network" | "http" | "denied" | "quota" | "invalid" | "unknown";

/**
 * A maps provider couldn't answer. The message is built from the kind and the
 * provider's status only — NEVER from a request URL, because a URL carries the
 * API key, and an error message ends up in logs, error trackers and, through a
 * careless handler, HTTP responses.
 */
export class MapsProviderError extends Error {
  readonly name = "MapsProviderError";
  readonly kind: MapsProviderErrorKind;
  /** The provider's own status string ("OVER_QUERY_LIMIT"), when there was one. */
  readonly status?: string;
  constructor(kind: MapsProviderErrorKind, message: string, status?: string) {
    super(message);
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export interface HaversineOptions {
  /** Average speed used to turn straight-line miles into minutes. Default 30. */
  assumedMph?: number;
}

/**
 * The no-key default: it cannot geocode (returns null, so the caller keeps the
 * coordinates it already has), but it estimates drive time from straight-line
 * distance at an assumed average speed. Good enough to cluster a route in a
 * demo; a real provider makes it road-accurate in production. It says so:
 * `estimates: true`.
 */
export function createHaversineMapsProvider(options: HaversineOptions = {}): MapsProvider {
  const mph = options.assumedMph ?? 30;
  return {
    geocodes: false,
    estimates: true,
    async geocode(): Promise<LatLng | null> {
      return null;
    },
    async driveTime(origin: LatLng, dest: LatLng): Promise<DriveTime> {
      const miles = haversineDistance(origin.lat, origin.lng, dest.lat, dest.lng);
      return {
        durationMinutes: Math.round((miles / mph) * 60),
        distanceMiles: Math.round(miles * 10) / 10,
      };
    },
  };
}

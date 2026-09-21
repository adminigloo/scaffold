import { haversineDistance, type LatLng } from "./math.js";

export type { LatLng } from "./math.js";

export interface DriveTime {
  durationMinutes: number;
  distanceMiles: number;
}

/**
 * The seam between the scheduler and a maps API. Ship the keyless Haversine
 * default so the engine works out of the box (the demo path); inject a real
 * provider — Google Distance Matrix, Mapbox — when a key exists. Choosing the
 * provider by whether a key is present, not a boolean flag, is the house
 * configuration-not-flags rule, and it's why drive-time scoring degrades
 * gracefully instead of switching off.
 */
export interface MapsProvider {
  /** Address → coordinates, or null if this provider can't geocode (Haversine can't). */
  geocode(address: string): Promise<LatLng | null>;
  /** Travel time/distance between two points, or null on failure. */
  driveTime(origin: LatLng, dest: LatLng): Promise<DriveTime | null>;
}

export interface HaversineOptions {
  /** Average speed used to turn straight-line miles into minutes. Default 30. */
  assumedMph?: number;
}

/**
 * The no-key default: it cannot geocode (returns null, so the caller keeps the
 * coordinates it already has), but it estimates drive time from straight-line
 * distance at an assumed average speed. Good enough to cluster a route in a
 * demo; a real provider makes it traffic-accurate in production.
 */
export function createHaversineMapsProvider(options: HaversineOptions = {}): MapsProvider {
  const mph = options.assumedMph ?? 30;
  return {
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

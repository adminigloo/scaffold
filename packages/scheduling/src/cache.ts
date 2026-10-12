import { and, eq, gte } from "drizzle-orm";
import type { DriveTime, MapsProvider } from "./maps.js";
import { schedulingDriveCache } from "./schema.js";
import type { SchedulingDb } from "./types.js";

export interface CachedMapsOptions {
  ttlDays?: number;
  /** Coordinate rounding for the cache key (decimal places). Default 4 (~11m). */
  precision?: number;
}

/**
 * Wrap a real maps provider so drive times are cached in the database for a few
 * days — the pattern SG Glass used to keep the Google bill down. Geocoding is
 * passed straight through, and so are `geocodes` and `estimates`. The keyless
 * Haversine provider needs no cache (it's deterministic and free), so wrap
 * only a paid provider with this; `selectMapsProvider` does it for you.
 *
 * The cache reads and writes on `db`, the handle it was built with — never on
 * a caller's transaction. That is safe with every function here: they look
 * drive times up before taking a crew's lock, outside any transaction. Don't
 * hand it to `validateBookingSlot` inside a transaction of your own; on a
 * one-connection handle the cache would wait for the connection your
 * transaction is holding.
 *
 * A cache that can't be read or written (a database hiccup) falls through to
 * the provider: `driveTime` never throws.
 */
export function createCachedMapsProvider(
  base: MapsProvider,
  db: SchedulingDb,
  options: CachedMapsOptions = {},
): MapsProvider {
  const ttlMs = (options.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
  const p = options.precision ?? 4;
  const round = (n: number): number => Math.round(n * 10 ** p) / 10 ** p;
  return {
    ...(base.geocodes !== undefined ? { geocodes: base.geocodes } : {}),
    ...(base.estimates !== undefined ? { estimates: base.estimates } : {}),
    geocode: (address) => base.geocode(address),
    async driveTime(origin, dest): Promise<DriveTime | null> {
      const oLat = round(origin.lat);
      const oLng = round(origin.lng);
      const dLat = round(dest.lat);
      const dLng = round(dest.lng);
      try {
        const [hit] = await db
          .select()
          .from(schedulingDriveCache)
          .where(
            and(
              eq(schedulingDriveCache.originLat, oLat),
              eq(schedulingDriveCache.originLng, oLng),
              eq(schedulingDriveCache.destLat, dLat),
              eq(schedulingDriveCache.destLng, dLng),
              gte(schedulingDriveCache.fetchedAt, new Date(Date.now() - ttlMs)),
            ),
          )
          .limit(1);
        if (hit) {
          const row = hit as typeof schedulingDriveCache.$inferSelect;
          return { durationMinutes: row.durationMinutes, distanceMiles: row.distanceMiles };
        }
      } catch {
        /* no cache this time; ask the provider */
      }
      const fresh = await base.driveTime(origin, dest);
      if (fresh) {
        try {
          await db.insert(schedulingDriveCache).values({
            originLat: oLat,
            originLng: oLng,
            destLat: dLat,
            destLng: dLng,
            durationMinutes: fresh.durationMinutes,
            distanceMiles: fresh.distanceMiles,
          });
        } catch {
          /* the answer is still good; it just won't be cached */
        }
      }
      return fresh;
    },
  };
}

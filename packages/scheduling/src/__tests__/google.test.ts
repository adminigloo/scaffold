import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bookVisit,
  createGoogleMapsProvider,
  createResource,
  findAvailableSlots,
  findPublicSlots,
  getBooking,
  MapsProviderError,
  requestPublicBooking,
  selectMapsProvider,
  updateSchedulingSettings,
} from "../index.js";
import { fakeGoogle, GOOGLE_KEY } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The Google provider against a fake fetch: the exact URLs, every answer and
 * failure, a timeout through a fetch that never resolves — and the API key
 * never appearing in any error, message or `onError` payload. Then the
 * provider doing its job: a request geocoded (or booked without coordinates
 * when Google is down), and drive scores that change with where the job is
 * (SB-04's proof).
 */

const NOW = new Date("2026-03-02T09:00:00Z");
const WED = "2026-03-04";
const HOME = { lat: 40.76, lng: -111.89 };

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

/** Every string a failure could leak through. */
function surfaces(error: unknown): string {
  const e = error as Error & { kind?: string; status?: string };
  return [e.message, e.stack, String(e), JSON.stringify(e), e.kind, e.status].join(" | ");
}

describe("geocode", () => {
  it("asks Google with the exact URL and parameters, and reads the first result", async () => {
    const google = fakeGoogle({ places: { "1 Main St, SLC": { lat: 40.7, lng: -111.9 } } });
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch, region: "us", components: "country:US" });
    expect(maps).toMatchObject({ geocodes: true, estimates: false });
    expect(await maps.geocode("1 Main St, SLC")).toEqual({ lat: 40.7, lng: -111.9 });
    expect(google.urls).toEqual([
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent("1 Main St, SLC")}&key=${GOOGLE_KEY}&region=us&components=${encodeURIComponent("country:US")}`,
    ]);
  });

  it("ZERO_RESULTS is null; a blank address is null with no request", async () => {
    const google = fakeGoogle();
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch });
    expect(await maps.geocode("Nowhere at all")).toBeNull();
    expect(await maps.geocode("   ")).toBeNull();
    expect(google.urls).toHaveLength(1);
  });

  const failures: Array<[string, Parameters<typeof fakeGoogle>[0], string, string | undefined]> = [
    ["OVER_QUERY_LIMIT", { geocodeFailures: { x: { status: "OVER_QUERY_LIMIT" } } }, "quota", "OVER_QUERY_LIMIT"],
    ["REQUEST_DENIED", { geocodeFailures: { x: { status: "REQUEST_DENIED" } } }, "denied", "REQUEST_DENIED"],
    ["INVALID_REQUEST", { geocodeFailures: { x: { status: "INVALID_REQUEST" } } }, "invalid", "INVALID_REQUEST"],
    ["UNKNOWN_ERROR", { geocodeFailures: { x: { status: "UNKNOWN_ERROR" } } }, "unknown", "UNKNOWN_ERROR"],
    ["a 500", { geocodeFailures: { x: { http: 500 } } }, "http", "500"],
    ["a network failure that quotes the URL", { geocodeFailures: { x: { network: true } } }, "network", undefined],
  ];
  for (const [what, setup, kind, status] of failures) {
    it(`${what} throws MapsProviderError (${kind}), tells onError, and never shows the key`, async () => {
      const google = fakeGoogle(setup);
      const reported: MapsProviderError[] = [];
      const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch, onError: (e) => reported.push(e) });
      const error = await maps.geocode("x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MapsProviderError);
      expect(error).toMatchObject({ name: "MapsProviderError", kind, ...(status ? { status } : {}) });
      expect(reported).toEqual([error]);
      expect(surfaces(error)).not.toContain(GOOGLE_KEY);
      expect(surfaces(error)).not.toContain("key=");
    });
  }

  it("a fetch that never resolves times out", async () => {
    const google = fakeGoogle({ geocodeFailures: { slow: { hang: true } } });
    const reported: MapsProviderError[] = [];
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch, timeoutMs: 30, onError: (e) => reported.push(e) });
    const started = Date.now();
    const error = await maps.geocode("slow").catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(error).toMatchObject({ kind: "timeout" });
    expect(reported[0]?.kind).toBe("timeout");
    expect(surfaces(error)).not.toContain(GOOGLE_KEY);
  });

  it("refuses to build without a key", () => {
    expect(() => createGoogleMapsProvider({ apiKey: "  " })).toThrow(/apiKey/);
  });
});

describe("driveTime (Distance Matrix)", () => {
  it("asks with the exact URL, typical duration by default, and rounds", async () => {
    const google = fakeGoogle({ driveMinutes: 17, miles: 9.24 });
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch });
    expect(await maps.driveTime({ lat: 40.7, lng: -111.9 }, { lat: 40.8, lng: -111.8 })).toEqual({ durationMinutes: 17, distanceMiles: 9.2 });
    expect(google.urls).toEqual([
      `https://maps.googleapis.com/maps/api/distancematrix/json?origins=40.7,-111.9&destinations=40.8,-111.8&mode=driving&units=imperial&key=${GOOGLE_KEY}`,
    ]);
  });

  it("with departureTime: 'now' it asks for traffic and uses duration_in_traffic", async () => {
    const google = fakeGoogle({ driveMinutes: 17 });
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch, departureTime: "now" });
    expect((await maps.driveTime({ lat: 1, lng: 2 }, { lat: 3, lng: 4 }))?.durationMinutes).toBe(22);
    expect(google.urls[0]).toMatch(/&departure_time=now$/);
  });

  it("never throws: failures are null (reported), a road-less element is null (not reported)", async () => {
    for (const failure of [{ status: "OVER_QUERY_LIMIT" }, { http: 503 }, { network: true }, { hang: true }]) {
      const reported: MapsProviderError[] = [];
      const maps = createGoogleMapsProvider({
        apiKey: GOOGLE_KEY,
        fetch: fakeGoogle({ matrixFailure: failure }).fetch,
        timeoutMs: 30,
        onError: (e) => reported.push(e),
      });
      await expect(maps.driveTime({ lat: 1, lng: 2 }, { lat: 3, lng: 4 })).resolves.toBeNull();
      expect(reported).toHaveLength(1);
      expect(surfaces(reported[0])).not.toContain(GOOGLE_KEY);
    }
    const reported: MapsProviderError[] = [];
    const island = createGoogleMapsProvider({
      apiKey: GOOGLE_KEY,
      fetch: fakeGoogle({ matrixFailure: { elementStatus: "ZERO_RESULTS" } }).fetch,
      onError: (e) => reported.push(e),
    });
    expect(await island.driveTime({ lat: 1, lng: 2 }, { lat: 3, lng: 4 })).toBeNull();
    expect(reported).toEqual([]);
  });
});

describe("selectMapsProvider", () => {
  it("key + db → Google cached in the database; key only → Google; no key → Haversine estimates, no fetch", async () => {
    const google = fakeGoogle({ driveMinutes: 20 });
    const cached = selectMapsProvider({ googleMapsApiKey: GOOGLE_KEY, db: t.db, fetch: google.fetch });
    expect(cached).toMatchObject({ geocodes: true, estimates: false });
    const a = { lat: 40.123456, lng: -111.1 };
    const b = { lat: 40.2, lng: -111.2 };
    expect(await cached.driveTime(a, b)).toEqual({ durationMinutes: 20, distanceMiles: 6.2 });
    expect(await cached.driveTime(a, b)).toEqual({ durationMinutes: 20, distanceMiles: 6.2 });
    expect(google.matrices()).toHaveLength(1);

    const uncachedGoogle = fakeGoogle({ driveMinutes: 20 });
    const uncached = selectMapsProvider({ googleMapsApiKey: GOOGLE_KEY, fetch: uncachedGoogle.fetch });
    await uncached.driveTime(a, b);
    await uncached.driveTime(a, b);
    expect(uncachedGoogle.matrices()).toHaveLength(2);

    const blank = fakeGoogle();
    for (const keyless of [selectMapsProvider({}), selectMapsProvider({ googleMapsApiKey: "  ", fetch: blank.fetch })]) {
      expect(keyless).toMatchObject({ geocodes: false, estimates: true });
      expect(await keyless.geocode("1 Main St")).toBeNull();
      expect((await keyless.driveTime(a, b))?.durationMinutes).toBeGreaterThan(0);
    }
    expect(blank.urls).toEqual([]);
  });
});

describe("the provider at work", () => {
  async function bookable() {
    const tenantId = tenant();
    await createResource(t.db, { tenantId, name: "Crew" });
    const [slot] = await findPublicSlots(t.db, { tenantId, service: "visit", from: WED, days: 1 }, { now: NOW });
    return { tenantId, slot: slot! };
  }

  it("a request is geocoded through Google; ZERO_RESULTS refuses; Google down still books, without coordinates", async () => {
    const google = fakeGoogle({
      places: { "1 Main St": { lat: 40.71, lng: -111.9 } },
      geocodeFailures: { "2 Main St": { http: 500 } },
    });
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch });
    const ask = async (address: string) => {
      const { tenantId, slot } = await bookable();
      const receipt = await requestPublicBooking(
        t.db,
        { tenantId, slotId: slot.slotId, service: "visit", customerName: "V", customerEmail: "v@example.com", address },
        { now: NOW, maps },
      );
      return getBooking(t.db, tenantId, receipt.id);
    };
    expect(await ask("1 Main St")).toMatchObject({ lat: 40.71, lng: -111.9 });
    await expect(ask("99 Imaginary Rd")).rejects.toMatchObject({ code: "address_unresolved" });
    expect(await ask("2 Main St")).toMatchObject({ address: "2 Main St", lat: null, lng: null });
  });

  it("staff suggestions score by where the job is (SB-04): a job near the morning visit ranks the slot after it higher", async () => {
    const tenantId = tenant();
    await updateSchedulingSettings(t.db, tenantId, { timeZone: "UTC" });
    const crew = await createResource(t.db, { tenantId, name: "Crew", homeBaseLat: HOME.lat, homeBaseLng: HOME.lng });
    // The morning visit is downtown; a second crew-free afternoon.
    await bookVisit(t.db, { tenantId, resourceId: crew.id, scheduledDate: WED, startTime: "08:00", endTime: "10:00", lat: 40.76, lng: -111.89 }, { now: NOW });
    // Google answers by distance: next door is 5 minutes, across the valley is 50.
    const google = fakeGoogle({
      driveMinutes: (o, d) => (Math.abs(o.lat - d.lat) + Math.abs(o.lng - d.lng) < 0.05 ? 5 : 50),
      places: { "Next door": { lat: 40.761, lng: -111.891 }, "Across the valley": { lat: 40.5, lng: -112.1 } },
    });
    const maps = createGoogleMapsProvider({ apiKey: GOOGLE_KEY, fetch: google.fetch });
    const suggest = (jobAddress: string) =>
      findAvailableSlots(t.db, { tenantId, jobAddress, durationMinutes: 60, startDate: WED, endDate: WED }, maps);
    const near = await suggest("Next door");
    const far = await suggest("Across the valley");
    const firstAfterJob = (slots: typeof near) =>
      slots.filter((s) => s.previousJobAddress !== null).sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
    // Right at 10:00 nobody can make it (the drive needs minutes); next door, 10:30 can.
    expect(firstAfterJob(near)).toMatchObject({ startTime: "10:30", driveMinutesFromPrevious: 5, score: 110 }); // 100 + short drive
    // Across the valley 50 minutes of driving doesn't fit before 11:00, and scores worse when it does.
    expect(firstAfterJob(far)).toMatchObject({ startTime: "11:00", driveMinutesFromPrevious: 50, score: 60 }); // 100 − long drive
    // The best suggestion for the nearby job outranks the best for the far one.
    expect(near[0]!.score).toBeGreaterThan(far[0]!.score);
    expect(google.geocodes()).toHaveLength(2);
  });
});

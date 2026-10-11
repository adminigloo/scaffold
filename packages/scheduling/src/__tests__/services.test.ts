import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BookingNotBookableError,
  BookingStatusTransitionError,
  createBooking,
  createHaversineMapsProvider,
  createResource,
  deactivateResource,
  findAvailableSlots,
  findPublicSlots,
  getBooking,
  listAvailability,
  listBookings,
  listResources,
  requestPublicBooking,
  setAvailability,
  setBookingStatus,
  updateResource,
  validateBookingSlot,
  type FindPublicSlotsInput,
  type MapsProvider,
  type PublicBookingPolicy,
} from "../index.js";
import { encodeSlotId } from "../public.js";
import { schedulingAvailability } from "../schema.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The package against real Postgres (PGlite): tenant isolation on every by-id
 * function, the public projection, the public request's rules, the slot grid,
 * explicit hours, and the status lifecycle. Each test gets its own tenant, so
 * the scoping under test is also what keeps the tests apart.
 *
 * The clock is injected. NOW is Monday 2026-03-02 09:00 UTC, so with the
 * default 24-hour notice the first bookable start is Tuesday 09:00.
 */

const NOW = new Date("2026-03-02T09:00:00Z"); // Monday
const MON = "2026-03-02";
const TUE = "2026-03-03";
const WED = "2026-03-04";
const SAT = "2026-03-07";
const day = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

/** A booked customer's home, and two addresses a visitor might type: the same street, and ~28 miles off (56 min at 30 mph). */
const VISIT_AT = { lat: 40.7, lng: -111.9 };
const NEAR = { lat: 40.7, lng: -111.9 };
const FAR = { lat: 41.105, lng: -111.9 };

/** A provider that places a few known addresses, and times drives the Haversine way. */
function geocoder(places: Record<string, { lat: number; lng: number }>): MapsProvider {
  const drives = createHaversineMapsProvider();
  return {
    geocode: async (address) => places[address] ?? null,
    driveTime: (origin, dest) => drives.driveTime(origin, dest),
  };
}

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

async function crew(tenantId: string, overrides: Record<string, unknown> = {}) {
  return createResource(t.db, { tenantId, name: "Field crew", ...overrides });
}

const visitor = {
  customerName: "Pat Visitor",
  customerEmail: "pat@example.com",
};

/** The public slots for one day, as an anonymous visitor would get them. */
async function publicSlotsOn(
  tenantId: string,
  iso: string,
  policy: PublicBookingPolicy = {},
  durationMinutes = 60,
  requiredSkill: string | null = null,
) {
  return findPublicSlots(t.db, { tenantId, durationMinutes, from: day(iso), days: 1, requiredSkill }, { now: NOW, policy });
}

describe("tenant isolation: every by-id function", () => {
  it("another tenant's ids are not found — nothing read, nothing written", async () => {
    const a = tenant("a");
    const b = tenant("b");
    const resource = await crew(a);
    await setAvailability(t.db, {
      tenantId: a,
      resourceId: resource.id,
      blocks: [{ dayOfWeek: 3, startTime: "08:00", endTime: "17:00" }],
    });
    const booking = await createBooking(t.db, {
      tenantId: a,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "10:00",
      endTime: "11:00",
      customerName: "A's customer",
    });

    expect(await updateResource(t.db, b, resource.id, { name: "Hijacked" })).toBeNull();
    expect(await deactivateResource(t.db, b, resource.id)).toBe(false);
    expect(await setAvailability(t.db, { tenantId: b, resourceId: resource.id, blocks: [] })).toBe(false);
    expect(await listAvailability(t.db, b, resource.id)).toEqual([]);
    expect(await getBooking(t.db, b, booking.id)).toBeNull();
    expect(await setBookingStatus(t.db, b, { id: booking.id, status: "cancelled" })).toBe(false);
    expect(await listBookings(t.db, b, { from: day(MON), to: day(SAT) })).toEqual([]);
    expect(
      await validateBookingSlot(t.db, {
        tenantId: b,
        resourceId: resource.id,
        date: day(WED),
        startTime: "13:00",
        endTime: "14:00",
      }),
    ).toMatchObject({ valid: false, reason: "Resource not found" });
    await expect(
      createBooking(t.db, {
        tenantId: b,
        resourceId: resource.id,
        scheduledDate: day(WED),
        startTime: "13:00",
        endTime: "14:00",
      }),
    ).rejects.toBeInstanceOf(BookingNotBookableError);

    // Tenant A's rows are exactly as they were.
    const [still] = await listResources(t.db, a);
    expect(still).toMatchObject({ name: "Field crew", isActive: true, hoursConfigured: true });
    expect(await listAvailability(t.db, a, resource.id)).toHaveLength(1);
    expect(await getBooking(t.db, a, booking.id)).toMatchObject({ status: "confirmed" });
    expect(await listBookings(t.db, b, { from: day(MON), to: day(SAT) })).toHaveLength(0);
  });

  it("a resource patch cannot move it to another tenant or flip its hours flag", async () => {
    const a = tenant("a");
    const b = tenant("b");
    const resource = await crew(a);
    const patched = await updateResource(t.db, a, resource.id, {
      name: "Crew 2",
      ...({ tenantId: b, id: "other", hoursConfigured: true, isActive: false } as object),
    });
    expect(patched).toMatchObject({ id: resource.id, tenantId: a, name: "Crew 2", hoursConfigured: false, isActive: true });
    expect(await listResources(t.db, b, { includeInactive: true })).toEqual([]);
  });

  it("the public finder and request never cross tenants", async () => {
    const a = tenant("a");
    const b = tenant("b");
    await crew(a);
    const [slot] = await publicSlotsOn(a, WED);
    expect(slot).toBeDefined();
    expect(await publicSlotsOn(b, WED)).toEqual([]);
    // Tenant B presents tenant A's slot id: the same refusal as a taken time.
    await expect(
      requestPublicBooking(t.db, { tenantId: b, slotId: slot!.slotId, durationMinutes: 60, ...visitor }, { now: NOW }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(await listBookings(t.db, a, { from: day(MON), to: day(SAT) })).toEqual([]);
  });
});

describe("the public projection", () => {
  it("carries four fields and nothing about the crew or any other customer", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId, { name: "Crew Bravo", homeBaseLat: 40.76, homeBaseLng: -111.89 });
    await createBooking(t.db, {
      tenantId,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "08:00",
      endTime: "10:00",
      customerName: "Earlier Customer",
      customerEmail: "earlier@example.com",
      address: "12 Secret Lane, Salt Lake City",
      ...VISIT_AT,
    });

    // Staff slots DO carry the previous job's address — the data the 0.2 public
    // route leaked by returning these as they came.
    const staff = await findAvailableSlots(t.db, {
      tenantId,
      durationMinutes: 60,
      startDate: day(WED),
      endDate: day(WED),
    });
    expect(staff.some((s) => s.previousJobAddress === "12 Secret Lane, Salt Lake City")).toBe(true);

    const slots = await publicSlotsOn(tenantId, WED);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(Object.keys(slot).sort()).toEqual(["date", "endTime", "slotId", "startTime"]);
    }
    const wire = JSON.stringify(slots);
    for (const secret of [
      "Secret Lane",
      "Earlier Customer",
      "earlier@example.com",
      "Crew Bravo",
      "previousJobAddress",
      "resourceName",
      "resourceId",
      "score",
      "drive",
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("a slot id names a day and a start — decoded, it holds no crew", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    for (const slot of await publicSlotsOn(tenantId, WED)) {
      const decoded = JSON.parse(Buffer.from(slot.slotId, "base64url").toString("utf8")) as unknown[];
      expect(decoded).toEqual(["s1", slot.date, slot.startTime]);
      expect(decoded).not.toContain(resource.id);
    }
  });

  it("offers one choice per time when two crews are free, in time order", async () => {
    const tenantId = tenant();
    await crew(tenantId, { name: "Alpha" });
    await crew(tenantId, { name: "Bravo" });
    const slots = await publicSlotsOn(tenantId, WED);
    const times = slots.map((s) => s.startTime);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual([...times].sort());
  });
});

describe("the public list is the same for every visitor", () => {
  it("keeps a fixed travel buffer around every visit instead of scoring the visitor's drive", async () => {
    // The list used to be worked out from the visitor's geocoded address: the
    // 10:00 start right after an 08:00–10:00 visit appeared only when the
    // drive from that visit was 0 minutes, so typing an address and reading
    // the list said where the earlier customer lives.
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await createBooking(t.db, {
      tenantId,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "08:00",
      endTime: "10:00",
      address: "12 Victim Lane",
      ...VISIT_AT,
    });

    // @ts-expect-error — there is no address to pass; the list can't depend on what a visitor types.
    const withAddress: FindPublicSlotsInput = { tenantId, durationMinutes: 60, jobAddress: "12 Victim Lane" };
    expect(withAddress.tenantId).toBe(tenantId);

    const starts = (await publicSlotsOn(tenantId, WED)).map((s) => s.startTime);
    expect(starts[0]).toBe("10:30"); // the visit's end + the default 30-minute buffer
    expect(starts).not.toContain("10:00");
    // A visit whose address nobody geocoded is buffered the same way.
    const zero = (await publicSlotsOn(tenantId, WED, { travelBufferMinutes: 0 })).map((s) => s.startTime);
    expect(zero[0]).toBe("10:00");
  });

  it("checks the visitor's real drive when they ask, and a drive that doesn't fit is a plain refusal", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await createBooking(t.db, {
      tenantId,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "08:00",
      endTime: "10:00",
      ...VISIT_AT,
    });
    const maps = geocoder({ "1 Near St": NEAR, "99 Far Rd": FAR });
    const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === "10:30")!;
    const ask = (address: string, email: string) =>
      requestPublicBooking(
        t.db,
        { tenantId, slotId: slot.slotId, durationMinutes: 60, customerName: "V", customerEmail: email, address },
        { now: NOW, maps },
      );
    // 56 minutes from the 08:00 visit into a 30-minute gap: the same refusal as a taken time.
    await expect(ask("99 Far Rd", "far@example.com")).rejects.toMatchObject({ code: "slot_unavailable" });
    const receipt = await ask("1 Near St", "near@example.com");
    expect(receipt.startTime).toBe("10:30");
    expect(await getBooking(t.db, tenantId, receipt.id)).toMatchObject({ ...NEAR });
  });
});

describe("the slot grid", () => {
  it("an empty day offers a full day of starts, not just 08:00", async () => {
    const tenantId = tenant();
    await crew(tenantId);
    const slots = await publicSlotsOn(tenantId, WED);
    // 08:00 … 16:00 every 30 minutes for a 60-minute visit in an 08:00–17:00 day.
    expect(slots).toHaveLength(17);
    expect(slots[0]).toMatchObject({ date: WED, startTime: "08:00", endTime: "09:00" });
    expect(slots.at(-1)).toMatchObject({ startTime: "16:00", endTime: "17:00" });
    expect(slots.some((s) => s.startTime === "14:30")).toBe(true);
  });

  it("follows the policy's step and per-day cap", async () => {
    const tenantId = tenant();
    await crew(tenantId);
    expect(await publicSlotsOn(tenantId, WED, { slotStepMinutes: 60 })).toHaveLength(9);
    const capped = await publicSlotsOn(tenantId, WED, { maxSlotsPerDay: 3 });
    expect(capped).toHaveLength(3);
  });

  it("a crew with room for more visits still offers the whole day (the cap is not a slice)", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId, { maxJobsPerDay: 2 });
    await createBooking(t.db, {
      tenantId,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "08:00",
      endTime: "09:00",
    });
    const slots = await publicSlotsOn(tenantId, WED);
    expect(slots.some((s) => s.startTime === "15:00")).toBe(true);
  });

  it("costs the same few queries however many crews and days it covers", async () => {
    // It used to read each crew's visits once per day: a 30-day list on ten
    // crews was ~220 queries from one anonymous request.
    const tenantId = tenant();
    for (const name of ["A", "B", "C"]) await crew(tenantId, { name });
    t.queries.length = 0;
    const slots = await findPublicSlots(t.db, { tenantId, durationMinutes: 60 }, { now: NOW });
    expect(slots.length).toBeGreaterThan(100);
    expect(t.queries.length).toBeLessThanOrEqual(3); // crews, their hours, the range's visits
  });
});

describe("explicit hours", () => {
  it("a crew whose hours were never saved works Mon–Fri on its own hours", async () => {
    const tenantId = tenant();
    await crew(tenantId, { workStartTime: "09:00", workEndTime: "12:00" });
    const wed = await publicSlotsOn(tenantId, WED);
    expect(wed[0]?.startTime).toBe("09:00");
    expect(wed.at(-1)?.endTime).toBe("12:00");
    expect(await publicSlotsOn(tenantId, SAT)).toEqual([]);
  });

  it("turned off every day stays off — saving an empty week does not bring Mon–Fri back", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    expect(await setAvailability(t.db, { tenantId, resourceId: resource.id, blocks: [] })).toBe(true);
    const [saved] = await listResources(t.db, tenantId);
    expect(saved?.hoursConfigured).toBe(true);

    const week = await findPublicSlots(t.db, { tenantId, durationMinutes: 60, from: day(TUE), days: 7 }, { now: NOW });
    expect(week).toEqual([]);
    expect(
      await validateBookingSlot(t.db, {
        tenantId,
        resourceId: resource.id,
        date: day(WED),
        startTime: "10:00",
        endTime: "11:00",
      }),
    ).toMatchObject({ valid: false });
  });

  it("saved hours are the whole week: only the saved day is offered", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await setAvailability(t.db, {
      tenantId,
      resourceId: resource.id,
      blocks: [{ dayOfWeek: 6, startTime: "10:00", endTime: "14:00" }], // Saturday only
    });
    expect(await publicSlotsOn(tenantId, WED)).toEqual([]);
    expect((await publicSlotsOn(tenantId, SAT))[0]?.startTime).toBe("10:00");
  });

  it("a never-configured crew with one dated exception keeps its other weekdays", async () => {
    // 0.2 inferred "never configured" from "no rows", so one day off (written
    // by a host directly, or from 0.2 data) took every other day with it.
    const tenantId = tenant();
    const resource = await crew(tenantId);
    await t.db.insert(schedulingAvailability).values({
      tenantId,
      resourceId: resource.id,
      specificDate: day(WED),
      startTime: "00:00",
      endTime: "00:00",
      isAvailable: false,
    });
    expect(await publicSlotsOn(tenantId, WED)).toEqual([]);
    expect((await publicSlotsOn(tenantId, "2026-03-05")).length).toBeGreaterThan(0); // Thursday
  });

  it("a paused crew offers nothing online but staff can still book it", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    const [slot] = await publicSlotsOn(tenantId, WED);
    await updateResource(t.db, tenantId, resource.id, { acceptsPublicBookings: false });
    expect(await publicSlotsOn(tenantId, WED)).toEqual([]);
    await expect(
      requestPublicBooking(t.db, { tenantId, slotId: slot!.slotId, durationMinutes: 60, ...visitor }, { now: NOW }),
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    const staff = await createBooking(t.db, {
      tenantId,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "08:00",
      endTime: "09:00",
    });
    expect(staff.status).toBe("confirmed");
  });

  it("asking for every crew, removed ones included, is how a seed knows a tenant already set up", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    expect(await deactivateResource(t.db, tenantId, resource.id)).toBe(true);
    expect(await listResources(t.db, tenantId)).toEqual([]);
    expect(await listResources(t.db, tenantId, { includeInactive: true })).toHaveLength(1);
  });
});

describe("requestPublicBooking", () => {
  it("books a slot it offered: server times, pending, no client coordinates", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === "10:00")!;
    const receipt = await requestPublicBooking(
      t.db,
      {
        tenantId,
        slotId: slot.slotId,
        durationMinutes: 60,
        ...visitor,
        address: "1 Main St",
        // None of these are in the schema; a client sending them changes nothing.
        ...({ startTime: "08:00", endTime: "17:00", lat: 1, lng: 2, status: "confirmed", resourceId: "x" } as object),
      },
      { now: NOW },
    );
    expect(receipt).toEqual({
      id: expect.any(String),
      date: WED,
      startTime: "10:00",
      endTime: "11:00",
      status: "pending",
    });
    const row = await getBooking(t.db, tenantId, receipt.id);
    expect(row).toMatchObject({
      resourceId: resource.id,
      startTime: "10:00",
      endTime: "11:00",
      durationMinutes: 60,
      status: "pending",
      lat: null, // Haversine can't geocode, and client coordinates are never read
      lng: null,
      customerEmail: "pat@example.com",
      requesterKey: null,
    });
  });

  it("geocodes the address on the server when the provider can", async () => {
    const tenantId = tenant();
    await crew(tenantId);
    const maps: MapsProvider = {
      geocode: async () => ({ lat: 40.5, lng: -111.5 }),
      driveTime: async () => ({ durationMinutes: 5, distanceMiles: 2 }),
    };
    const [slot] = await publicSlotsOn(tenantId, WED);
    const receipt = await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, durationMinutes: 60, ...visitor, address: "1 Main St" },
      { now: NOW, maps },
    );
    expect(await getBooking(t.db, tenantId, receipt.id)).toMatchObject({ lat: 40.5, lng: -111.5 });
  });

  it("lands confirmed when the policy says so", async () => {
    const tenantId = tenant();
    await crew(tenantId);
    const policy = { requestStatus: "confirmed" } as const;
    const [slot] = await publicSlotsOn(tenantId, WED, policy);
    const receipt = await requestPublicBooking(
      t.db,
      { tenantId, slotId: slot!.slotId, durationMinutes: 60, ...visitor },
      { now: NOW, policy },
    );
    expect(receipt.status).toBe("confirmed");
  });

  it("two visitors racing for one slot: exactly one booking", async () => {
    const tenantId = tenant();
    await crew(tenantId);
    const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === "13:00")!;
    const ask = (name: string) =>
      requestPublicBooking(
        t.db,
        { tenantId, slotId: slot.slotId, durationMinutes: 60, customerName: name, customerEmail: `${name}@example.com` },
        { now: NOW },
      );
    const results = await Promise.allSettled([ask("first"), ask("second"), ask("third")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "slot_unavailable" });
    }
    const booked = await listBookings(t.db, tenantId, { from: day(WED), to: new Date(`${WED}T23:59:59Z`) });
    expect(booked.filter((b) => b.startTime === "13:00")).toHaveLength(1);
    // And the time is gone from what the next visitor is offered.
    expect((await publicSlotsOn(tenantId, WED)).some((s) => s.startTime === "13:00")).toBe(false);
  });

  it("a staff booking and a web request for the same time cannot both land", async () => {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === "11:00")!;
    const results = await Promise.allSettled([
      requestPublicBooking(t.db, { tenantId, slotId: slot.slotId, durationMinutes: 60, ...visitor }, { now: NOW }),
      createBooking(t.db, {
        tenantId,
        resourceId: resource.id,
        scheduledDate: day(WED),
        startTime: "11:00",
        endTime: "12:00",
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  describe("a slot id carries no authority", () => {
    it("a start maxSlotsPerDay held back is refused, though it is free", async () => {
      // The id used to seal the crew, unsigned, and the request re-checked only
      // that crew's day: re-encoding 14:00 booked a start the list never showed.
      const tenantId = tenant();
      await crew(tenantId);
      const policy = { maxSlotsPerDay: 1 };
      const offered = await publicSlotsOn(tenantId, WED, policy);
      expect(offered.map((s) => s.startTime)).toEqual(["08:00"]);
      const forged = encodeSlotId({ date: WED, startTime: "14:00" });
      await expect(
        requestPublicBooking(t.db, { tenantId, slotId: forged, durationMinutes: 60, ...visitor }, { now: NOW, policy }),
      ).rejects.toMatchObject({ code: "slot_unavailable" });
      expect(await listBookings(t.db, tenantId, { from: day(MON), to: day(SAT) })).toEqual([]);
      const receipt = await requestPublicBooking(
        t.db,
        { tenantId, slotId: offered[0]!.slotId, durationMinutes: 60, ...visitor },
        { now: NOW, policy },
      );
      expect(receipt.startTime).toBe("08:00");
    });

    it("the crew comes from the offer for the service's skill, never from the id", async () => {
      const tenantId = tenant();
      await crew(tenantId, { name: "Cleaners", skills: ["cleaning"] });
      const glass = await crew(tenantId, { name: "Glass", skills: ["glass"] });
      const slot = (await publicSlotsOn(tenantId, WED, {}, 60, "glass")).find((s) => s.startTime === "10:00")!;
      const receipt = await requestPublicBooking(
        t.db,
        { tenantId, slotId: slot.slotId, durationMinutes: 60, requiredSkill: "glass", serviceType: "glass", ...visitor },
        { now: NOW },
      );
      expect((await getBooking(t.db, tenantId, receipt.id))?.resourceId).toBe(glass.id);
    });

    it("when the offered crew takes a time, the other free crew offers it next", async () => {
      const tenantId = tenant();
      const alpha = await crew(tenantId, { name: "Alpha" });
      const bravo = await crew(tenantId, { name: "Bravo" });
      const book = async (email: string) => {
        const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === "10:00");
        if (!slot) return null;
        const receipt = await requestPublicBooking(
          t.db,
          { tenantId, slotId: slot.slotId, durationMinutes: 60, customerName: "V", customerEmail: email },
          { now: NOW },
        );
        return (await getBooking(t.db, tenantId, receipt.id))?.resourceId;
      };
      expect(await book("one@example.com")).toBe(alpha.id);
      expect(await book("two@example.com")).toBe(bravo.id);
      expect(await book("three@example.com")).toBeNull(); // both crews busy at 10:00
    });
  });

  describe("pending requests can't be used to empty the calendar", () => {
    it("one requester may hold only the policy's number of requests at once", async () => {
      const tenantId = tenant();
      const resource = await crew(tenantId);
      const ask = async (requesterKey: string, startTime: string, email: string) => {
        const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === startTime)!;
        return requestPublicBooking(
          t.db,
          { tenantId, slotId: slot.slotId, durationMinutes: 60, customerName: "Junk", customerEmail: email },
          { now: NOW, requesterKey },
        );
      };
      // A fresh email every time, as a script would: the requester is what counts.
      const first = await ask("ip:203.0.113.7", "08:00", "a@example.com");
      await ask("ip:203.0.113.7", "10:00", "b@example.com");
      await ask("ip:203.0.113.7", "12:00", "c@example.com");
      await expect(ask("ip:203.0.113.7", "14:00", "d@example.com")).rejects.toMatchObject({
        code: "too_many_requests",
      });
      expect(await getBooking(t.db, tenantId, first.id)).toMatchObject({ requesterKey: "ip:203.0.113.7" });

      // Somebody else is unaffected.
      expect((await ask("ip:198.51.100.2", "14:00", "e@example.com")).startTime).toBe("14:00");
      // Staff declining a request frees the requester's place.
      await setBookingStatus(t.db, tenantId, { id: first.id, status: "cancelled" });
      expect((await ask("ip:203.0.113.7", "16:00", "f@example.com")).startTime).toBe("16:00");
      expect(resource.id).toBeTruthy();
    });

    it("null in the policy turns the cap off", async () => {
      const tenantId = tenant();
      await crew(tenantId);
      const policy = { maxOpenRequestsPerRequester: null };
      for (const [i, startTime] of ["08:00", "10:00", "12:00", "14:00"].entries()) {
        const slot = (await publicSlotsOn(tenantId, WED, policy)).find((s) => s.startTime === startTime)!;
        await requestPublicBooking(
          t.db,
          { tenantId, slotId: slot.slotId, durationMinutes: 60, customerName: "V", customerEmail: `v${i}@example.com` },
          { now: NOW, policy, requesterKey: "ip:203.0.113.7" },
        );
      }
      expect(await listBookings(t.db, tenantId, { from: day(WED), to: day(WED) })).toHaveLength(4);
    });
  });

  describe("an address", () => {
    it("a geocoding provider that can't place it refuses the request, rather than booking it unchecked", async () => {
      // It used to book with no coordinates, and a visit with none skips every
      // drive check — "99 Far Rd, gate code 1234 #" got past a drive "99 Far
      // Rd" was refused for.
      const tenantId = tenant();
      await crew(tenantId);
      const maps = geocoder({ "99 Far Rd": FAR });
      const [slot] = await publicSlotsOn(tenantId, WED);
      await expect(
        requestPublicBooking(
          t.db,
          { tenantId, slotId: slot!.slotId, durationMinutes: 60, ...visitor, address: "99 Far Rd, gate code 1234 #" },
          { now: NOW, maps },
        ),
      ).rejects.toMatchObject({ code: "address_unresolved" });
      expect(await listBookings(t.db, tenantId, { from: day(MON), to: day(SAT) })).toEqual([]);
    });

    it("the keyless provider, which can't geocode at all, books without coordinates as before", async () => {
      const tenantId = tenant();
      await crew(tenantId);
      const [slot] = await publicSlotsOn(tenantId, WED);
      const receipt = await requestPublicBooking(
        t.db,
        { tenantId, slotId: slot!.slotId, durationMinutes: 60, ...visitor, address: "Anywhere" },
        { now: NOW, maps: createHaversineMapsProvider() },
      );
      expect(await getBooking(t.db, tenantId, receipt.id)).toMatchObject({ address: "Anywhere", lat: null });
    });

    it("requireAddress refuses a request with none", async () => {
      const tenantId = tenant();
      await crew(tenantId);
      const policy = { requireAddress: true };
      const [slot] = await publicSlotsOn(tenantId, WED, policy);
      await expect(
        requestPublicBooking(t.db, { tenantId, slotId: slot!.slotId, durationMinutes: 60, ...visitor }, { now: NOW, policy }),
      ).rejects.toMatchObject({ code: "address_unresolved" });
    });
  });

  describe("a request sent twice", () => {
    it("a retry gets the first receipt back, not 'that time is gone'", async () => {
      const tenantId = tenant();
      await crew(tenantId);
      const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === "13:00")!;
      const ask = (email: string) =>
        requestPublicBooking(
          t.db,
          { tenantId, slotId: slot.slotId, durationMinutes: 60, customerName: "Pat", customerEmail: email },
          { now: NOW, requesterKey: "ip:203.0.113.7" },
        );
      const first = await ask("pat@example.com");
      expect(await ask("PAT@example.com")).toEqual(first);
      // Somebody else asking for that time is still refused.
      await expect(ask("other@example.com")).rejects.toMatchObject({ code: "slot_unavailable" });
      expect(await listBookings(t.db, tenantId, { from: day(WED), to: day(WED) })).toHaveLength(1);
    });

    it("a double click: both land on one visit", async () => {
      const tenantId = tenant();
      await crew(tenantId);
      const slot = (await publicSlotsOn(tenantId, WED)).find((s) => s.startTime === "15:00")!;
      const ask = () =>
        requestPublicBooking(t.db, { tenantId, slotId: slot.slotId, durationMinutes: 60, ...visitor }, { now: NOW });
      const [a, b] = await Promise.all([ask(), ask()]);
      expect(a.id).toBe(b.id);
      expect(await listBookings(t.db, tenantId, { from: day(WED), to: day(WED) })).toHaveLength(1);
    });
  });

  describe("refusals", () => {
    async function setUp(overrides: Record<string, unknown> = {}) {
      const tenantId = tenant();
      const resource = await crew(tenantId, overrides);
      const ask = (date: string, startTime: string, durationMinutes = 60) =>
        requestPublicBooking(
          t.db,
          { tenantId, slotId: encodeSlotId({ date, startTime }), durationMinutes, ...visitor },
          { now: NOW },
        );
      return { tenantId, resource, ask };
    }

    it("a date in the past", async () => {
      const { ask } = await setUp();
      await expect(ask("2026-02-25", "10:00")).rejects.toMatchObject({ code: "too_soon" });
    });

    it("inside the minimum notice (later today)", async () => {
      const { ask } = await setUp();
      await expect(ask(MON, "15:00")).rejects.toMatchObject({ code: "too_soon" });
    });

    it("beyond the horizon", async () => {
      const { ask } = await setUp();
      await expect(ask("2026-04-15", "10:00")).rejects.toMatchObject({ code: "too_far" });
    });

    it("over the crew's maxJobsPerDay", async () => {
      const { tenantId, resource, ask } = await setUp({ maxJobsPerDay: 1 });
      await createBooking(t.db, {
        tenantId,
        resourceId: resource.id,
        scheduledDate: day(WED),
        startTime: "08:00",
        endTime: "09:00",
      });
      expect(await publicSlotsOn(tenantId, WED)).toEqual([]);
      await expect(ask(WED, "13:00")).rejects.toMatchObject({ code: "slot_unavailable" });
    });

    it("a start that is not on the grid", async () => {
      const { ask } = await setUp();
      await expect(ask(WED, "10:10")).rejects.toMatchObject({ code: "slot_unavailable" });
    });

    it("a time outside the crew's hours, or one that runs past closing", async () => {
      const { ask } = await setUp();
      await expect(ask(WED, "18:00")).rejects.toMatchObject({ code: "slot_unavailable" });
      await expect(ask(WED, "16:30")).rejects.toMatchObject({ code: "slot_unavailable" }); // 16:30–17:30
      await expect(ask(SAT, "10:00")).rejects.toMatchObject({ code: "slot_unavailable" });
    });

    it("a time that overlaps another visit", async () => {
      const { tenantId, resource, ask } = await setUp();
      await createBooking(t.db, {
        tenantId,
        resourceId: resource.id,
        scheduledDate: day(WED),
        startTime: "10:00",
        endTime: "12:00",
      });
      await expect(ask(WED, "11:00")).rejects.toMatchObject({ code: "slot_unavailable" });
    });

    it("a duration the policy doesn't offer (a whole day)", async () => {
      const { ask } = await setUp();
      await expect(ask(WED, "08:00", 480)).rejects.toMatchObject({ code: "invalid_duration" });
    });

    it("a slot id that isn't one", async () => {
      const { tenantId } = await setUp();
      const legacy = Buffer.from(JSON.stringify(["s1", "some-crew", WED, "10:00"])).toString("base64url");
      for (const slotId of ["nope", legacy, encodeSlotId({ date: "2026-02-31", startTime: "10:00" })]) {
        await expect(
          requestPublicBooking(t.db, { tenantId, slotId, durationMinutes: 60, ...visitor }, { now: NOW }),
        ).rejects.toMatchObject({ code: "slot_unavailable" });
      }
    });

    it("an email that isn't one", async () => {
      const { tenantId } = await setUp();
      const [slot] = await publicSlotsOn(tenantId, WED);
      await expect(
        requestPublicBooking(
          t.db,
          { tenantId, slotId: slot!.slotId, durationMinutes: 60, customerName: "Pat", customerEmail: "not-an-email" },
          { now: NOW },
        ),
      ).rejects.toThrow();
      expect(await listBookings(t.db, tenantId, { from: day(MON), to: day(SAT) })).toEqual([]);
    });
  });
});

describe("status transitions", () => {
  async function booked() {
    const tenantId = tenant();
    const resource = await crew(tenantId);
    const visit = await createBooking(t.db, {
      tenantId,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "10:00",
      endTime: "11:00",
      status: "pending",
    });
    return { tenantId, resource, visit };
  }

  it("refuses illegal moves and leaves the visit as it was", async () => {
    const { tenantId, visit } = await booked();
    await expect(setBookingStatus(t.db, tenantId, { id: visit.id, status: "completed" })).rejects.toBeInstanceOf(
      BookingStatusTransitionError,
    );
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" })).toBe(true);
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "completed" })).toBe(true);
    await expect(setBookingStatus(t.db, tenantId, { id: visit.id, status: "pending" })).rejects.toBeInstanceOf(
      BookingStatusTransitionError,
    );
    expect((await getBooking(t.db, tenantId, visit.id))?.status).toBe("completed");
  });

  it("re-asserting the current status is a no-op, not an error", async () => {
    const { tenantId, visit } = await booked();
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "pending" })).toBe(true);
  });

  it("un-cancelling re-validates: a slot rebooked since can't be double-booked", async () => {
    const { tenantId, resource, visit } = await booked();
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "cancelled" })).toBe(true);
    await createBooking(t.db, {
      tenantId,
      resourceId: resource.id,
      scheduledDate: day(WED),
      startTime: "10:00",
      endTime: "11:00",
    });
    await expect(setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" })).rejects.toMatchObject({
      code: "slot_unavailable",
    });
    expect((await getBooking(t.db, tenantId, visit.id))?.status).toBe("cancelled");
  });

  it("un-cancelling a visit whose slot is still free puts it back", async () => {
    const { tenantId, visit } = await booked();
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "cancelled" });
    expect(await setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" })).toBe(true);
    expect((await getBooking(t.db, tenantId, visit.id))?.status).toBe("confirmed");
  });

  it("a no-show brought back is re-validated the same way", async () => {
    const { tenantId, resource, visit } = await booked();
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" });
    await setBookingStatus(t.db, tenantId, { id: visit.id, status: "no_show" });
    await setAvailability(t.db, { tenantId, resourceId: resource.id, blocks: [] }); // crew since turned off
    await expect(setBookingStatus(t.db, tenantId, { id: visit.id, status: "confirmed" })).rejects.toMatchObject({
      code: "outside_hours",
    });
  });
});

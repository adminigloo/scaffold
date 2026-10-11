import { describe, expect, it } from "vitest";
import {
  BookingNotBookableError,
  createBooking,
  validateBookingSlot,
} from "../index.js";
import {
  schedulingAvailability,
  schedulingBookings,
  schedulingResources,
} from "../schema.js";

/**
 * The guard on the DIRECT booking path: a caller-supplied slot must fall inside
 * the resource's working window, and createBooking must refuse an out-of-hours
 * or off-day slot rather than write it. (The port had dropped both; slots at 3am
 * or on a day off could be inserted.)
 */

// Monday and Sunday in UTC — the weekday fallback (Mon–Fri work hours) applies
// to the first and not the second.
const MONDAY = new Date("2026-02-02T00:00:00Z");
const SUNDAY = new Date("2026-02-01T00:00:00Z");

const RESOURCE = {
  id: "res-1",
  tenantId: "t1",
  name: "Installer",
  workStartTime: "08:00",
  workEndTime: "17:00",
  maxJobsPerDay: 5,
  hoursConfigured: false,
  isActive: true,
};

/** A drizzle-shaped fake routed by table reference. `.where()` is both awaitable
 * (availability/bookings read it directly) and has `.limit()` (the resource read).
 * It ignores every WHERE, so it can prove the ORDER of validate-then-write and
 * nothing about tenant scoping — the PGlite suite (services.test.ts) does that.
 * `transaction` runs the callback on the same fake and `execute` (the advisory
 * lock) is recorded, so the 0.3 lock-then-validate path runs here unchanged. */
function fakeDb(state: {
  resource?: typeof RESOURCE | null;
  availability?: unknown[];
  bookings?: unknown[];
}) {
  const inserted: unknown[] = [];
  const locks: unknown[] = [];
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schedulingResources) return state.resource ? [state.resource] : [];
    if (table === schedulingAvailability) return state.availability ?? [];
    if (table === schedulingBookings) return state.bookings ?? [];
    return [];
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = rowsFor(table);
        return {
          where: () => Object.assign(Promise.resolve(rows), { limit: async () => rows }),
        };
      },
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ ...v, id: "bk-1", createdAt: new Date() }] };
      },
    }),
    execute: async (query: unknown) => {
      locks.push(query);
      return [];
    },
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
  };
  return { db: db as never, inserted, locks };
}

describe("validateBookingSlot — availability window", () => {
  it("accepts a slot inside the weekday fallback window", async () => {
    const { db } = fakeDb({ resource: RESOURCE });
    const r = await validateBookingSlot(db, {
      tenantId: "t1",
      resourceId: "res-1",
      date: MONDAY,
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(r.valid).toBe(true);
  });

  it("rejects a slot outside the working window (3am)", async () => {
    const { db } = fakeDb({ resource: RESOURCE });
    const r = await validateBookingSlot(db, {
      tenantId: "t1",
      resourceId: "res-1",
      date: MONDAY,
      startTime: "03:00",
      endTime: "05:00",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/outside availability/i);
  });

  it("rejects a day the resource is not available (weekend, no rows)", async () => {
    const { db } = fakeDb({ resource: RESOURCE });
    const r = await validateBookingSlot(db, {
      tenantId: "t1",
      resourceId: "res-1",
      date: SUNDAY,
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not available/i);
  });

  it("rejects an unknown resource", async () => {
    const { db } = fakeDb({ resource: null });
    const r = await validateBookingSlot(db, {
      tenantId: "t1",
      resourceId: "ghost",
      date: MONDAY,
      startTime: "10:00",
      endTime: "12:00",
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/not found/i);
  });
});

describe("createBooking — validates before writing", () => {
  const validInput = {
    tenantId: "t1",
    resourceId: "res-1",
    scheduledDate: MONDAY,
    startTime: "10:00",
    endTime: "12:00",
  };

  it("writes a valid, in-hours booking, under the resource lock", async () => {
    const { db, inserted, locks } = fakeDb({ resource: RESOURCE });
    const row = await createBooking(db, validInput);
    expect(row.id).toBe("bk-1");
    expect(inserted).toHaveLength(1);
    expect(locks).toHaveLength(1);
  });

  it("stores the duration the times describe, not a default", async () => {
    const { db, inserted } = fakeDb({ resource: RESOURCE });
    await createBooking(db, validInput); // 10:00–12:00, no durationMinutes given
    expect(inserted[0]).toMatchObject({ durationMinutes: 120 });
    await createBooking(db, { ...validInput, endTime: "10:45", durationMinutes: 300 });
    expect(inserted[1]).toMatchObject({ durationMinutes: 45 });
  });

  it("refuses a booking past the crew's daily cap", async () => {
    const full = Array.from({ length: RESOURCE.maxJobsPerDay }, (_, i) => ({
      startTime: `${String(13 + i).padStart(2, "0")}:00`,
      endTime: `${String(13 + i).padStart(2, "0")}:30`,
      status: "confirmed",
      lat: null,
      lng: null,
    }));
    const { db, inserted } = fakeDb({ resource: RESOURCE, bookings: full });
    await expect(createBooking(db, validInput)).rejects.toThrow(/fully booked/i);
    expect(inserted).toHaveLength(0);
  });

  it("refuses an out-of-hours booking", async () => {
    const { db, inserted } = fakeDb({ resource: RESOURCE });
    await expect(
      createBooking(db, { ...validInput, startTime: "03:00", endTime: "05:00" }),
    ).rejects.toBeInstanceOf(BookingNotBookableError);
    expect(inserted).toHaveLength(0); // nothing written
  });

  it("skips validation for a trusted caller (seed/override)", async () => {
    const { db, inserted } = fakeDb({ resource: RESOURCE });
    const row = await createBooking(
      db,
      { ...validInput, startTime: "03:00", endTime: "05:00" },
      { skipValidation: true },
    );
    expect(row.id).toBe("bk-1");
    expect(inserted).toHaveLength(1);
  });

  it("writes an unassigned booking without validation (no resource to check)", async () => {
    const { db, inserted } = fakeDb({ resource: RESOURCE });
    const row = await createBooking(db, {
      tenantId: "t1",
      resourceId: null,
      scheduledDate: SUNDAY,
      startTime: "03:00",
      endTime: "05:00",
    });
    expect(row.id).toBe("bk-1");
    expect(inserted).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import * as bookingSchema from "@adminigloo/booking/schema";
import type { BookingStatus } from "@adminigloo/booking/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { callsGlance } from "../glances/booking.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 60 * 60 * 1000);
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * DAY_MS);

/** Mirrors the glance's own per-call time format, so the test never hardcodes a weekday. */
function fmt(date: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...bookingSchema }, logQueries: false });
  close = () => t.close();
  return t.db;
}

type Db = Awaited<ReturnType<typeof setup>>;

async function addType(db: Db, tenantId: string): Promise<string> {
  const [row] = await db
    .insert(bookingSchema.bookingTypes)
    .values({ tenantId, key: "intro", name: "Intro call", durationMinutes: 30 })
    .returning({ id: bookingSchema.bookingTypes.id });
  return row!.id;
}

async function addBooking(
  db: Db,
  tenantId: string,
  typeId: string,
  input: { status: BookingStatus; startUtc: Date; hostTimezone?: string; inviteeName?: string | null },
) {
  await db.insert(bookingSchema.bookingBookings).values({
    tenantId,
    typeId,
    hostId: "host-1",
    status: input.status,
    startUtc: input.startUtc,
    endUtc: new Date(input.startUtc.getTime() + 30 * 60 * 1000),
    hostTimezone: input.hostTimezone ?? "UTC",
    inviteeName: input.inviteeName ?? null,
  });
}

describe("callsGlance", () => {
  it("shows no calls when the calendar is empty", async () => {
    const db = await setup();
    const glance = await callsGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glance.status).toEqual({ text: "No calls today.", tone: "good" });
    expect(glance.attention).toBe(0);
    expect(glance.tiles?.map((t) => t.value)).toEqual([0, 0, 0]);
    expect(glance.list?.rows).toEqual([]);
  });

  it("counts today, the next 7 days and calls needing a response, and lists the next calls soonest first", async () => {
    const db = await setup();
    const typeId = await addType(db, "tenant-a");

    // Today, confirmed, in the future: counts today AND upcoming AND is listed, in Denver time.
    await addBooking(db, "tenant-a", typeId, { status: "confirmed", startUtc: hoursFromNow(2), hostTimezone: "America/Denver", inviteeName: "Jane Doe" });
    // Today, requested (needs a response): counts today, upcoming AND waiting, listed first (soonest).
    await addBooking(db, "tenant-a", typeId, { status: "requested", startUtc: hoursFromNow(1), inviteeName: "Bob Lee" });
    // Today, confirmed, but already earlier today: counts today, but not upcoming (it's in the past) or listed.
    await addBooking(db, "tenant-a", typeId, { status: "confirmed", startUtc: hoursFromNow(-3), inviteeName: "Early Bird" });
    // Three days out: counts upcoming, listed; not today.
    await addBooking(db, "tenant-a", typeId, { status: "confirmed", startUtc: daysFromNow(3), inviteeName: "Future Call" });
    // Ten days out: outside the 7-day window, but still among the next 5 calls.
    await addBooking(db, "tenant-a", typeId, { status: "confirmed", startUtc: daysFromNow(10), inviteeName: "Far Future" });
    // Cancelled: never counted, never listed, even though it's today and soon.
    await addBooking(db, "tenant-a", typeId, { status: "cancelled", startUtc: hoursFromNow(1) });
    // A hold: a mid-flow claim, not a real call yet.
    await addBooking(db, "tenant-a", typeId, { status: "hold", startUtc: hoursFromNow(1) });
    // Completed earlier today: counts today (it happened), not upcoming, not listed.
    await addBooking(db, "tenant-a", typeId, { status: "completed", startUtc: hoursFromNow(-5) });

    const glance = await callsGlance({ db, tenantId: "tenant-a", now: NOW });

    expect(glance.tiles?.map((t) => ({ label: t.label, value: t.value }))).toEqual([
      { label: "Today", value: 4 },
      { label: "Next 7 days", value: 3 },
      { label: "Needs a response", value: 1 },
    ]);
    expect(glance.tiles?.every((t) => t.href === "/app/calls")).toBe(true);
    expect(glance.attention).toBe(1);
    expect(glance.status).toEqual({ text: "1 call waiting for your response.", tone: "warn" });

    expect(glance.list?.rows).toEqual([
      { title: "Bob Lee", meta: fmt(hoursFromNow(1), "UTC"), badge: "Needs confirmation", tone: "warn", href: "/app/calls" },
      { title: "Jane Doe", meta: fmt(hoursFromNow(2), "America/Denver"), badge: undefined, tone: undefined, href: "/app/calls" },
      { title: "Future Call", meta: fmt(daysFromNow(3), "UTC"), badge: undefined, tone: undefined, href: "/app/calls" },
      { title: "Far Future", meta: fmt(daysFromNow(10), "UTC"), badge: undefined, tone: undefined, href: "/app/calls" },
    ]);
  });

  it("never counts or lists another tenant's calls", async () => {
    const db = await setup();
    const typeA = await addType(db, "tenant-a");
    const typeB = await addType(db, "tenant-b");

    await addBooking(db, "tenant-a", typeA, { status: "confirmed", startUtc: hoursFromNow(1), inviteeName: "Tenant A's call" });

    await addBooking(db, "tenant-b", typeB, { status: "requested", startUtc: hoursFromNow(1), inviteeName: "Tenant B's call" });
    for (let i = 2; i <= 5; i += 1) await addBooking(db, "tenant-b", typeB, { status: "confirmed", startUtc: hoursFromNow(i) });

    const glanceA = await callsGlance({ db, tenantId: "tenant-a", now: NOW });
    expect(glanceA.tiles?.map((t) => t.value)).toEqual([1, 1, 0]);
    expect(glanceA.list?.rows.map((r) => r.title)).toEqual(["Tenant A's call"]);

    const glanceB = await callsGlance({ db, tenantId: "tenant-b", now: NOW });
    expect(glanceB.tiles?.map((t) => t.value)).toEqual([5, 5, 1]);
  });
});

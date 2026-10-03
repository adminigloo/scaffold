import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { BusySource } from "../busy-source.js";
import { BookingError } from "../errors.js";
import { bookingBookings, bookingEvents } from "../schema.js";
import type { BookingContext, BookingEvent } from "../services/context.js";
import {
  addBlackout,
  addException,
  confirmBooking,
  countLiveHolds,
  getAvailability,
  getBooking,
  hostCancelBooking,
  hostRescheduleBooking,
  listBookings,
  listHosts,
  removeException,
  rotateHostFeedToken,
  setOutcome,
  setWeeklyAvailability,
  testBusySource,
  upsertHost,
  upsertType,
  type UpsertTypeInput,
} from "../services/admin.js";
import {
  book,
  cancelByToken,
  getBookingByToken,
  getPublicConfig,
  holdSlot,
  hostFeed,
  icsByToken,
  listOpenSlots,
  releaseHold,
  rescheduleByToken,
  type BookInput,
} from "../services/public.js";
import { purgeExpiredHolds, purgeTenants, seedSandboxTenant } from "../services/maintenance.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

/** Monday 2026-10-05, 09:00 in Denver (MDT, UTC-6). */
const NOW = new Date("2026-10-05T15:00:00Z");
const MIN = 60_000;
const at = (iso: string) => new Date(iso);
/** Monday 13:00 MDT — the first start four hours' notice allows. */
const FIRST = "2026-10-05T19:00:00.000Z";
const TUE_10 = "2026-10-06T16:00:00.000Z";
const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 }));

async function setup(
  options: {
    type?: Partial<UpsertTypeInput>;
    host?: Record<string, unknown>;
    ctx?: Partial<BookingContext>;
  } = {},
) {
  const tenantId = tenant();
  const ctx: BookingContext = { db: t.db, tenantId, now: NOW, ...options.ctx };
  const host = await upsertHost(ctx, {
    displayName: "Dallin Humphrey",
    email: "dallin@adminigloo.com",
    timezone: "America/Denver",
    meetingLink: "https://meet.example.com/dallin",
    phone: "+1 801 555 0143",
    ...options.host,
  });
  await setWeeklyAvailability(ctx, { hostId: host.id, windows: WEEKDAYS_9_TO_5 });
  const type = await upsertType(ctx, {
    key: "intro",
    name: "Intro call",
    durationMinutes: 30,
    media: ["video", "phone", "prospect_hosted"],
    ...options.type,
  });
  return { ctx, host, type, tenantId };
}

function invitee(overrides: Partial<BookInput> = {}): BookInput {
  return {
    typeKey: "intro",
    start: FIRST,
    name: "Ada Lovelace",
    email: "Ada@Example.com",
    medium: "video",
    timezone: "Europe/London",
    company: "Analytical Engines",
    notes: "Interested in the support console.",
    ...overrides,
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (error instanceof BookingError) return error.code;
    throw error;
  }
}

async function rows(tenantId: string) {
  return t.db.select().from(bookingBookings).where(eq(bookingBookings.tenantId, tenantId));
}

describe("config and slots", () => {
  it("serves the first host and the bookable types", async () => {
    const { ctx } = await setup();
    const config = await getPublicConfig({ ...ctx, sandbox: true });
    expect(config).toEqual({
      sandbox: true,
      hostDisplayName: "Dallin Humphrey",
      hostTimezone: "America/Denver",
      types: [
        {
          key: "intro",
          name: "Intro call",
          description: "",
          durationMinutes: 30,
          media: ["video", "phone", "prospect_hosted"],
          minNoticeMinutes: 240,
          horizonDays: 21,
        },
      ],
      emailsEnabled: true,
      contactEmail: null,
    });
    expect("defaultCallingCode" in config).toBe(false);
  });

  it("advertises the type's own notice and horizon, and a configured calling code", async () => {
    const { ctx } = await setup({ type: { minNoticeMinutes: 60, horizonDays: 45 }, ctx: { defaultCallingCode: "+1" } });
    const config = await getPublicConfig(ctx);
    expect(config.types[0]).toMatchObject({ minNoticeMinutes: 60, horizonDays: 45 });
    expect(config.defaultCallingCode).toBe("1");
    // Not a calling code: not advertised (and not applied — see the phone tests).
    expect("defaultCallingCode" in (await getPublicConfig({ ...ctx, defaultCallingCode: "USA" }))).toBe(false);
  });

  it("lists open starts from the notice boundary, weekdays only, and says sync is off", async () => {
    const { ctx } = await setup();
    const result = await listOpenSlots(ctx, { typeKey: "intro" });
    expect(result.busySync).toBe("off");
    expect(result.slots[0]).toEqual({ start: FIRST, end: "2026-10-05T19:30:00.000Z" });
    const mondays = result.slots.filter((slot) => slot.start.startsWith("2026-10-05"));
    expect(mondays).toHaveLength(8); // 13:00 … 16:30
    expect(result.slots.some((slot) => slot.start.startsWith("2026-10-10"))).toBe(false); // Saturday
    // Horizon: 21 host-zone days, today included → nothing on or after 2026-10-26 (Denver).
    expect(result.slots.every((slot) => slot.start < "2026-10-26T06:00:00.000Z")).toBe(true);
  });

  it("clamps an explicit window to 31 days and to the horizon", async () => {
    const { ctx } = await setup({ type: { horizonDays: 365 } });
    const result = await listOpenSlots(ctx, { typeKey: "intro", from: "2026-10-05T00:00:00Z", to: "2027-06-01T00:00:00Z" });
    const last = result.slots[result.slots.length - 1];
    expect(last && Date.parse(last.start) - NOW.getTime()).toBeLessThan(32 * 24 * 60 * MIN);
  });

  it("not_found for an unknown or inactive type", async () => {
    const { ctx } = await setup();
    expect(await code(listOpenSlots(ctx, { typeKey: "nope" }))).toBe("not_found");
    await upsertType(ctx, { key: "intro", name: "Intro call", durationMinutes: 30, media: ["video"], isActive: false });
    expect(await code(listOpenSlots(ctx, { typeKey: "intro" }))).toBe("not_found");
  });

  it("honours exceptions and blackouts", async () => {
    const { ctx, host } = await setup();
    const tuesday = (slots: Array<{ start: string }>) => slots.filter((slot) => slot.start.startsWith("2026-10-06"));
    const off = await addException(ctx, { hostId: host.id, date: "2026-10-06", kind: "off" });
    expect(tuesday((await listOpenSlots(ctx, { typeKey: "intro" })).slots)).toHaveLength(0);
    await removeException(ctx, off.id);
    await addException(ctx, { hostId: host.id, date: "2026-10-06", kind: "block", startMinute: 540, endMinute: 720 });
    expect(tuesday((await listOpenSlots(ctx, { typeKey: "intro" })).slots)[0]?.start).toBe("2026-10-06T18:00:00.000Z"); // 12:00
    await addBlackout(ctx, { date: "2026-10-06", label: "Holiday" });
    expect(tuesday((await listOpenSlots(ctx, { typeKey: "intro" })).slots)).toHaveLength(0);
    const availability = await getAvailability(ctx, { hostId: host.id });
    expect(availability.weekly).toHaveLength(5);
    expect(availability.exceptions.map((e) => e.kind)).toEqual(["block"]);
  });
});

describe("holds", () => {
  it("a hold takes the time off the market, and a second claimant gets slot_taken", async () => {
    const { ctx } = await setup();
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    expect(hold.start).toBe(FIRST);
    expect(hold.expiresAt).toBe(new Date(NOW.getTime() + 10 * MIN).toISOString());
    expect(hold.holdToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const slots = await listOpenSlots(ctx, { typeKey: "intro" });
    expect(slots.slots.some((slot) => slot.start === FIRST)).toBe(false);
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: FIRST }))).toBe("slot_taken");
  });

  it("two racing holds for one start: exactly one wins", async () => {
    const { ctx } = await setup();
    const results = await Promise.allSettled([
      holdSlot(ctx, { typeKey: "intro", start: FIRST }),
      holdSlot(ctx, { typeKey: "intro", start: FIRST }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as BookingError).code).toBe("slot_taken");
  });

  it("previousHoldToken releases the caller's old hold in the same transaction", async () => {
    const { ctx, tenantId } = await setup({ type: { durationMinutes: 60 } });
    const first = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    // 13:30 overlaps the held 13:00–14:00; it is only free once the old hold goes.
    const second = await holdSlot(ctx, { typeKey: "intro", start: "2026-10-05T19:30:00Z", previousHoldToken: first.holdToken });
    expect(second.start).toBe("2026-10-05T19:30:00.000Z");
    const holds = (await rows(tenantId)).filter((row) => row.status === "hold");
    expect(holds).toHaveLength(1);
  });

  it("an expired hold frees its time without becoming a cancellation", async () => {
    const { ctx, tenantId } = await setup();
    await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    const later = { ...ctx, now: new Date(NOW.getTime() + 11 * MIN) };
    expect((await listOpenSlots(later, { typeKey: "intro" })).slots.some((slot) => slot.start === TUE_10)).toBe(true);
    expect((await rows(tenantId)).map((row) => row.status)).toEqual(["hold"]);
  });

  it("releaseHold always answers ok and frees a live hold", async () => {
    const { ctx } = await setup();
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    expect(await releaseHold(ctx, { holdToken: hold.holdToken })).toEqual({ ok: true });
    expect(await releaseHold(ctx, { holdToken: "unknown-token-unknown-token" })).toEqual({ ok: true });
    expect(await releaseHold(ctx, { holdToken: "../junk" })).toEqual({ ok: true });
    expect((await listOpenSlots(ctx, { typeKey: "intro" })).slots[0]?.start).toBe(FIRST);
  });

  it("a replaced or released hold takes its audit rows with it", async () => {
    const { ctx, tenantId } = await setup();
    const first = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    const second = await holdSlot(ctx, { typeKey: "intro", start: TUE_10, previousHoldToken: first.holdToken });
    await releaseHold(ctx, { holdToken: second.holdToken });
    const events = await t.db.select().from(bookingEvents).where(eq(bookingEvents.tenantId, tenantId));
    expect(events).toEqual([]);
    expect(await rows(tenantId)).toEqual([]);
  });

  it("refuses a start that is off the grid, outside hours, or inside the notice window", async () => {
    const { ctx } = await setup();
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: "2026-10-05T19:10:00Z" }))).toBe("slot_taken");
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: "2026-10-05T16:00:00Z" }))).toBe("slot_taken"); // 10:00, inside notice
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: "2026-10-04T16:00:00Z" }))).toBe("slot_taken"); // Sunday
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: "yesterday" }))).toBe("invalid");
  });
});

describe("book", () => {
  it("converts the live hold in place: one row, one id, from first click to confirmation", async () => {
    const { ctx, tenantId } = await setup();
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    const [heldRow] = await rows(tenantId);
    const result = await book({ ...ctx, now: new Date(NOW.getTime() + 5 * MIN) }, invitee({ holdToken: hold.holdToken }));
    const after = await rows(tenantId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(heldRow?.id);
    expect(after[0]?.status).toBe("confirmed");
    // No longer a hold — but it keeps the hold's token hash, so a second
    // submit of the same form is recognised (already_booked).
    expect(after[0]?.holdExpiresAt).toBeNull();
    expect(after[0]?.holdTokenHash).toBe(heldRow?.holdTokenHash);
    expect(after[0]?.holdTokenHash).not.toBe(hold.holdToken);
    expect(after[0]?.inviteeEmail).toBe("ada@example.com");
    expect(after[0]?.manageTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after[0]?.manageTokenHash).not.toBe(result.manageToken);
    expect(result.booking).toMatchObject({
      status: "confirmed",
      start: FIRST,
      end: "2026-10-05T19:30:00.000Z",
      typeName: "Intro call",
      typeKey: "intro",
      durationMinutes: 30,
      hostDisplayName: "Dallin Humphrey",
      hostTimezone: "America/Denver",
      inviteeName: "Ada Lovelace",
      inviteeTimezone: "Europe/London",
      medium: "video",
      meetingLink: "https://meet.example.com/dallin",
      hostPhone: null,
      inviteMailbox: null,
      canCancel: true,
      canReschedule: true,
      sandbox: false,
    });
    expect(result.booking.googleCalendarUrl).toContain("calendar.google.com");
    const events = await t.db.select().from(bookingEvents).where(eq(bookingEvents.tenantId, tenantId));
    expect(events.map((event) => event.kind)).toEqual(["held", "booked"]);
    expect(JSON.stringify(events)).not.toContain(result.manageToken);
    expect(JSON.stringify(events)).not.toContain("support console");
  });

  it("a live hold keeps its time even when the notice boundary has since passed it", async () => {
    // 13:00 is exactly four hours out at 09:00; five minutes later it is not.
    const { ctx } = await setup();
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    const later = { ...ctx, now: new Date(NOW.getTime() + 5 * MIN) };
    expect((await book(later, invitee({ holdToken: hold.holdToken }))).booking.start).toBe(FIRST);
  });

  it("books directly without a hold, and a second booking of the same time is slot_taken", async () => {
    const { ctx } = await setup();
    await book(ctx, invitee());
    expect(await code(book(ctx, invitee({ email: "grace@example.com" })))).toBe("slot_taken");
  });

  it("an expired hold still books a time that is free — and says hold_expired when it is not", async () => {
    const { ctx } = await setup();
    const mine = await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    const later = { ...ctx, now: new Date(NOW.getTime() + 11 * MIN) };
    expect((await book(later, invitee({ holdToken: mine.holdToken, start: TUE_10 }))).booking.status).toBe("confirmed");

    const other = await setup();
    const lapsed = await holdSlot(other.ctx, { typeKey: "intro", start: TUE_10 });
    const afterwards = { ...other.ctx, now: new Date(NOW.getTime() + 11 * MIN) };
    // Someone else takes the time once the hold has lapsed…
    await book(afterwards, invitee({ start: TUE_10, email: "y@example.com" }));
    // …so the original holder is told their hold expired, not just "taken".
    expect(await code(book(afterwards, invitee({ start: TUE_10, holdToken: lapsed.holdToken })))).toBe("hold_expired");
    // Without a hold token the same refusal is plain slot_taken.
    expect(await code(book(afterwards, invitee({ start: TUE_10, email: "z@example.com" })))).toBe("slot_taken");
  });

  it("validates the form", async () => {
    const { ctx } = await setup({ type: { media: ["video", "phone"] } });
    const noPhone = await code(book(ctx, invitee({ medium: "phone" })));
    expect(noPhone).toBe("invalid");
    try {
      await book(ctx, invitee({ medium: "phone" }));
    } catch (error) {
      expect((error as BookingError).issues?.[0]?.path).toEqual(["phone"]);
    }
    expect(await code(book(ctx, invitee({ medium: "prospect_hosted" })))).toBe("invalid");
    expect(await code(book(ctx, invitee({ email: "nope" })))).toBe("invalid");
    expect(await code(book(ctx, invitee({ name: " " })))).toBe("invalid");
    expect(await code(book(ctx, invitee({ notes: "x".repeat(1001) })))).toBe("invalid");
    const phoned = await book(ctx, invitee({ medium: "phone", phone: "+44 20 7946 0958" }));
    expect(phoned.booking.hostPhone).toBe("+18015550143");
    expect(phoned.booking.meetingLink).toBeNull();
  });

  it("falls back to the host zone for an unknown invitee zone, and scrubs the source", async () => {
    const { ctx, tenantId } = await setup();
    const result = await book(ctx, invitee({ timezone: "Mars/Olympus", source: "ada@example.com" }));
    expect(result.booking.inviteeTimezone).toBe("America/Denver");
    expect((await rows(tenantId))[0]?.source).toBeNull();
  });

  it("a host without autoConfirm gets a request, which the host confirms", async () => {
    const events: BookingEvent[] = [];
    const { ctx, tenantId } = await setup({ host: { autoConfirm: false }, ctx: { onEvent: (e) => void events.push(e) } });
    const result = await book(ctx, invitee());
    expect(result.booking.status).toBe("requested");
    const [row] = await rows(tenantId);
    const confirmed = await confirmBooking(ctx, row?.id ?? "");
    expect(confirmed.status).toBe("confirmed");
    expect(events.map((e) => e.event)).toEqual(["booking.created", "booking.confirmed"]);
  });

  it("prospect_hosted tells the prospect which mailbox to invite", async () => {
    const { ctx } = await setup({ host: { inviteMailbox: "calls@adminigloo.com" } });
    const result = await book(ctx, invitee({ medium: "prospect_hosted" }));
    expect(result.booking.inviteMailbox).toBe("calls@adminigloo.com");
    expect(result.booking.meetingLink).toBeNull();
  });
});

describe("manage by token", () => {
  it("reads the booking; unknown and foreign tokens are the same not_found", async () => {
    const { ctx } = await setup();
    const { manageToken } = await book(ctx, invitee());
    expect((await getBookingByToken(ctx, manageToken)).start).toBe(FIRST);
    expect(await code(getBookingByToken(ctx, "a".repeat(43)))).toBe("not_found");
    expect(await code(getBookingByToken(ctx, "../../x"))).toBe("not_found");
    const other = await setup();
    expect(await code(getBookingByToken(other.ctx, manageToken))).toBe("not_found");
  });

  it("reschedule moves the SAME row: same id, same token, sequence + 1", async () => {
    const events: BookingEvent[] = [];
    const { ctx, tenantId } = await setup({ ctx: { onEvent: (e) => void events.push(e) } });
    const { manageToken } = await book(ctx, invitee());
    const [before] = await rows(tenantId);
    const moved = await rescheduleByToken(ctx, manageToken, { start: TUE_10 });
    expect(moved.start).toBe(TUE_10);
    expect(moved.status).toBe("confirmed");
    const after = await rows(tenantId);
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before?.id);
    expect(after[0]?.sequence).toBe(1);
    expect((await getBookingByToken(ctx, manageToken)).start).toBe(TUE_10);
    // The old time is free again.
    expect((await listOpenSlots(ctx, { typeKey: "intro" })).slots.some((slot) => slot.start === FIRST)).toBe(true);
    const rescheduled = events.find((e) => e.event === "booking.rescheduled");
    expect(rescheduled && "previousStart" in rescheduled && rescheduled.previousStart.toISOString()).toBe(FIRST);
    expect(rescheduled && "manageToken" in rescheduled && rescheduled.manageToken).toBe(manageToken);
  });

  it("does not block itself: a booking can move to a time overlapping its own", async () => {
    const { ctx } = await setup({ type: { durationMinutes: 60 } });
    const { manageToken } = await book(ctx, invitee());
    const moved = await rescheduleByToken(ctx, manageToken, { start: "2026-10-05T19:30:00Z" });
    expect(moved.start).toBe("2026-10-05T19:30:00.000Z");
  });

  it("reschedule with a hold consumes the hold; into a taken time is slot_taken", async () => {
    const { ctx, tenantId } = await setup();
    const { manageToken } = await book(ctx, invitee());
    const hold = await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    await rescheduleByToken(ctx, manageToken, { start: TUE_10, holdToken: hold.holdToken });
    expect((await rows(tenantId)).map((row) => row.status)).toEqual(["confirmed"]);
    await book(ctx, invitee({ start: FIRST, email: "z@example.com" }));
    expect(await code(rescheduleByToken(ctx, manageToken, { start: FIRST }))).toBe("slot_taken");
  });

  it("cancel is idempotent, frees the time, bumps the sequence, and ends the right to change", async () => {
    const events: BookingEvent[] = [];
    const { ctx, tenantId } = await setup({ ctx: { onEvent: (e) => void events.push(e) } });
    const { manageToken } = await book(ctx, invitee());
    const cancelled = await cancelByToken(ctx, manageToken, { reason: "Found the answer already" });
    expect(cancelled).toMatchObject({ status: "cancelled", canCancel: false, canReschedule: false, meetingLink: null });
    const again = await cancelByToken(ctx, manageToken);
    expect(again.status).toBe("cancelled");
    const [row] = await rows(tenantId);
    expect(row).toMatchObject({ status: "cancelled", cancelledBy: "invitee", cancelReason: "Found the answer already", sequence: 1 });
    expect(events.filter((e) => e.event === "booking.cancelled")).toHaveLength(1);
    expect((await getBookingByToken(ctx, manageToken)).status).toBe("cancelled");
    expect(await code(rescheduleByToken(ctx, manageToken, { start: TUE_10 }))).toBe("not_found");
    expect((await listOpenSlots(ctx, { typeKey: "intro" })).slots[0]?.start).toBe(FIRST);
  });

  it("a call that has already happened can no longer be changed", async () => {
    const { ctx } = await setup();
    const { manageToken } = await book(ctx, invitee());
    const after = { ...ctx, now: new Date("2026-10-06T00:00:00Z") };
    const read = await getBookingByToken(after, manageToken);
    expect(read).toMatchObject({ canCancel: false, canReschedule: false });
    expect(await code(cancelByToken(after, manageToken))).toBe("not_found");
  });

  it("the .ics is PUBLISH, then CANCEL with the same UID and a higher SEQUENCE", async () => {
    const { ctx, tenantId } = await setup({ ctx: { manageUrl: (token) => `https://site.test/manage/${token}` } });
    const { manageToken } = await book(ctx, invitee());
    const [row] = await rows(tenantId);
    const published = await icsByToken(ctx, manageToken, { uidDomain: "site.test" });
    expect(published.method).toBe("PUBLISH");
    expect(published.ics).toContain(`UID:${row?.id}@site.test`);
    expect(published.ics).toContain("SEQUENCE:0");
    expect(published.ics.replace(/\r\n /g, "")).toContain(`https://site.test/manage/${manageToken}`);
    await cancelByToken(ctx, manageToken);
    const cancelled = await icsByToken(ctx, manageToken, { uidDomain: "site.test" });
    expect(cancelled.method).toBe("CANCEL");
    expect(cancelled.ics).toContain(`UID:${row?.id}@site.test`);
    expect(cancelled.ics).toContain("SEQUENCE:1");
    expect(cancelled.ics).toContain("STATUS:CANCELLED");
  });
});

describe("events", () => {
  it("created carries the full admin booking, the host, the type and the manage token", async () => {
    const events: BookingEvent[] = [];
    const { ctx, tenantId } = await setup({ ctx: { onEvent: (e) => void events.push(e) } });
    const { manageToken } = await book(ctx, invitee());
    const created = events[0];
    expect(created?.event).toBe("booking.created");
    expect(created?.tenantId).toBe(tenantId);
    expect(created?.booking).toMatchObject({ inviteeEmail: "ada@example.com", notes: "Interested in the support console." });
    expect(created?.host).toEqual({
      displayName: "Dallin Humphrey",
      email: "dallin@adminigloo.com",
      timezone: "America/Denver",
      meetingLink: "https://meet.example.com/dallin",
      phone: "+18015550143",
      inviteMailbox: null,
    });
    expect(created?.type).toMatchObject({ key: "intro", name: "Intro call", durationMinutes: 30 });
    expect(created && "manageToken" in created && created.manageToken).toBe(manageToken);
    expect(JSON.stringify(created)).not.toContain("busyIcsUrl");
  });

  it("a listener that throws never fails the booking it announces; holds emit nothing", async () => {
    let calls = 0;
    const { ctx } = await setup({
      ctx: {
        onEvent: () => {
          calls += 1;
          throw new Error("mailer down");
        },
      },
    });
    await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    expect(calls).toBe(0);
    expect((await book(ctx, invitee())).booking.status).toBe("confirmed");
    expect(calls).toBe(1);
  });
});

describe("rules that span bookings", () => {
  it("a booking's own after-buffer keeps the next start clear", async () => {
    const { ctx } = await setup({ type: { bufferAfterMinutes: 15 } });
    await book(ctx, invitee());
    const monday = (await listOpenSlots(ctx, { typeKey: "intro" })).slots.filter((s) => s.start.startsWith("2026-10-05"));
    // 13:00–13:30 booked + 15 clear: 13:30 is gone, 14:00 is the next start.
    expect(monday[0]?.start).toBe("2026-10-05T20:00:00.000Z");
  });

  it("buffers between bookings: the larger wins, and they may hang outside the hours (D17)", async () => {
    const { ctx } = await setup({ type: { stepMinutes: 15, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 } });
    await book(ctx, invitee({ start: TUE_10 })); // 10:00–10:30 MDT
    const tuesday = (await listOpenSlots(ctx, { typeKey: "intro" })).slots
      .map((slot) => slot.start)
      .filter((start) => start.startsWith("2026-10-06"));
    // 09:00 opens the day even though its lead-in starts at 08:45.
    expect(tuesday[0]).toBe("2026-10-06T15:00:00.000Z");
    // 09:15 ends 09:45: max(15, 15) = 15 clear before 10:00 (the sum rule demanded 30).
    expect(tuesday).toContain("2026-10-06T15:15:00.000Z");
    expect(tuesday).not.toContain("2026-10-06T15:30:00.000Z");
    // After the call: 10:45, not 11:00.
    expect(tuesday).not.toContain("2026-10-06T16:30:00.000Z");
    expect(tuesday).toContain("2026-10-06T16:45:00.000Z");
    // 16:30 ends at 17:00 with its write-up past closing — still the day's last start.
    expect(tuesday.at(-1)).toBe("2026-10-06T22:30:00.000Z");
  });

  it("maxPerDay closes the day after the cap", async () => {
    const { ctx } = await setup({ type: { maxPerDay: 1 } });
    await book(ctx, invitee());
    const slots = (await listOpenSlots(ctx, { typeKey: "intro" })).slots;
    expect(slots.some((s) => s.start.startsWith("2026-10-05"))).toBe(false);
    expect(slots.some((s) => s.start.startsWith("2026-10-06"))).toBe(true);
  });

  it("a pool of two: same time twice goes to both hosts, a third is slot_taken", async () => {
    const { ctx, host } = await setup();
    const second = await upsertHost(ctx, { displayName: "Second Host", email: "second@adminigloo.com", timezone: "America/Denver" });
    await setWeeklyAvailability(ctx, { hostId: second.id, windows: WEEKDAYS_9_TO_5 });
    const first = await book(ctx, invitee());
    const again = await book(ctx, invitee({ email: "grace@example.com" }));
    expect(new Set([first.booking.hostDisplayName, again.booking.hostDisplayName])).toEqual(
      new Set(["Dallin Humphrey", "Second Host"]),
    );
    // The lower id took the first (both had zero upcoming).
    const lower = [host.id, second.id].sort()[0];
    expect(first.booking.hostDisplayName).toBe(lower === host.id ? "Dallin Humphrey" : "Second Host");
    expect(await code(book(ctx, invitee({ email: "third@example.com" })))).toBe("slot_taken");
  });

  it("assignment prefers the host with fewer upcoming calls", async () => {
    const { ctx } = await setup();
    const second = await upsertHost(ctx, { displayName: "Second Host", email: "second@adminigloo.com", timezone: "America/Denver" });
    await setWeeklyAvailability(ctx, { hostId: second.id, windows: WEEKDAYS_9_TO_5 });
    const a = await book(ctx, invitee({ start: TUE_10 }));
    const b = await book(ctx, invitee({ start: "2026-10-07T16:00:00Z", email: "b@example.com" }));
    expect(a.booking.hostDisplayName).not.toBe(b.booking.hostDisplayName);
  });
});

describe("reschedule-aware availability", () => {
  const TUE_0930 = "2026-10-06T15:30:00.000Z";
  const TUE_1030 = "2026-10-06T16:30:00.000Z";
  const WED_10 = "2026-10-07T16:00:00.000Z";
  const starts = async (ctx: BookingContext, manageToken?: string) =>
    (await listOpenSlots(ctx, { typeKey: "intro", ...(manageToken !== undefined ? { manageToken } : {}) })).slots.map(
      (slot) => slot.start,
    );

  it("with the manage token, the booking being moved stops counting as busy", async () => {
    const { ctx } = await setup({ type: { durationMinutes: 60 } });
    const { manageToken } = await book(ctx, invitee({ start: TUE_10 })); // 10:00–11:00
    const plain = await starts(ctx);
    expect(plain).not.toContain(TUE_0930);
    expect(plain).not.toContain(TUE_1030);
    // Half an hour earlier or later overlaps the call itself — which is moving.
    expect(await starts(ctx, manageToken)).toEqual(expect.arrayContaining([TUE_0930, TUE_10, TUE_1030]));
  });

  it("…and so do its buffers", async () => {
    const { ctx } = await setup({ type: { bufferAfterMinutes: 30 } });
    const { manageToken } = await book(ctx, invitee({ start: TUE_10 })); // 10:00–10:30, clear until 11:00
    expect(await starts(ctx)).not.toContain(TUE_1030);
    expect(await starts(ctx, manageToken)).toContain(TUE_1030);
  });

  it("a token that opens nothing it could move changes nothing (and says nothing)", async () => {
    const { ctx } = await setup({ type: { durationMinutes: 60 } });
    await upsertType(ctx, { key: "deep", name: "Deep dive", durationMinutes: 60, media: ["video"] });
    await book(ctx, invitee({ start: TUE_10 }));
    const deep = await book(ctx, invitee({ typeKey: "deep", start: WED_10, email: "deep@example.com" }));
    const plain = await starts(ctx);
    expect(plain).not.toContain(WED_10);
    for (const token of ["a".repeat(43), "../../x", "", "x".repeat(5000)]) expect(await starts(ctx, token)).toEqual(plain);
    // Another type's booking cannot move into this type, so its time stays busy here.
    expect(await starts(ctx, deep.manageToken)).toEqual(plain);
    // Another tenant's token opens nothing in this one.
    const other = await setup({ type: { durationMinutes: 60 } });
    const foreign = await book(other.ctx, invitee({ start: TUE_10 }));
    expect(await starts(ctx, foreign.manageToken)).toEqual(plain);
  });

  it("a move can HOLD a time next to its own call, and the reschedule consumes that hold", async () => {
    const { ctx, tenantId } = await setup({ type: { durationMinutes: 60 } });
    const { manageToken } = await book(ctx, invitee({ start: TUE_10 }));
    // To everyone else 10:30 overlaps the booked 10:00–11:00.
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: TUE_1030 }))).toBe("slot_taken");
    const hold = await holdSlot(ctx, { typeKey: "intro", start: TUE_1030, manageToken });
    expect(hold.start).toBe(TUE_1030);
    expect((await rescheduleByToken(ctx, manageToken, { start: TUE_1030, holdToken: hold.holdToken })).start).toBe(TUE_1030);
    expect((await rows(tenantId)).map((row) => row.status)).toEqual(["confirmed"]);
  });

  it("a hold FOR a booking whose token opens none is not_found, and holds nothing", async () => {
    const { ctx, tenantId } = await setup();
    const { manageToken } = await book(ctx, invitee({ start: TUE_10 }));
    for (const token of ["a".repeat(43), "", "../x"]) {
      expect(await code(holdSlot(ctx, { typeKey: "intro", start: WED_10, manageToken: token }))).toBe("not_found");
    }
    await cancelByToken(ctx, manageToken);
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: WED_10, manageToken }))).toBe("not_found");
    expect((await rows(tenantId)).filter((row) => row.status === "hold")).toHaveLength(0);
  });

  it("with a pool, a move's hold reserves the host who keeps the call", async () => {
    const { ctx, tenantId } = await setup();
    const second = await upsertHost(ctx, { displayName: "Second Host", email: "second@adminigloo.com", timezone: "America/Denver" });
    await setWeeklyAvailability(ctx, { hostId: second.id, windows: WEEKDAYS_9_TO_5 });
    const { manageToken } = await book(ctx, invitee({ start: TUE_10 }));
    await holdSlot(ctx, { typeKey: "intro", start: WED_10, manageToken });
    const all = await rows(tenantId);
    const booked = all.find((row) => row.status === "confirmed");
    expect(all.find((row) => row.status === "hold")?.hostId).toBe(booked?.hostId);
    // An ordinary hold still goes to the fairest host: the one with nothing on.
    await holdSlot(ctx, { typeKey: "intro", start: "2026-10-08T16:00:00Z" });
    const fresh = (await rows(tenantId)).find((row) => row.status === "hold" && row.startUtc.toISOString() !== WED_10);
    expect(fresh?.hostId).not.toBe(booked?.hostId);
  });
});

describe("double submit", () => {
  it("the same form sent twice: the second answers already_booked and books nothing", async () => {
    const events: BookingEvent[] = [];
    const { ctx, tenantId } = await setup({ ctx: { onEvent: (e) => void events.push(e) } });
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    await book(ctx, invitee({ holdToken: hold.holdToken }));
    let error: BookingError | null = null;
    try {
      await book({ ...ctx, now: new Date(NOW.getTime() + 2 * MIN) }, invitee({ holdToken: hold.holdToken }));
    } catch (caught) {
      error = caught as BookingError;
    }
    expect(error?.code).toBe("already_booked");
    expect(error?.status).toBe(409);
    expect(error?.message).toMatch(/Check your email/);
    expect(await rows(tenantId)).toHaveLength(1);
    expect(events.filter((e) => e.event === "booking.created")).toHaveLength(1);
  });

  it("with a host pool, a second submit can no longer book the prospect twice on another host", async () => {
    const { ctx, tenantId } = await setup();
    const second = await upsertHost(ctx, { displayName: "Second Host", email: "second@adminigloo.com", timezone: "America/Denver" });
    await setWeeklyAvailability(ctx, { hostId: second.id, windows: WEEKDAYS_9_TO_5 });
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    await book(ctx, invitee({ holdToken: hold.holdToken }));
    expect(await code(book(ctx, invitee({ holdToken: hold.holdToken })))).toBe("already_booked");
    expect((await rows(tenantId)).filter((row) => row.status === "confirmed")).toHaveLength(1);
  });

  it("is recognised when a lapsed hold was the one that booked", async () => {
    const { ctx } = await setup();
    const hold = await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    const later = { ...ctx, now: new Date(NOW.getTime() + 11 * MIN) };
    await book(later, invitee({ start: TUE_10, holdToken: hold.holdToken }));
    expect(await code(book(later, invitee({ start: TUE_10, holdToken: hold.holdToken })))).toBe("already_booked");
  });

  it("is only a double submit for ten minutes, and only while the booking stands", async () => {
    const { ctx } = await setup();
    const hold = await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    await book(ctx, invitee({ start: TUE_10, holdToken: hold.holdToken }));
    const later = { ...ctx, now: new Date(NOW.getTime() + 11 * MIN) };
    // The time is taken (by that very booking), so it reads as any lapsed hold would.
    expect(await code(book(later, invitee({ start: TUE_10, holdToken: hold.holdToken })))).toBe("hold_expired");

    const other = await setup();
    const again = await holdSlot(other.ctx, { typeKey: "intro", start: TUE_10 });
    const first = await book(other.ctx, invitee({ start: TUE_10, holdToken: again.holdToken }));
    await cancelByToken(other.ctx, first.manageToken);
    // Cancelled: nothing stands, the time is free — the form books afresh.
    expect((await book(other.ctx, invitee({ start: TUE_10, holdToken: again.holdToken }))).booking.status).toBe("confirmed");
  });

  it("in the sandbox the message promises no email", async () => {
    const { ctx } = await setup({ ctx: { sandbox: true } });
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    await book(ctx, invitee({ holdToken: hold.holdToken }));
    await expect(book(ctx, invitee({ holdToken: hold.holdToken }))).rejects.toMatchObject({
      code: "already_booked",
      message: expect.stringMatching(/nothing was emailed/),
    });
  });
});

describe("phone numbers and the default calling code", () => {
  it("a deployment's calling code reads a national number; without one the + is required", async () => {
    const { ctx, tenantId } = await setup({ ctx: { defaultCallingCode: "1" } });
    const booked = await book(ctx, invitee({ medium: "phone", phone: "1 (801) 555-0199" }));
    expect(booked.booking.medium).toBe("phone");
    expect((await rows(tenantId))[0]?.inviteePhone).toBe("+18015550199");
    const strict = await setup();
    expect(await code(book(strict.ctx, invitee({ medium: "phone", phone: "(801) 555-0199" })))).toBe("invalid");
    // A code that is not a calling code is not applied.
    expect(await code(book({ ...strict.ctx, defaultCallingCode: "US" }, invitee({ medium: "phone", phone: "(801) 555-0199" })))).toBe(
      "invalid",
    );
  });

  it("hosts' own numbers stay strict whatever the public rule", async () => {
    const { ctx } = await setup({ ctx: { defaultCallingCode: "1" } });
    expect(
      await code(upsertHost(ctx, { displayName: "X", email: "x@example.com", timezone: "America/Denver", phone: "801 555 0100" })),
    ).toBe("invalid");
  });
});

describe("the busy source", () => {
  const icsUrl = "https://calendar.google.com/calendar/ical/x/private-secret/basic.ics";

  it("removes externally busy times and reports ok", async () => {
    const source: BusySource = {
      busy: async () => [{ start: at("2026-10-05T19:00:00Z"), end: at("2026-10-05T20:00:00Z") }],
    };
    const { ctx } = await setup({ host: { busyIcsUrl: icsUrl }, ctx: { busySource: source } });
    const result = await listOpenSlots(ctx, { typeKey: "intro" });
    expect(result.busySync).toBe("ok");
    expect(result.slots[0]?.start).toBe("2026-10-05T20:00:00.000Z");
    // …and the write-time check sees the same calendar.
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: FIRST }))).toBe("slot_taken");
  });

  it("degrades to internal-only on failure, records it for the admin, and clears it on recovery", async () => {
    let failing = true;
    const source: BusySource = {
      busy: async () => {
        if (failing) throw new Error("calendar fetch failed: HTTP 404");
        return [];
      },
    };
    const { ctx } = await setup({ host: { busyIcsUrl: icsUrl }, ctx: { busySource: source } });
    const degraded = await listOpenSlots(ctx, { typeKey: "intro" });
    expect(degraded.busySync).toBe("degraded");
    expect(degraded.slots[0]?.start).toBe(FIRST);
    let [host] = await listHosts(ctx);
    expect(host?.busySync.error).toBe("calendar fetch failed: HTTP 404");
    expect(host?.busySync.failingSince?.toISOString()).toBe(NOW.toISOString());
    // A booking still goes through while the calendar is down.
    expect((await book(ctx, invitee())).booking.status).toBe("confirmed");
    failing = false;
    expect((await listOpenSlots(ctx, { typeKey: "intro" })).busySync).toBe("ok");
    [host] = await listHosts(ctx);
    expect(host?.busySync.error).toBeNull();
    expect(host?.busySync.failingSince).toBeNull();
  });

  it("is never asked about a host without a calendar address", async () => {
    let calls = 0;
    const source: BusySource = { busy: async () => ((calls += 1), []) };
    const { ctx } = await setup({ ctx: { busySource: source } });
    expect((await listOpenSlots(ctx, { typeKey: "intro" })).busySync).toBe("off");
    expect(calls).toBe(0);
  });

  it("testBusySource reports events, errors, and a missing address", async () => {
    const { ctx, host } = await setup({ host: { busyIcsUrl: icsUrl } });
    expect(await testBusySource(ctx, host.id)).toMatchObject({ ok: false, error: expect.stringMatching(/No busy source/) });
    const ok = { ...ctx, busySource: { busy: async () => [{ start: NOW, end: new Date(NOW.getTime() + MIN) }] } };
    expect(await testBusySource(ok, host.id)).toEqual({ ok: true, events: 1 });
    const bad = { ...ctx, busySource: { busy: async () => Promise.reject(new Error("boom")) } };
    expect(await testBusySource(bad, host.id)).toEqual({ ok: false, events: 0, error: "boom" });
    const bare = await setup();
    expect(await testBusySource({ ...bare.ctx, busySource: ok.busySource }, bare.host.id)).toMatchObject({ ok: false });
  });
});

describe("admin", () => {
  it("masks the calendar secret in every admin read", async () => {
    const { ctx } = await setup({ host: { busyIcsUrl: "webcal://calendar.google.com/calendar/ical/me/private-SECRET123/basic.ics" } });
    const [host] = await listHosts(ctx);
    expect(host?.busyIcsUrl).toBe("https://calendar.google.com/…ics ✓");
    expect(JSON.stringify(await listHosts(ctx))).not.toContain("SECRET123");
  });

  it("validates host input: zone, links, phone", async () => {
    const { ctx } = await setup();
    const base = { displayName: "X", email: "x@example.com", timezone: "America/Denver" };
    expect(await code(upsertHost(ctx, { ...base, timezone: "Mountain" }))).toBe("invalid");
    expect(await code(upsertHost(ctx, { ...base, meetingLink: "http://insecure.example.com" }))).toBe("invalid");
    expect(await code(upsertHost(ctx, { ...base, phone: "555-0143" }))).toBe("invalid");
    expect(await code(upsertHost(ctx, { ...base, busyIcsUrl: "ftp://x" }))).toBe("invalid");
  });

  it("setWeeklyAvailability replaces the whole week", async () => {
    const { ctx, host } = await setup();
    await setWeeklyAvailability(ctx, { hostId: host.id, windows: [{ dayOfWeek: 2, startMinute: 600, endMinute: 660 }] });
    expect((await getAvailability(ctx, { hostId: host.id })).weekly).toEqual([{ dayOfWeek: 2, startMinute: 600, endMinute: 660 }]);
    expect(await code(setWeeklyAvailability(ctx, { hostId: host.id, windows: [{ dayOfWeek: 2, startMinute: 600, endMinute: 610 }] }))).toBe(
      "invalid",
    );
  });

  it("lists bookings without holds, with names, and shows one with its audit trail", async () => {
    const { ctx } = await setup();
    await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    await book(ctx, invitee());
    const list = await listBookings(ctx, { from: at("2026-10-01T00:00:00Z"), to: at("2026-11-01T00:00:00Z") });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ typeName: "Intro call", hostDisplayName: "Dallin Humphrey", inviteePhone: null });
    expect(await listBookings(ctx, { status: "hold" })).toHaveLength(1);
    const detail = await getBooking(ctx, list[0]?.id ?? "");
    expect(detail?.events.map((e) => e.kind)).toEqual(["booked"]);
    expect(await getBooking(ctx, "nope")).toBeNull();
  });

  it("hostCancelBooking cancels once, as the host, and emits once", async () => {
    const events: BookingEvent[] = [];
    const { ctx, tenantId } = await setup({ ctx: { onEvent: (e) => void events.push(e) } });
    await book(ctx, invitee());
    const [row] = await rows(tenantId);
    const cancelled = await hostCancelBooking(ctx, { id: row?.id ?? "", reason: "Sick" });
    expect(cancelled).toMatchObject({ status: "cancelled", cancelledBy: "host", cancelReason: "Sick", sequence: 1 });
    await hostCancelBooking(ctx, { id: row?.id ?? "" });
    const cancels = events.filter((e) => e.event === "booking.cancelled");
    expect(cancels).toHaveLength(1);
    expect(cancels[0] && "by" in cancels[0] && cancels[0].by).toBe("host");
  });

  it("setOutcome records the outcome and can close the call", async () => {
    const { ctx, tenantId } = await setup();
    await book(ctx, invitee());
    const [row] = await rows(tenantId);
    // Once the call has started (FIRST is 13:00 MDT; this is 13:40).
    const during = { ...ctx, now: new Date(Date.parse(FIRST) + 40 * MIN) };
    const done = await setOutcome(during, { id: row?.id ?? "", outcome: "won", status: "completed" });
    expect(done).toMatchObject({ outcome: "won", status: "completed" });
    const detail = await getBooking(ctx, row?.id ?? "");
    expect(detail?.events[0]).toMatchObject({ kind: "outcome", actor: "host", detail: { outcome: "won", status: "completed" } });
  });

  it("upsertType validates and refuses another tenant's host ids", async () => {
    const { ctx } = await setup();
    const other = await setup();
    expect(await code(upsertType(ctx, { key: "x", name: "X", durationMinutes: 30, media: [] }))).toBe("invalid");
    expect(await code(upsertType(ctx, { key: "x", name: "X", durationMinutes: 7, media: ["video"] }))).toBe("invalid");
    expect(await code(upsertType(ctx, { key: "x", name: "X", durationMinutes: 30, media: ["video"], hostIds: [other.host.id] }))).toBe(
      "invalid",
    );
  });
});

describe("tenant isolation", () => {
  it("no id, token or feed crosses tenants", async () => {
    const a = await setup();
    const b = await setup();
    const { manageToken } = await book(a.ctx, invitee());
    const [row] = await rows(a.tenantId);
    expect(await code(upsertHost(b.ctx, { id: a.host.id, displayName: "Hijack", email: "x@example.com", timezone: "UTC" }))).toBe(
      "not_found",
    );
    expect(await code(hostCancelBooking(b.ctx, { id: row?.id ?? "" }))).toBe("not_found");
    expect(await getBooking(b.ctx, row?.id ?? "")).toBeNull();
    expect(await listBookings(b.ctx)).toHaveLength(0);
    expect(await code(cancelByToken(b.ctx, manageToken))).toBe("not_found");
    const { feedToken } = await rotateHostFeedToken(a.ctx, a.host.id);
    expect(await code(hostFeed(b.ctx, feedToken, { uidDomain: "x" }))).toBe("not_found");
    expect(await code(setWeeklyAvailability(b.ctx, { hostId: a.host.id, windows: [] }))).toBe("not_found");
    // A's booking does not occupy B's identical host and week.
    expect((await listOpenSlots(b.ctx, { typeKey: "intro" })).slots[0]?.start).toBe(FIRST);
  });

  it("the host feed shows first name and company, and a rotated token kills the old one", async () => {
    const { ctx, host } = await setup();
    await book(ctx, invitee());
    const first = await rotateHostFeedToken(ctx, host.id);
    const feed = await hostFeed(ctx, first.feedToken, { uidDomain: "site.test" });
    expect(feed).toContain("Intro call: Ada (Analytical Engines)");
    expect(feed).not.toContain("Lovelace");
    expect(feed).not.toContain("ada@example.com");
    expect(feed).not.toContain("support console");
    const second = await rotateHostFeedToken(ctx, host.id);
    expect(await code(hostFeed(ctx, first.feedToken, { uidDomain: "site.test" }))).toBe("not_found");
    expect(await hostFeed(ctx, second.feedToken, { uidDomain: "site.test" })).toContain("BEGIN:VCALENDAR");
  });
});

describe("sandbox and maintenance", () => {
  const seed = (tenantId: string) =>
    seedSandboxTenant(t.db, {
      tenantId,
      host: { displayName: "Demo Host", email: "demo@example.com", timezone: "America/Denver" },
      weekly: WEEKDAYS_9_TO_5,
      types: [{ key: "intro", name: "Intro call", durationMinutes: 30, media: ["video", "phone"] }],
    });

  it("seedSandboxTenant is idempotent, even when two first requests race", async () => {
    const tenantId = tenant("demo");
    const [one, two] = await Promise.all([seed(tenantId), seed(tenantId)]);
    expect(one?.hostId).toBe(two?.hostId);
    expect([one?.created, two?.created].sort()).toEqual([false, true]);
    const third = await seed(tenantId);
    expect(third).toEqual({ hostId: one?.hostId, typeKeys: ["intro"], created: false });
    const slots = await listOpenSlots({ db: t.db, tenantId, now: NOW }, { typeKey: "intro" });
    expect(slots.slots[0]?.start).toBe(FIRST);
  });

  it("purgeExpiredHolds deletes lapsed holds and their audit rows, nothing else", async () => {
    const { ctx, tenantId } = await setup();
    await holdSlot(ctx, { typeKey: "intro", start: TUE_10 });
    await book(ctx, invitee());
    const fresh = await holdSlot({ ...ctx, now: new Date(NOW.getTime() + 30 * MIN) }, { typeKey: "intro", start: "2026-10-07T16:00:00Z" });
    expect(fresh.start).toBeTruthy();
    const result = await purgeExpiredHolds(t.db, { tenantId, olderThan: new Date(NOW.getTime() + 20 * MIN) });
    expect(result.deleted).toBe(1);
    const left = await rows(tenantId);
    expect(left.map((row) => row.status).sort()).toEqual(["confirmed", "hold"]);
    const heldEvents = await t.db
      .select()
      .from(bookingEvents)
      .where(and(eq(bookingEvents.tenantId, tenantId), eq(bookingEvents.kind, "held")));
    expect(heldEvents).toHaveLength(1);
  });

  it("purgeTenants removes stale sandboxes by newest activity, and only under the prefix", async () => {
    const stale = `sbx_${tenant()}`;
    const active = `sbx_${tenant()}`;
    const lookalike = `sbxX${tenant()}`; // `_` is literal, not a wildcard
    for (const id of [stale, active, lookalike]) await seed(id);
    // Old activity everywhere except `active`, which books something today.
    const old = new Date("2026-01-01T00:00:00Z");
    const { bookingHosts, bookingTypes, bookingAvailability } = await import("../schema.js");
    for (const id of [stale, active, lookalike]) {
      await t.db.update(bookingHosts).set({ updatedAt: old, createdAt: old }).where(eq(bookingHosts.tenantId, id));
      await t.db.update(bookingTypes).set({ updatedAt: old, createdAt: old }).where(eq(bookingTypes.tenantId, id));
      await t.db.update(bookingAvailability).set({ createdAt: old }).where(eq(bookingAvailability.tenantId, id));
    }
    await book({ db: t.db, tenantId: active, now: NOW }, invitee());
    const result = await purgeTenants(t.db, { prefix: "sbx_", olderThan: new Date("2026-06-01T00:00:00Z") });
    expect(result.tenants).toBe(1);
    expect(await listHosts({ db: t.db, tenantId: stale })).toHaveLength(0);
    expect(await listHosts({ db: t.db, tenantId: active })).toHaveLength(1);
    expect(await listHosts({ db: t.db, tenantId: lookalike })).toHaveLength(1);
    expect(await code(purgeTenants(t.db, { prefix: "", olderThan: new Date() }))).toBe("invalid");
  });
});

describe("hold limits and the live-holds read", () => {
  const WED_10 = "2026-10-07T16:00:00.000Z";
  const THU_10 = "2026-10-08T16:00:00.000Z";

  it("refuses a subject's third live hold; an expired hold stops counting", async () => {
    const { ctx } = await setup();
    const limits = { subject: "ip:203.0.113.9", maxPerSubject: 2 };
    await holdSlot(ctx, { typeKey: "intro", start: FIRST }, limits);
    await holdSlot(ctx, { typeKey: "intro", start: TUE_10 }, limits);
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: WED_10 }, limits))).toBe("rate_limited");
    // Ten minutes on, both holds have lapsed and the subject may hold again.
    const later = { ...ctx, now: new Date(NOW.getTime() + 11 * MIN) };
    expect((await holdSlot(later, { typeKey: "intro", start: WED_10 }, limits)).start).toBe(WED_10);
  });

  it("a refused hold keeps the hold it would have replaced (the release rolls back)", async () => {
    const { ctx, tenantId } = await setup();
    const limits = { subject: "s", maxPerSubject: 1 };
    const mine = await holdSlot(ctx, { typeKey: "intro", start: FIRST }, limits);
    // Replacing it is fine — the replaced hold does not count.
    const moved = await holdSlot(ctx, { typeKey: "intro", start: TUE_10, previousHoldToken: mine.holdToken }, limits);
    // A second hold WITHOUT naming the first is refused, and the first survives.
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: WED_10 }, limits))).toBe("rate_limited");
    // A refused replacement (a token that is not the subject's hold) leaves `moved` in place.
    const other = await holdSlot(ctx, { typeKey: "intro", start: THU_10 });
    expect(await code(holdSlot(ctx, { typeKey: "intro", start: WED_10, previousHoldToken: other.holdToken }, limits))).toBe("rate_limited");
    const held = (await rows(tenantId)).filter((row) => row.status === "hold").map((row) => row.startUtc.toISOString()).sort();
    expect(held).toEqual([TUE_10, THU_10]);
    expect(moved.start).toBe(TUE_10);
  });

  it("the subject is hashed with the tenant, and the hash is cleared when the hold becomes a booking", async () => {
    const { ctx, tenantId } = await setup();
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST }, { subject: "ip:1.2.3.4" });
    const [held] = await rows(tenantId);
    expect(held?.holdSubjectHash).toMatch(/^[0-9a-f]{64}$/);
    const other = await setup();
    await holdSlot(other.ctx, { typeKey: "intro", start: FIRST }, { subject: "ip:1.2.3.4" });
    const [otherHeld] = await rows(other.tenantId);
    expect(otherHeld?.holdSubjectHash).not.toBe(held?.holdSubjectHash); // not linkable across tenants
    await book(ctx, invitee({ holdToken: hold.holdToken }));
    const [booked] = await rows(tenantId);
    expect(booked?.status).toBe("confirmed");
    expect(booked?.holdSubjectHash).toBeNull();
  });

  it("countLiveHolds counts live holds and distinct requesters, not bookings or lapsed holds", async () => {
    const { ctx } = await setup();
    expect(await countLiveHolds(ctx)).toEqual({ live: 0, subjects: 0 });
    await holdSlot(ctx, { typeKey: "intro", start: FIRST }, { subject: "a", maxPerSubject: 5 });
    await holdSlot(ctx, { typeKey: "intro", start: TUE_10 }, { subject: "a", maxPerSubject: 5 });
    await holdSlot(ctx, { typeKey: "intro", start: WED_10 }, { subject: "b" });
    await holdSlot(ctx, { typeKey: "intro", start: THU_10 }); // no subject
    await book(ctx, invitee({ start: "2026-10-09T16:00:00.000Z" }));
    expect(await countLiveHolds(ctx)).toEqual({ live: 4, subjects: 2 });
    expect(await countLiveHolds({ ...ctx, now: new Date(NOW.getTime() + 11 * MIN) })).toEqual({ live: 0, subjects: 0 });
  });
});

describe("admin guards and the host's reschedule", () => {
  const DURING = new Date(Date.parse(FIRST) + 10 * MIN);
  const AFTER = new Date(Date.parse(FIRST) + 45 * MIN);

  it("setOutcome refuses completed / no-show before the call starts; a note alone is fine any time", async () => {
    const { ctx, tenantId } = await setup();
    await book(ctx, invitee());
    const [row] = await rows(tenantId);
    const id = row?.id ?? "";
    expect(await code(setOutcome(ctx, { id, outcome: null, status: "completed" }))).toBe("invalid");
    expect(await code(setOutcome(ctx, { id, outcome: null, status: "no_show" }))).toBe("invalid");
    // Nothing changed: the call still blocks its time and can still be changed.
    expect((await rows(tenantId))[0]?.status).toBe("confirmed");
    expect(await setOutcome(ctx, { id, outcome: "warm lead" })).toMatchObject({ outcome: "warm lead", status: "confirmed" });
    expect(await setOutcome({ ...ctx, now: DURING }, { id, outcome: null, status: "no_show" })).toMatchObject({ status: "no_show" });
  });

  it("hostCancelBooking refuses a call that has already ended, and still cancels one in progress", async () => {
    const { ctx, tenantId } = await setup();
    const events: BookingEvent[] = [];
    const listening = { ...ctx, onEvent: (event: BookingEvent) => void events.push(event) };
    await book(ctx, invitee());
    const [row] = await rows(tenantId);
    expect(await code(hostCancelBooking({ ...listening, now: AFTER }, { id: row?.id ?? "" }))).toBe("invalid");
    expect(events).toHaveLength(0);
    expect((await rows(tenantId))[0]?.status).toBe("confirmed");
    expect(await hostCancelBooking({ ...listening, now: DURING }, { id: row?.id ?? "" })).toMatchObject({ status: "cancelled" });
  });

  it("hostRescheduleBooking moves the SAME row as the host, emits booking.rescheduled by: host, and the invitee's link follows", async () => {
    const events: BookingEvent[] = [];
    const { ctx, tenantId } = await setup({ ctx: { onEvent: (event) => void events.push(event) } });
    const { manageToken } = await book(ctx, invitee());
    const [before] = await rows(tenantId);
    const moved = await hostRescheduleBooking(ctx, { id: before?.id ?? "", start: TUE_10 });
    expect(moved).toMatchObject({ id: before?.id, status: "confirmed", sequence: 1 });
    expect(moved.start.toISOString()).toBe(TUE_10);
    const rescheduled = events.find((e) => e.event === "booking.rescheduled");
    expect(rescheduled).toMatchObject({ event: "booking.rescheduled", by: "host", previousStart: at(FIRST) });
    expect(rescheduled && "manageToken" in rescheduled ? rescheduled.manageToken : undefined).toBeUndefined();
    const detail = await getBooking(ctx, before?.id ?? "");
    expect(detail?.events[0]).toMatchObject({ kind: "rescheduled", actor: "host" });
    // The invitee's token still opens it, at the new time, with a higher sequence.
    expect((await getBookingByToken(ctx, manageToken)).start).toBe(TUE_10);
    const ics = await icsByToken(ctx, manageToken, { uidDomain: "x.test" });
    expect(ics.ics).toContain("SEQUENCE:1");
    // An ISO string works as well as a Date, and the same time is a no-op.
    expect((await hostRescheduleBooking(ctx, { id: before?.id ?? "", start: new Date(TUE_10) })).sequence).toBe(1);
    expect(events.filter((e) => e.event === "booking.rescheduled")).toHaveLength(1);
  });

  it("hostRescheduleBooking obeys the slot rules and refuses a call that cannot move", async () => {
    const { ctx, tenantId } = await setup();
    await book(ctx, invitee());
    await book(ctx, invitee({ start: TUE_10, email: "bo@example.com" }));
    const [first] = (await rows(tenantId)).filter((row) => row.startUtc.toISOString() === FIRST);
    const id = first?.id ?? "";
    expect(await code(hostRescheduleBooking(ctx, { id, start: TUE_10 }))).toBe("slot_taken"); // taken
    expect(await code(hostRescheduleBooking(ctx, { id, start: "2026-10-04T16:00:00Z" }))).toBe("slot_taken"); // Sunday
    expect(await code(hostRescheduleBooking(ctx, { id, start: "soon" }))).toBe("invalid");
    expect(await code(hostRescheduleBooking({ ...ctx, now: DURING }, { id, start: "2026-10-07T16:00:00Z" }))).toBe("invalid"); // started
    await hostCancelBooking(ctx, { id });
    expect(await code(hostRescheduleBooking(ctx, { id, start: "2026-10-07T16:00:00Z" }))).toBe("invalid"); // cancelled
    expect(await code(hostRescheduleBooking(ctx, { id: "nope", start: "2026-10-07T16:00:00Z" }))).toBe("not_found");
    const other = await setup();
    expect(await code(hostRescheduleBooking(other.ctx, { id, start: "2026-10-07T16:00:00Z" }))).toBe("not_found"); // other tenant
  });
});

describe("races (PGlite: one connection, so these prove the re-check under the lock, not the lock itself)", () => {
  it("two book() calls for one start with no hold: one booking, one slot_taken", async () => {
    const { ctx, tenantId } = await setup();
    const results = await Promise.allSettled([
      book(ctx, invitee({ email: "a@example.com" })),
      book(ctx, invitee({ email: "b@example.com" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as BookingError).code).toBe("slot_taken");
    expect((await rows(tenantId)).filter((row) => row.status === "confirmed")).toHaveLength(1);
  });

  it("two bookings rescheduled into the same free start at once: one moves, one slot_taken", async () => {
    const { ctx, tenantId } = await setup();
    const a = await book(ctx, invitee({ start: FIRST, email: "a@example.com" }));
    const b = await book(ctx, invitee({ start: TUE_10, email: "b@example.com" }));
    const target = "2026-10-07T16:00:00.000Z";
    const results = await Promise.allSettled([
      rescheduleByToken(ctx, a.manageToken, { start: target }),
      rescheduleByToken(ctx, b.manageToken, { start: target }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as BookingError).code).toBe("slot_taken");
    const starts = (await rows(tenantId)).map((row) => row.startUtc.toISOString()).sort();
    expect(starts.filter((start) => start === target)).toHaveLength(1);
  });

  it("an invitee's reschedule and the host's, into one start at once: one wins", async () => {
    const { ctx, tenantId } = await setup();
    const a = await book(ctx, invitee({ start: FIRST, email: "a@example.com" }));
    await book(ctx, invitee({ start: TUE_10, email: "b@example.com" }));
    const bRow = (await rows(tenantId)).find((row) => row.startUtc.toISOString() === TUE_10);
    const target = "2026-10-07T16:00:00.000Z";
    const results = await Promise.allSettled([
      rescheduleByToken(ctx, a.manageToken, { start: target }),
      hostRescheduleBooking(ctx, { id: bRow?.id ?? "", start: target }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await rows(tenantId)).filter((row) => row.startUtc.toISOString() === target)).toHaveLength(1);
  });

  it("a direct book() racing a hold for the same start: one claim, one slot_taken", async () => {
    const { ctx, tenantId } = await setup();
    const results = await Promise.allSettled([holdSlot(ctx, { typeKey: "intro", start: FIRST }), book(ctx, invitee())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await rows(tenantId)).toHaveLength(1);
  });
});

describe("sandbox exports and emails-off copy at the service level", () => {
  it("toPublicBooking and icsByToken label a sandbox booking, with no 'Book a real call' line unless one is given", async () => {
    const { ctx } = await setup({ ctx: { sandbox: true } });
    const { booking, manageToken } = await book(ctx, invitee());
    const google = new URL(booking.googleCalendarUrl).searchParams;
    expect(google.get("text")).toMatch(/^\[Sandbox — not a real booking\] /);
    expect(google.get("details")).toBe("This was made in a live demo. Nothing was booked and nobody will join.");
    const { ics } = await icsByToken(ctx, manageToken, { uidDomain: "demo.test" });
    expect(ics).toContain("STATUS:TENTATIVE");
    expect(ics).not.toContain("ORGANIZER");
    await cancelByToken(ctx, manageToken);
    const cancelled = await icsByToken(ctx, manageToken, { uidDomain: "demo.test" });
    expect(cancelled.method).toBe("CANCEL");
    expect(cancelled.ics).toContain("STATUS:CANCELLED"); // so a client that imported it removes it
  });

  it("already_booked with emails off and no contact still makes no email promise", async () => {
    const { ctx } = await setup({ ctx: { emailsEnabled: false } });
    const hold = await holdSlot(ctx, { typeKey: "intro", start: FIRST });
    await book(ctx, invitee({ holdToken: hold.holdToken }));
    let message = "";
    try {
      await book(ctx, invitee({ holdToken: hold.holdToken }));
    } catch (error) {
      message = (error as BookingError).message;
    }
    expect(message).toMatch(/private link on your confirmation page/);
    expect(message).not.toMatch(/email/i);
  });
});

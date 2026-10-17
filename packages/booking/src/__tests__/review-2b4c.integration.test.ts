import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { networkKeyOf } from "../address.js";
import { createBookingAdminHandlers } from "../admin-handlers.js";
import { bookingEmailVars, platformBookingEmails } from "../emails.js";
import { createBookingHandlers, type CreateBookingHandlersOptions } from "../handlers.js";
import { cancelAllFromEmail, rotateHostFeedToken, setWeeklyAvailability, upsertHost, upsertType } from "../services/admin.js";
import type { BookingContext, BookingEvent, HostMembers } from "../services/context.js";
import { book, holdSlot, listOpenSlots } from "../services/public.js";
import { claimReminder, dueReminders, releaseReminder } from "../services/reminders.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * THE 2b-4c REVIEW, AS TESTS: a host who left the company (H1), a stranger
 * closing a company's page for the day (H2), a company phishing from the
 * platform's domain (H3), the host-limit race (M2) and reminder retries (L3)
 * — each with the control that shows the check is what makes the difference.
 */

const NOW = new Date("2026-10-05T15:00:00Z");
const HOST = "https://app.lawnco.test";
const WEEKDAYS = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startMinute: 540, endMinute: 1020 }));
const TUE = (hour: number) => `2026-10-06T${String(hour).padStart(2, "0")}:00:00.000Z`;

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

async function business(options: { userId?: string; typeName?: string } = {}) {
  const tenantId = tenant("rev");
  const ctx: BookingContext = { db: t.db, tenantId, now: NOW };
  const host = await upsertHost(ctx, { displayName: "Pat Host", email: "pat@biz.test", timezone: "UTC", ...(options.userId ? { userId: options.userId } : {}) });
  await setWeeklyAvailability(ctx, { hostId: host.id, windows: WEEKDAYS });
  await upsertType(ctx, { key: "intro", name: options.typeName ?? "Intro call", durationMinutes: 30, media: ["video"], minNoticeMinutes: 0 });
  return { tenantId, ctx, host };
}

function publicFor(tenantId: string, extra: Partial<CreateBookingHandlersOptions> = {}) {
  return createBookingHandlers({
    db: t.db,
    tenantId,
    uidDomain: "lawnco.test",
    manageUrl: (token) => `${HOST}/t/x/book/manage/${token}`,
    now: () => NOW,
    ...extra,
  });
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${HOST}/api/t/x/calls${path}`, { method: "POST", headers: { "sec-fetch-site": "same-origin", ...headers }, body: JSON.stringify(body) });

/** Hold, then book — the widget's way. */
async function holdAndBook(handlers: ReturnType<typeof publicFor>, start: string, email: string) {
  const held = await handlers.handle(post("/v1/hold", { type: "intro", start }));
  const hold = (await held.json()) as { holdToken?: string };
  const res = await handlers.handle(post("/v1/book", { type: "intro", start, holdToken: hold.holdToken, name: "Sam Buyer", email, medium: "video", timezone: "UTC" }));
  return { status: res.status, body: (await res.json()) as { manageToken?: string; error?: { code: string } } };
}

describe("H1: a host whose person left the company is off", () => {
  const nobody: HostMembers = () => new Set<string>();
  const stillHere: HostMembers = (_tenant, ids) => new Set(ids);

  it("no times, no booking, no feed, no notice — once they're not a member", async () => {
    const { ctx, host } = await business({ userId: "u_pat" });
    const { feedToken } = await rotateHostFeedToken(ctx, host.id);
    const gone: BookingContext = { ...ctx, hostMembers: nobody };
    expect((await listOpenSlots(gone, { typeKey: "intro" })).slots).toEqual([]);
    await expect(holdSlot(gone, { typeKey: "intro", start: TUE(10) })).rejects.toMatchObject({ code: "slot_taken" });
    const feed = await publicFor(ctx.tenantId, { hostMembers: nobody }).handle(new Request(`${HOST}/api/t/x/calls/v1/feed/${feedToken}.ics`));
    expect(feed.status).toBe(404);
    // A booking made while they were here, cancelled after they left: nobody writes them a notice.
    const events: BookingEvent[] = [];
    const here: BookingContext = { ...ctx, hostMembers: stillHere };
    const { manageToken } = await book(here, { typeKey: "intro", start: TUE(11), name: "Sam", email: "sam@x.test", medium: "video" });
    const cancel = await publicFor(ctx.tenantId, { hostMembers: nobody, onEvent: (event) => void events.push(event) }).handle(post(`/v1/manage/${manageToken}/cancel`, {}));
    expect(cancel.status).toBe(200);
    expect(events[0]?.hostActive).toBe(false);
    expect(bookingEmailVars(events[0]!, { baseUrl: HOST, includeManageLink: false }).templateFor.host).toBeNull();
  });

  it("negative control: the same host, still a member, is offered and has a feed", async () => {
    const { ctx, host } = await business({ userId: "u_pat" });
    const { feedToken } = await rotateHostFeedToken(ctx, host.id);
    expect((await listOpenSlots({ ...ctx, hostMembers: stillHere }, { typeKey: "intro" })).slots.length).toBeGreaterThan(0);
    const feed = await publicFor(ctx.tenantId, { hostMembers: stillHere }).handle(new Request(`${HOST}/api/t/x/calls/v1/feed/${feedToken}.ics`));
    expect(feed.status).toBe(200);
  });

  it("a single business's hosts with no user id keep 0.1's behaviour", async () => {
    const { ctx } = await business();
    expect((await listOpenSlots({ ...ctx, hostMembers: nobody }, { typeKey: "intro" })).slots.length).toBeGreaterThan(0);
  });

  it("switching someone off never asks if they're still on the team; switching them on does", async () => {
    const { tenantId, host } = await business({ userId: "u_pat" });
    const admin = createBookingAdminHandlers({ db: t.db, tenantId, authorize: () => true, member: () => null, now: () => NOW });
    const update = (body: unknown) =>
      admin.handle(new Request(`${HOST}/api/app/${tenantId}/calls/v1/hosts/${host.id}`, { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) }));
    const fields = { displayName: "Pat Host", email: "pat@biz.test", timezone: "UTC" };
    expect((await update({ ...fields, isActive: false })).status).toBe(200);
    // Negative control: back on, with nobody on the team by that email, is refused.
    expect((await update({ ...fields, isActive: true })).status).toBe(400);
  });
});

describe("H2: a stranger can't close a company's page for a day", () => {
  it("the daily cap counts live bookings: cancelling the junk opens the page again", async () => {
    const { tenantId, ctx } = await business();
    const handlers = publicFor(tenantId, { dailyBookingLimit: 1 });
    const first = await holdAndBook(handlers, TUE(10), "junk@spam.test");
    expect(first.status).toBe(200);
    // Negative control: while it stands, the page is closed for the day.
    expect((await holdAndBook(handlers, TUE(11), "real@buyer.test")).body.error?.code).toBe("rate_limited");
    expect(await cancelAllFromEmail(ctx, { email: "junk@spam.test" })).toEqual({ cancelled: 1 });
    expect((await holdAndBook(handlers, TUE(12), "real@buyer.test")).status).toBe(200);
  });

  it("a booking needs a hold, so the hold caps apply to every booking", async () => {
    const { tenantId } = await business();
    const res = await publicFor(tenantId).handle(post("/v1/book", { type: "intro", start: TUE(10), name: "Bot", email: "bot@x.test", medium: "video" }));
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([409, "hold_expired"]);
    // Negative control: an app that turns the rule off books without a hold, as 0.1 did.
    expect((await publicFor(tenantId, { requireHold: false }).handle(post("/v1/book", { type: "intro", start: TUE(10), name: "Bot", email: "bot@x.test", medium: "video" }))).status).toBe(200);
  });

  it("one email: two a day with one company, and a cap across every company", async () => {
    const a = await business();
    const handlersA = publicFor(a.tenantId);
    expect((await holdAndBook(handlersA, TUE(10), "same@x.test")).status).toBe(200);
    expect((await holdAndBook(handlersA, TUE(11), "same@x.test")).status).toBe(200);
    expect((await holdAndBook(handlersA, TUE(12), "same@x.test")).body.error?.code).toBe("rate_limited");
    // Negative control: another address still books here.
    expect((await holdAndBook(handlersA, TUE(13), "other@x.test")).status).toBe(200);
    // Across companies: with a site-wide cap of 3, this address's third company... it already has 2 here.
    const b = await business();
    const handlersB = publicFor(b.tenantId, { maxBookingsPerEmailSitewide: 3 });
    expect((await holdAndBook(handlersB, TUE(10), "same@x.test")).status).toBe(200);
    expect((await holdAndBook(handlersB, TUE(11), "same@x.test")).body.error?.code).toBe("rate_limited");
  });

  it("IPv6 visitors are counted by /64: rotating addresses in one /64 meets the hold cap", async () => {
    expect(networkKeyOf("2001:db8:1:2:aaaa::1")).toBe(networkKeyOf("2001:db8:1:2:bbbb:cccc:dddd:9"));
    expect(networkKeyOf("2001:db8:1:2::1")).not.toBe(networkKeyOf("2001:db8:1:3::1"));
    expect(networkKeyOf("203.0.113.9")).toBe("203.0.113.9");
    const { tenantId } = await business();
    let n = 0;
    const handlers = publicFor(tenantId, { holdSubject: () => `2001:db8:1:2::${(n += 1)}` });
    const hold = (start: string) => handlers.handle(post("/v1/hold", { type: "intro", start }));
    expect((await hold(TUE(10))).status).toBe(200);
    expect((await hold(TUE(11))).status).toBe(200);
    expect((await hold(TUE(12))).status).toBe(429);
    // Negative control: another /64 is another visitor.
    const other = publicFor(tenantId, { holdSubject: () => "2001:db8:9:9::1" });
    expect((await other.handle(post("/v1/hold", { type: "intro", start: TUE(13) }))).status).toBe(200);
  });
});

describe("H3: a company can't phish from the platform's domain", () => {
  async function created(typeName: string, meetingLink: string) {
    const { ctx, host } = await business({ typeName });
    await upsertHost(ctx, { id: host.id, displayName: "Pat Host", email: "pat@biz.test", timezone: "UTC", meetingLink });
    const events: BookingEvent[] = [];
    await book({ ...ctx, onEvent: (event) => void events.push(event) }, { typeKey: "intro", start: TUE(10), name: "Sam", email: "sam@buyer.test", medium: "video" });
    return events[0]!;
  }
  const options = { baseUrl: HOST, includeManageLink: true, businessName: 'Acme <Roofing>\n"Ltd"', appName: "Igloo", replyTo: "owner@acme.test" };

  it("fixed subject, quoted type, From '{business} via {app}', the owner's reply-to, the footer", async () => {
    const event = await created("URGENT: verify your bank account", "https://us02web.zoom.us/j/123");
    const mail = platformBookingEmails(event, options);
    expect(mail.fromName).toBe("Acme Roofing Ltd via Igloo");
    expect(mail.invitee?.subject).toMatch(/^Your call with Acme Roofing Ltd is booked — /);
    expect(mail.invitee?.subject).not.toContain("URGENT");
    expect(mail.invitee?.text).toContain("“URGENT: verify your bank account”");
    expect(mail.invitee?.text.trim().endsWith("Sent for Acme Roofing Ltd by Igloo.")).toBe(true);
    expect(mail.invitee?.replyTo).toBe("owner@acme.test");
    // A known meeting service is a button, its host shown in bold.
    expect(mail.invitee?.html).toContain('<a href="https://us02web.zoom.us/j/123"');
    expect(mail.invitee?.html).toContain("<b>us02web.zoom.us</b>");
  });

  it("any other link is plain text — never a button, never clickable", async () => {
    const event = await created("Intro call", "https://zoom.us.evil.example/login");
    const mail = platformBookingEmails(event, { ...options, replyTo: null });
    expect(mail.invitee?.html).not.toContain('href="https://zoom.us.evil.example');
    expect(mail.invitee?.html).toContain("<b>zoom.us.evil.example</b>");
    // No verified address: no Reply-To at all — never the host's typed one.
    expect(mail.invitee?.replyTo).toBeNull();
  });

  it("negative control: the single-site emails (0.1's) still put the call type in the subject", async () => {
    const event = await created("URGENT: verify your bank account", "https://zoom.us/j/1");
    const mail = bookingEmailVars(event, { baseUrl: HOST, includeManageLink: true });
    expect(mail.invitee["typeName"]).toBe("URGENT: verify your bank account");
  });
});

describe("M2: the people-taking-calls limit, and one host per person", () => {
  it("two adds at once can't both be the one that fits; the same person can't be added twice", async () => {
    const tenantId = tenant("race");
    const ctx: BookingContext = { db: t.db, tenantId, now: NOW };
    const adds = await Promise.allSettled([
      upsertHost(ctx, { displayName: "A", email: "a@x.test", timezone: "UTC", userId: "u_a" }, { maxActive: 1 }),
      upsertHost(ctx, { displayName: "B", email: "b@x.test", timezone: "UTC", userId: "u_b" }, { maxActive: 1 }),
    ]);
    expect(adds.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(adds.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "limit_reached" } });
    const winner = (adds.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ userId: string }>).value.userId;
    await expect(upsertHost(ctx, { displayName: "Again", email: "again@x.test", timezone: "UTC", userId: winner })).rejects.toMatchObject({ code: "invalid" });
    // Negative control: with room in the plan, a different person is added.
    expect((await upsertHost(ctx, { displayName: "C", email: "c@x.test", timezone: "UTC", userId: "u_c" }, { maxActive: 5 })).userId).toBe("u_c");
  });
});

describe("L3: a reminder whose send failed is tried again, at most three times", () => {
  it("released claims come back, until the third attempt", async () => {
    const { ctx } = await business();
    await book(ctx, { typeKey: "intro", start: TUE(10), name: "Sam", email: "sam@x.test", medium: "video" });
    const window = { withinMs: 2 * 86_400_000 };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [due] = await dueReminders(ctx, window);
      expect(due, `attempt ${attempt}`).toBeDefined();
      expect(await claimReminder(ctx, due!.booking.id)).toBe(true);
      await releaseReminder(ctx, due!.booking.id);
    }
    expect(await dueReminders(ctx, window)).toEqual([]);
  });
});

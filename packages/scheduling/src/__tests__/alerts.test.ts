import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The real comms functions, wrapped so a test can tell which one sent an
// office notice: 2a's `sendNow` (no alerts) or 0.4's `deliverNow` (with
// `officeRecipients`, contract 9.3). Hoisted above every import by vitest.
vi.mock("@adminigloo/comms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@adminigloo/comms")>();
  return { ...actual, sendNow: vi.fn(actual.sendNow), deliverNow: vi.fn(actual.deliverNow) };
});

import * as comms from "@adminigloo/comms";
import { commsMessages, type OutboundEmail } from "@adminigloo/comms";
import { and, eq } from "drizzle-orm";
import { schedulingOfficeNotice } from "../alerts.js";
import {
  createSchedulingCommsListener,
  type SchedulingCommsOptions,
  type SchedulingOfficeNotice,
  type SchedulingOfficeSendResult,
} from "../comms.js";
import {
  createResource,
  createSchedulingAdminHandlers,
  getSchedulingSettings,
  listExpiringRequests,
  schedulingAlertKinds,
  schedulingAlertsFor,
  schedulingBookings,
  schedulingExpiringAlert,
  updateSchedulingSettings,
  type SchedulingAlertDraft,
  type SchedulingAlertKinds,
  type SchedulingEvent,
  type SchedulingEventType,
  type VisitSnapshot,
} from "../index.js";
import { apiRequest, readJson } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, contract 9.1–9.4 and 15.3: what scheduling tells the bell,
 * and how the office email follows the one alert setting.
 *
 *   - the mapper writes an alert exactly where the comms listener writes an
 *     office notice, under the SAME kind and dedupe key (the claim finds the
 *     rows the mapper wrote);
 *   - the words: times in the visit's own zone, both times on a move, the
 *     crew (old and new) and where their link goes;
 *   - the expiring sweep's window and its "not just made" rule;
 *   - `officeRecipients` / `officeSent` on the real comms tables (PGlite),
 *     and 2a's path exactly without them;
 *   - `alertsHref` on the settings routes;
 *   - the fragment against the registry's rules (4.2), copied here as a
 *     check so scheduling never imports notifications.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});
afterEach(() => {
  vi.mocked(comms.sendNow).mockClear();
  vi.mocked(comms.deliverNow).mockClear();
});

const HREFS = {
  visit: "/app/schedule?date={date}&visit={id}",
  crewDay: "/app/schedule/today",
  visitFiles: "/app/schedule/visits/{id}/files",
} as const;

/** Tue 2026-11-03 09:00 MST (Denver is on standard time from Nov 1). */
function snapshot(over: Partial<VisitSnapshot> = {}): VisitSnapshot {
  return {
    id: "visit-1",
    status: "pending",
    nextStatuses: [],
    date: "2026-11-03",
    startTime: "09:00",
    endTime: "10:00",
    startsAt: "2026-11-03T16:00:00.000Z",
    endsAt: "2026-11-03T17:00:00.000Z",
    timeZone: "America/Denver",
    durationMinutes: 60,
    resourceId: null,
    resourceName: null,
    serviceKey: "estimate",
    serviceName: "Free estimate",
    title: null,
    customerName: "Pat Rivera",
    customerEmail: "pat@example.com",
    customerPhone: "(801) 555-0101",
    address: "1 Main St, SLC",
    lat: null,
    lng: null,
    notes: null,
    estimateId: null,
    origin: "public",
    sequence: 0,
    pendingExpiresAt: "2026-11-02T16:00:00.000Z",
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-10-29T15:00:00.000Z",
    updatedAt: "2026-10-29T15:00:00.000Z",
    ...over,
  };
}

let eventCounter = 0;
function event(
  type: SchedulingEventType,
  actor: SchedulingEvent["actor"]["type"],
  options: { tenantId?: string; visit?: Partial<VisitSnapshot>; data?: Partial<SchedulingEvent["data"]> } = {},
): SchedulingEvent {
  eventCounter += 1;
  const visit = snapshot(options.visit);
  return {
    id: `event-${eventCounter}`,
    type,
    tenantId: options.tenantId ?? "acme",
    visitId: visit.id,
    occurredAt: "2026-10-29T15:00:00.000Z",
    actor: { type: actor, id: actor === "staff" ? "user-staff" : null },
    data: { visit, notify: true, ...options.data },
  };
}

const ALL_TYPES: SchedulingEventType[] = [
  "visit.requested",
  "visit.confirmed",
  "visit.declined",
  "visit.rescheduled",
  "visit.reassigned",
  "visit.cancelled",
  "visit.expired",
  "visit.started",
  "visit.completed",
];
const ACTORS = ["customer", "staff", "system"] as const;

/** Contract 9.1's table: which (event, actor) is an alert, and of which kind. */
function expectedKind(type: SchedulingEventType, actor: (typeof ACTORS)[number]): string | null {
  if (type === "visit.expired") return "scheduling.request.expired";
  if (actor === "staff") return null;
  if (type === "visit.requested") return "scheduling.visit.requested";
  if (type === "visit.rescheduled" && actor === "customer") return "scheduling.visit.moved";
  if (type === "visit.cancelled" && actor === "customer") return "scheduling.visit.cancelled";
  return null;
}

async function company(over: Parameters<typeof updateSchedulingSettings>[2] = {}) {
  const tenantId = tenant("acme");
  await updateSchedulingSettings(t.db, tenantId, {
    timeZone: "America/Denver",
    businessName: "Acme Windows",
    staffNotifyEmails: ["saved@acme.test"],
    services: [{ key: "estimate", name: "Free estimate", durationMinutes: 60 }],
    ...over,
  });
  return tenantId;
}

/** A sender that records what left, and fails for some addresses. */
function mailbox(options: { down?: readonly string[]; hang?: readonly string[] } = {}) {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    senders: {
      email: async (message: OutboundEmail) => {
        if (options.hang?.includes(message.to)) return new Promise<never>(() => undefined);
        if (options.down?.includes(message.to)) throw new Error("mail server down");
        sent.push(message);
        return { id: `msg-${sent.length}` };
      },
    },
  };
}

function listener(tenantId: string, overrides: Partial<SchedulingCommsOptions> = {}, mail = mailbox()) {
  const errors: Array<{ error: unknown; step: string }> = [];
  const notices: SchedulingOfficeNotice[] = [];
  const outcomes: Array<{ notice: SchedulingOfficeNotice; result: SchedulingOfficeSendResult }> = [];
  const l = createSchedulingCommsListener({
    db: t.db,
    senders: mail.senders,
    manageUrl: (token) => `https://acme.test/visit/${token}`,
    adminUrl: "https://acme.test/app/schedule",
    reminders: false,
    now: () => new Date("2026-10-29T15:00:00Z"),
    onError: (error, context) => errors.push({ error, step: context.step }),
    ...overrides,
  });
  return { listener: l, errors, notices, outcomes, mail, tenantId };
}

async function staffNotices(tenantId: string) {
  return t.db
    .select()
    .from(commsMessages)
    .where(and(eq(commsMessages.tenantId, tenantId), eq(commsMessages.templateKey, "visit_staff_notice")));
}

// ---------------------------------------------------------------------------

describe("the fragment (contract 9.1; the registry's rules of 4.2, copied as a check)", () => {
  const KIND_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
  const ROUTING_KEY = /^[a-z][a-z0-9-]{1,31}$/;

  /** What `defineAlertKinds` refuses, as plain checks (no notifications import, 2a D4). */
  function problems(fragment: SchedulingAlertKinds): string[] {
    const out: string[] = [];
    const routings = new Set<string>();
    for (const routing of fragment.routings) {
      if (!ROUTING_KEY.test(routing.key)) out.push(`routing key ${routing.key}`);
      if (routings.has(routing.key)) out.push(`duplicate routing ${routing.key}`);
      routings.add(routing.key);
      if (routing.label.length < 1 || routing.label.length > 80) out.push(`routing label ${routing.key}`);
      if ((routing.description ?? "").length > 200) out.push(`routing description ${routing.key}`);
      if (!routing.permission) out.push(`routing permission ${routing.key}`);
    }
    const keys = new Set<string>();
    for (const kind of fragment.kinds) {
      if (!KIND_KEY.test(kind.key) || kind.key.length > 64) out.push(`key ${kind.key}`);
      if (keys.has(kind.key)) out.push(`duplicate ${kind.key}`);
      keys.add(kind.key);
      if (kind.label.length < 1 || kind.label.length > 80) out.push(`label ${kind.key}`);
      if (kind.category.length < 1 || kind.category.length > 40) out.push(`category ${kind.key}`);
      if ((kind.description ?? "").length > 200) out.push(`description ${kind.key}`);
      if (!kind.audience.permission) out.push(`permission ${kind.key}`);
      if (kind.audience.assigned && !kind.audience.assigned.permission) out.push(`assigned permission ${kind.key}`);
      if (kind.email === false && kind.defaultChannel === "email") out.push(`email default on email:false ${kind.key}`);
      if (kind.email === false && kind.emailBy === "producer") out.push(`producer on email:false ${kind.key}`);
      if (kind.audience.routing && !routings.has(kind.audience.routing)) out.push(`unknown routing ${kind.key}`);
    }
    return out;
  }

  it("passes every rule, and is the contract's table", () => {
    expect(problems(schedulingAlertKinds)).toEqual([]);
    expect(schedulingAlertKinds.kinds.map((k) => [k.key, k.audience.routing, k.audience.assigned?.permission ?? null, k.defaultChannel, k.emailBy])).toEqual([
      ["scheduling.visit.requested", "visits", null, "email", "producer"],
      ["scheduling.visit.moved", "visits", "schedule.route", "email", "producer"],
      ["scheduling.visit.cancelled", "visits", "schedule.route", "email", "producer"],
      ["scheduling.request.expiring", "visits", null, "email", "notifications"],
      ["scheduling.request.expired", "visits", null, "email", "producer"],
    ]);
    expect(new Set(schedulingAlertKinds.kinds.map((k) => k.category))).toEqual(new Set(["Visits"]));
    expect(new Set(schedulingAlertKinds.kinds.map((k) => k.audience.permission))).toEqual(new Set(["schedule.view"]));
    expect(schedulingAlertKinds.routings).toEqual([
      {
        key: "visits",
        label: "Visit requests and customer changes",
        description: "New visit requests, a customer moving or cancelling, and requests about to lapse.",
        permission: "schedule.view",
        order: 20,
      },
    ]);
  });

  it("the check catches what the registry refuses (negative control)", () => {
    const broken: SchedulingAlertKinds = {
      routings: [],
      kinds: [
        { key: "Scheduling.Bad", label: "", category: "Visits", audience: { permission: "", routing: "nope" }, defaultChannel: "email", email: false, emailBy: "producer" },
      ],
    };
    expect(problems(broken)).toEqual([
      "key Scheduling.Bad",
      "label Scheduling.Bad",
      "permission Scheduling.Bad",
      "email default on email:false Scheduling.Bad",
      "producer on email:false Scheduling.Bad",
      "unknown routing Scheduling.Bad",
    ]);
  });
});

describe("the mapper writes exactly where the office notice does (contract 9.1)", () => {
  it("every event type and actor: an alert iff an office notice, with the same kind and key", async () => {
    const tenantId = await company();
    const notices: SchedulingOfficeNotice[] = [];
    const { listener: l } = listener(tenantId, {
      officeRecipients: (notice) => {
        notices.push(notice);
        return [];
      },
    });
    for (const type of ALL_TYPES) {
      for (const actor of ACTORS) {
        const shapes: Array<Partial<VisitSnapshot>> = type === "visit.requested" ? [{ status: "pending" }, { status: "confirmed" }] : [{ status: "confirmed", sequence: 2 }];
        for (const visit of shapes) {
          const e = event(type, actor, {
            tenantId,
            visit,
            data: type === "visit.rescheduled" ? { previous: { date: "2026-11-02", startTime: "09:00", endTime: "10:00", startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z", resourceId: null, resourceName: null } } : {},
          });
          const drafts = await schedulingAlertsFor(t.db, e, { hrefs: HREFS, now: new Date("2026-10-29T15:00:00Z") });
          notices.length = 0;
          await l.onEvent(e);
          const label = `${type} by ${actor} (${visit.status})`;
          const expected = expectedKind(type, actor);
          expect(drafts.map((d) => d.kind), label).toEqual(expected ? [expected] : []);
          expect(notices.map((n) => [n.kind, n.dedupeKey]), label).toEqual(drafts.map((d) => [d.kind, d.dedupeKey]));
          if (expected) expect(notices[0]!.eventId, label).toBe(e.id);
        }
      }
    }
  });

  it("dedupe keys come from the fact (contract 9.1's table)", async () => {
    const at = { hrefs: HREFS, now: new Date("2026-10-29T15:00:00Z") };
    const key = async (e: SchedulingEvent) => (await schedulingAlertsFor(t.db, e, at))[0]!.dedupeKey;
    expect(await key(event("visit.requested", "customer"))).toBe("scheduling.visit.requested:visit-1");
    // An auto-confirmed booking is the same fact as the request: one row.
    expect(await key(event("visit.requested", "customer", { visit: { status: "confirmed" } }))).toBe("scheduling.visit.requested:visit-1");
    expect(await key(event("visit.rescheduled", "customer", { visit: { status: "confirmed", sequence: 3 } }))).toBe("scheduling.visit.moved:visit-1:3");
    expect(await key(event("visit.cancelled", "customer", { visit: { status: "cancelled", sequence: 4 } }))).toBe("scheduling.visit.cancelled:visit-1:4");
    expect(await key(event("visit.expired", "system", { visit: { status: "expired", sequence: 1 } }))).toBe("scheduling.request.expired:visit-1");
    // The same move handed over twice is the same key; the next move is a new one.
    const first = event("visit.rescheduled", "customer", { visit: { sequence: 3 } });
    const again = { ...first, id: "event-redelivered" };
    expect(await key(again)).toBe(await key(first));
    expect(await key(event("visit.rescheduled", "customer", { visit: { sequence: 4 } }))).not.toBe(await key(first));
  });

  it("schedulingOfficeNotice is what both halves ask (the comms listener imports it)", () => {
    expect(schedulingOfficeNotice(event("visit.requested", "customer"))).toEqual({
      notice: "New request",
      kind: "scheduling.visit.requested",
      dedupeKey: "scheduling.visit.requested:visit-1",
    });
    expect(schedulingOfficeNotice(event("visit.requested", "staff"))).toBeNull();
    expect(schedulingOfficeNotice(event("visit.expired", "staff"))?.notice).toBe("Request expired");
  });
});

describe("the words", () => {
  const at = { hrefs: HREFS, now: new Date("2026-10-29T15:00:00Z") };

  it("a request: the time in the visit's own zone, the service and address, and the map warning", async () => {
    const [draft] = await schedulingAlertsFor(t.db, event("visit.requested", "customer", { data: { addressUnverified: true } }), at);
    expect(draft).toEqual({
      tenantId: "acme",
      kind: "scheduling.visit.requested",
      title: "New visit request: Pat Rivera, Tue, Nov 3, 9:00 AM MST",
      body: "Free estimate at 1 Main St, SLC.\nThe address couldn't be found on the map. Check it with them.",
      href: "/app/schedule?date=2026-11-03&visit=visit-1",
      dedupeKey: "scheduling.visit.requested:visit-1",
      subject: { type: "scheduling.visit", id: "visit-1" },
      actorUserId: null,
      replyTo: "pat@example.com",
    } satisfies SchedulingAlertDraft);
  });

  it("the same instant reads in another zone's clock for a business there", async () => {
    const [draft] = await schedulingAlertsFor(t.db, event("visit.requested", "customer", { visit: { timeZone: "America/New_York" } }), at);
    expect(draft!.title).toBe("New visit request: Pat Rivera, Tue, Nov 3, 11:00 AM EST");
  });

  it("a booking; a nameless customer; no address", async () => {
    const [booking] = await schedulingAlertsFor(t.db, event("visit.requested", "customer", { visit: { status: "confirmed", customerName: null, address: null } }), at);
    expect(booking!.title).toBe("New booking: a customer, Tue, Nov 3, 9:00 AM MST");
    expect(booking!.body).toBe("Free estimate.");
  });

  it("what a customer typed is one line in a title, and long text is clipped", async () => {
    const separator = String.fromCharCode(0x2028);
    const [draft] = await schedulingAlertsFor(t.db, event("visit.requested", "customer", { visit: { customerName: `Pat\r\nBcc: x@y.z${separator}Rivera` } }), at);
    expect(draft!.title).not.toMatch(new RegExp(`[\\r\\n${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`));
    expect(draft!.title).toBe("New visit request: Pat Bcc: x@y.z Rivera, Tue, Nov 3, 9:00 AM MST");
    const [long] = await schedulingAlertsFor(t.db, event("visit.requested", "customer", { visit: { customerName: "N".repeat(400) } }), at);
    expect(long!.title.length).toBeLessThanOrEqual(200);
  });

  it("a move states both times in full (review BO-04)", async () => {
    const [draft] = await schedulingAlertsFor(
      t.db,
      event("visit.rescheduled", "customer", {
        visit: { status: "confirmed", sequence: 2, date: "2026-11-05", startsAt: "2026-11-05T21:00:00.000Z", endsAt: "2026-11-05T22:00:00.000Z" },
        data: { previous: { date: "2026-11-03", startTime: "09:00", endTime: "10:00", startsAt: "2026-11-03T16:00:00.000Z", endsAt: "2026-11-03T17:00:00.000Z", resourceId: null, resourceName: null } },
      }),
      at,
    );
    expect(draft!.title).toBe("Pat Rivera moved their visit to Thu, Nov 5, 2:00 PM MST");
    // Both times in full, and where the job is (review BO-13).
    expect(draft!.body).toBe("Now Thu, Nov 5, 2:00 PM MST. It was Tue, Nov 3, 9:00 AM MST. Free estimate at 1 Main St, SLC.");
    expect(draft!.href).toBe("/app/schedule?date=2026-11-05&visit=visit-1");
  });

  it("a cancel carries what they said; an expiry says what they asked for", async () => {
    const [cancel] = await schedulingAlertsFor(t.db, event("visit.cancelled", "customer", { visit: { status: "cancelled", customerName: null }, data: { reason: "Moving house" } }), at);
    expect(cancel!.title).toBe("A customer cancelled their visit on Tue, Nov 3, 9:00 AM MST");
    expect(cancel!.body).toBe("Free estimate at 1 Main St, SLC. They said: Moving house");
    const [quiet] = await schedulingAlertsFor(t.db, event("visit.cancelled", "customer", { visit: { status: "cancelled", address: null } }), at);
    expect(quiet!.body).toBe("Free estimate.");
    const [expired] = await schedulingAlertsFor(t.db, event("visit.expired", "system", { visit: { status: "expired" } }), at);
    expect(expired!.title).toBe("Pat Rivera's visit request lapsed unanswered");
    expect(expired!.body).toBe("They asked for Tue, Nov 3, 9:00 AM MST (Free estimate).");
    expect(expired!.assignedUserIds).toBeUndefined();
  });

  it("an id is URL-encoded into the patterns", async () => {
    const [draft] = await schedulingAlertsFor(t.db, event("visit.requested", "customer", { visit: { id: "a b/c?d" } }), at);
    expect(draft!.href).toBe("/app/schedule?date=2026-11-03&visit=a%20b%2Fc%3Fd");
  });
});

describe("the crew (contract 9.1, review BO-03 / BO-04)", () => {
  it("a move names the people on the visit's crew AND its previous crew (the old crew alone in their own draft, review BO-2); a crew with nobody linked adds nobody", async () => {
    const tenantId = await company();
    const oldCrew = await createResource(t.db, { tenantId, name: "Crew A", userId: "user-cam" });
    const newCrew = await createResource(t.db, { tenantId, name: "Crew B", userId: "user-dee" });
    const nobody = await createResource(t.db, { tenantId, name: "Crew C" });
    const other = tenant("other");
    const foreign = await createResource(t.db, { tenantId: other, name: "Their crew", userId: "user-foreign" });
    const moved = (resourceId: string, previousId: string | null) =>
      event("visit.rescheduled", "customer", {
        tenantId,
        visit: { status: "confirmed", sequence: 1, resourceId },
        data: { previous: { date: "2026-11-02", startTime: "09:00", endTime: "10:00", startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z", resourceId: previousId, resourceName: null } },
      });
    t.queries.length = 0;
    const both = await schedulingAlertsFor(t.db, moved(newCrew.id, oldCrew.id), { hrefs: HREFS });
    expect(both.flatMap((draft) => draft.assignedUserIds ?? []).sort()).toEqual(["user-cam", "user-dee"]);
    expect(both.map((draft) => draft.assignedUserIds)).toEqual([["user-dee"], ["user-cam"]]);
    // ONE query for the crew, whatever the move.
    expect(t.queries.filter((q) => q.sql.includes("scheduling_resources"))).toHaveLength(1);
    const [none] = await schedulingAlertsFor(t.db, moved(nobody.id, null), { hrefs: HREFS });
    expect(none!.assignedUserIds).toEqual([]);
    // Another company's crew id names nobody here.
    const [cross] = await schedulingAlertsFor(t.db, moved(foreign.id, null), { hrefs: HREFS });
    expect(cross!.assignedUserIds).toEqual([]);
    const [cancel] = await schedulingAlertsFor(t.db, event("visit.cancelled", "customer", { tenantId, visit: { status: "cancelled", resourceId: newCrew.id } }), { hrefs: HREFS });
    expect(cancel!.assignedUserIds).toEqual(["user-dee"]);
  });

  it("assignedHref: today's route for today, else the visit's files page, else nothing", async () => {
    // 08:00 MST on Tue Nov 3 in Denver: still Nov 3 there.
    const now = new Date("2026-11-03T15:00:00Z");
    const move = (date: string) =>
      event("visit.rescheduled", "customer", {
        visit: { status: "confirmed", sequence: 1, date },
        data: { previous: { date: "2026-11-09", startTime: "09:00", endTime: "10:00", startsAt: "2026-11-09T16:00:00.000Z", endsAt: "2026-11-09T17:00:00.000Z", resourceId: null, resourceName: null } },
      });
    const cancel = (date: string) => event("visit.cancelled", "customer", { visit: { status: "cancelled", sequence: 1, date } });
    const href = async (e: SchedulingEvent, hrefs: { visit: string; crewDay: string; visitFiles?: string } = HREFS) =>
      (await schedulingAlertsFor(t.db, e, { hrefs, now }))[0]!.assignedHref;
    expect(await href(move("2026-11-03"))).toBe("/app/schedule/today");
    expect(await href(move("2026-11-04"))).toBe("/app/schedule/visits/visit-1/files");
    expect(await href(move("2026-11-04"), { visit: HREFS.visit, crewDay: HREFS.crewDay })).toBeNull();
    expect(await href(cancel("2026-11-03"))).toBe("/app/schedule/today");
    expect(await href(cancel("2026-11-05"))).toBe("/app/schedule/visits/visit-1/files");
    // "Today" is the visit's zone: 23:30 MST on Nov 2 is already Nov 3 in UTC, not in Denver.
    expect(await schedulingAlertsFor(t.db, move("2026-11-03"), { hrefs: HREFS, now: new Date("2026-11-03T06:30:00Z") }).then((d) => d[0]!.assignedHref)).toBe(
      "/app/schedule/visits/visit-1/files",
    );
  });
});

/**
 * What each person ends up with from one `notify` call: notifications keeps
 * ONE row per person per dedupe key, the first draft's (contract 4.5, D7).
 * `office` is who the kind's routing reaches; the crew come from each draft's
 * `assignedUserIds`, opening its `assignedHref`.
 */
function rowsFor(drafts: readonly SchedulingAlertDraft[], office: readonly string[]) {
  const rows = new Map<string, { title: string; body: string | null; href: string | null }>();
  for (const draft of drafts) {
    for (const person of office) {
      const key = `${person} ${draft.dedupeKey}`;
      if (!rows.has(key)) rows.set(key, { title: draft.title, body: draft.body, href: draft.href });
    }
    for (const person of draft.assignedUserIds ?? []) {
      const key = `${person} ${draft.dedupeKey}`;
      if (!rows.has(key)) rows.set(key, { title: draft.title, body: draft.body, href: draft.assignedHref === undefined ? draft.href : draft.assignedHref });
    }
  }
  return Object.fromEntries([...rows].map(([key, row]) => [key.split(" ")[0]!, row]));
}

describe("a customer's move onto another crew (review BO-2), and the job's address for the crew (BO-13)", () => {
  const previous = (resourceId: string | null, resourceName: string | null, date = "2026-11-03") => ({
    date,
    startTime: "09:00",
    endTime: "10:00",
    startsAt: `${date}T16:00:00.000Z`,
    endsAt: `${date}T17:00:00.000Z`,
    resourceId,
    resourceName,
  });

  it("the office and the new crew hear of the move; the old crew alone hear it's off their route, with nothing to open", async () => {
    const tenantId = await company();
    const north = await createResource(t.db, { tenantId, name: "North", userId: "user-cam" });
    const south = await createResource(t.db, { tenantId, name: "South", userId: "user-dee" });
    const moved = event("visit.rescheduled", "customer", {
      tenantId,
      visit: { status: "confirmed", sequence: 2, resourceId: south.id, resourceName: "South", date: "2026-11-04", startsAt: "2026-11-04T17:00:00.000Z", endsAt: "2026-11-04T18:00:00.000Z" },
      data: { previous: previous(north.id, "North") },
    });
    t.queries.length = 0;
    const drafts = await schedulingAlertsFor(t.db, moved, { hrefs: HREFS, now: new Date("2026-11-02T15:00:00Z") });
    // Still ONE query for the crews.
    expect(t.queries.filter((q) => q.sql.includes("scheduling_resources"))).toHaveLength(1);
    expect(drafts).toHaveLength(2);
    const [move, offRoute] = drafts as [SchedulingAlertDraft, SchedulingAlertDraft];
    expect(move).toMatchObject({
      kind: "scheduling.visit.moved",
      title: "Pat Rivera moved their visit to Wed, Nov 4, 10:00 AM MST",
      body: "Now Wed, Nov 4, 10:00 AM MST, with South. It was Tue, Nov 3, 9:00 AM MST, with North. Free estimate at 1 Main St, SLC.",
      assignedUserIds: ["user-dee"],
      assignedHref: "/app/schedule/visits/visit-1/files",
    });
    expect(offRoute).toMatchObject({
      kind: move.kind,
      dedupeKey: move.dedupeKey,
      title: "Pat Rivera's visit is off your route: moved to Wed, Nov 4, 10:00 AM MST",
      body: "It's now with South. It was Tue, Nov 3, 9:00 AM MST. Free estimate at 1 Main St, SLC.",
      assignedUserIds: ["user-cam"],
      assignedHref: null,
    });
    // What each one reads: Gail (the office) and Dee the move, Cam that it left his route.
    const rows = rowsFor(drafts, ["user-gail"]);
    expect(rows["user-gail"]).toEqual({ title: move.title, body: move.body, href: "/app/schedule?date=2026-11-04&visit=visit-1" });
    expect(rows["user-dee"]).toEqual({ title: move.title, body: move.body, href: "/app/schedule/visits/visit-1/files" });
    expect(rows["user-cam"]).toEqual({ title: offRoute.title, body: offRoute.body, href: null });
  });

  it("the old crew had it on today's route: their alert opens today's route (it is gone from it)", async () => {
    const tenantId = await company();
    const north = await createResource(t.db, { tenantId, name: "North", userId: "user-cam" });
    const south = await createResource(t.db, { tenantId, name: "South", userId: "user-dee" });
    const drafts = await schedulingAlertsFor(
      t.db,
      event("visit.rescheduled", "customer", {
        tenantId,
        visit: { status: "confirmed", sequence: 2, resourceId: south.id, resourceName: "South", date: "2026-11-04", startsAt: "2026-11-04T17:00:00.000Z", endsAt: "2026-11-04T18:00:00.000Z" },
        data: { previous: previous(north.id, "North", "2026-11-02") },
      }),
      { hrefs: HREFS, now: new Date("2026-11-02T15:00:00Z") },
    );
    expect(drafts[1]).toMatchObject({ assignedUserIds: ["user-cam"], assignedHref: "/app/schedule/today" });
  });

  it("someone on both crews, or a move on the same crew: one draft, and nobody is told it's off their route", async () => {
    const tenantId = await company();
    const north = await createResource(t.db, { tenantId, name: "North", userId: "user-cam" });
    const south = await createResource(t.db, { tenantId, name: "South", userId: "user-cam" });
    const across = await schedulingAlertsFor(
      t.db,
      event("visit.rescheduled", "customer", { tenantId, visit: { status: "confirmed", sequence: 1, resourceId: south.id, resourceName: "South" }, data: { previous: previous(north.id, "North", "2026-11-02") } }),
      { hrefs: HREFS },
    );
    expect(across).toHaveLength(1);
    expect(across[0]!.assignedUserIds).toEqual(["user-cam"]);
    const same = await schedulingAlertsFor(
      t.db,
      event("visit.rescheduled", "customer", { tenantId, visit: { status: "confirmed", sequence: 1, resourceId: north.id, resourceName: "North" }, data: { previous: previous(north.id, "North", "2026-11-02") } }),
      { hrefs: HREFS },
    );
    expect(same).toHaveLength(1);
    // No crew change, no crew names: the times and where.
    expect(same[0]!.body).toBe("Now Tue, Nov 3, 9:00 AM MST. It was Mon, Nov 2, 9:00 AM MST. Free estimate at 1 Main St, SLC.");
  });

  it("a crew member's cancel says where the job was; with no address, just the service", async () => {
    const [cancel] = await schedulingAlertsFor(t.db, event("visit.cancelled", "customer", { visit: { status: "cancelled" }, data: { reason: "Sold the house" } }), { hrefs: HREFS });
    expect(cancel!.body).toBe("Free estimate at 1 Main St, SLC. They said: Sold the house");
    const [bare] = await schedulingAlertsFor(t.db, event("visit.cancelled", "customer", { visit: { status: "cancelled", address: null } }), { hrefs: HREFS });
    expect(bare!.body).toBe("Free estimate.");
  });
});

describe("listExpiringRequests and its alert (contract 9.2)", () => {
  const NOW = new Date("2026-11-02T15:00:00Z");
  const HOUR = 3_600_000;

  async function seed(tenantId: string, rows: Array<{ id: string; status?: string; deadline: Date | null; createdAt: Date; startsAt?: Date }>) {
    for (const row of rows) {
      const startsAt = row.startsAt ?? new Date("2026-11-04T16:00:00Z");
      await t.db.insert(schedulingBookings).values({
        id: `${tenantId}-${row.id}`,
        tenantId,
        serviceType: "estimate",
        customerName: "Pat Rivera",
        customerEmail: "pat@example.com",
        scheduledDate: new Date("2026-11-04T00:00:00Z"),
        startTime: "09:00",
        endTime: "10:00",
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        status: row.status ?? "pending",
        origin: "public",
        sequence: 0,
        pendingExpiresAt: row.deadline,
        createdAt: row.createdAt,
        updatedAt: row.createdAt,
      });
    }
  }

  it("the window (now, now + 26 h], pending only, made more than 6 h ago; soonest first; one query", async () => {
    const tenantId = await company();
    const old = new Date(NOW.getTime() - 24 * HOUR);
    await seed(tenantId, [
      { id: "inside", deadline: new Date(NOW.getTime() + 26 * HOUR), createdAt: old },
      { id: "soon", deadline: new Date(NOW.getTime() + 1 * HOUR), createdAt: old },
      { id: "outside", deadline: new Date(NOW.getTime() + 26 * HOUR + 60_000), createdAt: old },
      { id: "past", deadline: new Date(NOW.getTime() - 60_000), createdAt: old },
      { id: "at-now", deadline: NOW, createdAt: old },
      { id: "confirmed", status: "confirmed", deadline: new Date(NOW.getTime() + 2 * HOUR), createdAt: old },
      { id: "no-deadline", deadline: null, createdAt: old },
      { id: "made-5h-ago", deadline: new Date(NOW.getTime() + 3 * HOUR), createdAt: new Date(NOW.getTime() - 5 * HOUR) },
      { id: "made-7h-ago", deadline: new Date(NOW.getTime() + 4 * HOUR), createdAt: new Date(NOW.getTime() - 7 * HOUR) },
    ]);
    const elsewhere = await company();
    await seed(elsewhere, [{ id: "theirs", deadline: new Date(NOW.getTime() + HOUR), createdAt: old }]);
    t.queries.length = 0;
    const found = await listExpiringRequests(t.db, tenantId, { now: NOW });
    expect(t.queries).toHaveLength(1);
    expect(found.map((r) => r.id.replace(`${tenantId}-`, ""))).toEqual(["soon", "made-7h-ago", "inside"]);
    expect(found[0]).toEqual({
      id: `${tenantId}-soon`,
      sequence: 0,
      customerName: "Pat Rivera",
      serviceName: "Free estimate",
      date: "2026-11-04",
      startsAt: new Date("2026-11-04T16:00:00Z"),
      timeZone: "America/Denver",
      pendingExpiresAt: new Date(NOW.getTime() + HOUR),
    });
    expect((await listExpiringRequests(t.db, tenantId, { now: NOW, limit: 1 })).length).toBe(1);
    expect((await listExpiringRequests(t.db, tenantId, { now: NOW, withinHours: 2 })).map((r) => r.id)).toEqual([`${tenantId}-soon`]);
    // An explicit createdBefore wins over the six hours.
    expect((await listExpiringRequests(t.db, tenantId, { now: NOW, createdBefore: NOW })).map((r) => r.id.replace(`${tenantId}-`, ""))).toContain("made-5h-ago");
  });

  it("a tenant that never saved settings reads UTC and the default service name", async () => {
    const tenantId = tenant("bare");
    await seed(tenantId, [{ id: "one", deadline: new Date(NOW.getTime() + HOUR), createdAt: new Date(NOW.getTime() - 24 * HOUR) }]);
    const [request] = await listExpiringRequests(t.db, tenantId, { now: NOW });
    expect(request!.timeZone).toBe("UTC");
    expect(request!.serviceName).toBe("Estimate");
  });

  it("the alert: answer it by the deadline, in the business's clock; keyed on the request and its sequence", () => {
    const draft = schedulingExpiringAlert(
      "acme",
      {
        id: "visit-9",
        sequence: 2,
        customerName: "Pat Rivera",
        serviceName: "Free estimate",
        date: "2026-11-04",
        startsAt: new Date("2026-11-04T16:00:00Z"),
        timeZone: "America/Denver",
        pendingExpiresAt: new Date("2026-11-03T16:00:00Z"),
      },
      { hrefs: { visit: HREFS.visit } },
    );
    expect(draft).toEqual({
      tenantId: "acme",
      kind: "scheduling.request.expiring",
      title: "Answer Pat Rivera's visit request by Tue, Nov 3, 9:00 AM MST, or it lapses",
      body: "They asked for Wed, Nov 4, 9:00 AM MST (Free estimate).",
      href: "/app/schedule?date=2026-11-04&visit=visit-9",
      dedupeKey: "scheduling.request.expiring:visit-9:2",
      subject: { type: "scheduling.visit", id: "visit-9" },
      actorUserId: null,
    });
    const nameless = schedulingExpiringAlert("acme", { ...draftInput(), customerName: null }, { hrefs: { visit: HREFS.visit } });
    expect(nameless.title).toBe("Answer a customer's visit request by Tue, Nov 3, 9:00 AM MST, or it lapses");
  });

  function draftInput() {
    return {
      id: "visit-9",
      sequence: 2,
      customerName: "Pat Rivera" as string | null,
      serviceName: "Free estimate",
      date: "2026-11-04",
      startsAt: new Date("2026-11-04T16:00:00Z"),
      timeZone: "America/Denver",
      pendingExpiresAt: new Date("2026-11-03T16:00:00Z"),
    };
  }
});

describe("officeRecipients and officeSent (contract 9.3, review BO-02)", () => {
  const requested = (tenantId: string, over: Partial<VisitSnapshot> = {}) => event("visit.requested", "customer", { tenantId, visit: over });

  it("replaces the saved list: only the answer is emailed, through deliverNow, with 2a's template, reply-to and key", async () => {
    const tenantId = await company();
    const h = listener(tenantId, {
      staffEmails: ["inbox@acme.test"],
      officeRecipients: () => ["owner@acme.test"],
      officeSent: () => undefined,
    });
    const e = requested(tenantId);
    await h.listener.onEvent(e);
    const rows = await staffNotices(tenantId);
    expect(rows.map((r) => r.toAddress)).toEqual(["owner@acme.test"]);
    expect(rows[0]!.replyTo).toBe("pat@example.com");
    expect(h.mail.sent.find((m) => m.to === "owner@acme.test")?.idempotencyKey).toBe(`visit:visit-1:${e.id}:staff:0`);
    const staffCalls = (fn: typeof comms.sendNow | typeof comms.deliverNow) =>
      vi.mocked(fn).mock.calls.filter(([, input]) => input.templateKey === "visit_staff_notice");
    expect(staffCalls(comms.deliverNow)).toHaveLength(1);
    expect(staffCalls(comms.sendNow)).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it("[] sends no office email (the people chose the app, or the email was already claimed)", async () => {
    const tenantId = await company();
    const h = listener(tenantId, { staffEmails: ["inbox@acme.test"], officeRecipients: async () => [] });
    await h.listener.onEvent(requested(tenantId));
    expect(await staffNotices(tenantId)).toEqual([]);
  });

  it("a throw is reported and falls back to the host's staffEmails (never the saved list), and that send is told to nobody", async () => {
    const tenantId = await company();
    const sent: SchedulingOfficeSendResult[] = [];
    const h = listener(
      tenantId,
      {
        staffEmails: async () => ["inbox@acme.test"],
        officeRecipients: () => {
          throw new Error("alerts database down");
        },
        officeSent: (_notice, result) => {
          sent.push(result);
        },
      },
      mailbox({ down: ["inbox@acme.test"] }),
    );
    await h.listener.onEvent(requested(tenantId));
    expect(h.errors.map((e) => e.step)).toEqual(["office-recipients"]);
    expect((await staffNotices(tenantId)).map((r) => [r.toAddress, r.status])).toEqual([["inbox@acme.test", "failed"]]);
    // Released for a resend it would be: but nothing was claimed for it.
    expect(sent).toEqual([]);
  });

  it("officeSent hears each address's outcome: sent, failed and retryable, failed for good", async () => {
    const tenantId = await company();
    const outcomes: Array<[string, SchedulingOfficeSendResult]> = [];
    const e = requested(tenantId);
    const h = listener(
      tenantId,
      {
        officeRecipients: () => ["owner@acme.test", "down@acme.test", "not-an-address"],
        officeSent: async (notice, result) => {
          outcomes.push([notice.dedupeKey, result]);
        },
      },
      mailbox({ down: ["down@acme.test"] }),
    );
    await h.listener.onEvent(e);
    const byAddress = Object.fromEntries(outcomes.map(([, result]) => [result.to, result]));
    expect(byAddress).toEqual({
      "owner@acme.test": { to: "owner@acme.test", status: "sent", retryable: false },
      "down@acme.test": { to: "down@acme.test", status: "failed", retryable: true },
      "not-an-address": { to: "not-an-address", status: "failed", retryable: false },
    });
    expect(new Set(outcomes.map(([key]) => key))).toEqual(new Set(["scheduling.visit.requested:visit-1"]));
  });

  it("no provider set up is a skip, not a failure", async () => {
    const tenantId = await company();
    const outcomes: SchedulingOfficeSendResult[] = [];
    const h = listener(tenantId, { senders: {}, officeRecipients: () => ["owner@acme.test"], officeSent: (_n, r) => void outcomes.push(r) });
    await h.listener.onEvent(requested(tenantId));
    expect(outcomes).toEqual([{ to: "owner@acme.test", status: "skipped", retryable: false }]);
  });

  it("a send that timed out is not handed to officeSent (it may have gone), and is reported", async () => {
    const tenantId = await company();
    const outcomes: SchedulingOfficeSendResult[] = [];
    const h = listener(
      tenantId,
      { sendTimeoutMs: 40, officeRecipients: () => ["slow@acme.test", "owner@acme.test"], officeSent: (_n, r) => void outcomes.push(r) },
      mailbox({ hang: ["slow@acme.test"] }),
    );
    await h.listener.onEvent(requested(tenantId));
    expect(outcomes).toEqual([{ to: "owner@acme.test", status: "sent", retryable: false }]);
    expect(h.errors.map((e) => e.step)).toEqual(["office-timeout"]);
  });

  it("a throwing officeSent is reported and changes nothing else", async () => {
    const tenantId = await company();
    const h = listener(tenantId, {
      officeRecipients: () => ["owner@acme.test", "second@acme.test"],
      officeSent: () => {
        throw new Error("release failed");
      },
    });
    await h.listener.onEvent(requested(tenantId));
    expect(h.errors.map((e) => e.step)).toEqual(["office-sent", "office-sent"]);
    expect((await staffNotices(tenantId)).map((r) => r.status).sort()).toEqual(["sent", "sent"]);
  });

  it("the notice: the mapper's kind and key, the event's id, and the visit's crew (current and previous)", async () => {
    const tenantId = await company();
    const a = await createResource(t.db, { tenantId, name: "Crew A", userId: "user-cam" });
    const b = await createResource(t.db, { tenantId, name: "Crew B", userId: "user-dee" });
    const notices: SchedulingOfficeNotice[] = [];
    const h = listener(tenantId, { officeRecipients: (notice) => (notices.push(notice), []) });
    const e = event("visit.rescheduled", "customer", {
      tenantId,
      visit: { status: "confirmed", sequence: 5, resourceId: b.id },
      data: { previous: { date: "2026-11-02", startTime: "09:00", endTime: "10:00", startsAt: "2026-11-02T16:00:00.000Z", endsAt: "2026-11-02T17:00:00.000Z", resourceId: a.id, resourceName: "Crew A" } },
    });
    await h.listener.onEvent(e);
    const drafts = await schedulingAlertsFor(t.db, e, { hrefs: HREFS });
    const [draft] = drafts;
    expect(notices).toHaveLength(1);
    expect(notices[0]!.tenantId).toBe(tenantId);
    expect(notices[0]!.eventId).toBe(e.id);
    // Every draft of the fact (the move, and the old crew's own words) under the notice's kind and key.
    for (const each of drafts) {
      expect(notices[0]!.kind).toBe(each.kind);
      expect(notices[0]!.dedupeKey).toBe(each.dedupeKey);
    }
    expect(notices[0]!.kind).toBe(draft!.kind);
    expect([...notices[0]!.assignedUserIds].sort()).toEqual(drafts.flatMap((each) => each.assignedUserIds ?? []).sort());
    expect([...notices[0]!.assignedUserIds].sort()).toEqual(["user-cam", "user-dee"]);
  });

  it("without officeRecipients: 2a's path exactly (the saved list, sendNow, no officeSent)", async () => {
    const tenantId = await company();
    const told = vi.fn();
    const h = listener(tenantId, { staffEmails: ["inbox@acme.test"], officeSent: told });
    await h.listener.onEvent(requested(tenantId));
    expect((await staffNotices(tenantId)).map((r) => r.toAddress)).toEqual(["saved@acme.test"]);
    const staff = (fn: typeof comms.sendNow | typeof comms.deliverNow) =>
      vi.mocked(fn).mock.calls.filter(([, input]) => input.templateKey === "visit_staff_notice");
    expect(staff(comms.sendNow)).toHaveLength(1);
    expect(staff(comms.deliverNow)).toHaveLength(0);
    expect(told).not.toHaveBeenCalled();
    // With nothing saved, the host's inbox, as in 2a.
    const bare = await company({ staffNotifyEmails: [] });
    const h2 = listener(bare, { staffEmails: ["inbox@acme.test"] });
    await h2.listener.onEvent(requested(bare));
    expect((await staffNotices(bare)).map((r) => r.toAddress)).toEqual(["inbox@acme.test"]);
  });
});

describe("alertsHref on the settings routes (contract 9.4)", () => {
  const authorize = () => true;

  it("settings-get reports where Alert settings are; without it, null", async () => {
    const tenantId = await company();
    const routed = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize, alertsHref: "/app/alerts/settings" });
    const body = await readJson(await routed.handle(apiRequest("GET", "/v1/admin/settings")));
    expect(body.settings.alertRecipients).toEqual({ href: "/app/alerts/settings" });
    expect(body.settings.staffNotifyEmails).toEqual(["saved@acme.test"]);
    const plain = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize });
    expect((await readJson(await plain.handle(apiRequest("GET", "/v1/admin/settings")))).settings.alertRecipients).toBeNull();
  });

  it("settings-update drops staffNotifyEmails (never a 422); a body of only it saves nothing", async () => {
    const tenantId = await company();
    const routed = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize, alertsHref: "/app/alerts/settings" });
    const before = await getSchedulingSettings(t.db, tenantId);
    const only = await routed.handle(apiRequest("POST", "/v1/admin/settings", { staffNotifyEmails: ["new@acme.test"] }));
    expect(only.status).toBe(200);
    expect((await readJson(only)).settings.alertRecipients).toEqual({ href: "/app/alerts/settings" });
    const unchanged = await getSchedulingSettings(t.db, tenantId);
    expect(unchanged.staffNotifyEmails).toEqual(["saved@acme.test"]);
    expect(unchanged.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
    const mixed = await routed.handle(apiRequest("POST", "/v1/admin/settings", { staffNotifyEmails: ["new@acme.test"], horizonDays: 45 }));
    expect(mixed.status).toBe(200);
    const after = await getSchedulingSettings(t.db, tenantId);
    expect(after.horizonDays).toBe(45);
    expect(after.staffNotifyEmails).toEqual(["saved@acme.test"]);
    // Without alertsHref the list is the business's own, as in 2a.
    const plain = createSchedulingAdminHandlers({ db: t.db, tenantId, authorize });
    await plain.handle(apiRequest("POST", "/v1/admin/settings", { staffNotifyEmails: ["new@acme.test"] }));
    expect((await getSchedulingSettings(t.db, tenantId)).staffNotifyEmails).toEqual(["new@acme.test"]);
  });
});

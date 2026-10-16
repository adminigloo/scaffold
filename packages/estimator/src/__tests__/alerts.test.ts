import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The real comms functions, wrapped so a test can tell which one sent an
// office email: 2a's `sendNow` (no alerts) or 0.4's `deliverNow` (with
// `officeRecipients`, contract 10.2). Hoisted above every import by vitest.
vi.mock("@adminigloo/comms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@adminigloo/comms")>();
  return { ...actual, sendNow: vi.fn(actual.sendNow), deliverNow: vi.fn(actual.deliverNow) };
});

import * as comms from "@adminigloo/comms";
import { commsMessages, type OutboundEmail } from "@adminigloo/comms";
import { and, eq, inArray } from "drizzle-orm";
import { estimatorOfficeNotice, formatEstimateRange } from "../alerts.js";
import {
  createEstimatorCommsListener,
  estimatorEmailVars,
  type EstimatorCommsOptions,
  type EstimatorOfficeNotice,
  type EstimatorOfficeSendResult,
} from "../comms.js";
import {
  createEstimatorAdminHandlers,
  estimatorAlertKinds,
  estimatorAlertsFor,
  getEstimatorSettings,
  updateEstimatorSettings,
  type EstimateSnapshot,
  type EstimatorAlertDraft,
  type EstimatorAlertKinds,
  type EstimatorEvent,
  type EstimatorEventType,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, contract 10.1–10.3 and 15.3: what the estimator tells the
 * bell, and how its office emails follow the one alert setting. The mapper
 * and the comms listener agree on kind and key for every event and actor;
 * staff-made changes alert nobody; `{range}` is the customer's range in the
 * business's money; `officeRecipients` / `officeSent` on the real comms
 * tables (PGlite), and 2a's path exactly without them; `alertsHref` on the
 * settings routes; the fragment against the registry's rules (4.2), copied
 * here so the estimator never imports notifications.
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

const HREFS = { estimate: "/app/estimates/{id}" } as const;

function snapshot(over: Partial<EstimateSnapshot> = {}): EstimateSnapshot {
  return {
    id: "est-1",
    number: "1042",
    status: "draft",
    source: "public_tool",
    customerName: "Pat Rivera",
    customerEmail: "pat@example.test",
    customerPhone: "(801) 555-0101",
    jobAddress: "1 Main St, SLC",
    notes: null,
    currency: "USD",
    subtotal: 55_000,
    discount: 0,
    taxRateBp: 0,
    taxAmount: 0,
    total: 54_950,
    rangeLow: 48_000,
    rangeHigh: 62_000,
    rangeReasons: [],
    validUntil: null,
    sentAt: null,
    viewedAt: null,
    respondedAt: null,
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    convertedAt: null,
    archivedAt: null,
    responseName: null,
    responseNote: null,
    quoteMessage: null,
    quoteSequence: 1,
    photoCount: 0,
    lines: [{ description: "Modular aluminum ramp", inputsSummary: null, quantity: 1, total: 54_950, lowTotal: 48_000, highTotal: 62_000, options: [], assumption: null }],
    createdAt: "2026-11-02T15:00:00.000Z",
    updatedAt: "2026-11-02T15:00:00.000Z",
    ...over,
  };
}

let counter = 0;
function event(
  type: EstimatorEventType,
  actor: EstimatorEvent["actor"]["type"],
  options: { tenantId?: string; estimate?: Partial<EstimateSnapshot>; data?: Partial<EstimatorEvent["data"]> } = {},
): EstimatorEvent {
  counter += 1;
  const estimate = snapshot(options.estimate);
  return {
    id: `event-${counter}`,
    type,
    tenantId: options.tenantId ?? "summit",
    estimateId: estimate.id,
    occurredAt: "2026-11-02T15:00:00.000Z",
    actor: { type: actor, id: actor === "staff" ? "user-staff" : null },
    data: { estimate, notify: true, ...options.data },
  };
}

const TYPES: EstimatorEventType[] = [
  "lead.received",
  "quote.sent",
  "quote.viewed",
  "quote.accepted",
  "quote.declined",
  "quote.expired",
  "quote.revised",
  "estimate.converted",
];
const ACTORS = ["customer", "staff", "system"] as const;

/** Contract 10.1's table. */
function expectedKind(type: EstimatorEventType, actor: (typeof ACTORS)[number]): string | null {
  if (type === "quote.expired") return "estimator.quote.expired";
  if (type === "lead.received") return actor === "staff" ? null : "estimator.lead";
  if (type === "quote.accepted" && actor === "customer") return "estimator.quote.accepted";
  if (type === "quote.declined" && actor === "customer") return "estimator.quote.declined";
  return null;
}

async function business(leadNotifyEmails: string[] = ["saved@summit.test"]) {
  const tenantId = tenant("summit");
  await updateEstimatorSettings(t.db, tenantId, {
    businessName: "Summit Ramps",
    contactPhone: "(801) 555-0143",
    timeZone: "America/Denver",
    taxRateBp: 725,
    leadNotifyEmails,
  });
  return tenantId;
}

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

function listener(overrides: Partial<EstimatorCommsOptions> = {}, mail = mailbox()) {
  const errors: string[] = [];
  const l = createEstimatorCommsListener({
    db: t.db,
    senders: mail.senders,
    quoteUrl: (token) => `https://summit.test/quote/${token}`,
    adminEstimateUrl: (id) => `https://summit.test/app/estimates/${id}`,
    followUps: false,
    now: () => new Date("2026-11-02T15:00:00Z"),
    onError: (_error, context) => void errors.push(context.step),
    ...overrides,
  });
  return { listener: l, errors, mail };
}

const OFFICE = ["estimate_lead_staff", "quote_staff_notice"];
async function officeEmails(tenantId: string) {
  return t.db
    .select()
    .from(commsMessages)
    .where(and(eq(commsMessages.tenantId, tenantId), inArray(commsMessages.templateKey, OFFICE)));
}

// ---------------------------------------------------------------------------

describe("the fragment (contract 10.1; the registry's rules of 4.2, copied as a check)", () => {
  const KIND_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
  const ROUTING_KEY = /^[a-z][a-z0-9-]{1,31}$/;
  function problems(fragment: EstimatorAlertKinds): string[] {
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
      if (kind.email === false && kind.defaultChannel === "email") out.push(`email default on email:false ${kind.key}`);
      if (kind.email === false && kind.emailBy === "producer") out.push(`producer on email:false ${kind.key}`);
      if (kind.audience.routing && !routings.has(kind.audience.routing)) out.push(`unknown routing ${kind.key}`);
    }
    return out;
  }

  it("passes every rule, and is the contract's table", () => {
    expect(problems(estimatorAlertKinds)).toEqual([]);
    expect(estimatorAlertKinds.kinds.map((k) => [k.key, k.label, k.defaultChannel, k.emailBy])).toEqual([
      ["estimator.lead", "Someone asks for an estimate", "email", "producer"],
      ["estimator.quote.accepted", "A customer accepts a quote", "email", "producer"],
      ["estimator.quote.declined", "A customer declines a quote", "email", "producer"],
      ["estimator.quote.expired", "A quote lapses unanswered", "email", "producer"],
    ]);
    for (const kind of estimatorAlertKinds.kinds) {
      expect(kind.category).toBe("Estimates");
      expect(kind.audience).toEqual({ permission: "estimator.view", routing: "estimates" });
    }
    expect(estimatorAlertKinds.routings).toEqual([
      {
        key: "estimates",
        label: "New estimate requests and quote answers",
        description: "Someone asking for an estimate, and customers accepting, declining or letting a quote lapse.",
        permission: "estimator.view",
        order: 10,
      },
    ]);
  });

  it("the check catches what the registry refuses (negative control)", () => {
    expect(
      problems({ routings: [{ key: "x", label: "", permission: "" }], kinds: [{ key: "estimator", label: "L", category: "", audience: { permission: "p", routing: "nope" }, defaultChannel: "in_app" }] }),
    ).toEqual(["routing key x", "routing label x", "routing permission x", "key estimator", "category estimator", "unknown routing estimator"]);
  });
});

describe("the mapper (contract 10.1)", () => {
  it("every event and actor: an alert iff an office email, with the same kind and key; staff-made changes alert nobody", async () => {
    const tenantId = await business();
    const notices: EstimatorOfficeNotice[] = [];
    const { listener: l } = listener({ officeRecipients: (notice) => (notices.push(notice), []) });
    for (const type of TYPES) {
      for (const actor of ACTORS) {
        const e = event(type, actor, { tenantId });
        const drafts = estimatorAlertsFor(e, { hrefs: HREFS });
        notices.length = 0;
        await l.onEvent(e);
        const label = `${type} by ${actor}`;
        const expected = expectedKind(type, actor);
        expect(drafts.map((d) => d.kind), label).toEqual(expected ? [expected] : []);
        expect(notices.map((n) => [n.kind, n.dedupeKey, n.eventId, n.assignedUserIds]), label).toEqual(
          drafts.map((d) => [d.kind, d.dedupeKey, e.id, []]),
        );
      }
    }
  });

  it("dedupe keys from the fact: the estimate, and the quote's sequence for an answer", () => {
    const key = (e: EstimatorEvent) => estimatorAlertsFor(e, { hrefs: HREFS })[0]!.dedupeKey;
    expect(key(event("lead.received", "customer"))).toBe("estimator.lead:est-1");
    expect(key(event("quote.accepted", "customer", { estimate: { quoteSequence: 3 } }))).toBe("estimator.quote.accepted:est-1:3");
    expect(key(event("quote.declined", "customer", { estimate: { quoteSequence: 2 } }))).toBe("estimator.quote.declined:est-1:2");
    expect(key(event("quote.expired", "system", { estimate: { quoteSequence: 4 } }))).toBe("estimator.quote.expired:est-1:4");
    expect(estimatorOfficeNotice(event("lead.received", "customer"))?.templateKey).toBe("estimate_lead_staff");
    expect(estimatorOfficeNotice(event("quote.accepted", "customer"))?.templateKey).toBe("quote_staff_notice");
  });

  it("a lead: who and the range in the title; up to three lines, then the address and phone", () => {
    const lines = ["Ramp", "Handrail", "Landing", "Threshold", "Grab bar"].map((description, i) => ({
      description,
      inputsSummary: null,
      quantity: i + 1,
      total: 1_000,
      lowTotal: 900,
      highTotal: 1_100,
      options: [],
      assumption: null,
    }));
    const [draft] = estimatorAlertsFor(event("lead.received", "customer", { estimate: { lines } }), { hrefs: HREFS });
    expect(draft).toEqual({
      tenantId: "summit",
      kind: "estimator.lead",
      title: "New estimate request: Pat Rivera, $480 – $620 (1042)",
      body: "Ramp × 1\nHandrail × 2\nLanding × 3\nand 2 more\n1 Main St, SLC\nPhone: (801) 555-0101",
      href: "/app/estimates/est-1",
      dedupeKey: "estimator.lead:est-1",
      subject: { type: "estimator.estimate", id: "est-1" },
      actorUserId: null,
      replyTo: "pat@example.test",
    } satisfies EstimatorAlertDraft);
    const [bare] = estimatorAlertsFor(event("lead.received", "customer", { estimate: { customerName: null, jobAddress: null, customerPhone: null, customerEmail: null } }), { hrefs: HREFS });
    expect(bare!.title).toBe("New estimate request: a customer, $480 – $620 (1042)");
    expect(bare!.body).toBe("Modular aluminum ramp × 1");
    expect(bare!.replyTo).toBeNull();
  });

  it("{range}: whole units before tax, as the office email says it, + tax when taxed; the business's money", () => {
    expect(formatEstimateRange({ rangeLow: 48_000, rangeHigh: 62_000, total: 54_950, currency: "USD" }, "en-US")).toBe("$480 – $620");
    expect(formatEstimateRange({ rangeLow: 48_000, rangeHigh: 62_000, total: 58_934, currency: "USD", taxRateBp: 725 }, "en-US")).toBe("$480 – $620 + tax");
    expect(formatEstimateRange({ rangeLow: 54_900, rangeHigh: 54_900, total: 54_900, currency: "USD" }, "en-US")).toBe("$549");
    expect(formatEstimateRange({ rangeLow: 0, rangeHigh: 0, total: 0, currency: "USD" }, "en-US")).toBe("no price yet");
    const euro = formatEstimateRange({ rangeLow: 48_000, rangeHigh: 62_000, total: 54_950, currency: "EUR" }, "de-DE");
    expect(euro).toMatch(/^480\s€ – 620\s€$/);
    const [single] = estimatorAlertsFor(event("lead.received", "customer", { estimate: { rangeLow: 54_900, rangeHigh: 54_900, total: 54_900 } }), { hrefs: HREFS, locale: "en-US" });
    expect(single!.title).toBe("New estimate request: Pat Rivera, $549 (1042)");
  });

  it("answers and lapses: the quote's number and total, the customer's note", () => {
    const at = { hrefs: HREFS };
    const [accepted] = estimatorAlertsFor(event("quote.accepted", "customer", { data: { note: "Can you start Monday?" } }), at);
    expect(accepted!.title).toBe("Pat Rivera accepted quote 1042 ($549.50)");
    expect(accepted!.body).toBe("Their note: Can you start Monday?");
    const [quiet] = estimatorAlertsFor(event("quote.accepted", "customer"), at);
    expect(quiet!.body).toBeNull();
    const [declined] = estimatorAlertsFor(event("quote.declined", "customer", { estimate: { customerName: null }, data: { note: "Too dear" } }), at);
    expect(declined!.title).toBe("A customer declined quote 1042");
    expect(declined!.body).toBe("Their note: Too dear");
    const [expired] = estimatorAlertsFor(event("quote.expired", "system"), at);
    expect(expired!.title).toBe("Quote 1042 for Pat Rivera lapsed unanswered");
    expect(expired!.body).toBeNull();
  });

  it("one lead, one price (review BO-3): the bell's figure is the office email's, + tax when taxed, with the estimate number", async () => {
    const tenantId = tenant("bo3");
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 725 });
    const settings = await getEstimatorSettings(t.db, tenantId);
    // $59 before tax, $63.10 with it: the customer was told "$59, plus 7.25% sales tax".
    const taxed = event("lead.received", "customer", {
      estimate: { number: "EST-2026-0001", subtotal: 5_900, rangeLow: 5_900, rangeHigh: 5_900, taxRateBp: 725, taxAmount: 428, total: 6_328 },
    });
    const [draft] = estimatorAlertsFor(taxed, { hrefs: HREFS });
    expect(draft!.title).toBe("New estimate request: Pat Rivera, $59 + tax (EST-2026-0001)");
    const vars = estimatorEmailVars(taxed, settings, { quoteUrl: null, audience: "staff" });
    expect(vars["estimateLine"]).toBe("Estimate: $59, plus 7.25% sales tax.");
    expect(draft!.title).toContain(`, ${vars["rangeText"]} + tax (${vars["estimateNumber"]})`);
    expect(draft!.title).not.toContain("63.10");
    // A range reads as the email's range; no tax, no "+ tax".
    const range = event("lead.received", "customer", { estimate: { number: "EST-2026-0002" } });
    const [ranged] = estimatorAlertsFor(range, { hrefs: HREFS });
    const rangeVars = estimatorEmailVars(range, settings, { quoteUrl: null, audience: "staff" });
    expect(ranged!.title).toBe(`New estimate request: Pat Rivera, ${rangeVars["rangeText"]} (EST-2026-0002)`);
    expect(ranged!.title).toBe("New estimate request: Pat Rivera, $480 – $620 (EST-2026-0002)");
  });

  it("a title is one line, however the name was typed; an id is URL-encoded", () => {
    const separator = String.fromCharCode(0x2029);
    const [draft] = estimatorAlertsFor(event("lead.received", "customer", { estimate: { id: "a/b c", customerName: `Pat\nRivera${separator}Jr` } }), { hrefs: HREFS });
    expect(draft!.title).toBe("New estimate request: Pat Rivera Jr, $480 – $620 (1042)");
    expect(draft!.href).toBe("/app/estimates/a%2Fb%20c");
  });
});

describe("officeRecipients and officeSent (contract 10.2, review BO-02)", () => {
  const lead = (tenantId: string) => event("lead.received", "customer", { tenantId });
  const staffCalls = (fn: typeof comms.sendNow | typeof comms.deliverNow) =>
    vi.mocked(fn).mock.calls.filter(([, input]) => OFFICE.includes(input.templateKey));

  it("replaces the saved list: only the answer is emailed, through deliverNow, replying to the customer", async () => {
    const tenantId = await business();
    const h = listener({ staffEmails: ["inbox@summit.test"], officeRecipients: () => ["owner@summit.test"] });
    const e = lead(tenantId);
    await h.listener.onEvent(e);
    const rows = await officeEmails(tenantId);
    expect(rows.map((r) => r.toAddress)).toEqual(["owner@summit.test"]);
    expect(rows[0]!.replyTo).toBe("pat@example.test");
    expect(h.mail.sent.find((m) => m.to === "owner@summit.test")?.idempotencyKey).toBe(`estimate:est-1:${e.id}:staff:0`);
    expect(staffCalls(comms.deliverNow)).toHaveLength(1);
    expect(staffCalls(comms.sendNow)).toHaveLength(0);
  });

  it("[] sends nothing; a throw is reported and falls back to staffEmails, told to nobody", async () => {
    const tenantId = await business();
    const quiet = listener({ staffEmails: ["inbox@summit.test"], officeRecipients: async () => [] });
    await quiet.listener.onEvent(lead(tenantId));
    expect(await officeEmails(tenantId)).toEqual([]);

    const told: EstimatorOfficeSendResult[] = [];
    const broken = listener({
      staffEmails: async () => ["inbox@summit.test"],
      officeRecipients: () => {
        throw new Error("alerts database down");
      },
      officeSent: (_n, result) => void told.push(result),
    });
    await broken.listener.onEvent(lead(tenantId));
    expect(broken.errors).toEqual(["office-recipients"]);
    expect((await officeEmails(tenantId)).map((r) => r.toAddress)).toEqual(["inbox@summit.test"]);
    expect(told).toEqual([]);
  });

  it("officeSent hears sent, failed and retryable, failed for good, per address", async () => {
    const tenantId = await business();
    const told: Array<[EstimatorOfficeNotice, EstimatorOfficeSendResult]> = [];
    const h = listener(
      { officeRecipients: () => ["owner@summit.test", "down@summit.test", "not-an-address"], officeSent: (notice, result) => void told.push([notice, result]) },
      mailbox({ down: ["down@summit.test"] }),
    );
    await h.listener.onEvent(event("quote.accepted", "customer", { tenantId, estimate: { quoteSequence: 2 } }));
    expect(Object.fromEntries(told.map(([, r]) => [r.to, r]))).toEqual({
      "owner@summit.test": { to: "owner@summit.test", status: "sent", retryable: false },
      "down@summit.test": { to: "down@summit.test", status: "failed", retryable: true },
      "not-an-address": { to: "not-an-address", status: "failed", retryable: false },
    });
    expect(new Set(told.map(([n]) => `${n.kind} ${n.dedupeKey}`))).toEqual(new Set(["estimator.quote.accepted estimator.quote.accepted:est-1:2"]));
  });

  it("a timed-out send is not handed to officeSent, and is reported", async () => {
    const tenantId = await business();
    const told: EstimatorOfficeSendResult[] = [];
    const h = listener(
      { sendTimeoutMs: 40, officeRecipients: () => ["slow@summit.test", "owner@summit.test"], officeSent: (_n, r) => void told.push(r) },
      mailbox({ hang: ["slow@summit.test"] }),
    );
    await h.listener.onEvent(lead(tenantId));
    expect(told).toEqual([{ to: "owner@summit.test", status: "sent", retryable: false }]);
    expect(h.errors).toEqual(["office-timeout"]);
  });

  it("a throwing officeSent is reported and changes nothing", async () => {
    const tenantId = await business();
    const h = listener({
      officeRecipients: () => ["owner@summit.test"],
      officeSent: () => {
        throw new Error("release failed");
      },
    });
    await h.listener.onEvent(lead(tenantId));
    expect(h.errors).toEqual(["office-sent"]);
    expect((await officeEmails(tenantId)).map((r) => r.status)).toEqual(["sent"]);
  });

  it("without officeRecipients: 2a's path exactly (the saved list, sendNow, no officeSent)", async () => {
    const tenantId = await business();
    const told = vi.fn();
    const h = listener({ staffEmails: ["inbox@summit.test"], officeSent: told });
    await h.listener.onEvent(lead(tenantId));
    expect((await officeEmails(tenantId)).map((r) => r.toAddress)).toEqual(["saved@summit.test"]);
    expect(staffCalls(comms.sendNow)).toHaveLength(1);
    expect(staffCalls(comms.deliverNow)).toHaveLength(0);
    expect(told).not.toHaveBeenCalled();
    const bare = await business([]);
    const h2 = listener({ staffEmails: ["inbox@summit.test"] });
    await h2.listener.onEvent(lead(bare));
    expect((await officeEmails(bare)).map((r) => r.toAddress)).toEqual(["inbox@summit.test"]);
  });
});

describe("alertsHref on the settings routes (contract 10.3)", () => {
  const ADMIN = "https://summit.test/api/admin/estimator/v1/admin";
  const call = (handlers: ReturnType<typeof createEstimatorAdminHandlers>, method: "GET" | "POST", body?: unknown) =>
    handlers.handle(
      new Request(`${ADMIN}/settings`, {
        method,
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}), headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" } } : {}),
      }),
    );

  it("settings-get reports where Alert settings are; settings-update drops leadNotifyEmails, and a body of only it saves nothing", async () => {
    const tenantId = await business();
    const routed = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-1" }), alertsHref: "/app/alerts/settings" });
    const got = (await (await call(routed, "GET")).json()) as { settings: { alertRecipients: unknown; leadNotifyEmails: string[] } };
    expect(got.settings.alertRecipients).toEqual({ href: "/app/alerts/settings" });
    expect(got.settings.leadNotifyEmails).toEqual(["saved@summit.test"]);

    const before = await getEstimatorSettings(t.db, tenantId);
    const only = await call(routed, "POST", { leadNotifyEmails: ["new@summit.test"] });
    expect(only.status).toBe(200);
    const unchanged = await getEstimatorSettings(t.db, tenantId);
    expect(unchanged.leadNotifyEmails).toEqual(["saved@summit.test"]);
    expect(unchanged.updatedAt?.getTime()).toBe(before.updatedAt?.getTime());
    const mixed = await call(routed, "POST", { leadNotifyEmails: ["new@summit.test"], quoteValidDays: 45 });
    expect(mixed.status).toBe(200);
    const after = await getEstimatorSettings(t.db, tenantId);
    expect(after.quoteValidDays).toBe(45);
    expect(after.leadNotifyEmails).toEqual(["saved@summit.test"]);

    const plain = createEstimatorAdminHandlers({ db: t.db, tenantId, authorize: () => ({ userId: "u-1" }) });
    expect(((await (await call(plain, "GET")).json()) as { settings: { alertRecipients: unknown } }).settings.alertRecipients).toBeNull();
    await call(plain, "POST", { leadNotifyEmails: ["new@summit.test"] });
    expect((await getEstimatorSettings(t.db, tenantId)).leadNotifyEmails).toEqual(["new@summit.test"]);
  });
});

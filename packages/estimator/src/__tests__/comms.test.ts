import { commsMessages, commsScheduled, commsTemplates } from "@adminigloo/comms";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProducts } from "../catalog.js";
import {
  createEstimatorCommsListener,
  ESTIMATOR_COMMS_REF_TYPE,
  ESTIMATOR_EMAIL_TEMPLATES,
  estimatorEmailVars,
  followUpSendAt,
} from "../comms.js";
import { createEstimate, createPublicEstimate, markEstimateConverted, setEstimateStatus } from "../estimates.js";
import { buildEvents, type EstimatorEvent } from "../events.js";
import { acceptQuote, declineQuote, expireQuotes, insertQuoteToken, openEstimateByToken, resendQuote, reviseQuote, sendQuote } from "../quotes.js";
import { loadSampleCatalog } from "../sample.js";
import { getEstimatorSettings, updateEstimatorSettings } from "../settings.js";
import { recordingSender } from "./fixtures.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** `@adminigloo/estimator/comms` (7): who is emailed what, the follow-up queue, and no key left in a table. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ comms: true });
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date("2026-11-02T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const TOKEN_LINK = /quote\/([A-Za-z0-9_-]{43})/;

async function business(options: { staffEmails?: string[]; leadNotify?: string[] } = {}) {
  const tenantId = tenant("mail");
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  await updateEstimatorSettings(t.db, tenantId, {
    businessName: "Summit Ramps",
    contactPhone: "(801) 555-0143",
    contactEmail: "hello@summit.test",
    timeZone: "America/Denver",
    taxRateBp: 725,
    leadNotifyEmails: options.leadNotify ?? ["office@summit.test"],
    followUpDays: 3,
  });
  const mail = recordingSender();
  let clock = NOW;
  const errors: string[] = [];
  const listener = createEstimatorCommsListener({
    db: t.db,
    senders: mail.senders,
    quoteUrl: (token) => `https://summit.test/quote/${token}`,
    adminEstimateUrl: (id) => `https://summit.test/admin/estimates/${id}`,
    bookUrl: (estimate) => `https://summit.test/book-visit?estimate=${estimate.id}`,
    ...(options.staffEmails ? { staffEmails: options.staffEmails } : {}),
    now: () => clock,
    onError: (_error, context) => void errors.push(context.step),
  });
  const ramp = (await listProducts(t.db, tenantId)).find((p) => p.name === "Modular aluminum ramp")!.id;
  const quote = async (email = "pat@example.test") => {
    const created = await createEstimate(t.db, { tenantId, customerName: "Pat Lee", customerEmail: email, items: [{ productId: ramp, inputs: { steps: 3, stepHeightIn: 7.5 } }] });
    return created.id;
  };
  return { tenantId, mail, listener, errors, ramp, quote, setClock: (d: Date) => void (clock = d) };
}

const queued = (estimateId: string) =>
  t.db.select().from(commsScheduled).where(and(eq(commsScheduled.refType, ESTIMATOR_COMMS_REF_TYPE), eq(commsScheduled.refId, estimateId)));

describe("what each event sends", () => {
  it("a lead: the customer's copy (no link) and the office's notice; every variable filled", async () => {
    const b = await business();
    await createPublicEstimate(
      t.db,
      { customerName: "https://evil.example/pay Pat", customerEmail: "pat@example.test", items: [{ productId: b.ramp, inputs: { steps: 3 } }] },
      { tenantId: b.tenantId, onEvent: b.listener.onEvent },
    ).catch(() => undefined); // a name with a link is refused at the door…
    await createPublicEstimate(
      t.db,
      { customerName: "Pat Lee", customerEmail: "pat@example.test", jobAddress: "12 Oak St", items: [{ productId: b.ramp, inputs: { steps: 3 } }] },
      { tenantId: b.tenantId, onEvent: b.listener.onEvent },
    );
    expect(b.mail.sent.map((m) => [m.to, m.subject.replace(/EST-\d{4}-\d{4}/, "EST")])).toEqual([
      ["pat@example.test", "Your estimate from Summit Ramps (EST)"],
      ["office@summit.test", "New lead: Pat Lee, $6,473 – $7,146 (EST)"],
    ]);
    const copy = b.mail.sent[0]!.body;
    expect(copy).toContain("Hi Pat,");
    expect(copy).toContain("• Modular aluminum ramp: 3 steps, $6,473 – $7,146");
    expect(copy).toContain("Estimate: $6,473 – $7,146, plus 7.25% sales tax.");
    expect(copy).toContain("Based on an estimated step height of 7–8 in.");
    expect(copy).not.toMatch(TOKEN_LINK);
    const office = b.mail.sent[1]!.body;
    expect(office).toContain("Why it's a range: Step height 7–8 in (estimated).");
    expect(office).toContain("Where: 12 Oak St");
    expect(office).toContain("Open it: https://summit.test/admin/estimates/");
    const rows = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, b.tenantId));
    expect(rows.every((r) => (r.missingVars ?? []).length === 0 && r.status === "sent")).toBe(true);
    expect(b.errors).toEqual([]);
  });

  it("a quote: the link goes to the customer, never into the log; the follow-up is queued link-free", async () => {
    const b = await business();
    const id = await b.quote();
    await sendQuote(t.db, b.tenantId, id, { validDays: 30 }, { now: NOW, onEvent: b.listener.onEvent });
    expect(b.mail.sent).toHaveLength(1);
    const email = b.mail.sent[0]!;
    expect(email.to).toBe("pat@example.test");
    expect(email.body).toContain("Total: $7,423.27, including $501.81 sales tax");
    expect(email.body).toContain("Good until: December 2, 2026");
    expect(email.body).toContain("Here's your quote for the work we talked about.");
    const token = TOKEN_LINK.exec(email.body)![1]!;
    expect((await openEstimateByToken(t.db, b.tenantId, token))?.id).toBe(id);
    const [logged] = await t.db.select().from(commsMessages).where(and(eq(commsMessages.tenantId, b.tenantId), eq(commsMessages.templateKey, "quote_sent")));
    expect(logged!.body).toContain("https://summit.test/quote/:token");
    expect(logged!.body).not.toContain(token);
    const [followUp] = await queued(id);
    expect(followUp).toMatchObject({ templateKey: "quote_follow_up", dedupeKey: `estimate:${id}:followup:1`, status: "pending", toAddress: "pat@example.test" });
    expect(followUp!.sendAt.toISOString()).toBe(at(3).toISOString());
    expect(followUp!.expiresAt?.toISOString()).toBe(at(30).toISOString());
    expect(JSON.stringify(followUp!.vars)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect((followUp!.vars as Record<string, string>)["quoteLine"]).toBe("Use the link in our earlier email to see it, or reply to this one.");

    // A resend: a new link, the follow-up untouched.
    await resendQuote(t.db, b.tenantId, id, { now: at(1), onEvent: b.listener.onEvent });
    expect(b.mail.sent).toHaveLength(2);
    expect(TOKEN_LINK.exec(b.mail.sent[1]!.body)![1]).not.toBe(token);
    expect((await queued(id)).map((r) => r.status)).toEqual(["pending"]);
  });

  it("the follow-up is withdrawn on accept, decline, expiry, revise and convert", async () => {
    const b = await business();
    const withdrawnBy = async (act: (id: string, token: string) => Promise<unknown>) => {
      const id = await b.quote();
      await sendQuote(t.db, b.tenantId, id, { validDays: 10 }, { now: NOW, onEvent: b.listener.onEvent });
      const token = await insertQuoteToken(t.db, b.tenantId, id);
      await act(id, token);
      return (await queued(id)).map((r) => r.status);
    };
    const opts = { now: at(1), onEvent: b.listener.onEvent };
    expect(await withdrawnBy((_id, token) => acceptQuote(t.db, b.tenantId, token, { version: 1 }, opts))).toEqual(["cancelled"]);
    expect(await withdrawnBy((_id, token) => declineQuote(t.db, b.tenantId, token, { version: 1 }, opts))).toEqual(["cancelled"]);
    expect(await withdrawnBy((id) => reviseQuote(t.db, b.tenantId, id, opts))).toEqual(["cancelled"]);
    // Not on a resend (see above), nor on a view.
    const converted = await b.quote();
    await sendQuote(t.db, b.tenantId, converted, {}, { now: NOW, onEvent: b.listener.onEvent });
    await setEstimateStatus(t.db, b.tenantId, { id: converted, status: "approved" }, { now: at(1) });
    await markEstimateConverted(t.db, b.tenantId, converted, opts);
    expect((await queued(converted)).map((r) => r.status)).toEqual(["cancelled"]);
    const expiring = await b.quote();
    await sendQuote(t.db, b.tenantId, expiring, { validDays: 10 }, { now: NOW, onEvent: b.listener.onEvent });
    await expireQuotes(t.db, b.tenantId, { now: at(11), onEvent: b.listener.onEvent });
    expect((await queued(expiring)).map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("answers and expiry: the right email to the right person, staff never told of their own move", async () => {
    const b = await business();
    const id = await b.quote();
    await sendQuote(t.db, b.tenantId, id, {}, { now: NOW });
    const token = await insertQuoteToken(t.db, b.tenantId, id);
    await acceptQuote(t.db, b.tenantId, token, { version: 1, name: "Pat Lee", note: "Mornings" }, { now: at(1), onEvent: b.listener.onEvent });
    expect(b.mail.sent.map((m) => m.to)).toEqual(["pat@example.test", "office@summit.test"]);
    expect(b.mail.sent[0]!.body).toContain(`Pick a time for the work here: https://summit.test/book-visit?estimate=${id}`);
    expect(b.mail.sent[0]!.body).toMatch(TOKEN_LINK);
    expect(b.mail.sent[1]!.body).toContain(`Pat Lee accepted quote`);
    expect(b.mail.sent[1]!.body).toContain('Their note: "Mornings"');

    const staffMove = await b.quote();
    await sendQuote(t.db, b.tenantId, staffMove, {}, { now: NOW });
    const before = b.mail.sent.length;
    await setEstimateStatus(t.db, b.tenantId, { id: staffMove, status: "rejected" }, { now: at(1), onEvent: b.listener.onEvent });
    expect(b.mail.sent.length).toBe(before); // staff's own move, not emailed (notify false) and no office notice

    const lapsing = await b.quote();
    await sendQuote(t.db, b.tenantId, lapsing, { validDays: 2 }, { now: NOW });
    await expireQuotes(t.db, b.tenantId, { now: at(3), onEvent: b.listener.onEvent });
    const lapsed = b.mail.sent.slice(before);
    expect(lapsed.map((m) => [m.to, m.subject.replace(/EST-\d{4}-\d{4}/, "EST")])).toEqual([
      ["pat@example.test", "Your quote EST has expired"],
      ["office@summit.test", "Quote expired: Pat Lee, EST"],
    ]);
    expect(lapsed[0]!.body).toContain("expired on November 4, 2026");
    expect(lapsed[0]!.body).not.toMatch(TOKEN_LINK);
    const rows = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, b.tenantId));
    expect(rows.every((r) => (r.missingVars ?? []).length === 0)).toBe(true);
  });

  it("staff emails go to the lead alerts, else the listener's staffEmails", async () => {
    const b = await business({ leadNotify: [], staffEmails: ["owner@summit.test", "desk@summit.test"] });
    await createPublicEstimate(
      t.db,
      { customerName: "Pat", customerPhone: "555-0100", items: [{ productId: b.ramp, inputs: { steps: 2 } }] },
      { tenantId: b.tenantId, onEvent: b.listener.onEvent },
    );
    expect(b.mail.sent.map((m) => m.to).sort()).toEqual(["desk@summit.test", "owner@summit.test"]); // no customer email given
  });
});

describe("the follow-up at send time", () => {
  it("beforeSend: skip when answered, revised, expired or without an email; otherwise a fresh working link", async () => {
    const b = await business();
    const row = async (id: string) => (await queued(id))[0]!;

    // Every quote is sent at NOW (the listener's clock), then the clock moves.
    const fine = await b.quote();
    const answered = await b.quote();
    const revised = await b.quote();
    const expired = await b.quote();
    for (const id of [fine, answered, revised]) await sendQuote(t.db, b.tenantId, id, {}, { now: NOW, onEvent: b.listener.onEvent });
    await sendQuote(t.db, b.tenantId, expired, { validDays: 4 }, { now: NOW, onEvent: b.listener.onEvent });
    const [fineRow, answeredRow, revisedRow, expiredRow] = [await row(fine), await row(answered), await row(revised), await row(expired)];

    b.setClock(at(3));
    const verdict = (await b.listener.beforeSend(fineRow)) as { to: string; vars: Record<string, string> };
    expect(verdict.to).toBe("pat@example.test");
    const token = TOKEN_LINK.exec(verdict.vars["quoteLine"]!)![1]!;
    expect((await openEstimateByToken(t.db, b.tenantId, token))?.id).toBe(fine);
    expect(verdict.vars["sentDateText"]).toBe("November 2, 2026");

    await acceptQuote(t.db, b.tenantId, await insertQuoteToken(t.db, b.tenantId, answered), { version: 1 }, { now: at(1) });
    expect(await b.listener.beforeSend(answeredRow)).toEqual({ skip: true, reason: "the customer has answered" });

    await reviseQuote(t.db, b.tenantId, revised, { now: at(1) });
    expect(await b.listener.beforeSend(revisedRow)).toEqual({ skip: true, reason: "the quote is draft" });
    await sendQuote(t.db, b.tenantId, revised, {}, { now: at(1) });
    expect(await b.listener.beforeSend(revisedRow)).toEqual({ skip: true, reason: "the quote was revised since this was queued" });

    b.setClock(at(5));
    expect(await b.listener.beforeSend(expiredRow)).toEqual({ skip: true, reason: "the quote has expired" });

    expect(await b.listener.beforeSend({ ...expiredRow, refType: "scheduling_visit" })).toBeNull();
    expect(await b.listener.beforeSend({ ...expiredRow, refId: "gone" })).toEqual({ skip: true, reason: "the estimate no longer exists" });
  });

  it("redactSent scrubs a token a crashed run left in the log", async () => {
    const b = await business();
    const id = await b.quote();
    const token = await insertQuoteToken(t.db, b.tenantId, id);
    await t.db.insert(commsMessages).values({
      tenantId: b.tenantId,
      channel: "email",
      toAddress: "pat@example.test",
      templateKey: "quote_follow_up",
      subject: "Following up",
      body: `See it: https://summit.test/quote/${token}`,
      status: "sent",
    });
    expect(await b.listener.redactSent()).toBeGreaterThanOrEqual(1);
    const rows = await t.db.select().from(commsMessages).where(eq(commsMessages.tenantId, b.tenantId));
    expect(rows.some((r) => r.body.includes(token))).toBe(false);
    expect(rows.find((r) => r.templateKey === "quote_follow_up")!.body).toBe("See it: https://summit.test/quote/:token");
  });

  it("followUpRuns: the follow-up goes on the cron run before it is due", () => {
    expect(followUpSendAt(NOW, 3, { dailyAtUtc: "14:00" }).toISOString()).toBe("2026-11-05T14:00:00.000Z");
    expect(followUpSendAt(NOW, 3, { everyMinutes: 60 }).toISOString()).toBe("2026-11-05T15:00:00.000Z");
    expect(followUpSendAt(NOW, 3).toISOString()).toBe(at(3).toISOString());
  });
});

describe("templates and variables", () => {
  it("ensureTemplates inserts the seven once and never overwrites an owner's edit", async () => {
    const b = await business();
    expect(await b.listener.ensureTemplates(b.tenantId)).toBe(7);
    await t.db
      .update(commsTemplates)
      .set({ body: "Our own words {{firstName}}" })
      .where(and(eq(commsTemplates.tenantId, b.tenantId), eq(commsTemplates.key, "quote_sent")));
    expect(await b.listener.ensureTemplates(b.tenantId)).toBe(0);
    const [edited] = await t.db.select().from(commsTemplates).where(and(eq(commsTemplates.tenantId, b.tenantId), eq(commsTemplates.key, "quote_sent")));
    expect(edited!.body).toBe("Our own words {{firstName}}");
    await expect(b.listener.verify()).resolves.toBeUndefined();
    expect(ESTIMATOR_EMAIL_TEMPLATES.map((tmpl) => tmpl.key)).toEqual([
      "estimate_lead_customer",
      "estimate_lead_staff",
      "quote_sent",
      "quote_follow_up",
      "quote_accepted_customer",
      "quote_expired_customer",
      "quote_staff_notice",
    ]);
  });

  it("estimatorEmailVars: every template variable for every event, a single price, no tax, a defanged name", async () => {
    const b = await business();
    await updateEstimatorSettings(t.db, b.tenantId, { taxRateBp: 0 });
    const id = await b.quote();
    const settings = await getEstimatorSettings(t.db, b.tenantId);
    const used = new Set(ESTIMATOR_EMAIL_TEMPLATES.flatMap((tmpl) => [...`${tmpl.subject} ${tmpl.body}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!)));
    for (const type of ["lead.received", "quote.sent", "quote.accepted", "quote.declined", "quote.expired"] as const) {
      const [event] = (await buildEvents(t.db, b.tenantId, [{ type, estimateId: id, actor: { type: "customer", id: null } }], { now: NOW })) as [EstimatorEvent];
      for (const audience of ["customer", "staff"] as const) {
        const vars = estimatorEmailVars(event, settings, { quoteUrl: null, audience });
        for (const name of used) expect(vars[name], `${type}/${audience}: ${name}`).toEqual(expect.any(String));
      }
    }
    const [event] = (await buildEvents(t.db, b.tenantId, [{ type: "lead.received", estimateId: id, actor: { type: "customer", id: null } }], { now: NOW })) as [EstimatorEvent];
    const vars = estimatorEmailVars({ ...event, data: { ...event.data, estimate: { ...event.data.estimate, customerName: "www.evil.example now", jobAddress: "Visit evil.com/pay" } } }, settings, {
      quoteUrl: null,
    });
    expect(vars["rangeText"]).toBe("$6,921");
    expect(vars["estimateLine"]).toBe("Estimate: $6,921.");
    expect(vars["totalText"]).toBe("$6,921.46");
    expect(vars["firstName"]).toBe("there");
    expect(vars["address"]).toBe("Visit evil[.]com/pay");
    expect(vars["customerPhone"]).toBe(""); // unknown, in a customer email
    expect(estimatorEmailVars(event, settings, { quoteUrl: null, audience: "staff" })["customerPhone"]).toBe("—");
  });
});

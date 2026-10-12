import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProducts } from "../catalog.js";
import { createEstimate, createPublicEstimate, getEstimate, setEstimateStatus } from "../estimates.js";
import type { EstimatorEvent } from "../events.js";
import {
  acceptQuote,
  declineQuote,
  expireQuotes,
  getQuoteByToken,
  issueQuoteToken,
  openEstimateByToken,
  resendQuote,
  reviseQuote,
  sendQuote,
} from "../quotes.js";
import { loadSampleCatalog } from "../sample.js";
import { updateEstimatorSettings } from "../settings.js";
import { EstimatorInputError } from "../types.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** Quotes (6.8): the link, send, view, answer, revise, expire — every answer one conditional UPDATE. */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const NOW = new Date("2026-11-02T15:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

async function quoteable(email: string | null = "pat@example.test") {
  const tenantId = tenant("q");
  await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
  await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", contactPhone: "(801) 555-0143", timeZone: "America/Denver", taxRateBp: 725 });
  const products = await listProducts(t.db, tenantId);
  const ramp = products.find((p) => p.name === "Modular aluminum ramp")!.id;
  const created = await createEstimate(t.db, {
    tenantId,
    customerName: "Pat Lee",
    customerEmail: email,
    items: [{ productId: ramp, inputs: { steps: 4, stepHeightIn: 7.25 }, optionValueIds: [] }],
  });
  return { tenantId, id: created.id, ramp, products };
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EstimatorInputError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

function recorder() {
  const events: EstimatorEvent[] = [];
  return { events, onEvent: (event: EstimatorEvent) => void events.push(event), types: () => events.map((e) => e.type) };
}

describe("quote links", () => {
  it("only hashes are stored; every link opens the one estimate; another tenant's is nothing", async () => {
    const { tenantId, id } = await quoteable();
    const first = (await issueQuoteToken(t.db, tenantId, id))!;
    const second = (await issueQuoteToken(t.db, tenantId, id))!;
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
    expect((await openEstimateByToken(t.db, tenantId, first))?.id).toBe(id);
    expect((await openEstimateByToken(t.db, tenantId, second))?.id).toBe(id);
    expect(await openEstimateByToken(t.db, tenant(), first)).toBeNull();
    expect(await openEstimateByToken(t.db, tenantId, "not a token!")).toBeNull();
    expect(await issueQuoteToken(t.db, tenant(), id)).toBeNull();
    // No plaintext in any text column of any table.
    const tables = (await t.client.query<{ table_name: string; column_name: string }>(
      "select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('text', 'jsonb')",
    )).rows;
    for (const { table_name, column_name } of tables) {
      const hit = await t.client.query(`select 1 from "${table_name}" where "${column_name}"::text like $1 limit 1`, [`%${first}%`]);
      expect(hit.rows, `${table_name}.${column_name}`).toHaveLength(0);
    }
  });
});

describe("sendQuote", () => {
  it("refuses what can't be sent, each with a sentence", async () => {
    const noEmail = await quoteable(null);
    expect(await refusal(sendQuote(t.db, noEmail.tenantId, noEmail.id, {}))).toEqual({
      code: "no_customer_email",
      message: "Add the customer's email address to send the quote.",
    });
    const tenantId = tenant("q");
    const empty = await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [] });
    // A business that never saved its name and tax rate sends nothing (review EST-R02).
    expect(await refusal(sendQuote(t.db, tenantId, empty.id, {}))).toEqual({
      code: "settings_incomplete",
      message: "Add your business name and tax rate in Settings first.",
    });
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 725 });
    expect(await refusal(sendQuote(t.db, tenantId, empty.id, {}))).toEqual({ code: "empty_estimate", message: "Add at least one line before sending." });
    // A "request a quote" line nobody priced.
    const { tenantId: other, products } = await quoteable();
    const lead = await createPublicEstimate(
      t.db,
      { customerName: "Sam", customerEmail: "sam@x.test", items: [{ productId: products.find((p) => p.name === "Something else")!.id }] },
      { tenantId: other },
    );
    expect(await refusal(sendQuote(t.db, other, lead.id, {}))).toEqual({ code: "unpriced_lines", message: "Price every line before sending: Something else." });
    expect(await sendQuote(t.db, tenant(), lead.id, {})).toBeNull();
  });

  it("sent, valid until now + days, the sequence bumped, warnings for a line still a range; then not again", async () => {
    const { tenantId, ramp } = await quoteable();
    const ranged = await createEstimate(t.db, { tenantId, customerEmail: "pat@example.test", items: [{ productId: ramp, inputs: { steps: 3 } }] });
    const events = recorder();
    const result = (await sendQuote(t.db, tenantId, ranged.id, { validDays: 10, message: "Thanks for having us out." }, { now: NOW, onEvent: events.onEvent }))!;
    expect(result.estimate).toMatchObject({ status: "sent", quoteSequence: 1, quoteMessage: "Thanks for having us out." });
    expect(result.estimate.sentAt?.toISOString()).toBe(NOW.toISOString());
    expect(result.estimate.validUntil?.toISOString()).toBe(at(10).toISOString());
    expect(result.warnings).toEqual([
      "Line 1 (Modular aluminum ramp) is priced at 3 steps, 7.5 in each (estimated), 23 ft of ramp. The range was $6,473 – $7,146 (Step height 7–8 in (estimated)): measure first, or send it as is.",
    ]);
    expect(events.types()).toEqual(["quote.sent"]);
    expect(events.events[0]!.data.via).toBe("send");
    expect(await refusal(sendQuote(t.db, tenantId, ranged.id, {}))).toMatchObject({ code: "not_changeable" });
  });

  it("resend keeps the sequence and the date; revise takes it back to draft, saying 'updating'", async () => {
    const { tenantId, id } = await quoteable();
    expect(await refusal(resendQuote(t.db, tenantId, id))).toMatchObject({ code: "not_changeable", message: "Send the quote first." });
    await sendQuote(t.db, tenantId, id, {}, { now: NOW });
    const events = recorder();
    const resent = (await resendQuote(t.db, tenantId, id, { now: at(1), onEvent: events.onEvent }))!;
    expect(resent).toMatchObject({ quoteSequence: 1 });
    expect(resent.validUntil?.toISOString()).toBe(at(30).toISOString());
    expect(events.events.map((e) => [e.type, e.data.via])).toEqual([["quote.sent", "resend"]]);
    const token = (await issueQuoteToken(t.db, tenantId, id))!;
    const revised = (await reviseQuote(t.db, tenantId, id, { now: at(1), onEvent: events.onEvent }))!;
    expect(revised.status).toBe("draft");
    expect(events.types().at(-1)).toBe("quote.revised");
    expect((await getQuoteByToken(t.db, tenantId, token, { now: at(1) }))?.status).toBe("updating");
    expect(await refusal(reviseQuote(t.db, tenantId, id))).toMatchObject({ code: "not_changeable" });
    expect(await refusal(acceptQuote(t.db, tenantId, token, { version: 1 }, { now: at(1) }))).toEqual({
      code: "not_changeable",
      message: "We're updating this quote. You'll get the new one by email.",
    });
    const again = (await sendQuote(t.db, tenantId, id, {}, { now: at(2) }))!;
    expect(again.estimate.quoteSequence).toBe(2);
    // The link from the first send is dead once the quote is sent again (review ADV-2); a new one opens it.
    expect(await getQuoteByToken(t.db, tenantId, token, { now: at(2) })).toBeNull();
    const fresh = (await issueQuoteToken(t.db, tenantId, id))!;
    expect((await getQuoteByToken(t.db, tenantId, fresh, { now: at(2) }))?.status).toBe("open");
  });
});

describe("the customer's view and answer", () => {
  it("the first view marks it viewed (once); the quote shows the business, the lines and the dates — no costs", async () => {
    const { tenantId, id } = await quoteable();
    await sendQuote(t.db, tenantId, id, { message: "Here you go." }, { now: NOW });
    const token = (await issueQuoteToken(t.db, tenantId, id))!;
    const events = recorder();
    const quote = (await getQuoteByToken(t.db, tenantId, token, { now: at(0.1), onEvent: events.onEvent }))!;
    await getQuoteByToken(t.db, tenantId, token, { now: at(0.2), onEvent: events.onEvent });
    expect(events.types()).toEqual(["quote.viewed"]);
    expect(events.events[0]!.data.notify).toBe(false);
    expect(quote).toMatchObject({
      status: "open",
      canRespond: true,
      estimateId: id,
      businessName: "Summit Ramps",
      contactPhone: "(801) 555-0143",
      timeZone: "America/Denver",
      message: "Here you go.",
      customerName: "Pat Lee",
      subtotal: 838_558,
      taxRateBp: 725,
      taxAmount: 60_795,
      total: 899_353,
      version: 1,
    });
    // What the price rests on, measured: steps, height, feet of ramp (review EST-R05).
    expect(quote.lines).toEqual([{ description: "Modular aluminum ramp", details: ["4 steps, 7.25 in each, 29 ft of ramp"], quantity: 1, total: 838_558 }]);
    expect(JSON.stringify(quote)).not.toMatch(/cost|margin|internal|rangeLow|photo/i);
    expect((await getEstimate(t.db, tenantId, id))!.estimate.viewedAt?.toISOString()).toBe(at(0.1).toISOString());
  });

  it("accept is atomic and idempotent; a decline after it is already answered", async () => {
    const { tenantId, id } = await quoteable();
    await sendQuote(t.db, tenantId, id, {}, { now: NOW });
    const token = (await issueQuoteToken(t.db, tenantId, id))!;
    const events = recorder();
    const accepted = (await acceptQuote(t.db, tenantId, token, { version: 1, name: "Pat Lee", note: "Mornings are best" }, { now: at(1), onEvent: events.onEvent }))!;
    expect(accepted).toMatchObject({ status: "accepted", responseName: "Pat Lee", canRespond: false });
    expect(events.events.map((e) => [e.type, e.actor.type, e.data.notify, e.data.note])).toEqual([["quote.accepted", "customer", true, "Mornings are best"]]);
    const row = (await getEstimate(t.db, tenantId, id))!.estimate;
    expect(row).toMatchObject({ status: "approved", responseNote: "Mornings are best" });
    expect(row.approvedAt?.toISOString()).toBe(at(1).toISOString());
    expect(row.respondedAt?.toISOString()).toBe(at(1).toISOString());
    // A double tap: as is, no event.
    expect((await acceptQuote(t.db, tenantId, token, { version: 1 }, { now: at(1), onEvent: events.onEvent }))?.status).toBe("accepted");
    expect(events.events).toHaveLength(1);
    expect(await refusal(declineQuote(t.db, tenantId, token, { version: 1 }, { now: at(1) }))).toMatchObject({
      code: "already_answered",
      message: "You've already accepted this quote. Call us at (801) 555-0143 if you need to change it.",
    });
    expect(await acceptQuote(t.db, tenant(), token, { version: 1 })).toBeNull();
  });

  it("decline mirrors it", async () => {
    const { tenantId, id } = await quoteable();
    await sendQuote(t.db, tenantId, id, {}, { now: NOW });
    const token = (await issueQuoteToken(t.db, tenantId, id))!;
    expect((await declineQuote(t.db, tenantId, token, { version: 1, note: "Too much" }, { now: at(1) }))?.status).toBe("declined");
    expect((await declineQuote(t.db, tenantId, token, { version: 1 }, { now: at(1) }))?.status).toBe("declined");
    expect(await refusal(acceptQuote(t.db, tenantId, token, { version: 1 }, { now: at(1) }))).toMatchObject({
      code: "already_answered",
      message: "You've already declined this quote. Call us at (801) 555-0143 if you've changed your mind.",
    });
  });

  it("past its date: a view expires it first; an answer expires it and refuses, naming the phone", async () => {
    const viewed = await quoteable();
    await sendQuote(t.db, viewed.tenantId, viewed.id, { validDays: 5 }, { now: NOW });
    const viewToken = (await issueQuoteToken(t.db, viewed.tenantId, viewed.id))!;
    const events = recorder();
    const lapsed = (await getQuoteByToken(t.db, viewed.tenantId, viewToken, { now: at(6), onEvent: events.onEvent }))!;
    expect(lapsed).toMatchObject({ status: "expired", canRespond: false });
    expect(events.types()).toEqual(["quote.expired"]);

    const answered = await quoteable();
    await sendQuote(t.db, answered.tenantId, answered.id, { validDays: 5 }, { now: NOW });
    const token = (await issueQuoteToken(t.db, answered.tenantId, answered.id))!;
    const late = await refusal(acceptQuote(t.db, answered.tenantId, token, { version: 1 }, { now: at(6), onEvent: events.onEvent }));
    expect(late).toEqual({ code: "quote_expired", message: "This quote expired on Nov 7, 2026. Call us at (801) 555-0143 for an updated one." });
    expect(events.types()).toEqual(["quote.expired", "quote.expired"]);
    expect((await getEstimate(t.db, answered.tenantId, answered.id))!.estimate.status).toBe("expired");
    expect(await refusal(declineQuote(t.db, answered.tenantId, token, { version: 1 }, { now: at(7) }))).toMatchObject({ code: "quote_expired" });
    expect(events.events).toHaveLength(2); // already expired: no second event
  });
});

describe("expireQuotes and setEstimateStatus", () => {
  it("one statement, SKIP LOCKED, the overdue only; a second run is a no-op", async () => {
    const tenantId = tenant("sweep");
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps" });
    const ids: string[] = [];
    for (const days of [1, 2, 10]) {
      const created = await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [{ description: "Work", unitPrice: 100 }] });
      await sendQuote(t.db, tenantId, created.id, { validDays: days }, { now: NOW });
      ids.push(created.id);
    }
    const events = recorder();
    t.queries.length = 0;
    const result = await expireQuotes(t.db, tenantId, { now: at(5), onEvent: events.onEvent });
    expect(result).toEqual({ expired: 2, estimateIds: expect.arrayContaining([ids[0], ids[1]]), announced: 2 });
    const updates = t.queries.filter((q) => /^update "estimator_estimates" set "status"/.test(q.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.sql).toMatch(/for update skip locked/);
    expect(events.events.map((e) => [e.type, e.actor.type])).toEqual([
      ["quote.expired", "system"],
      ["quote.expired", "system"],
    ]);
    expect(await expireQuotes(t.db, tenantId, { now: at(5), onEvent: events.onEvent })).toEqual({ expired: 0, estimateIds: [], announced: 0 });
    expect(events.events).toHaveLength(2);
    expect(await expireQuotes(t.db, tenant(), { now: at(50) })).toEqual({ expired: 0, estimateIds: [], announced: 0 });
  });

  it("setEstimateStatus stamps each move and tells of staff's accept or decline (not emailed by default)", async () => {
    const { tenantId, id } = await quoteable();
    const events = recorder();
    expect(await setEstimateStatus(t.db, tenantId, { id, status: "sent" }, { now: NOW, onEvent: events.onEvent })).toBe(true);
    let row = (await getEstimate(t.db, tenantId, id))!.estimate;
    expect(row.sentAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.validUntil?.toISOString()).toBe(at(30).toISOString());
    expect(events.events).toHaveLength(0); // no link was sent: never quote.sent
    expect(await setEstimateStatus(t.db, tenantId, { id, status: "approved", note: "Said yes on the phone" }, { now: at(1), onEvent: events.onEvent, actor: { type: "staff", id: "u-1" } })).toBe(true);
    row = (await getEstimate(t.db, tenantId, id))!.estimate;
    expect(row).toMatchObject({ status: "approved", responseNote: "Said yes on the phone" });
    expect(row.approvedAt?.toISOString()).toBe(at(1).toISOString());
    expect(events.events.map((e) => [e.type, e.actor, e.data.notify, e.data.via])).toEqual([["quote.accepted", { type: "staff", id: "u-1" }, false, "staff"]]);
    expect(await setEstimateStatus(t.db, tenantId, { id, status: "draft" })).toBe(false); // approved → draft is not a move
    expect(await setEstimateStatus(t.db, tenant(), { id, status: "rejected" })).toBe(false);
  });
});

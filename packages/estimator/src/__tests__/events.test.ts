import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listProducts } from "../catalog.js";
import { createEstimate, createPublicEstimate, getEstimateRow, markEstimateConverted, setEstimateStatus } from "../estimates.js";
import type { EstimatorEvent } from "../events.js";
import { issueClientKey } from "../keys.js";
import { acceptQuote, declineQuote, expireQuotes, getQuoteByToken, insertQuoteToken, resendQuote, reviseQuote, sendQuote } from "../quotes.js";
import { loadSampleCatalog } from "../sample.js";
import { updateEstimatorSettings } from "../settings.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/** Events (6.11): one envelope, eight types, after commit, awaited in order, contained, no secrets, none for a no-op. */

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

describe("every emitter, every type", () => {
  it("the envelope, exactly, after commit", async () => {
    const tenantId = tenant("ev");
    await loadSampleCatalog(t.db, tenantId, { showInEstimator: true });
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps", taxRateBp: 825 });
    const ramp = (await listProducts(t.db, tenantId)).find((p) => p.name === "Modular aluminum ramp")!.id;
    const events: EstimatorEvent[] = [];
    const seen: string[] = [];
    // A read inside the listener sees the new state.
    const onEvent = async (event: EstimatorEvent) => {
      events.push(event);
      seen.push((await getEstimateRow(t.db, tenantId, event.estimateId))!.status);
    };
    const options = { onEvent };

    const lead = await createPublicEstimate(
      t.db,
      { customerName: "Pat Lee", customerEmail: "pat@x.test", items: [{ productId: ramp, inputs: { steps: 3 } }] },
      { tenantId, now: NOW, onEvent, requesterKey: "ip:203.0.113.10" },
    );
    await sendQuote(t.db, tenantId, lead.id, {}, { ...options, now: NOW, actor: { type: "staff", id: "u-1" } });
    await resendQuote(t.db, tenantId, lead.id, { ...options, now: at(1) });
    const token = await insertQuoteToken(t.db, tenantId, lead.id);
    await getQuoteByToken(t.db, tenantId, token, { ...options, now: at(1) });
    await reviseQuote(t.db, tenantId, lead.id, { ...options, now: at(1) });
    await sendQuote(t.db, tenantId, lead.id, {}, { ...options, now: at(2) });
    // Sent again: the first link is dead (review ADV-2); the new email's link answers version 2.
    const fresh = await insertQuoteToken(t.db, tenantId, lead.id);
    await acceptQuote(t.db, tenantId, fresh, { version: 2, name: "Pat", note: "Yes please" }, { ...options, now: at(3) });
    await markEstimateConverted(t.db, tenantId, lead.id, { ...options, now: at(4) });

    const second = await createEstimate(t.db, { tenantId, customerEmail: "sam@x.test", items: [{ description: "Work", unitPrice: 100 }] });
    await sendQuote(t.db, tenantId, second.id, {}, { now: NOW });
    await declineQuote(t.db, tenantId, await insertQuoteToken(t.db, tenantId, second.id), { version: 1, note: "No thanks" }, { ...options, now: at(1) });
    const third = await createEstimate(t.db, { tenantId, customerEmail: "jo@x.test", items: [{ description: "Work", unitPrice: 100 }] });
    await sendQuote(t.db, tenantId, third.id, { validDays: 1 }, { now: NOW });
    await expireQuotes(t.db, tenantId, { now: at(2), onEvent });
    const fourth = await createEstimate(t.db, { tenantId, items: [{ description: "Work", unitPrice: 100 }] });
    await setEstimateStatus(t.db, tenantId, { id: fourth.id, status: "sent" }, { now: NOW });
    await setEstimateStatus(t.db, tenantId, { id: fourth.id, status: "rejected", note: "Called to say no" }, { ...options, now: at(1), notify: true });

    expect(events.map((e) => [e.type, e.actor.type, e.data.notify, e.data.via ?? null])).toEqual([
      ["lead.received", "customer", true, "online"],
      ["quote.sent", "staff", true, "send"],
      ["quote.sent", "staff", true, "resend"],
      ["quote.viewed", "customer", false, null],
      ["quote.revised", "staff", false, null],
      ["quote.sent", "staff", true, "send"],
      ["quote.accepted", "customer", true, null],
      ["estimate.converted", "staff", false, null],
      ["quote.declined", "customer", true, null],
      ["quote.expired", "system", true, null],
      ["quote.declined", "staff", true, "staff"],
    ]);
    expect(seen).toEqual(["draft", "sent", "sent", "viewed", "draft", "sent", "approved", "converted", "rejected", "expired", "rejected"]);

    const sent = events[1]!;
    expect(Object.keys(sent).sort()).toEqual(["actor", "data", "estimateId", "id", "occurredAt", "tenantId", "type"]);
    expect(sent).toMatchObject({ tenantId, estimateId: lead.id, occurredAt: NOW.toISOString(), actor: { type: "staff", id: "u-1" } });
    expect(sent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    expect(sent.data.estimate).toMatchObject({
      id: lead.id,
      number: lead.estimateNumber,
      status: "sent",
      source: "public_tool",
      customerName: "Pat Lee",
      rangeLow: 647_262,
      rangeHigh: 714_588,
      rangeReasons: ["Step height 7–8 in (estimated)"],
      quoteSequence: 1,
      photoCount: 0,
      lines: [
        {
          description: "Modular aluminum ramp",
          inputsSummary: "3 steps",
          quantity: 1,
          total: 692_146,
          lowTotal: 647_262,
          highTotal: 714_588,
          options: [],
          assumption: "Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.",
        },
      ],
    });
    expect(events[6]!.data.note).toBe("Yes please");
    expect(events[10]!.data.note).toBe("Called to say no");

    // No secrets and nothing staff-only in any event.
    const { key } = await issueClientKey(t.db, { tenantId, label: "site" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(fresh);
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain("203.0.113.10");
    expect(serialized).not.toMatch(/"cost"|"internalNotes"|"marginBp"|tokenHash|requester/);
  });
});

describe("the guarantees", () => {
  it("contained: a throwing listener never fails the action; onEventError hears it", async () => {
    const tenantId = tenant("ev");
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps" });
    const created = await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [{ description: "Work", unitPrice: 100 }] });
    const heard: string[] = [];
    const result = await sendQuote(
      t.db,
      tenantId,
      created.id,
      {},
      {
        onEvent: () => {
          throw new Error("the mail server is down");
        },
        onEventError: (error, event) => void heard.push(`${event.type}: ${(error as Error).message}`),
      },
    );
    expect(result?.estimate.status).toBe("sent");
    expect(heard).toEqual(["quote.sent: the mail server is down"]);
  });

  it("awaited, in order: the second listener call starts after the first finished", async () => {
    const tenantId = tenant("ev");
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps" });
    for (let i = 0; i < 3; i += 1) {
      const created = await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [{ description: "Work", unitPrice: 100 }] });
      await sendQuote(t.db, tenantId, created.id, { validDays: 1 }, { now: NOW });
    }
    const log: string[] = [];
    await expireQuotes(t.db, tenantId, {
      now: at(2),
      onEvent: async (event) => {
        log.push(`start ${event.estimateId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        log.push(`end ${event.estimateId}`);
      },
    });
    expect(log).toHaveLength(6);
    for (let i = 0; i < 6; i += 2) expect(log[i]!.replace("start", "end")).toBe(log[i + 1]);
  });

  it("no event for a no-op: a second view, a double accept, an empty expiry run, a refused move", async () => {
    const tenantId = tenant("ev");
    await updateEstimatorSettings(t.db, tenantId, { businessName: "Summit Ramps" });
    const created = await createEstimate(t.db, { tenantId, customerEmail: "a@x.test", items: [{ description: "Work", unitPrice: 100 }] });
    await sendQuote(t.db, tenantId, created.id, {}, { now: NOW });
    const token = await insertQuoteToken(t.db, tenantId, created.id);
    const events: EstimatorEvent[] = [];
    const onEvent = (event: EstimatorEvent) => void events.push(event);
    await getQuoteByToken(t.db, tenantId, token, { now: at(1), onEvent });
    await getQuoteByToken(t.db, tenantId, token, { now: at(1), onEvent });
    await acceptQuote(t.db, tenantId, token, { version: 1 }, { now: at(1), onEvent });
    await acceptQuote(t.db, tenantId, token, { version: 1 }, { now: at(1), onEvent });
    await expireQuotes(t.db, tenantId, { now: at(60), onEvent });
    await setEstimateStatus(t.db, tenantId, { id: created.id, status: "rejected" }, { onEvent });
    expect(events.map((e) => e.type)).toEqual(["quote.viewed", "quote.accepted"]);
  });
});

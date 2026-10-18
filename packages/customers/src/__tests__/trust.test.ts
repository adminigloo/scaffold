import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomersAdminHandlers } from "../admin-handlers.js";
import { backfillCustomers } from "../backfill.js";
import { createCustomer, customerTimeline, findOrCreateCustomer, getCustomer, listCustomers, mergeCustomers, resolveCustomerNotice } from "../customers.js";
import { createDrizzleCustomerDirectory, recordCustomerActivity } from "../directory.js";
import { normalisePhone } from "../normalise.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * THE REVIEW'S FINDINGS, PINNED. A public form (an estimate request, a
 * booking, a store order) never changes a customer it matched, never matches
 * one by phone alone, and no detail another customer holds is ever added. A
 * message links only to the one customer who is exactly its address.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

const directory = () => createDrizzleCustomerDirectory(t.db);

async function mrsLee(tenantId: string) {
  return (await findOrCreateCustomer(t.db, { tenantId, name: "Mrs Lee", email: "may.lee@example.com", phone: "(415) 555-0123", address: "12 Elm St", source: "staff" })).customer;
}

describe("R1: a public form with her email can't change her record", () => {
  it("links the estimate to Mrs Lee, adds nothing, and offers the new details for Add or Ignore", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    await recordCustomerActivity(directory(), {
      tenantId: a,
      kind: "estimate",
      refId: "est-12",
      action: "submitted",
      occurredAt: new Date(),
      summary: "Quote Q-0012 asked for online",
      name: "Evil",
      email: "MAY.LEE@example.com",
      phone: "212-555-0199",
      address: "666 Evil St",
      companyName: "Evil Inc",
    });
    const card = (await getCustomer(t.db, a, lee.id))!;
    expect(card).toMatchObject({ name: "Mrs Lee", phones: ["+14155550123"], companyName: null });
    expect(card.addresses.map((address) => address.text)).toEqual(["12 Elm St"]);
    expect(card.notices).toHaveLength(1);
    expect(card.notices[0]!.message).toBe("New details from a form (Quote Q-0012 asked for online): phone +12125550199, 666 Evil St, company Evil Inc");
    // The attacker's phone now finds nobody: it isn't hers.
    expect((await findOrCreateCustomer(t.db, { tenantId: a, phone: "2125550199", source: "staff" })).customer.id).not.toBe(lee.id);
    expect((await customerTimeline(t.db, a, lee.id))?.entries.map((entry) => entry.refId)).toEqual(["est-12"]);
  });

  it("Ignore leaves her as she is and isn't asked again; Add applies, except a detail another customer has", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    const kim = await createCustomer(t.db, a, { name: "Mr Kim", phone: "212-555-0199" });
    await findOrCreateCustomer(t.db, { tenantId: a, email: "may.lee@example.com", phone: "212 555 0199", address: "1 New Rd", sourceLabel: "Call booked" });
    const offered = (await getCustomer(t.db, a, lee.id))!.notices[0]!;
    const added = (await resolveCustomerNotice(t.db, a, lee.id, offered.id, "add", "u1"))!;
    expect(added.phones).toEqual(["+14155550123"]);
    expect(added.addresses.map((address) => address.text)).toEqual(["12 Elm St", "1 New Rd"]);
    expect(added.notices.map((notice) => notice.message)).toEqual(["Mr Kim also has this phone, +12125550199. It wasn't added here."]);
    expect(added.notices[0]!.other).toEqual({ id: kim.id, name: "Mr Kim" });
    // A second form with the same details: no new question once decided.
    await findOrCreateCustomer(t.db, { tenantId: a, email: "may.lee@example.com", address: "9 Other Rd" });
    const next = (await getCustomer(t.db, a, lee.id))!.notices.find((notice) => notice.kind === "new-details")!;
    expect((await resolveCustomerNotice(t.db, a, lee.id, next.id, "ignore"))!.addresses).toHaveLength(2);
    await findOrCreateCustomer(t.db, { tenantId: a, email: "may.lee@example.com", address: "9 Other Rd" });
    expect((await getCustomer(t.db, a, lee.id))!.notices.filter((notice) => notice.kind === "new-details")).toEqual([]);
    // Another company can't decide A's notices.
    expect(await resolveCustomerNotice(t.db, tenant(), lee.id, next.id, "add")).toBeNull();
  });
});

describe("R2: a public form that matches only by phone makes a new customer", () => {
  it("never links to Mrs Lee by her phone; both records say they might be the same person, and either can merge", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    const booked = await recordCustomerActivity(directory(), {
      tenantId: a,
      kind: "booking",
      refId: "call-1",
      action: "booked",
      occurredAt: new Date(),
      summary: "Intro call booked",
      name: "Somebody",
      email: "somebody@example.com",
      phone: "+1 415 555 0123",
    });
    expect(booked!.id).not.toBe(lee.id);
    const stranger = (await getCustomer(t.db, a, booked!.id))!;
    // Her phone isn't given to the new customer either.
    expect(stranger.phones).toEqual([]);
    expect(stranger.notices.map((notice) => notice.message)).toEqual(["Might be the same person as Mrs Lee (the same phone, +14155550123)"]);
    expect((await getCustomer(t.db, a, lee.id))!.notices.map((notice) => notice.message)).toEqual(["Might be the same person as Somebody (the same phone, +14155550123)"]);
    expect((await customerTimeline(t.db, a, lee.id))?.entries).toEqual([]);
    // One click from her record merges the new one in; the question is answered on both.
    const merged = (await mergeCustomers(t.db, a, lee.id, stranger.id, "u1"))!;
    expect(merged.customer.notices).toEqual([]);
    expect((await customerTimeline(t.db, a, lee.id))?.entries.map((entry) => entry.refId)).toEqual(["call-1"]);
  });

  it("'Not the same person' answers it on both records", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    const other = (await findOrCreateCustomer(t.db, { tenantId: a, name: "Other", phone: "415 555 0123" })).customer;
    const notice = (await getCustomer(t.db, a, other.id))!.notices[0]!;
    expect((await resolveCustomerNotice(t.db, a, other.id, notice.id, "dismiss"))!.notices).toEqual([]);
    expect((await getCustomer(t.db, a, lee.id))!.notices).toEqual([]);
  });
});

describe("R5b: a message links only to the one customer who is exactly its address", () => {
  it("links nobody for a phone two customers have, an address nobody has, or a Gmail spelling; links the exact one", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    // Two customers on one phone (a staff edit can't do it; a merge-less import of an old list could).
    const kim = await createCustomer(t.db, a, { name: "Mr Kim", email: "kim@gmail.com" });
    await t.client.query(`update customers set phones = '["+14155550123"]'::jsonb where id = $1`, [kim.id]);
    const sent = (refId: string, to: { email?: string; phone?: string }) =>
      recordCustomerActivity(directory(), { tenantId: a, kind: "message", refId, action: "sent", occurredAt: new Date(), summary: "Email sent", ...to, mode: "find" });
    expect(await sent("m1", { phone: "+14155550123" })).toBeNull();
    expect(await sent("m2", { email: "owner@example.com" })).toBeNull();
    expect(await sent("m3", { email: "k.i.m@gmail.com" })).toBeNull();
    expect((await sent("m4", { email: "may.lee@example.com" }))?.id).toBe(lee.id);
    expect((await sent("m5", { email: "kim@gmail.com" }))?.id).toBe(kim.id);
    expect((await listCustomers(t.db, a)).customers).toHaveLength(2);
  });
});

describe("one occurrence, one row (M1); history per action (M2)", () => {
  it("keeps a visit moved twice as two entries, and the same move told again as one", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    const move = (sequence: number) =>
      recordCustomerActivity(directory(), { tenantId: a, kind: "visit", refId: "v1", action: "moved", occurrence: String(sequence), occurredAt: new Date(Date.UTC(2026, 0, sequence)), summary: `Moved (${sequence})`, email: "may.lee@example.com" });
    await move(2);
    await move(3);
    await move(3);
    expect((await customerTimeline(t.db, a, lee.id))?.entries.map((entry) => entry.summary)).toEqual(["Moved (3)", "Moved (2)"]);
  });

  it("backfills an invoice's raised AND paid even one record a chunk, and even when paid was linked live first", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    await recordCustomerActivity(directory(), { tenantId: a, kind: "invoice", refId: "inv-7", action: "paid", occurredAt: new Date(Date.UTC(2026, 1, 2)), summary: "Invoice paid", email: "may.lee@example.com" });
    const result = await backfillCustomers(
      directory(),
      a,
      [
        { kind: "invoice", refId: "inv-7", action: "raised", occurredAt: new Date(Date.UTC(2026, 1, 1)), summary: "Invoice raised", email: "may.lee@example.com", source: "staff" },
        { kind: "invoice", refId: "inv-7", action: "paid", occurredAt: new Date(Date.UTC(2026, 1, 2)), summary: "Invoice paid", email: "may.lee@example.com", source: "staff" },
      ],
      { chunkSize: 1 },
    );
    expect(result).toMatchObject({ linked: 1, alreadyLinked: 1 });
    expect((await customerTimeline(t.db, a, lee.id, { order: "oldest" }))?.entries.map((entry) => entry.action)).toEqual(["raised", "paid"]);
  });
});

describe("phones (L2) and phone search (L3)", () => {
  it("reads 011 as an international call from North America, and refuses a number the wrong length for its country", () => {
    expect(normalisePhone("011 44 20 7946 0958")).toBe("+442079460958");
    expect(normalisePhone("+44 20 7946 0")).toBeNull();
    expect(normalisePhone("+61 412 345 678")).toBe("+61412345678");
    expect(normalisePhone("+61 412 345 67")).toBeNull();
    expect(normalisePhone("011 44 20 7946 0958", "GB")).toBeNull();
  });

  it("finds a customer by part of a phone typed any way", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    for (const q of ["(415) 555", "415-555-01", "4155550123", "+1 415"]) {
      expect((await listCustomers(t.db, a, { q })).customers.map((row) => row.id), q).toEqual([lee.id]);
    }
  });
});

describe("a merged customer's old link (L5)", () => {
  it("opens the customer they were merged into, inside the company only", async () => {
    const a = tenant();
    const lee = await mrsLee(a);
    const dup = await createCustomer(t.db, a, { name: "May L" });
    await mergeCustomers(t.db, a, lee.id, dup.id);
    const { handle } = createCustomersAdminHandlers({ db: t.db, resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null, authorize: () => true });
    const res = await handle(new Request(`https://app.test/api/app/${a}/customers/v1/admin/customers/${dup.id}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ customer: { id: lee.id, name: "Mrs Lee" }, mergedFrom: dup.id });
    const elsewhere = await handle(new Request(`https://app.test/api/app/${tenant()}/customers/v1/admin/customers/${dup.id}`));
    expect(elsewhere.status).toBe(404);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCustomer,
  CustomersRefusal,
  customerTimeline,
  exportCustomersCsv,
  findCustomer,
  findOrCreateCustomer,
  getCustomer,
  linkCustomer,
  linkedCustomer,
  listCustomers,
  mergeCustomers,
  updateCustomer,
} from "../customers.js";
import { createDrizzleCustomerDirectory, recordCustomerActivity } from "../directory.js";
import { customerMerges } from "../schema.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

describe("findOrCreate, inside one company", () => {
  it("the same email in companies A and B gives two separate customers", async () => {
    const a = tenant("a");
    const b = tenant("b");
    const inA = await findOrCreateCustomer(t.db, { tenantId: a, name: "Mrs Lee", email: "may.lee@example.com" });
    const inB = await findOrCreateCustomer(t.db, { tenantId: b, name: "May Lee", email: "MAY.LEE@example.com" });
    expect(inA.created).toBe(true);
    expect(inB.created).toBe(true);
    expect(inB.customer.id).not.toBe(inA.customer.id);
    expect(inB.customer.tenantId).toBe(b);
    // And each company finds only its own.
    expect((await findCustomer(t.db, { tenantId: a, email: "may.lee@example.com" }))?.id).toBe(inA.customer.id);
    expect((await findCustomer(t.db, { tenantId: b, email: "may.lee@example.com" }))?.id).toBe(inB.customer.id);
    expect(await findCustomer(t.db, { tenantId: tenant("c"), email: "may.lee@example.com" })).toBeNull();
  });

  it("finds the same customer again by a Gmail spelling of their email, or by their phone written another way", async () => {
    const a = tenant();
    const first = await findOrCreateCustomer(t.db, { tenantId: a, name: "Mrs Lee", email: "May.Lee+quotes@gmail.com", phone: "(415) 555-0123" });
    const byEmail = await findOrCreateCustomer(t.db, { tenantId: a, name: "M Lee", email: "maylee@googlemail.com" });
    const byPhone = await findOrCreateCustomer(t.db, { tenantId: a, name: "Lee", phone: "+1 415 555 0123", source: "staff" });
    expect(byEmail).toMatchObject({ created: false });
    expect(byPhone).toMatchObject({ created: false });
    expect(byEmail.customer.id).toBe(first.customer.id);
    expect(byPhone.customer.id).toBe(first.customer.id);
    // The name the business had stays; the email kept is the one first typed.
    expect(byPhone.customer.name).toBe("Mrs Lee");
    expect(byPhone.customer.emails).toEqual(["may.lee+quotes@gmail.com"]);
  });

  it("staff: adds a new phone, email and address to the customer it found, never a new name", async () => {
    const a = tenant();
    await findOrCreateCustomer(t.db, { tenantId: a, name: "Bo Diaz", email: "bo@example.com" });
    const again = await findOrCreateCustomer(t.db, { tenantId: a, name: "Robert", email: "bo@example.com", phone: "415-555-0199", address: "12 Elm St", source: "staff" });
    const card = await getCustomer(t.db, a, again.customer.id);
    expect(card).toMatchObject({ name: "Bo Diaz", emails: ["bo@example.com"], phones: ["+14155550199"] });
    expect(card?.addresses.map((address) => address.text)).toEqual(["12 Elm St"]);
    // And then the phone alone finds them.
    expect((await findOrCreateCustomer(t.db, { tenantId: a, phone: "4155550199", source: "staff" })).customer.id).toBe(again.customer.id);
  });

  it("makes ONE customer when the same new customer arrives twice at once", async () => {
    const a = tenant();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => findOrCreateCustomer(t.db, { tenantId: a, name: `Racer ${i}`, email: "racer@example.com", phone: "415 555 0144" })),
    );
    expect(new Set(results.map((result) => result.customer.id)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await listCustomers(t.db, a)).customers).toHaveLength(1);
  });

  it("creates a customer from a name alone, and one with nothing gets a plain name", async () => {
    const a = tenant();
    expect((await findOrCreateCustomer(t.db, { tenantId: a, name: "Walk-in" })).customer.name).toBe("Walk-in");
    expect((await findOrCreateCustomer(t.db, { tenantId: a, email: "zed@example.com" })).customer.name).toBe("zed");
  });
});

describe("links and the timeline", () => {
  it("one customer's quote, visit, invoice raised and paid show in order — inside company A only", async () => {
    const a = tenant("a");
    const b = tenant("b");
    const directory = createDrizzleCustomerDirectory(t.db);
    const at = (minutes: number) => new Date(Date.UTC(2026, 2, 3, 9, minutes));
    // The estimate arrives with everything the customer typed.
    await recordCustomerActivity(directory, { tenantId: a, kind: "estimate", refId: "est-1", action: "submitted", occurredAt: at(0), summary: "Quote Q-0001 · $480.00", name: "Mrs Lee", email: "may.lee@example.com", phone: "415 555 0123", address: "12 Elm St" });
    // The visit is booked with a phone only.
    await recordCustomerActivity(directory, { tenantId: a, kind: "visit", refId: "visit-1", action: "booked", occurredAt: at(10), summary: "Visit booked for Tue 3 Mar, 9:00", name: "May Lee", phone: "+14155550123", source: "staff" });
    // The invoice is raised with her email in another case.
    await recordCustomerActivity(directory, { tenantId: a, kind: "invoice", refId: "inv-1", action: "raised", occurredAt: at(20), summary: "Invoice INV-0001 raised · $480.00", name: "May Lee", email: "MAY.LEE@example.com", source: "staff" });
    // The payment knows only the invoice: it lands on the customer the invoice was raised for.
    await recordCustomerActivity(directory, { tenantId: a, kind: "invoice", refId: "inv-1", action: "paid", occurredAt: at(30), summary: "Invoice INV-0001 paid · $480.00" });
    // Company B has a customer with the same email, and its own invoice with the same id.
    await recordCustomerActivity(directory, { tenantId: b, kind: "invoice", refId: "inv-1", action: "raised", occurredAt: at(25), summary: "B's own invoice", email: "may.lee@example.com" });

    const { customers: inA } = await listCustomers(t.db, a);
    expect(inA).toHaveLength(1);
    const lee = inA[0]!;
    const timeline = await customerTimeline(t.db, a, lee.id, { order: "oldest" });
    expect(timeline?.entries.map((entry) => [entry.kind, entry.action])).toEqual([
      ["estimate", "submitted"],
      ["visit", "booked"],
      ["invoice", "raised"],
      ["invoice", "paid"],
    ]);
    expect(timeline?.entries.some((entry) => entry.summary.includes("B's"))).toBe(false);
    const newest = await customerTimeline(t.db, a, lee.id);
    expect(newest?.entries[0]?.action).toBe("paid");
    expect((await linkedCustomer(t.db, a, "invoice", "inv-1"))?.id).toBe(lee.id);
    // Company B can't open A's customer or their timeline, and A's links aren't B's.
    expect(await customerTimeline(t.db, b, lee.id)).toBeNull();
    expect(await getCustomer(t.db, b, lee.id)).toBeNull();
    const inB = (await listCustomers(t.db, b)).customers;
    expect(inB).toHaveLength(1);
    expect(inB[0]!.id).not.toBe(lee.id);
    expect((await customerTimeline(t.db, b, inB[0]!.id))?.entries.map((entry) => entry.summary)).toEqual(["B's own invoice"]);
  });

  it("tells the same thing twice as one row, and pages the timeline", async () => {
    const a = tenant();
    const { customer } = await findOrCreateCustomer(t.db, { tenantId: a, name: "Pager", email: "pager@example.com" });
    for (let i = 0; i < 35; i += 1) {
      await linkCustomer(t.db, { tenantId: a, customerId: customer.id, kind: "message", refId: `m-${i}`, action: "sent", occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)), summary: `Message ${i}` });
    }
    expect((await linkCustomer(t.db, { tenantId: a, customerId: customer.id, kind: "message", refId: "m-3", action: "sent", occurredAt: new Date(), summary: "again" })).linked).toBe(false);
    const first = await customerTimeline(t.db, a, customer.id);
    expect(first?.entries).toHaveLength(30);
    expect(first?.entries[0]?.summary).toBe("Message 34");
    const second = await customerTimeline(t.db, a, customer.id, { cursor: first?.nextCursor });
    expect(second?.entries.map((entry) => entry.summary)).toEqual(["Message 4", "Message 3", "Message 2", "Message 1", "Message 0"]);
    expect(second?.nextCursor).toBeNull();
  });

  it("refuses to link another company's customer", async () => {
    const a = tenant();
    const { customer } = await findOrCreateCustomer(t.db, { tenantId: a, name: "Theirs" });
    await expect(linkCustomer(t.db, { tenantId: tenant(), customerId: customer.id, kind: "order", refId: "o1", occurredAt: new Date(), summary: "x" })).rejects.toThrow(CustomersRefusal);
  });

  it("a message links only to a customer who already exists", async () => {
    const a = tenant();
    const directory = createDrizzleCustomerDirectory(t.db);
    expect(await recordCustomerActivity(directory, { tenantId: a, kind: "message", refId: "msg-1", action: "sent", occurredAt: new Date(), summary: "To the office", email: "owner@example.com", mode: "find" })).toBeNull();
    expect((await listCustomers(t.db, a)).customers).toHaveLength(0);
  });
});

describe("search, edit, merge, export", () => {
  it("searches by name, company, email, phone and address", async () => {
    const a = tenant();
    const { customer } = await findOrCreateCustomer(t.db, { tenantId: a, name: "Ana Ruiz", companyName: "Ruiz Rentals", email: "ana@example.com", phone: "415 555 0177", address: "9 Harbor Way" });
    await findOrCreateCustomer(t.db, { tenantId: a, name: "Someone Else", email: "else@example.com" });
    for (const q of ["ruiz", "Rentals", "ANA@example", "(415) 555-0177", "harbor"]) {
      expect((await listCustomers(t.db, a, { q })).customers.map((row) => row.id), q).toEqual([customer.id]);
    }
    expect((await listCustomers(t.db, tenant(), { q: "ruiz" })).customers).toHaveLength(0);
  });

  it("refuses an email another customer has, by their name", async () => {
    const a = tenant();
    await createCustomer(t.db, a, { name: "Kim", email: "kim@example.com" });
    await expect(createCustomer(t.db, a, { name: "Kim 2", emails: ["KIM@example.com"] })).rejects.toThrow("already Kim's");
    const other = await createCustomer(t.db, a, { name: "Lou" });
    await expect(updateCustomer(t.db, a, other.id, { emails: ["kim@example.com"] })).rejects.toThrow("already Kim's");
    await expect(createCustomer(t.db, a, { name: "Bad", phone: "12" })).rejects.toThrow("phone number");
    expect(await updateCustomer(t.db, tenant(), other.id, { notes: "x" })).toBeNull();
  });

  it("merges a duplicate: its timeline, emails, phones and addresses move, the merge is kept, and it's never matched again", async () => {
    const a = tenant();
    const keep = await findOrCreateCustomer(t.db, { tenantId: a, name: "May Lee", email: "may@example.com", address: "12 Elm St" });
    const dup = await findOrCreateCustomer(t.db, { tenantId: a, name: "Mrs Lee", phone: "415 555 0123", address: "12 elm st." });
    await linkCustomer(t.db, { tenantId: a, customerId: dup.customer.id, kind: "visit", refId: "v1", action: "booked", occurredAt: new Date(), summary: "Visit" });
    await linkCustomer(t.db, { tenantId: a, customerId: dup.customer.id, kind: "booking", refId: "c1", action: "booked", occurredAt: new Date(), summary: "Call" });
    expect(await mergeCustomers(t.db, tenant(), keep.customer.id, dup.customer.id)).toBeNull();
    const merged = await mergeCustomers(t.db, a, keep.customer.id, dup.customer.id, "user-1");
    expect(merged?.linksMoved).toBe(2);
    expect(merged?.customer).toMatchObject({ name: "May Lee", emails: ["may@example.com"], phones: ["+14155550123"] });
    expect(merged?.customer.addresses).toHaveLength(1);
    expect((await customerTimeline(t.db, a, keep.customer.id))?.entries).toHaveLength(2);
    expect(await getCustomer(t.db, a, dup.customer.id)).toBeNull();
    expect((await findOrCreateCustomer(t.db, { tenantId: a, phone: "4155550123", source: "staff" })).customer.id).toBe(keep.customer.id);
    const audit = await t.db.select().from(customerMerges);
    expect(audit.find((row) => row.mergedId === dup.customer.id)).toMatchObject({ keptId: keep.customer.id, mergedBy: "user-1", linksMoved: 2 });
    // A link told to the merged id later lands on the kept customer.
    expect((await linkCustomer(t.db, { tenantId: a, customerId: dup.customer.id, kind: "order", refId: "o9", occurredAt: new Date(), summary: "Order" })).customerId).toBe(keep.customer.id);
    await expect(mergeCustomers(t.db, a, keep.customer.id, keep.customer.id)).rejects.toThrow("themselves");
  });

  it("exports the company's list as CSV, safe to open", async () => {
    const a = tenant();
    await createCustomer(t.db, a, { name: "=SUM(A1)", email: "f@example.com", tags: ["vip"] });
    await createCustomer(t.db, tenant(), { name: "Not ours" });
    const csv = await exportCustomersCsv(t.db, a);
    expect(csv.split("\r\n")[0]).toBe("Name,Company,Email,Phone,Address,Tags,Notes,Customer since");
    expect(csv).toContain("'=SUM(A1),,f@example.com,,,vip");
    expect(csv).not.toContain("Not ours");
  });
});

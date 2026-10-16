import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvoice, INVOICING_INVOICE_RECORD, invoicingFileRecords, invoicingPermissions } from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, 11.4, on a real Postgres: the invoice as a record files
 * belong to. `find` answers this company's invoices only, in one query, with
 * the label the Files screen shows and where the invoice opens.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const RECORD_TYPE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
const HREF = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

async function invoiceFor(tenantId: string, customerName: string | null): Promise<{ id: string; number: string }> {
  const created = await createInvoice(t.db, {
    tenantId,
    customerName,
    items: [{ description: "Mowing", quantity: 1, unitPrice: 5_000 }],
  });
  return { id: created.id, number: created.invoiceNumber };
}

describe("invoicingFileRecords (11.4)", () => {
  it("is one record type: 3.5's shape, with the plural for the Files screen's filter", () => {
    const types = invoicingFileRecords(t.db, { invoiceHref: "/app/invoices/{id}" });
    expect(types).toHaveLength(1);
    const [invoice] = types;
    expect(invoice).toMatchObject({
      type: "invoicing.invoice",
      label: "Invoice",
      pluralLabel: "Invoices",
      view: ["invoices.view"],
      manage: ["invoices.manage"],
    });
    expect(invoice!.assigned).toBeUndefined();
    expect(INVOICING_INVOICE_RECORD).toBe(invoice!.type);
    expect(RECORD_TYPE.test(invoice!.type)).toBe(true);
    // Every permission it names is one invoicing declares.
    for (const key of [...invoice!.view, ...invoice!.manage]) expect(Object.keys(invoicingPermissions)).toContain(key);
    expect(Object.isFrozen(types)).toBe(true);
  });

  it("finds this company's invoices only: another company's id is simply absent", async () => {
    const a = tenant("green");
    const b = tenant("summit");
    const mine = await invoiceFor(a, "Pat Rivera");
    const theirs = await invoiceFor(b, "Sam Lee");
    const [invoice] = invoicingFileRecords(t.db, { invoiceHref: "/app/invoices/{id}" });
    const found = await invoice!.find({ tenantId: a, ids: [mine.id, theirs.id, "no-such-invoice"] });
    expect([...found.keys()]).toEqual([mine.id]);
    expect(found.get(mine.id)).toEqual({
      label: `Invoice ${mine.number} · Pat Rivera`,
      href: `/app/invoices/${mine.id}`,
      assignedUserIds: [],
    });
    expect(HREF.test(found.get(mine.id)!.href!)).toBe(true);
    // And B sees only its own.
    expect([...(await invoice!.find({ tenantId: b, ids: [mine.id, theirs.id] })).keys()]).toEqual([theirs.id]);
  });

  it("labels an invoice with no customer 'Invoice {number}'; a customer's line breaks stay out", async () => {
    const a = tenant("green");
    const plain = await invoiceFor(a, null);
    const odd = await invoiceFor(a, "Pat\nRivera");
    const [invoice] = invoicingFileRecords(t.db, { invoiceHref: "/admin/invoices/{id}" });
    const found = await invoice!.find({ tenantId: a, ids: [plain.id, odd.id] });
    expect(found.get(plain.id)?.label).toBe(`Invoice ${plain.number}`);
    expect(found.get(odd.id)?.label).toBe(`Invoice ${odd.number} · Pat Rivera`);
    expect(found.get(plain.id)?.href).toBe(`/admin/invoices/${plain.id}`);
  });

  it("one query for many ids, none for none", async () => {
    const a = tenant("green");
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await invoiceFor(a, `Customer ${i}`)).id);
    const [invoice] = invoicingFileRecords(t.db, { invoiceHref: "/app/invoices/{id}" });
    t.queries.length = 0;
    const found = await invoice!.find({ tenantId: a, ids: [...ids, ...ids] });
    expect(found.size).toBe(12);
    expect(t.queries).toHaveLength(1);
    expect(t.queries[0]!.sql).toMatch(/"invoices"\."tenant_id" = \$1/);
    t.queries.length = 0;
    expect((await invoice!.find({ tenantId: a, ids: [] })).size).toBe(0);
    expect((await invoice!.find({ tenantId: "", ids })).size).toBe(0);
    expect(t.queries).toHaveLength(0);
  });

  it("an href pattern that isn't a same-site path opens nothing (the label still shows)", async () => {
    const a = tenant("green");
    const inv = await invoiceFor(a, "Pat Rivera");
    const [invoice] = invoicingFileRecords(t.db, { invoiceHref: "https://evil.test/{id}" });
    const found = await invoice!.find({ tenantId: a, ids: [inv.id] });
    expect(found.get(inv.id)).toMatchObject({ href: null, label: `Invoice ${inv.number} · Pat Rivera` });
  });
});

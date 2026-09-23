import { describe, expect, it } from "vitest";
import { invoiceCursor, invoices, listInvoices } from "../index.js";
import { createFakeDb } from "./fake-db.js";

const PAST = new Date("2020-01-01T00:00:00Z");
const FUTURE = new Date("2999-01-01T00:00:00Z");

function seeded() {
  const fake = createFakeDb();
  let n = 0;
  const add = (over: Record<string, unknown>) => {
    n++;
    fake.seed(invoices, [
      {
        id: `inv-${String(n).padStart(2, "0")}`,
        tenantId: "t1",
        invoiceNumber: `INV-2026-${String(n).padStart(4, "0")}`,
        viewToken: `tok-${n}`,
        createdAt: new Date(Date.UTC(2026, 0, n)),
        ...over,
      },
    ]);
  };
  return { fake, add };
}

describe("listInvoices — cursor pagination", () => {
  it("walks every row exactly once, newest first, across pages (ties broken by id)", async () => {
    const { fake, add } = seeded();
    for (let i = 0; i < 5; i++) add({});
    // Two invoices in the same millisecond: the id breaks the tie so the page
    // boundary can't drop or repeat one.
    const same = new Date(Date.UTC(2026, 0, 3));
    add({ createdAt: same });
    add({ tenantId: "t2" });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const rows = await listInvoices(fake.db, "t1", { limit: 2, cursor });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      cursor = invoiceCursor(rows[rows.length - 1]!);
    }
    expect(seen).toEqual(["inv-05", "inv-04", "inv-06", "inv-03", "inv-02", "inv-01"]);
  });

  it("still takes a bare limit", async () => {
    const { fake, add } = seeded();
    for (let i = 0; i < 3; i++) add({});
    expect(await listInvoices(fake.db, "t1", 2)).toHaveLength(2);
  });

  it("rejects a malformed cursor rather than silently restarting at page one", async () => {
    const { fake } = seeded();
    await expect(listInvoices(fake.db, "t1", { cursor: "garbage" })).rejects.toThrow();
  });
});

describe("listInvoices — status filter in SQL", () => {
  function ledger() {
    const { fake, add } = seeded();
    add({ status: "sent", dueDate: PAST }); // 01 overdue
    add({ status: "viewed", dueDate: PAST }); // 02 overdue
    add({ status: "partial", dueDate: PAST }); // 03 overdue
    add({ status: "paid", dueDate: PAST }); // 04 settled — never overdue
    add({ status: "draft", dueDate: PAST }); // 05 not issued — never overdue
    add({ status: "void", dueDate: PAST }); // 06 closed
    add({ status: "sent", dueDate: FUTURE }); // 07
    add({ status: "sent", dueDate: null }); // 08
    add({ status: "sent", dueDate: PAST, tenantId: "t2" }); // 09 other tenant
    return fake;
  }
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  it("overdue = open (sent/viewed/partial) and past due, in this tenant", async () => {
    const fake = ledger();
    expect(ids(await listInvoices(fake.db, "t1", { status: "overdue" }))).toEqual(["inv-01", "inv-02", "inv-03"]);
  });

  it("an open status excludes its overdue rows, so the filters partition like the badges", async () => {
    const fake = ledger();
    expect(ids(await listInvoices(fake.db, "t1", { status: "sent" }))).toEqual(["inv-07", "inv-08"]);
    expect(ids(await listInvoices(fake.db, "t1", { status: "paid" }))).toEqual(["inv-04"]);
    expect(ids(await listInvoices(fake.db, "t1", { status: "draft" }))).toEqual(["inv-05"]);
  });

  it("filters BEFORE the limit — a page of overdue is full even behind newer rows", async () => {
    const fake = ledger();
    // The three overdue rows are the OLDEST; a JS filter over the newest 3 rows
    // would find none.
    expect(await listInvoices(fake.db, "t1", { status: "overdue", limit: 3 })).toHaveLength(3);
  });
});

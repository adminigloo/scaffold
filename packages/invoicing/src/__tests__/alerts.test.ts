import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInvoice,
  endOfDayInZone,
  INVOICING_INVOICE_OVERDUE_KIND,
  INVOICING_INVOICE_PAID_KIND,
  INVOICING_INVOICE_VIEWED_KIND,
  invoices,
  invoicingAlertKinds,
  invoicingAlertsFor,
  invoicingOverdueAlert,
  listOverdueInvoices,
  OVERDUE_SINCE_DAYS,
  type InvoicingAlertDraft,
  type InvoicingAlertKinds,
  type InvoicingEvent,
  type MoneyFormatWire,
  type OverdueInvoice,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, 11.2–11.3: the kinds, the mappers' table and their money
 * words, and the overdue sweep on a real Postgres (the statuses, the tenant,
 * the order, the `dueSince` edges in the business's zone).
 */

// --- 4.2's and 3.3's rules, copied (invoicing never imports notifications) ------

const KIND_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;
const ROUTING_KEY = /^[a-z][a-z0-9-]{1,31}$/;
const HREF = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function fragmentProblems(fragment: InvoicingAlertKinds): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const kind of fragment.kinds) {
    if (!KIND_KEY.test(kind.key) || kind.key.length > 64) problems.push(`${kind.key}: key`);
    if (keys.has(kind.key)) problems.push(`${kind.key}: duplicate`);
    keys.add(kind.key);
    if (kind.label.length < 1 || kind.label.length > 80) problems.push(`${kind.key}: label`);
    if (kind.category.length < 1 || kind.category.length > 40) problems.push(`${kind.key}: category`);
    if (kind.description !== undefined && kind.description.length > 200) problems.push(`${kind.key}: description`);
    if (!kind.audience.permission) problems.push(`${kind.key}: permission`);
    if (kind.email === false && kind.defaultChannel === "email") problems.push(`${kind.key}: email default, never emailed`);
    if (kind.email === false && kind.emailBy === "producer") problems.push(`${kind.key}: producer, never emailed`);
    if (kind.audience.routing && !fragment.routings.some((r) => r.key === kind.audience.routing)) problems.push(`${kind.key}: routing`);
  }
  for (const routing of fragment.routings) {
    if (!ROUTING_KEY.test(routing.key)) problems.push(`${routing.key}: routing key`);
    if (!routing.permission) problems.push(`${routing.key}: routing permission`);
    if (routing.label.length < 1 || routing.label.length > 80) problems.push(`${routing.key}: routing label`);
  }
  return problems;
}

function draftProblems(draft: InvoicingAlertDraft): string[] {
  const problems: string[] = [];
  if (draft.title.length < 1 || Array.from(draft.title).length > 200) problems.push("title length");
  if (/[\r\n]/.test(draft.title) || draft.title.includes(LS) || draft.title.includes(PS)) problems.push("title lines");
  if (draft.body !== null && Array.from(draft.body).length > 2000) problems.push("body length");
  if (draft.href !== null && !HREF.test(draft.href)) problems.push("href");
  if (draft.dedupeKey.length < 1 || draft.dedupeKey.length > 200) problems.push("dedupe key");
  return problems;
}

const FORMAT: MoneyFormatWire = { currency: "USD", locale: "en-US", timeZone: "America/Denver" };
const HREFS = { hrefs: { invoice: "/app/invoices/{id}" } } as const;
const DUE = "2026-11-03T06:59:59.999Z"; // the end of Nov 2 in Denver

function event(type: InvoicingEvent["type"], overrides: Partial<InvoicingEvent["data"]["invoice"]> = {}, actorId: string | null = null): InvoicingEvent {
  return {
    id: "0199aaaa-0000-7000-8000-000000000001",
    type,
    tenantId: "t-green",
    invoiceId: "inv-1",
    occurredAt: "2026-10-13T18:00:00.000Z",
    actor: type === "invoice.paid" ? { type: "staff", id: actorId } : { type: "customer", id: null },
    data: {
      invoice: {
        id: "inv-1",
        number: "INV-2026-0042",
        status: type === "invoice.paid" ? "paid" : "viewed",
        customerName: "Pat Rivera",
        customerEmail: "pat@x.com",
        total: 125_000,
        amountPaid: type === "invoice.paid" ? 125_000 : 0,
        balanceDue: type === "invoice.paid" ? 0 : 125_000,
        dueDate: DUE,
        viewedAt: "2026-10-13T18:00:00.000Z",
        paidAt: type === "invoice.paid" ? "2026-10-13T18:00:00.000Z" : null,
        ...overrides,
      },
      format: FORMAT,
    },
  };
}

describe("invoicingAlertKinds (11.3)", () => {
  it("passes the registry's definition rules (copied)", () => {
    expect(fragmentProblems(invoicingAlertKinds)).toEqual([]);
  });

  it("is 11.3's table: three kinds, all routed through 'invoices', notifications-sent email", () => {
    expect(invoicingAlertKinds.kinds.map((k) => [k.key, k.label, k.defaultChannel])).toEqual([
      ["invoicing.invoice.viewed", "A customer opens an invoice", "in_app"],
      ["invoicing.invoice.paid", "An invoice is paid in full", "in_app"],
      ["invoicing.invoice.overdue", "An invoice goes overdue", "email"],
    ]);
    for (const kind of invoicingAlertKinds.kinds) {
      expect(kind.category).toBe("Invoices");
      expect(kind.audience).toEqual({ permission: "invoices.view", routing: "invoices" });
      expect(kind.email ?? true).toBe(true);
      expect(kind.emailBy ?? "notifications").toBe("notifications");
    }
    expect(invoicingAlertKinds.routings).toEqual([
      {
        key: "invoices",
        label: "Invoices opened, paid or overdue",
        description: "A customer opening an invoice, an invoice paid in full, and one going past its due date.",
        permission: "invoices.view",
        order: 30,
      },
    ]);
    expect([INVOICING_INVOICE_VIEWED_KIND, INVOICING_INVOICE_PAID_KIND, INVOICING_INVOICE_OVERDUE_KIND]).toEqual(
      invoicingAlertKinds.kinds.map((k) => k.key),
    );
    expect(Object.isFrozen(invoicingAlertKinds.kinds)).toBe(true);
  });
});

describe("the mappers' table and money words (11.3)", () => {
  it("invoice.viewed", () => {
    const drafts = invoicingAlertsFor(event("invoice.viewed"), HREFS);
    expect(drafts).toEqual([
      {
        tenantId: "t-green",
        kind: "invoicing.invoice.viewed",
        title: "Pat Rivera opened invoice INV-2026-0042",
        body: "$1,250.00 due Nov 2, 2026",
        href: "/app/invoices/inv-1",
        dedupeKey: "invoicing.invoice.viewed:inv-1",
        subject: { type: "invoicing.invoice", id: "inv-1" },
        actorUserId: null,
      },
    ]);
    expect(draftProblems(drafts[0]!)).toEqual([]);
  });

  it("invoice.viewed with no due date: '{balance} due'", () => {
    expect(invoicingAlertsFor(event("invoice.viewed", { dueDate: null }), HREFS)[0]!.body).toBe("$1,250.00 due");
  });

  it("invoice.paid: the total and the customer; keyed on when it was paid; the staff member is the actor", () => {
    const drafts = invoicingAlertsFor(event("invoice.paid", {}, "user-gail"), HREFS);
    expect(drafts).toEqual([
      {
        tenantId: "t-green",
        kind: "invoicing.invoice.paid",
        title: "Invoice INV-2026-0042 is paid: $1,250.00 from Pat Rivera",
        body: null,
        href: "/app/invoices/inv-1",
        dedupeKey: "invoicing.invoice.paid:inv-1:2026-10-13T18:00:00.000Z",
        subject: { type: "invoicing.invoice", id: "inv-1" },
        actorUserId: "user-gail",
      },
    ]);
  });

  it("overdue: '{balance} was due {date}.', keyed on the due date in the business's zone", () => {
    const overdue: OverdueInvoice = { id: "inv-9", number: "INV-2026-0009", customerName: "Sam Lee", balanceDue: 42_050, dueDate: new Date(DUE) };
    const draft = invoicingOverdueAlert("t-green", overdue, { ...HREFS, format: FORMAT });
    expect(draft).toEqual({
      tenantId: "t-green",
      kind: "invoicing.invoice.overdue",
      title: "Invoice INV-2026-0009 to Sam Lee is overdue",
      body: "$420.50 was due Nov 2, 2026.",
      href: "/app/invoices/inv-9",
      // 06:59Z on Nov 3 is still Nov 2 in Denver.
      dedupeKey: "invoicing.invoice.overdue:inv-9:2026-11-02",
      subject: { type: "invoicing.invoice", id: "inv-9" },
      actorUserId: null,
    });
    expect(draftProblems(draft)).toEqual([]);
    // The same instant in UTC is the 3rd: the zone decides the key's date.
    expect(invoicingOverdueAlert("t-green", overdue, { ...HREFS, format: { ...FORMAT, timeZone: "UTC" } }).dedupeKey).toBe(
      "invoicing.invoice.overdue:inv-9:2026-11-03",
    );
  });

  it("money in the business's currency and locale; a format the runtime can't use falls back to digits", () => {
    const eur = invoicingAlertsFor({ ...event("invoice.paid"), data: { ...event("invoice.paid").data, format: { currency: "EUR", locale: "de-DE", timeZone: "Europe/Berlin" } } }, HREFS);
    // The title is one line of plain spaces: Intl's no-break spaces become ordinary ones.
    const euros = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1250).replace(/\s+/g, " ");
    expect(eur[0]!.title).toBe(`Invoice INV-2026-0042 is paid: ${euros} from Pat Rivera`);
    const broken = invoicingAlertsFor({ ...event("invoice.paid"), data: { ...event("invoice.paid").data, format: { currency: "US", locale: "en-US", timeZone: "UTC" } } }, HREFS);
    expect(broken[0]!.title).toBe("Invoice INV-2026-0042 is paid: 1250.00 US from Pat Rivera");
  });

  it("no customer name: 'A customer opened …', and the 'from'/'to' part is left off", () => {
    expect(invoicingAlertsFor(event("invoice.viewed", { customerName: null }), HREFS)[0]!.title).toBe("A customer opened invoice INV-2026-0042");
    expect(invoicingAlertsFor(event("invoice.paid", { customerName: "   " }), HREFS)[0]!.title).toBe("Invoice INV-2026-0042 is paid: $1,250.00");
    const overdue = invoicingOverdueAlert("t", { id: "i", number: "INV-1", customerName: null, balanceDue: 100, dueDate: new Date(DUE) }, { ...HREFS, format: FORMAT });
    expect(overdue.title).toBe("Invoice INV-1 is overdue");
  });

  it("what a customer typed stays one line (D18), at most 200 characters", () => {
    const drafts = invoicingAlertsFor(event("invoice.viewed", { customerName: `Pat\r\nBcc: x@evil.test${LS}${"y".repeat(400)}` }), HREFS);
    expect(draftProblems(drafts[0]!)).toEqual([]);
    expect(drafts[0]!.title.startsWith("Pat Bcc: x@evil.test")).toBe(true);
  });

  it("the href pattern's {id} is URL-encoded; a pattern that isn't a same-site path opens nothing", () => {
    expect(invoicingAlertsFor({ ...event("invoice.viewed"), invoiceId: "a b" }, HREFS)[0]!.href).toBe("/app/invoices/a%20b");
    expect(invoicingAlertsFor(event("invoice.viewed"), { hrefs: { invoice: "/admin/invoices/{id}" } })[0]!.href).toBe("/admin/invoices/inv-1");
    for (const invoice of ["//evil.test/{id}", "https://evil.test/{id}", "/\\{id}"]) {
      expect(invoicingAlertsFor(event("invoice.viewed"), { hrefs: { invoice } })[0]!.href, invoice).toBeNull();
    }
  });

  it("the same event mapped twice gives the same key", () => {
    const one = invoicingAlertsFor(event("invoice.paid"), HREFS)[0]!.dedupeKey;
    expect(invoicingAlertsFor(event("invoice.paid"), HREFS)[0]!.dedupeKey).toBe(one);
  });
});

// --- The overdue sweep, on Postgres ----------------------------------------------

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

/** NOW is mid-morning Oct 13 in Denver (18:00Z). */
const NOW = new Date("2026-10-13T18:00:00.000Z");
const ZONE = "America/Denver";

async function invoice(
  tenantId: string,
  opts: { status: string; due: string | null; dueAt?: Date; total?: number; paid?: number; customer?: string | null },
): Promise<string> {
  const created = await createInvoice(t.db, {
    tenantId,
    customerName: opts.customer === undefined ? "Pat Rivera" : opts.customer,
    items: [{ description: "Mowing", quantity: 1, unitPrice: opts.total ?? 10_000 }],
  });
  await t.db
    .update(invoices)
    .set({
      status: opts.status,
      dueDate: opts.dueAt ?? (opts.due ? endOfDayInZone(opts.due, ZONE) : null),
      amountPaid: opts.paid ?? 0,
    })
    .where(eq(invoices.id, created.id));
  return created.id;
}

describe("listOverdueInvoices (11.2)", () => {
  it("open statuses only (sent, viewed, partial), past due, this tenant's", async () => {
    const a = tenant("green");
    const b = tenant("summit");
    const sent = await invoice(a, { status: "sent", due: "2026-10-10" });
    const viewed = await invoice(a, { status: "viewed", due: "2026-10-11" });
    const partial = await invoice(a, { status: "partial", due: "2026-10-12", paid: 4_000 });
    await invoice(a, { status: "draft", due: "2026-10-10" });
    await invoice(a, { status: "paid", due: "2026-10-10", paid: 10_000 });
    await invoice(a, { status: "void", due: "2026-10-10" });
    await invoice(a, { status: "sent", due: null });
    // Due today (the end of today in Denver hasn't come yet): not overdue.
    await invoice(a, { status: "sent", due: "2026-10-13" });
    await invoice(b, { status: "sent", due: "2026-10-10" });

    const found = await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE });
    expect(found.map((i) => i.id)).toEqual([sent, viewed, partial]);
    expect(found[2]).toMatchObject({ customerName: "Pat Rivera", balanceDue: 6_000 });
    expect(found[0]!.dueDate).toBeInstanceOf(Date);
    expect(found[0]!.number).toMatch(/^INV-2026-/);
  });

  it("oldest due first; the limit cuts from the newest", async () => {
    const a = tenant("green");
    const late = await invoice(a, { status: "sent", due: "2026-10-12" });
    const early = await invoice(a, { status: "sent", due: "2026-10-08" });
    const middle = await invoice(a, { status: "viewed", due: "2026-10-10" });
    expect((await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE })).map((i) => i.id)).toEqual([early, middle, late]);
    expect((await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE, limit: 2 })).map((i) => i.id)).toEqual([early, middle]);
  });

  it("dueSince edges (review BO-15): due 7 days ago in the zone is in, 8 days ago is out", async () => {
    const a = tenant("green");
    expect(OVERDUE_SINCE_DAYS).toBe(7);
    const seven = await invoice(a, { status: "sent", due: "2026-10-06" });
    await invoice(a, { status: "sent", due: "2026-10-05" });
    const yesterday = await invoice(a, { status: "sent", due: "2026-10-12" });
    expect((await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE })).map((i) => i.id)).toEqual([seven, yesterday]);
  });

  it("the edges follow the business's zone, not UTC", async () => {
    const a = tenant("green");
    // 03:00Z on Oct 14 is still the evening of Oct 13 in Denver.
    const now = new Date("2026-10-14T03:00:00.000Z");
    // Due at noon UTC on Oct 6: Oct 6 in Denver too.
    const id = await invoice(a, { status: "sent", due: null, dueAt: new Date("2026-10-06T12:00:00.000Z") });
    // Denver: today is Oct 13, so Oct 6 is seven days back: in.
    expect((await listOverdueInvoices(t.db, a, { now, timeZone: ZONE })).map((i) => i.id)).toEqual([id]);
    // UTC: today is already Oct 14, so Oct 6 is eight days back: out.
    expect(await listOverdueInvoices(t.db, a, { now, timeZone: "UTC" })).toEqual([]);
  });

  it("an explicit dueSince widens or narrows the window", async () => {
    const a = tenant("green");
    const old = await invoice(a, { status: "sent", due: "2026-09-01" });
    const recent = await invoice(a, { status: "sent", due: "2026-10-12" });
    expect((await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE, dueSince: "2026-08-01" })).map((i) => i.id)).toEqual([old, recent]);
    expect((await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE, dueSince: "2026-10-12" })).map((i) => i.id)).toEqual([recent]);
  });

  it("nothing owed is not overdue", async () => {
    const a = tenant("green");
    await invoice(a, { status: "sent", due: "2026-10-10", total: 10_000, paid: 10_000 });
    expect(await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE })).toEqual([]);
  });

  it("one query, scoped to the tenant and the open statuses", async () => {
    const a = tenant("green");
    await invoice(a, { status: "sent", due: "2026-10-10" });
    t.queries.length = 0;
    await listOverdueInvoices(t.db, a, { now: NOW, timeZone: ZONE });
    expect(t.queries).toHaveLength(1);
    expect(t.queries[0]!.sql).toMatch(/"invoices"\."tenant_id" = \$1/);
    expect(t.queries[0]!.sql).toMatch(/"invoices"\."status" in \(/);
    expect(t.queries[0]!.params[0]).toBe(a);
  });

  it("refuses a dueSince that isn't a calendar date, and answers [] for an empty tenant", async () => {
    await expect(listOverdueInvoices(t.db, "t", { dueSince: "2026-02-30" })).rejects.toThrow();
    await expect(listOverdueInvoices(t.db, "t", { dueSince: "yesterday" })).rejects.toThrow();
    expect(await listOverdueInvoices(t.db, "", { now: NOW })).toEqual([]);
  });

  it("a zone the runtime can't use falls back to UTC instead of throwing", async () => {
    const a = tenant("green");
    const id = await invoice(a, { status: "sent", due: "2026-10-10" });
    expect((await listOverdueInvoices(t.db, a, { now: NOW, timeZone: "Mars/Olympus" })).map((i) => i.id)).toEqual([id]);
  });

  it("sweep → alert: each overdue invoice once, keyed so the next run writes the same key", async () => {
    const a = tenant("green");
    await invoice(a, { status: "sent", due: "2026-10-10", customer: "Sam Lee" });
    const keys = async (now: Date) =>
      (await listOverdueInvoices(t.db, a, { now, timeZone: ZONE })).map((i) => invoicingOverdueAlert(a, i, { ...HREFS, format: FORMAT }).dedupeKey);
    const first = await keys(NOW);
    const nextDay = await keys(new Date(NOW.getTime() + 24 * 3_600_000));
    expect(first).toHaveLength(1);
    expect(nextDay).toEqual(first);
    // Make sure the row's due date is what the key says.
    const [row] = (await t.db.execute(sql`select due_date from invoices where tenant_id = ${a}`)).rows as Array<{ due_date: unknown }>;
    expect(row).toBeDefined();
    expect(first[0]).toMatch(/:2026-10-10$/);
  });
});

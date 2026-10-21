import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInvoice,
  createInvoicingAdminHandlers,
  createInvoicingHandlers,
  invoicePayments,
  invoices,
  invoicingAlertsFor,
  invoicingPermissions,
  recordPayment,
  type InvoiceDetailWire,
  type InvoicingEvent,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * PAST RECORDS WITH THEIR REAL DATES (invoicing 0.7): an invoice issued on
 * an earlier day is saved as issued that day (its number that year's, due
 * from that day, nobody emailed) and records when and by whom it was
 * entered; a past payment keeps the day it was paid beside the day it was
 * entered. Future dates, dates before 2000 and a payment before its invoice
 * are refused, naming the field. Their events carry the real day and raise
 * no alert. No customer route takes a date.
 */

const NOW = new Date("2026-10-20T15:00:00.000Z");
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const LINES = [{ description: "Gutter clean", quantity: 1, unitPrice: 20_000 }];

async function issuesOf(p: Promise<unknown>): Promise<{ path: (string | number)[]; message: string }[]> {
  try {
    await p;
  } catch (error) {
    return ((error as { issues?: { path: (string | number)[]; message: string }[] }).issues ?? []).map((i) => ({ path: i.path, message: i.message }));
  }
  throw new Error("expected a refusal");
}

describe("createInvoice with issuedAt, recordPayment with paidAt", () => {
  it("an invoice issued on a past day is sent that day, numbered that year, and says when it was entered", async () => {
    const tenantId = tenant();
    const made = await createInvoice(t.db, { tenantId, customerName: "Pat Lee", items: LINES }, "u-sam", { now: NOW, issuedAt: "2025-04-02" });
    expect(made.invoiceNumber).toMatch(/^INV-2025-/);
    const [row] = await t.db.select().from(invoices).where(eq(invoices.id, made.id));
    expect(row).toMatchObject({ status: "sent", enteredBy: "u-sam" });
    expect(row!.createdAt.toISOString()).toBe("2025-04-02T12:00:00.000Z");
    expect(row!.sentAt?.toISOString()).toBe("2025-04-02T12:00:00.000Z");
    expect(row!.enteredAt?.toISOString()).toBe(NOW.toISOString());

    const paid = await recordPayment(t.db, { tenantId, invoiceId: made.id, amount: 20_000, method: "check" }, "u-sam", { now: NOW, paidAt: "2025-04-20" });
    expect(paid?.status).toBe("paid");
    const [payment] = await t.db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, made.id));
    expect(payment!.paidAt.toISOString()).toBe("2025-04-20T12:00:00.000Z");
    expect(payment!.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(payment!.recordedBy).toBe("u-sam");
    const [after] = await t.db.select().from(invoices).where(eq(invoices.id, made.id));
    expect(after!.paidAt?.toISOString()).toBe("2025-04-20T12:00:00.000Z");
  });

  it("refuses a future day, one before 2000, and a payment before its invoice; another company's invoice isn't found", async () => {
    const tenantId = tenant();
    expect(await issuesOf(createInvoice(t.db, { tenantId, items: LINES }, "u", { now: NOW, issuedAt: "2026-12-01" }))).toEqual([
      { path: ["issuedAt"], message: "That date is in the future. Enter the day it really happened." },
    ]);
    expect(await issuesOf(createInvoice(t.db, { tenantId, items: LINES }, "u", { now: NOW, issuedAt: "1998-05-01" }))).toEqual([
      { path: ["issuedAt"], message: "That date is before 2000. Check the year." },
    ]);
    const made = await createInvoice(t.db, { tenantId, items: LINES }, "u", { now: NOW, issuedAt: "2025-04-02" });
    expect(await issuesOf(recordPayment(t.db, { tenantId, invoiceId: made.id, amount: 100, method: "cash" }, "u", { now: NOW, paidAt: "2025-03-30" }))).toEqual([
      { path: ["paidAt"], message: "That's before the invoice was issued (2025-04-02)." },
    ]);
    expect(await recordPayment(t.db, { tenantId: tenant(), invoiceId: made.id, amount: 100, method: "cash" }, "u", { now: NOW, paidAt: "2025-04-10" })).toBeNull();
    expect(await t.db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, made.id))).toEqual([]);
  });
});

describe("the staff routes take past dates; their events carry them and alert nobody", () => {
  it("POST invoices with issuedAt, POST payments with paidAt", async () => {
    const tenantId = tenant();
    const events: InvoicingEvent[] = [];
    const staff = createInvoicingAdminHandlers({
      db: t.db,
      tenantId,
      authorize: () => ({ userId: "u-sam" }),
      invoiceUrl: (token) => `https://app.test/invoice/${token}`,
      onEvent: (e) => void events.push(e),
      now: () => NOW,
    });
    const post = (path: string, body: unknown) =>
      staff.handle(
        new Request(`https://app.test/api/invoices/v1/admin/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
          body: JSON.stringify(body),
        }),
      );
    const created = await post("invoices", { customerName: "Pat Lee", items: LINES, issuedAt: "2025-04-02" });
    expect(created.status).toBe(201);
    const invoice = ((await created.json()) as { invoice: { id: string; storedStatus: string; createdAt: string } }).invoice;
    expect(invoice).toMatchObject({ storedStatus: "sent", createdAt: "2025-04-02T12:00:00.000Z" });
    const future = await post(`invoices/${invoice.id}/payments`, { amount: 20_000, method: "check", paidAt: "2027-01-01" });
    expect(future.status).toBe(400);
    const paid = await post(`invoices/${invoice.id}/payments`, { amount: 20_000, method: "check", paidAt: "2025-04-20" });
    expect(paid.status).toBe(200);
    expect(events.map((e) => [e.type, e.occurredAt, e.enteredLater])).toEqual([
      ["invoice.created", "2025-04-02T12:00:00.000Z", true],
      ["invoice.paid", "2025-04-20T12:00:00.000Z", true],
    ]);
    // History, not news: no alert for either.
    for (const event of events) expect(invoicingAlertsFor(event, { hrefs: { invoice: "/app/invoices/{id}" } })).toEqual([]);
    const live = { ...events[1]!, enteredLater: undefined };
    expect(invoicingAlertsFor(live as InvoicingEvent, { hrefs: { invoice: "/app/invoices/{id}" } })).toHaveLength(1);
  });

  it("a customer's request can't carry a date anywhere it lands", async () => {
    const tenantId = tenant();
    const made = await createInvoice(t.db, { tenantId, items: LINES }, "u", { now: NOW });
    const [row] = await t.db.select().from(invoices).where(and(eq(invoices.id, made.id), eq(invoices.tenantId, tenantId)));
    const customer = createInvoicingHandlers({ db: t.db, tenantId, now: () => NOW });
    // The customer's page is read-only apart from paying online; a date in the query or body changes nothing.
    const res = await customer.handle(new Request(`https://app.test/api/invoices/v1/invoices/${row!.viewToken}?paidAt=2024-01-01`));
    expect([200, 404]).toContain(res.status);
    const [after] = await t.db.select().from(invoices).where(eq(invoices.id, made.id));
    expect(after!.paidAt).toBeNull();
    expect(after!.createdAt.toISOString()).toBe(NOW.toISOString());
  });
});

function staffHandlers(tenantId: string, allow: (permission: string) => boolean, extra: Record<string, unknown> = {}) {
  const staff = createInvoicingAdminHandlers({
    db: t.db,
    tenantId,
    authorize: (_req, permission) => (allow(permission) ? { userId: "u-sam" } : false),
    invoiceUrl: (token) => `https://app.test/invoice/${token}`,
    now: () => NOW,
    ...extra,
  });
  const call = (method: string, path: string, body?: unknown) =>
    staff.handle(
      new Request(`https://app.test/api/invoices/v1/admin/${path}`, {
        method,
        headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { post: (path: string, body: unknown) => call("POST", path, body), get: (path: string) => call("GET", path) };
}

describe("a past date needs its own permission (review: anyone who records payments could back-date them)", () => {
  const noHistory = (permission: string) => permission !== "invoices.history";

  it("without invoices.history: a dated invoice and a dated payment are refused, nothing is written", async () => {
    const tenantId = tenant();
    const { post } = staffHandlers(tenantId, noHistory);
    const dated = await post("invoices", { customerName: "Pat Lee", items: LINES, issuedAt: "2025-04-02" });
    expect(dated.status).toBe(403);
    expect(((await dated.json()) as { error: { message: string } }).error.message).toBe(
      "Giving a past date needs the \u201cEnter past records\u201d permission. Leave the date out to record it as today, or ask the owner.",
    );
    expect(await t.db.select().from(invoices).where(eq(invoices.tenantId, tenantId))).toEqual([]);
    // NEGATIVE CONTROL: the same person raises the same invoice for today, and records a payment for today.
    const today = await post("invoices", { customerName: "Pat Lee", items: LINES });
    expect(today.status).toBe(201);
    const id = ((await today.json()) as { invoice: { id: string } }).invoice.id;
    await post(`invoices/${id}/status`, { status: "sent" });
    expect((await post(`invoices/${id}/payments`, { amount: 100, method: "cash", paidAt: "2026-10-19" })).status).toBe(403);
    expect(await t.db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, id))).toEqual([]);
    expect((await post(`invoices/${id}/payments`, { amount: 100, method: "cash" })).status).toBe(200);
  });

  it("the key is the owner's and an admin's by default, not a member's", () => {
    expect(invoicingPermissions["invoices.history"].defaultFor).toEqual(["owner", "admin"]);
    expect(invoicingPermissions["invoices.payments.record"].defaultFor).toContain("member");
  });
});

describe("the screens say a record was entered later (review: only created_at and recorded_by knew)", () => {
  it("the invoice and its payment carry enteredLater; today's don't", async () => {
    const tenantId = tenant();
    const { post, get } = staffHandlers(tenantId, () => true);
    const created = await post("invoices", { customerName: "Pat Lee", items: LINES, issuedAt: "2025-04-02" });
    const id = ((await created.json()) as { invoice: { id: string } }).invoice.id;
    await post(`invoices/${id}/payments`, { amount: 5_000, method: "check", paidAt: "2025-04-20" });
    await post(`invoices/${id}/payments`, { amount: 5_000, method: "cash" });
    const detail = ((await (await get(`invoices/${id}`)).json()) as { invoice: InvoiceDetailWire }).invoice;
    expect(detail.enteredLater).toEqual({ at: NOW.toISOString(), by: "u-sam" });
    // Money taken today is recorded on the ledger's own clock: nothing "entered later" about it.
    expect(detail.payments.map((p) => [p.method, p.enteredLater ?? null])).toEqual([
      ["check", { at: NOW.toISOString(), by: "u-sam" }],
      ["cash", null],
    ]);
    // NEGATIVE CONTROL: an invoice raised today says nothing about past records.
    const fresh = await post("invoices", { customerName: "Jo", items: LINES });
    const freshId = ((await fresh.json()) as { invoice: { id: string } }).invoice.id;
    expect(((await (await get(`invoices/${freshId}`)).json()) as { invoice: InvoiceDetailWire }).invoice.enteredLater).toBeNull();
  });
});

describe("a day is the business's day (review: '2025-06-14' was saved as UTC midnight, shown a day early in Denver)", () => {
  const dayIn = (instant: Date | string, timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
  const business = (timeZone: string) => () => ({
    name: "Acme",
    timeZone,
    contactEmail: null,
    contactPhone: null,
    logoUrl: null,
    brandColor: null,
    paymentInstructions: null,
    dueDays: 14,
    footer: null,
  });

  it("America/Denver: issued the 14th and paid the 20th read the 14th and the 20th there", async () => {
    const tenantId = tenant();
    const { post } = staffHandlers(tenantId, () => true, { business: business("America/Denver") });
    const created = await post("invoices", { customerName: "Pat", items: LINES, issuedAt: "2025-01-01" });
    const invoice = ((await created.json()) as { invoice: InvoiceDetailWire }).invoice;
    expect(invoice.number).toMatch(/^INV-2025-/);
    expect(dayIn(invoice.createdAt, "America/Denver")).toBe("2025-01-01");
    const paid = await post(`invoices/${invoice.id}/payments`, { amount: 20_000, method: "check", paidAt: "2025-06-20" });
    const after = ((await paid.json()) as { invoice: InvoiceDetailWire }).invoice;
    expect(dayIn(after.payments[0]!.paidAt, "America/Denver")).toBe("2025-06-20");
    // NEGATIVE CONTROL: the old reading (UTC midnight) shows the day before in Denver.
    expect(dayIn("2025-06-20T00:00:00.000Z", "America/Denver")).toBe("2025-06-19");
  });

  it("Asia/Tokyo: today's date in the Tokyo morning is today, not 'in the future'", async () => {
    const tenantId = tenant();
    const morning = new Date("2026-10-20T23:30:00Z"); // 08:30 on the 21st in Tokyo
    const made = await createInvoice(t.db, { tenantId, customerName: "Pat", items: LINES }, "u-sam", { now: morning, issuedAt: "2026-10-21", timeZone: "Asia/Tokyo" });
    const [row] = await t.db.select().from(invoices).where(eq(invoices.id, made.id));
    expect(dayIn(row!.createdAt, "Asia/Tokyo")).toBe("2026-10-21");
    expect(row!.createdAt.getTime()).toBeLessThanOrEqual(morning.getTime());
    // NEGATIVE CONTROL: read in UTC, the same day is tomorrow, and refused.
    expect(await issuesOf(createInvoice(t.db, { tenantId, items: LINES }, "u", { now: morning, issuedAt: "2026-10-21" }))).toEqual([
      { path: ["issuedAt"], message: "That date is in the future. Enter the day it really happened." },
    ]);
  });
});

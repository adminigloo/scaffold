import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInvoicingAdminHandlers,
  createInvoicingHandlers,
  invoices,
  invoicingAlertsFor,
  invoicingPermissions,
  type InvoicingBusiness,
  type InvoicingEvent,
  type InvoicingPermission,
} from "../index.js";
import type { InvoiceResponse } from "../wire.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Tenancy 2b-1, 11.1, on a real Postgres: `invoice.viewed` on the first view
 * only, `invoice.paid` only on the payment that settles it, both after
 * commit, awaited before the answer, contained, with no token in them.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ALL = Object.keys(invoicingPermissions) as InvoicingPermission[];
const NOW = new Date("2026-10-13T18:00:00.000Z");
const GREEN: InvoicingBusiness = {
  name: "Green Acres",
  timeZone: "America/Denver",
  contactEmail: "gail@greenacres.test",
  contactPhone: null,
  logoUrl: null,
  brandColor: null,
  paymentInstructions: "Pay by check.",
  dueDays: 10,
  footer: null,
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Recorder {
  readonly events: InvoicingEvent[];
  readonly errors: Array<{ error: unknown; event: InvoicingEvent }>;
  onEvent: (event: InvoicingEvent) => void | Promise<void>;
  onEventError: (error: unknown, event: InvoicingEvent) => void;
}

function recorder(listener?: (event: InvoicingEvent) => void | Promise<void>): Recorder {
  const events: InvoicingEvent[] = [];
  const errors: Recorder["errors"] = [];
  return {
    events,
    errors,
    onEvent: async (event) => {
      events.push(event);
      await listener?.(event);
    },
    onEventError: (error, event) => void errors.push({ error, event }),
  };
}

function staff(tenantId: string, rec: Recorder | null, onError?: (error: unknown) => void) {
  const h = createInvoicingAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, permission, id) => (id === tenantId && ALL.includes(permission) ? { userId: "user-gail" } : false),
    business: (id) => (id === tenantId ? GREEN : null),
    invoiceUrl: (token, id) => `https://app.test/t/${id}/invoice/${token}`,
    now: () => NOW,
    ...(rec ? { onEvent: rec.onEvent, onEventError: rec.onEventError } : {}),
    ...(onError ? { onError } : {}),
  });
  return (path: string, method: "GET" | "POST" = "GET", body?: unknown) =>
    h.handle(
      new Request(`https://app.test/api/app/${tenantId}/invoices/${path}`, {
        method,
        headers: { "sec-fetch-site": "same-origin", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      }),
    );
}

function page(tenantId: string, rec: Recorder | null) {
  const h = createInvoicingHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/t\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    business: (id) => (id === tenantId ? GREEN : null),
    now: () => NOW,
    ...(rec ? { onEvent: rec.onEvent, onEventError: rec.onEventError } : {}),
  });
  return (asTenant: string, path: string, method: "GET" | "POST" = "GET") =>
    h.handle(
      new Request(`https://app.test/api/t/${asTenant}/invoices/${path}`, {
        method,
        headers: { "sec-fetch-site": "same-origin" },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
    );
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A sent invoice of $250.00 for Pat, due Nov 2 (Denver). */
async function sentInvoice(tenantId: string, opts: { send?: boolean } = {}) {
  const call = staff(tenantId, null);
  const res = await call("v1/admin/invoices", "POST", {
    customerName: "Pat Customer",
    customerEmail: "pat@example.com",
    dueDate: "2026-11-02",
    items: [{ description: "Spring cleanup", quantity: 2, unitPrice: 12_500 }],
  });
  expect(res.status).toBe(201);
  const inv = (await json<InvoiceResponse>(res)).invoice;
  if (opts.send !== false) expect((await call(`v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" })).status).toBe(200);
  const [row] = await t.db.select({ token: invoices.viewToken }).from(invoices).where(eq(invoices.id, inv.id));
  return { id: inv.id, number: inv.number, token: (row as { token: string }).token };
}

describe("invoice.viewed (11.1)", () => {
  it("fires once, on the first view, as the customer, with the invoice after the change and the business's format", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const rec = recorder();
    const open = page(a, rec);
    expect(await json(await open(a, `v1/invoice/${inv.token}/viewed`, "POST"))).toEqual({ viewed: true });
    expect(rec.events).toHaveLength(1);
    const event = rec.events[0]!;
    expect(event).toMatchObject({
      type: "invoice.viewed",
      tenantId: a,
      invoiceId: inv.id,
      occurredAt: NOW.toISOString(),
      actor: { type: "customer", id: null },
      data: {
        invoice: {
          id: inv.id,
          number: inv.number,
          status: "viewed",
          customerName: "Pat Customer",
          customerEmail: "pat@example.com",
          total: 25_000,
          amountPaid: 0,
          balanceDue: 25_000,
          dueDate: "2026-11-03T06:59:59.999Z",
          paidAt: null,
        },
        format: { currency: "USD", locale: "en-US", timeZone: "America/Denver" },
      },
    });
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(event.data.invoice.viewedAt).not.toBeNull();
    // No token in an event, anywhere.
    expect(JSON.stringify(event)).not.toContain(inv.token);

    // A second view: no event.
    expect(await json(await open(a, `v1/invoice/${inv.token}/viewed`, "POST"))).toEqual({ viewed: false });
    expect(rec.events).toHaveLength(1);
  });

  it("a preview (the GET the business's own link makes) and a draft tell nobody", async () => {
    const a = tenant("green");
    const sent = await sentInvoice(a);
    const draft = await sentInvoice(a, { send: false });
    const rec = recorder();
    const open = page(a, rec);
    expect((await open(a, `v1/invoice/${sent.token}`)).status).toBe(200);
    expect((await open(a, `v1/invoice/${sent.token}?preview=1`)).status).toBe(200);
    expect((await open(a, `v1/invoice/${draft.token}/viewed`, "POST")).status).toBe(404);
    expect(rec.events).toEqual([]);
  });

  it("another company's token under this company's address tells nobody", async () => {
    const a = tenant("green");
    const b = tenant("summit");
    const inv = await sentInvoice(a);
    const rec = recorder();
    expect((await page(b, rec)(b, `v1/invoice/${inv.token}/viewed`, "POST")).status).toBe(404);
    expect(rec.events).toEqual([]);
  });

  it("is awaited before the answer: a slow listener's write is visible when the page hears back", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const written: string[] = [];
    const rec = recorder(async (event) => {
      await sleep(40);
      written.push(event.invoiceId);
    });
    await page(a, rec)(a, `v1/invoice/${inv.token}/viewed`, "POST");
    expect(written).toEqual([inv.id]);
  });

  it("is told AFTER commit: the listener reads the invoice as viewed", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const seen: string[] = [];
    const rec = recorder(async () => {
      const [row] = await t.db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv.id));
      seen.push((row as { status: string }).status);
    });
    await page(a, rec)(a, `v1/invoice/${inv.token}/viewed`, "POST");
    expect(seen).toEqual(["viewed"]);
  });

  it("is contained: a throwing listener goes to onEventError and the customer's answer is unchanged", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const rec = recorder(() => {
      throw new Error("alerts are down");
    });
    const res = await page(a, rec)(a, `v1/invoice/${inv.token}/viewed`, "POST");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ viewed: true });
    expect(rec.errors.map((e) => (e.error as Error).message)).toEqual(["alerts are down"]);
    expect(rec.errors[0]!.event.type).toBe("invoice.viewed");
  });

  it("a business seam that throws is reported and the event still carries a usable format", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const rec = recorder();
    const reported: unknown[] = [];
    const h = createInvoicingHandlers({
      db: t.db,
      resolveTenant: () => a,
      business: () => {
        throw new Error("profile read failed");
      },
      onError: (error) => void reported.push(error),
      onEvent: rec.onEvent,
    });
    await h.handle(new Request(`https://app.test/api/t/${a}/invoices/v1/invoice/${inv.token}/viewed`, { method: "POST", body: "{}", headers: { "sec-fetch-site": "same-origin" } }));
    expect(rec.events[0]?.data.format).toEqual({ currency: "USD", locale: "en-US", timeZone: "UTC" });
    expect(reported).toHaveLength(1);
  });
});

describe("invoice.paid (11.1)", () => {
  it("only on the payment that settles it: a part payment tells nobody, the last one does, as the staff member", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const rec = recorder();
    const call = staff(a, rec);
    expect((await call(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 10_000, method: "check", reference: "1043" })).status).toBe(200);
    expect(rec.events).toEqual([]);
    const res = await call(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 15_000, method: "card" });
    expect((await json<InvoiceResponse>(res)).invoice.storedStatus).toBe("paid");
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]).toMatchObject({
      type: "invoice.paid",
      tenantId: a,
      invoiceId: inv.id,
      actor: { type: "staff", id: "user-gail" },
      data: { invoice: { status: "paid", total: 25_000, amountPaid: 25_000, balanceDue: 0 }, format: { currency: "USD" } },
    });
    expect(rec.events[0]!.data.invoice.paidAt).not.toBeNull();
    expect(JSON.stringify(rec.events[0])).not.toContain(inv.token);
  });

  it("the same payment sent again (a retried request) is refused and tells nobody a second time", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const rec = recorder();
    const call = staff(a, rec);
    expect((await call(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 25_000, method: "card", reference: "ch_1" })).status).toBe(200);
    const again = await call(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 25_000, method: "card", reference: "ch_1" });
    expect(again.status).toBe(409);
    expect(rec.events.map((e) => e.type)).toEqual(["invoice.paid"]);
  });

  it("a reversal and a new full payment is a new event, with a new paid time (and a new alert key)", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const rec = recorder();
    const call = staff(a, rec);
    const paid = await json<InvoiceResponse>(await call(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 25_000, method: "check" }));
    const payment = paid.invoice.payments[0]!;
    await sleep(5);
    const reversed = await call(`v1/admin/payments/${payment.id}/reverse`, "POST", { reason: "The check bounced." });
    expect(reversed.status).toBe(200);
    // A reversal itself is no `paid` event.
    expect(rec.events).toHaveLength(1);
    await sleep(5);
    await call(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 25_000, method: "card" });
    expect(rec.events).toHaveLength(2);
    const [first, second] = rec.events;
    expect(first!.data.invoice.paidAt).not.toBe(second!.data.invoice.paidAt);
    const key = (e: InvoicingEvent) => invoicingAlertsFor(e, { hrefs: { invoice: "/app/invoices/{id}" } })[0]!.dedupeKey;
    expect(key(first!)).not.toBe(key(second!));
  });

  it("a refused payment (a draft, a void invoice) tells nobody: a rolled-back write announces nothing", async () => {
    const a = tenant("green");
    const draft = await sentInvoice(a, { send: false });
    const voided = await sentInvoice(a);
    const rec = recorder();
    const call = staff(a, rec);
    expect((await call(`v1/admin/invoices/${draft.id}/payments`, "POST", { amount: 25_000, method: "cash" })).status).toBe(409);
    await call(`v1/admin/invoices/${voided.id}/status`, "POST", { status: "void" });
    expect((await call(`v1/admin/invoices/${voided.id}/payments`, "POST", { amount: 25_000, method: "cash" })).status).toBe(409);
    expect(rec.events).toEqual([]);
  });

  it("is awaited, after commit, and contained", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const seen: string[] = [];
    const rec = recorder(async () => {
      await sleep(30);
      const [row] = await t.db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv.id));
      seen.push((row as { status: string }).status);
      throw new Error("alerts are down");
    });
    const res = await staff(a, rec)(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 25_000, method: "card" });
    expect(res.status).toBe(200);
    expect((await json<InvoiceResponse>(res)).invoice.storedStatus).toBe("paid");
    expect(seen).toEqual(["paid"]);
    expect(rec.errors).toHaveLength(1);
  });

  it("without onEvent nothing extra is read", async () => {
    const a = tenant("green");
    const inv = await sentInvoice(a);
    const call = staff(a, null);
    t.queries.length = 0;
    await call(`v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 25_000, method: "card" });
    const withoutListener = t.queries.length;
    const b = tenant("green");
    const other = await sentInvoice(b);
    const callB = staff(b, recorder());
    t.queries.length = 0;
    await callB(`v1/admin/invoices/${other.id}/payments`, "POST", { amount: 25_000, method: "card" });
    // One read of the committed row for the event.
    expect(t.queries.length).toBe(withoutListener + 1);
  });
});

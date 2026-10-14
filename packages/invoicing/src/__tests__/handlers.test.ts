import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createInvoicingAdminHandlers,
  createInvoicingHandlers,
  getInvoiceByToken,
  invoices,
  invoicingPermissions,
  markInvoiceViewed,
  type CreateInvoicingAdminHandlersOptions,
  type InvoicingBusiness,
  type InvoicingPermission,
} from "../index.js";
import type {
  InvoiceListWire,
  InvoiceLinkWire,
  InvoiceResponse,
  InvoicingStatusWire,
  PublicInvoiceResponse,
  SendResponse,
} from "../wire.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The staff and public handlers (Tenancy 2a, 10.5) on a real Postgres: every
 * staff route behind its permission, the package's refusals as 409s with
 * their sentences, the due date worked out in the business's zone, Send's
 * outcomes, the link as the only route carrying the token, and the
 * customer's page scoped to the company the URL names (D13).
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
  contactPhone: "(801) 555-0100",
  logoUrl: "https://cdn.test/green.png",
  brandColor: "#1f7a3a",
  paymentInstructions: "Pay by check to Green Acres LLC.",
  dueDays: 10,
  footer: "Thanks for your business.",
};

function admin(member: string, grants: readonly InvoicingPermission[] = ALL, extra: Partial<CreateInvoicingAdminHandlersOptions> = {}) {
  const asked: string[] = [];
  const h = createInvoicingAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, permission, tenantId) => {
      asked.push(permission);
      if (tenantId !== member) return new Response(JSON.stringify({ error: { code: "forbidden", message: "You're not part of this company." } }), { status: 403 });
      return grants.includes(permission) ? { userId: "user-1" } : false;
    },
    business: (id) => (id === member ? GREEN : null),
    invoiceUrl: (token, id) => `https://app.test/t/${id}/invoice/${token}`,
    detailsHref: "/settings/company#invoicing",
    now: () => NOW,
    ...extra,
  });
  const call = (tenantId: string, path: string, method: "GET" | "POST" = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    h.handle(
      new Request(`https://app.test/api/app/${tenantId}/invoices/${path}`, {
        method,
        headers: { "sec-fetch-site": "same-origin", ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      }),
    );
  return { call, asked };
}

function customer(member: string, extra: Partial<Parameters<typeof createInvoicingHandlers>[0]> = {}) {
  const h = createInvoicingHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/t\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    business: (id) => (id === member ? GREEN : null),
    ...extra,
  });
  return (slugTenant: string, path: string, method: "GET" | "POST" = "GET") =>
    h.handle(
      new Request(`https://app.test/api/t/${slugTenant}/invoices/${path}`, {
        method,
        headers: { "sec-fetch-site": "same-origin" },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
    );
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function create(tenantId: string, body: Record<string, unknown> = {}) {
  const res = await admin(tenantId).call(tenantId, "v1/admin/invoices", "POST", {
    customerName: "Pat Customer",
    customerEmail: "pat@example.com",
    items: [{ description: "Spring cleanup", quantity: 2, unitPrice: 12_500 }],
    ...body,
  });
  expect(res.status).toBe(201);
  return (await json<InvoiceResponse>(res)).invoice;
}

async function tokenOf(id: string): Promise<string> {
  const [row] = await t.db.select({ token: invoices.viewToken }).from(invoices).where(eq(invoices.id, id));
  return (row as { token: string }).token;
}

describe("staff routes and permissions", () => {
  it("create: lines in cents, totals from the server, the end of the chosen day in the business's zone", async () => {
    const a = tenant();
    const inv = await create(a, { dueDate: "2026-11-02", taxRateBp: 825, discount: 1_000 });
    expect(inv).toMatchObject({
      status: "draft",
      storedStatus: "draft",
      subtotal: 25_000,
      discount: 1_000,
      taxRateBp: 825,
      taxAmount: 1_980,
      total: 25_980,
      balanceDue: 25_980,
      customerName: "Pat Customer",
      editable: true,
      nextStatuses: ["sent", "void"],
      can: { manage: true, record: true, reverse: true },
    });
    // 23:59:59.999 on Nov 2 in Denver (MST after Nov 1) is 06:59:59.999Z on Nov 3.
    expect(inv.dueDate).toBe("2026-11-03T06:59:59.999Z");
    expect(inv.lines).toEqual([{ id: expect.any(String), description: "Spring cleanup", quantity: 2, unitPrice: 12_500, total: 25_000 }]);
  });

  it("create without a date: today in the business's zone plus its usual days", async () => {
    const a = tenant();
    const inv = await create(a);
    // NOW is Oct 13 12:00 in Denver (MDT); +10 days = Oct 23, end of day MDT = Oct 24 05:59:59.999Z.
    expect(inv.dueDate).toBe("2026-10-24T05:59:59.999Z");
  });

  it("create refuses a missing customer name and a non-number on their fields", async () => {
    const a = tenant();
    const res = await admin(a).call(a, "v1/admin/invoices", "POST", { customerName: "", items: [{ description: "x", quantity: 1, unitPrice: "12" }] });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; issues: { path: (string | number)[] }[] } }>(res);
    expect(body.error.code).toBe("invalid");
    expect(body.error.issues.map((i) => i.path.join("."))).toEqual(expect.arrayContaining(["customerName", "items.0.unitPrice"]));
  });

  it("the package's refusals are 409s with their own sentences", async () => {
    const a = tenant();
    const res = await admin(a).call(a, "v1/admin/invoices", "POST", {
      customerName: "Pat",
      discount: 99_999,
      items: [{ description: "x", quantity: 1, unitPrice: 100 }],
    });
    expect(res.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("discount_exceeds_subtotal");
  });

  it("every route asks its permission; without it, 403", async () => {
    const a = tenant();
    const inv = await create(a);
    const none = admin(a, []);
    for (const [path, method] of [
      ["v1/admin/status", "GET"],
      ["v1/admin/invoices", "GET"],
      [`v1/admin/invoices/${inv.id}`, "GET"],
      [`v1/admin/invoices/${inv.id}/send`, "POST"],
      [`v1/admin/invoices/${inv.id}/link`, "GET"],
    ] as const) {
      const res = await none.call(a, path, method);
      expect(res.status, path).toBe(403);
      expect((await json<{ error: { message: string } }>(res)).error.message).toBe("You don't have permission to do that.");
    }
  });

  it("get's `can` comes from asking once more for each key, and only says what the person may do", async () => {
    const a = tenant();
    const inv = await create(a);
    const viewer = admin(a, ["invoices.view"]);
    const res = await viewer.call(a, `v1/admin/invoices/${inv.id}`);
    expect((await json<InvoiceResponse>(res)).invoice.can).toEqual({ manage: false, record: false, reverse: false });
    const member = admin(a, ["invoices.view", "invoices.manage", "invoices.payments.record"]);
    const res2 = await member.call(a, `v1/admin/invoices/${inv.id}`);
    expect((await json<InvoiceResponse>(res2)).invoice.can).toEqual({ manage: true, record: true, reverse: false });
  });

  it("lines: add, change (a replacement on a sent invoice), remove; the whole invoice comes back", async () => {
    const a = tenant();
    const inv = await create(a);
    const h = admin(a);
    const added = await json<InvoiceResponse>(await h.call(a, `v1/admin/invoices/${inv.id}/items`, "POST", { description: "Mulch", quantity: 3, unitPrice: 4_000 }));
    expect(added.invoice.subtotal).toBe(37_000);
    const mulch = added.invoice.lines.find((l) => l.description === "Mulch")!;
    await h.call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" });
    const changed = await json<InvoiceResponse>(await h.call(a, `v1/admin/items/${mulch.id}`, "POST", { quantity: 1 }));
    expect(changed.invoice.subtotal).toBe(29_000);
    const replaced = changed.invoice.lines.find((l) => l.description === "Mulch")!;
    expect(replaced.id).not.toBe(mulch.id);
    const removed = await json<InvoiceResponse>(await h.call(a, `v1/admin/items/${replaced.id}/remove`, "POST"));
    expect(removed.invoice.subtotal).toBe(25_000);
    expect((await h.call(a, `v1/admin/items/${mulch.id}`, "POST", { quantity: 2 })).status).toBe(404);
  });

  it("status moves follow the package's table; a forbidden move is a 409", async () => {
    const a = tenant();
    const inv = await create(a);
    const h = admin(a);
    const sent = await json<InvoiceResponse>(await h.call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" }));
    expect(sent.invoice.storedStatus).toBe("sent");
    const back = await h.call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "draft" });
    expect(back.status).toBe(409);
    expect((await json<{ error: { code: string } }>(back)).error.code).toBe("invalid_status_transition");
  });

  it("payments: record (the status follows the money), reverse with a reason, overpaid shown", async () => {
    const a = tenant();
    const inv = await create(a);
    const h = admin(a);
    const draftPay = await h.call(a, `v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 1_000, method: "cash" });
    expect(draftPay.status).toBe(409);
    expect((await json<{ error: { code: string; message: string } }>(draftPay)).error).toEqual({
      code: "payment_refused",
      message: "This invoice is still a draft. Send it first, then record the payment.",
    });
    await h.call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" });
    const part = await json<InvoiceResponse>(await h.call(a, `v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 10_000, method: "check", reference: "1043" }));
    expect(part.invoice).toMatchObject({ status: "partial", amountPaid: 10_000, balanceDue: 15_000 });
    const over = await json<InvoiceResponse>(await h.call(a, `v1/admin/invoices/${inv.id}/payments`, "POST", { amount: 20_000, method: "card" }));
    expect(over.invoice).toMatchObject({ status: "paid", amountPaid: 30_000, balanceDue: 0, overpaid: 5_000 });
    const card = over.invoice.payments.find((p) => p.method === "card")!;
    const noReason = await h.call(a, `v1/admin/payments/${card.id}/reverse`, "POST", { reason: "" });
    expect(noReason.status).toBe(400);
    const reversed = await json<InvoiceResponse>(await h.call(a, `v1/admin/payments/${card.id}/reverse`, "POST", { reason: "Card charged twice" }));
    expect(reversed.invoice).toMatchObject({ status: "partial", amountPaid: 10_000, overpaid: 0 });
    const original = reversed.invoice.payments.find((p) => p.id === card.id)!;
    expect(original.reversed).toBe(true);
    const reversal = reversed.invoice.payments.find((p) => p.reversesPaymentId === card.id)!;
    expect(reversal).toMatchObject({ amount: -20_000, reason: "Card charged twice" });
    const twice = await h.call(a, `v1/admin/payments/${card.id}/reverse`, "POST", { reason: "again" });
    expect(twice.status).toBe(409);
  });

  it("list: 50 a page, newest first, filters by status in SQL, with the business's money format", async () => {
    const a = tenant();
    for (let i = 0; i < 3; i++) await create(a, { customerName: `C${i}` });
    const h = admin(a);
    const list = await json<InvoiceListWire>(await h.call(a, "v1/admin/invoices"));
    expect(list.invoices.map((i) => i.customerName)).toEqual(["C2", "C1", "C0"]);
    expect(list.nextCursor).toBeNull();
    expect(list.format).toEqual({ currency: "USD", locale: "en-US", timeZone: "America/Denver" });
    const drafts = await json<InvoiceListWire>(await h.call(a, "v1/admin/invoices?status=paid"));
    expect(drafts.invoices).toEqual([]);
    expect((await h.call(a, "v1/admin/invoices?status=nonsense")).status).toBe(400);
  });

  it("status reports whether invoice details are filled in and where to fill them", async () => {
    const a = tenant();
    const wire = await json<InvoicingStatusWire>(await admin(a).call(a, "v1/admin/status"));
    expect(wire).toEqual({
      emails: false,
      emailsOffReason: expect.stringContaining("doesn't email invoices yet"),
      detailsComplete: true,
      detailsHref: "/settings/company#invoicing",
      format: { currency: "USD", locale: "en-US", timeZone: "America/Denver" },
    });
    const bare = createInvoicingAdminHandlers({ db: t.db, tenantId: a, authorize: () => true, invoiceUrl: (x) => x });
    const wire2 = await json<InvoicingStatusWire>(await bare.handle(new Request("https://app.test/x/v1/admin/status")));
    expect(wire2.detailsComplete).toBe(false);
    expect(wire2.format.timeZone).toBe("UTC");
  });

  it("a throwing business seam is reported and the ledger still answers in UTC", async () => {
    const a = tenant();
    const errors: unknown[] = [];
    const h = admin(a, ALL, {
      business: () => {
        throw new Error("profile down");
      },
      onError: (e) => errors.push(e),
    });
    const res = await h.call(a, "v1/admin/status");
    expect(res.status).toBe(200);
    expect((await json<InvoicingStatusWire>(res)).format.timeZone).toBe("UTC");
    expect(errors).toHaveLength(1);
  });

  it("unknown path 404; wrong method 405 with allow; cross-site POST refused; no CORS", async () => {
    const a = tenant();
    const h = admin(a);
    expect((await h.call(a, "v1/admin/nope")).status).toBe(404);
    const wrong = await h.call(a, "v1/admin/status", "POST");
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("GET");
    const cross = await h.call(a, "v1/admin/invoices", "POST", {}, { "sec-fetch-site": "cross-site" });
    expect(cross.status).toBe(403);
    expect((await json<{ error: { code: string } }>(cross)).error.code).toBe("cross_site");
    const ok = await h.call(a, "v1/admin/status");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});

describe("send", () => {
  it("a draft moves to sent, then is emailed; the answer says so", async () => {
    const a = tenant();
    const inv = await create(a);
    const calls: unknown[] = [];
    const h = admin(a, ALL, {
      sendInvoiceEmail: async (input) => {
        calls.push(input);
        return { status: "sent", message: "Emailed to pat@example.com." };
      },
    });
    const res = await json<SendResponse>(await h.call(a, `v1/admin/invoices/${inv.id}/send`, "POST"));
    expect(res.invoice.storedStatus).toBe("sent");
    expect(res.delivery).toBe("sent");
    expect(res.message).toBe("Emailed to pat@example.com.");
    expect(calls).toEqual([{ tenantId: a, invoiceId: inv.id, userId: "user-1" }]);
  });

  it("no email on the invoice, or no sender: copy the link yourself", async () => {
    const a = tenant();
    const noEmail = await create(a, { customerEmail: "" });
    const h = admin(a);
    const res = await json<SendResponse>(await h.call(a, `v1/admin/invoices/${noEmail.id}/send`, "POST"));
    expect(res).toMatchObject({ delivery: "no-email", message: "This invoice has no customer email. Copy the link and send it yourself." });
    const withEmail = await create(a);
    const res2 = await json<SendResponse>(await h.call(a, `v1/admin/invoices/${withEmail.id}/send`, "POST"));
    expect(res2).toMatchObject({ delivery: "skipped", message: "This site doesn't send email yet. Copy the link and send it yourself." });
    expect(res2.invoice.storedStatus).toBe("sent");
  });

  it("a throwing sender is `failed`, reported, and the status move stays", async () => {
    const a = tenant();
    const inv = await create(a);
    const errors: unknown[] = [];
    const h = admin(a, ALL, {
      sendInvoiceEmail: async () => {
        throw new Error("provider down");
      },
      onError: (e) => errors.push(e),
    });
    const res = await h.call(a, `v1/admin/invoices/${inv.id}/send`, "POST");
    expect(res.status).toBe(200);
    const body = await json<SendResponse>(res);
    expect(body).toMatchObject({ delivery: "failed", message: "The email didn't go. Copy the link and send it yourself, or try again." });
    expect(body.invoice.storedStatus).toBe("sent");
    expect(errors).toHaveLength(1);
  });

  it("paid or void can't be sent; a line-less draft is refused by the package", async () => {
    const a = tenant();
    const inv = await create(a);
    const h = admin(a);
    await h.call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "void" });
    const res = await h.call(a, `v1/admin/invoices/${inv.id}/send`, "POST");
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: { code: "transition_not_allowed", message: "A paid or void invoice can't be sent." } });
    const bare = await create(a);
    await h.call(a, `v1/admin/items/${bare.lines[0]!.id}/remove`, "POST");
    const res2 = await h.call(a, `v1/admin/invoices/${bare.id}/send`, "POST");
    expect(res2.status).toBe(409);
    expect((await json<{ error: { code: string } }>(res2)).error.code).toBe("invoice_has_no_lines");
  });

  it("a sent invoice is just emailed again", async () => {
    const a = tenant();
    const inv = await create(a);
    let sends = 0;
    const h = admin(a, ALL, { sendInvoiceEmail: async () => (sends++, { status: "sent", message: "" }) });
    await h.call(a, `v1/admin/invoices/${inv.id}/send`, "POST");
    const again = await json<SendResponse>(await h.call(a, `v1/admin/invoices/${inv.id}/send`, "POST"));
    expect(sends).toBe(2);
    // An empty message from the sender falls back to the plain sentence.
    expect(again.message).toBe("Emailed to pat@example.com.");
  });
});

describe("the link", () => {
  it("is the ONLY admin route carrying the token", async () => {
    const a = tenant();
    const inv = await create(a);
    const token = await tokenOf(inv.id);
    const h = admin(a);
    const link = await json<InvoiceLinkWire>(await h.call(a, `v1/admin/invoices/${inv.id}/link`));
    expect(link).toEqual({ url: `https://app.test/t/${a}/invoice/${token}`, previewUrl: `https://app.test/t/${a}/invoice/${token}?preview=1` });
    for (const path of ["v1/admin/invoices", `v1/admin/invoices/${inv.id}`, "v1/admin/status"]) {
      expect(await (await h.call(a, path)).text(), path).not.toContain(token);
    }
    const send = await h.call(a, `v1/admin/invoices/${inv.id}/send`, "POST");
    expect(await send.text()).not.toContain(token);
  });

  it("keeps a host link's own query", async () => {
    const a = tenant();
    const inv = await create(a);
    const h = admin(a, ALL, { invoiceUrl: (token) => `https://app.test/i?t=${token}` });
    const link = await json<InvoiceLinkWire>(await h.call(a, `v1/admin/invoices/${inv.id}/link`));
    expect(link.previewUrl).toBe(`${link.url}&preview=1`);
  });
});

describe("the customer's page", () => {
  it("shows the invoice, the business and how to show money; never a draft", async () => {
    const a = tenant();
    const inv = await create(a, { taxRateBp: 825 });
    const token = await tokenOf(inv.id);
    const page = customer(a);
    const draft = await page(a, `v1/invoice/${token}`);
    expect(draft.status).toBe(404);
    expect(await json(draft)).toEqual({ error: { code: "not_found", message: "This invoice isn't available. It may have been replaced; contact the business." } });
    await admin(a).call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" });
    const res = await page(a, `v1/invoice/${token}`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const body = await json<PublicInvoiceResponse>(res);
    expect(body.business).toEqual({
      name: "Green Acres",
      logoUrl: "https://cdn.test/green.png",
      brandColor: "#1f7a3a",
      contactEmail: "gail@greenacres.test",
      contactPhone: "(801) 555-0100",
      paymentInstructions: "Pay by check to Green Acres LLC.",
      footer: "Thanks for your business.",
    });
    expect(body.invoice).toMatchObject({ number: inv.number, status: "sent", total: inv.total, taxRateBp: 825 });
    expect(Object.keys(body.invoice)).not.toContain("id");
    expect(JSON.stringify(body)).not.toContain(inv.id);
  });

  it("viewed is a POST fired by the page: sent → viewed once, never from the GET", async () => {
    const a = tenant();
    const inv = await create(a);
    const token = await tokenOf(inv.id);
    await admin(a).call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" });
    const page = customer(a);
    await page(a, `v1/invoice/${token}`);
    await page(a, `v1/invoice/${token}`);
    const [still] = await t.db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv.id));
    expect(still?.status).toBe("sent");
    expect(await json(await page(a, `v1/invoice/${token}/viewed`, "POST"))).toEqual({ viewed: true });
    expect(await json(await page(a, `v1/invoice/${token}/viewed`, "POST"))).toEqual({ viewed: false });
    expect((await page(a, `v1/invoice/${token}/viewed`)).status).toBe(405);
  });

  it("another company's token under this company's address is 404 (D13), for both routes", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    const inv = await create(a);
    await admin(a).call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" });
    const token = await tokenOf(inv.id);
    const asB = customer(b);
    const res = await asB(b, `v1/invoice/${token}`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(inv.number);
    expect((await asB(b, `v1/invoice/${token}/viewed`, "POST")).status).toBe(404);
    const [row] = await t.db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, inv.id));
    expect(row?.status).toBe("sent");
  });

  it("a closed company answers 409 unavailable with its message, before the rate limit or any query", async () => {
    const a = tenant();
    let limited = 0;
    const page = customer(a, {
      admit: () => ({ open: false, message: "Green Acres isn't taking requests online right now. Call (801) 555-0100." }),
      rateLimit: () => (limited++, true),
    });
    t.queries.length = 0;
    const res = await page(a, "v1/invoice/inv_0000000000000000000000000000000000000");
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: { code: "unavailable", message: "Green Acres isn't taking requests online right now. Call (801) 555-0100." } });
    expect(limited).toBe(0);
    expect(t.queries).toHaveLength(0);
  });

  it("the rate limit answers 429", async () => {
    const a = tenant();
    const page = customer(a, { rateLimit: () => false });
    const res = await page(a, "v1/invoice/inv_0000000000000000000000000000000000000");
    expect(res.status).toBe(429);
  });
});

describe("token reads with and without a tenant (D13)", () => {
  it("without a tenant: 0.2's behaviour; with one: only inside that tenant", async () => {
    const a = tenant();
    const b = tenant();
    const inv = await create(a);
    await admin(a).call(a, `v1/admin/invoices/${inv.id}/status`, "POST", { status: "sent" });
    const token = await tokenOf(inv.id);
    expect(await getInvoiceByToken(t.db, token)).not.toBeNull();
    expect(await getInvoiceByToken(t.db, token, { tenantId: a })).not.toBeNull();
    expect(await getInvoiceByToken(t.db, token, { tenantId: b })).toBeNull();
    expect(await getInvoiceByToken(t.db, token, { tenantId: "" })).toBeNull();
    expect(await markInvoiceViewed(t.db, token, { tenantId: b })).toBe(false);
    expect(await markInvoiceViewed(t.db, token, { tenantId: a })).toBe(true);
    const inv2 = await create(a);
    await admin(a).call(a, `v1/admin/invoices/${inv2.id}/status`, "POST", { status: "sent" });
    expect(await markInvoiceViewed(t.db, await tokenOf(inv2.id))).toBe(true);
  });
});

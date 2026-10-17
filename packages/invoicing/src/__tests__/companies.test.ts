import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createInvoice,
  createInvoicingAdminHandlers,
  createInvoicingHandlers,
  INVOICING_ADMIN_ROUTE_PERMISSIONS,
  INVOICING_ADMIN_ROUTES,
  INVOICING_PUBLIC_ROUTES,
  invoiceItems,
  invoicePayments,
  invoices,
  invoicingChecklistItems,
  invoicingPermissions,
  invoicingSettingsFragment,
  readInvoicingDetails,
  recordPayment,
  setInvoiceStatus,
  type InvoicingPermission,
  type InvoicingRoute,
} from "../index.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * Two companies on one database (Tenancy 2a, 13.5): the route tables match
 * the router and every example reaches its row lookup, and company B gets
 * not-found, or nothing of company A's, through every staff and public route,
 * while A's rows stay exactly as they were. Plus the settings fragment, the
 * checklist item and the permission keys.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const ALL = Object.keys(invoicingPermissions) as InvoicingPermission[];

function staffAs(member: string) {
  return createInvoicingAdminHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/app\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
    authorize: (_req, permission, tenantId) =>
      tenantId === member && ALL.includes(permission)
        ? { userId: `user-of-${member}` }
        : new Response(JSON.stringify({ error: { code: "forbidden", message: "You're not part of this company." } }), { status: 403 }),
    invoiceUrl: (token, id) => `https://app.test/t/${id}/invoice/${token}`,
  });
}

function customers() {
  return createInvoicingHandlers({
    db: t.db,
    resolveTenant: (req) => /\/api\/t\/([^/]+)\//.exec(new URL(req.url).pathname)?.[1] ?? null,
  });
}

function fill(text: string, rows: Record<string, string>): string {
  return text.replace(/\{([a-z-]+)\}/g, (_m, entity: string) => rows[entity] ?? `{${entity}}`);
}

function fillBody(body: unknown, rows: Record<string, string>): unknown {
  return JSON.parse(fill(JSON.stringify(body ?? {}), rows));
}

function request(base: string, route: InvoicingRoute, rows: Record<string, string>): Request {
  const query = route.query ? `?${new URLSearchParams(Object.fromEntries(Object.entries(route.query).map(([k, v]) => [k, fill(v, rows)])))}` : "";
  return new Request(`${base}${fill(route.path, rows)}${query}`, {
    method: route.method,
    headers: { "sec-fetch-site": "same-origin", ...(route.method === "POST" ? { "content-type": "application/json" } : {}) },
    ...(route.method === "POST" ? { body: JSON.stringify(fillBody(route.body, rows)) } : {}),
  });
}

/** Plant one of every entity for a company: an invoice with a line and a payment, sent, and its token. */
async function plant(tenantId: string, label: string) {
  const created = await createInvoice(t.db, {
    tenantId,
    customerName: `${label} Customer`,
    customerEmail: `${label.toLowerCase()}-customer@example.com`,
    items: [{ description: `${label} hedge trimming`, quantity: 1, unitPrice: 30_000 }],
  });
  await setInvoiceStatus(t.db, { tenantId, id: created.id, status: "sent" });
  const paid = await recordPayment(t.db, { tenantId, invoiceId: created.id, amount: 5_000, method: "check", reference: `${label}-check-77` });
  const [line] = await t.db.select({ id: invoiceItems.id }).from(invoiceItems).where(eq(invoiceItems.invoiceId, created.id));
  return {
    rows: { invoice: created.id, item: (line as { id: string }).id, payment: paid!.paymentId, "invoice-token": created.viewToken },
    // Not the invoice NUMBER: numbers run per company, so both have INV-…-0001.
    strings: [created.id, created.viewToken, `${label} Customer`, `${label.toLowerCase()}-customer@example.com`, `${label} hedge trimming`, `${label}-check-77`],
  };
}

async function snapshot(tenantId: string) {
  const inv = await t.db.select().from(invoices).where(eq(invoices.tenantId, tenantId)).orderBy(invoices.id);
  const ids = inv.map((r) => (r as { id: string }).id);
  const items = ids.length ? await t.db.select().from(invoiceItems).where(inArray(invoiceItems.invoiceId, ids)).orderBy(invoiceItems.id) : [];
  const pays = ids.length ? await t.db.select().from(invoicePayments).where(inArray(invoicePayments.invoiceId, ids)).orderBy(invoicePayments.id) : [];
  return JSON.stringify({ inv, items, pays });
}

describe("route tables", () => {
  it("every staff row routes to its kind (authorize sees that kind's permission once)", async () => {
    const a = tenant();
    for (const route of INVOICING_ADMIN_ROUTES) {
      const asked: string[] = [];
      const h = createInvoicingAdminHandlers({
        db: t.db,
        tenantId: a,
        authorize: (_r, permission) => {
          asked.push(permission);
          return false;
        },
        invoiceUrl: (x) => x,
      });
      const res = await h.handle(request("https://app.test/api/x/", route, { invoice: "i1", item: "l1", payment: "p1" }));
      expect(res.status, route.kind).toBe(403);
      expect(asked, route.kind).toEqual([INVOICING_ADMIN_ROUTE_PERMISSIONS[route.kind]]);
      expect(route.permission, route.kind).toBe(INVOICING_ADMIN_ROUTE_PERMISSIONS[route.kind]);
    }
    expect(new Set(INVOICING_ADMIN_ROUTES.map((r) => r.kind)).size).toBe(Object.keys(INVOICING_ADMIN_ROUTE_PERMISSIONS).length);
    expect(Object.isFrozen(INVOICING_ADMIN_ROUTES)).toBe(true);
    expect(Object.isFrozen(INVOICING_PUBLIC_ROUTES)).toBe(true);
  });

  it("every example reaches its lookup: on an EMPTY company a path placeholder is 404, the rest below 500", async () => {
    const empty = tenant("empty");
    const h = staffAs(empty);
    const made = { invoice: crypto.randomUUID(), item: crypto.randomUUID(), payment: crypto.randomUUID(), "invoice-token": `inv_${"a".repeat(36)}` };
    for (const route of INVOICING_ADMIN_ROUTES) {
      const res = await h.handle(request(`https://app.test/api/app/${empty}/invoices/`, route, made));
      if (/\{[a-z-]+\}/.test(route.path)) {
        expect(res.status, route.kind).toBe(404);
        expect(((await res.json()) as { error: { code: string } }).error.code, route.kind).toBe("not_found");
      } else expect(res.status, route.kind).toBeLessThan(500);
    }
    for (const route of INVOICING_PUBLIC_ROUTES) {
      const res = await customers().handle(request(`https://app.test/api/t/${empty}/invoices/`, route, made));
      expect(res.status, route.kind).toBe(404);
    }
  });

  it("public rows route to their kind", async () => {
    const a = tenant();
    const kinds: string[] = [];
    const h = createInvoicingHandlers({
      db: t.db,
      tenantId: a,
      rateLimit: (_req, bucket) => (kinds.push(bucket), false),
    });
    for (const route of INVOICING_PUBLIC_ROUTES) {
      const res = await h.handle(request("https://app.test/api/t/a/invoices/", route, { "invoice-token": `inv_${"b".repeat(36)}` }));
      expect(res.status, route.kind).toBe(429);
    }
    expect(kinds).toEqual(["read", "viewed", "pay"]);
  });
});

describe("two companies, every route", () => {
  it("B gets 403 with A's id in the path, 404 or nothing of A with A's rows, and A is unchanged", async () => {
    const a = tenant("alpha");
    const b = tenant("bravo");
    const A = await plant(a, "Alpha");
    await plant(b, "Bravo");
    const before = await snapshot(a);

    const asB = staffAs(b);
    for (const route of INVOICING_ADMIN_ROUTES) {
      // A's company in the path: the gate refuses before anything else.
      const viaA = await asB.handle(request(`https://app.test/api/app/${a}/invoices/`, route, A.rows));
      expect(viaA.status, route.kind).toBe(403);
      // B's company, A's rows.
      const res = await asB.handle(request(`https://app.test/api/app/${b}/invoices/`, route, A.rows));
      const text = await res.text();
      if (/\{[a-z-]+\}/.test(route.path)) expect(res.status, route.kind).toBe(404);
      else expect(res.status, route.kind).toBeLessThan(500);
      for (const s of A.strings) expect(text, `${route.kind} leaked ${s}`).not.toContain(s);
    }
    for (const route of INVOICING_PUBLIC_ROUTES) {
      const res = await customers().handle(request(`https://app.test/api/t/${b}/invoices/`, route, A.rows));
      const text = await res.text();
      expect(res.status, route.kind).toBe(404);
      for (const s of A.strings) expect(text, `${route.kind} leaked ${s}`).not.toContain(s);
    }
    expect(await snapshot(a)).toBe(before);
  });

  it("the check bites: a handler that ignored the tenant would be caught (negative control)", async () => {
    const a = tenant("alpha");
    const A = await plant(a, "Alpha");
    // The leak 2a closes: a public handler that reads tokens without the tenant.
    const leaky = createInvoicingHandlers({ db: t.db, tenantId: a });
    const res = await leaky.handle(request("https://app.test/api/t/bravo/invoices/", INVOICING_PUBLIC_ROUTES[0]!, A.rows));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Alpha Customer");
  });
});

describe("the settings fragment, the checklist item and the keys", () => {
  it("the fragment passes tenancy's rules: defaults from {}, every field in the shape, a flat key", () => {
    expect(invoicingSettingsFragment.schema.parse({})).toEqual({ paymentInstructions: null, dueDays: 14, footer: null, depositPercent: 0, allowPartialPayments: false });
    const shape = invoicingSettingsFragment.schema.shape as Record<string, z.ZodType>;
    for (const field of invoicingSettingsFragment.fields) expect(Object.keys(shape)).toContain(field.key);
    expect(invoicingSettingsFragment.key).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
    expect(invoicingSettingsFragment.schema.parse({ paymentInstructions: "   ", footer: "" })).toEqual({ paymentInstructions: null, dueDays: 14, footer: null, depositPercent: 0, allowPartialPayments: false });
    expect(invoicingSettingsFragment.schema.safeParse({ dueDays: 400 }).success).toBe(false);
  });

  it("readInvoicingDetails: junk reads as the defaults, one bad field keeps the rest", () => {
    expect(readInvoicingDetails(null)).toEqual({ paymentInstructions: null, dueDays: 14, footer: null, depositPercent: 0, allowPartialPayments: false });
    expect(readInvoicingDetails("junk")).toEqual({ paymentInstructions: null, dueDays: 14, footer: null, depositPercent: 0, allowPartialPayments: false });
    expect(readInvoicingDetails({ paymentInstructions: "Check please", dueDays: "ten", footer: "x".repeat(600) })).toEqual({
      paymentInstructions: "Check please",
      dueDays: 14,
      footer: null,
      depositPercent: 0,
      allowPartialPayments: false,
    });
    expect(readInvoicingDetails({ paymentInstructions: "Cash", dueDays: 0, footer: "Thanks" })).toEqual({ paymentInstructions: "Cash", dueDays: 0, footer: "Thanks", depositPercent: 0, allowPartialPayments: false });
  });

  it("the checklist item is done once payment instructions are written", async () => {
    const [item] = invoicingChecklistItems({ details: "/settings/company#invoicing" });
    expect(item).toMatchObject({ key: "invoices.details", order: 80, permission: "tenant.edit", href: "/settings/company#invoicing", title: "Tell customers how to pay you" });
    expect(await item!.isDone({ db: t.db, tenantId: "x", settings: {} })).toBe(false);
    expect(await item!.isDone({ db: t.db, tenantId: "x", settings: { invoicing: { paymentInstructions: "Check to Green Acres" } } })).toBe(true);
  });

  it("the permission keys carry the contract's defaults", () => {
    expect(invoicingPermissions["invoices.view"].defaultFor).toEqual(["owner", "admin", "member", "viewer"]);
    expect(invoicingPermissions["invoices.manage"].defaultFor).toEqual(["owner", "admin", "member"]);
    expect(invoicingPermissions["invoices.payments.record"].defaultFor).toEqual(["owner", "admin", "member"]);
    expect(invoicingPermissions["invoices.payments.reverse"].defaultFor).toEqual(["owner", "admin"]);
    for (const route of INVOICING_ADMIN_ROUTES) expect(Object.keys(invoicingPermissions)).toContain(route.permission);
  });
});

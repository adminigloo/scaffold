import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomersAdminHandlers } from "../admin-handlers.js";
import { CustomersAdmin, customerBody, recordHref } from "../admin/CustomersAdmin.js";
import { findOrCreateCustomer, getCustomer, linkCustomer } from "../customers.js";
import { CUSTOMERS_ADMIN_ROUTE_PERMISSIONS, CUSTOMERS_ADMIN_ROUTES } from "../routes.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The customer handler over HTTP-shaped requests: every route of the route
 * table answers, another company's customer named in the path (or a merge's
 * body) is "not found" and leaks nothing, a cross-site POST is refused, and
 * the permission asked is the table's. Plus the screen renders.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

function handler(asked: string[], allow: (permission: string) => boolean = () => true) {
  return createCustomersAdminHandlers({
    db: t.db,
    resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
    authorize: (_req, permission) => {
      asked.push(permission);
      return allow(permission) ? { userId: "u1" } : false;
    },
  });
}

function send(path: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://app.test${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

function fill(text: string, rows: Record<string, string>) {
  return text.replace(/\{([a-z-]+)\}/g, (_, name: string) => rows[name] ?? `missing-${name}`);
}

function fillDeep(value: unknown, rows: Record<string, string>): unknown {
  if (typeof value === "string") return fill(value, rows);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, rows)]));
  return value;
}

async function plant(tenantId: string, label: string) {
  const { customer } = await findOrCreateCustomer(t.db, { tenantId, name: `${label} Customer`, email: `customer@${label}.test`, address: `1 ${label} Road` });
  const spare = await findOrCreateCustomer(t.db, { tenantId, name: `${label} Spare`, email: `spare@${label}.test` });
  await linkCustomer(t.db, { tenantId, customerId: customer.id, kind: "estimate", refId: `est-${label}`, action: "submitted", occurredAt: new Date(), summary: `${label} quote` });
  // A form with her email and a phone she doesn't have: a notice, never a change.
  await findOrCreateCustomer(t.db, { tenantId, email: `customer@${label}.test`, phone: "415 555 0177", sourceLabel: `${label} form` });
  const card = await getCustomer(t.db, tenantId, customer.id);
  return { customer: customer.id, "customer-address": card!.addresses[0]!.id, "spare-customer": spare.customer.id, "customer-notice": card!.notices[0]!.id };
}

describe("the customer handler", () => {
  it("answers every route of the table, asking that route's permission", async () => {
    const a = tenant();
    const rows = await plant(a, "alpha");
    const asked: string[] = [];
    const { handle } = handler(asked);
    for (const route of CUSTOMERS_ADMIN_ROUTES) {
      // The merge consumes its spare: plant a fresh one each time it's driven.
      const query = new URLSearchParams(route.query ?? {}).toString();
      const res = await handle(send(`/api/app/${a}/customers/${fill(route.path, rows)}${query ? `?${query}` : ""}`, route.method, route.method === "POST" ? fillDeep(route.body ?? {}, rows) : undefined, { "sec-fetch-site": "same-origin" }));
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBeLessThan(300);
      expect(asked.at(-1)).toBe(CUSTOMERS_ADMIN_ROUTE_PERMISSIONS[route.kind]);
      expect(route.permission).toBe(CUSTOMERS_ADMIN_ROUTE_PERMISSIONS[route.kind]);
    }
  });

  it("another company's customer, address or merge target is not found, and nothing of it comes back", async () => {
    const a = tenant();
    const b = tenant();
    const aRows = await plant(a, "alpha");
    await plant(b, "bravo");
    const { handle } = handler([]);
    for (const route of CUSTOMERS_ADMIN_ROUTES) {
      const query = new URLSearchParams(route.query ?? {}).toString();
      const res = await handle(send(`/api/app/${b}/customers/${fill(route.path, aRows)}${query ? `?${query}` : ""}`, route.method, route.method === "POST" ? fillDeep(route.body ?? {}, aRows) : undefined, { "sec-fetch-site": "same-origin" }));
      const text = await res.text();
      for (const leak of ["alpha", ...Object.values(aRows)]) expect(text, `${route.kind}`).not.toContain(leak);
      if (/\{/.test(route.path)) expect(res.status, route.kind).toBe(404);
      else expect(res.status, route.kind).toBeLessThan(500);
    }
    // A merge naming A's customer as the duplicate, from B's own customer: not found.
    const bRows = await plant(b, "bravo2");
    const res = await handle(send(`/api/app/${b}/customers/v1/admin/customers/${bRows.customer}/merge`, "POST", { mergeId: aRows["spare-customer"] }, { "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(404);
    expect(await getCustomer(t.db, a, aRows["spare-customer"])).not.toBeNull();
  });

  it("refuses without the permission, and refuses a POST from another site", async () => {
    const a = tenant();
    const rows = await plant(a, "charlie");
    const viewOnly = handler([], (permission) => permission === "customers.view");
    const update = await viewOnly.handle(send(`/api/app/${a}/customers/v1/admin/customers/${rows.customer}`, "POST", { notes: "x" }, { "sec-fetch-site": "same-origin" }));
    expect(update.status).toBe(403);
    const cross = await handler([]).handle(send(`/api/app/${a}/customers/v1/admin/customers`, "POST", { name: "x" }, { "sec-fetch-site": "cross-site" }));
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { error: { code: string } }).error.code).toBe("cross_site");
  });

  it("exports CSV as a download, and says what was wrong in plain words", async () => {
    const a = tenant();
    await plant(a, "delta");
    const { handle } = handler([]);
    const res = await handle(send(`/api/app/${a}/customers/v1/admin/export`, "GET"));
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await res.text()).toContain("delta Customer");
    const bad = await handle(send(`/api/app/${a}/customers/v1/admin/customers`, "POST", { name: "" }, { "sec-fetch-site": "same-origin" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe("Give the customer a name.");
  });
});

describe("the screens", () => {
  it("render the list and one customer", () => {
    const list = renderToStaticMarkup(<CustomersAdmin baseUrl="/api/app/c1/customers" pageHref="/app/customers" />);
    expect(list).toContain("Customers");
    expect(list).toContain("Add customer");
    expect(list).toContain("/api/app/c1/customers/v1/admin/export");
    const readOnly = renderToStaticMarkup(<CustomersAdmin baseUrl="/x" pageHref="/app/customers" canManage={false} />);
    expect(readOnly).not.toContain("Add customer");
    const one = renderToStaticMarkup(<CustomersAdmin baseUrl="/x" pageHref="/app/customers" customerId="abc" />);
    expect(one).toContain("All customers");
  });

  it("builds record links and the editor's body", () => {
    expect(recordHref({ invoice: "/app/invoices/{id}" }, { kind: "invoice", refId: "a b" })).toBe("/app/invoices/a%20b");
    expect(recordHref({ invoice: "/app/invoices/{id}" }, { kind: "order", refId: "x" })).toBeNull();
    expect(customerBody({ name: "Lee", companyName: "", emails: "a@x.co\nb@x.co", phones: "", tags: "vip, new", notes: "" })).toEqual({ name: "Lee", companyName: "", emails: ["a@x.co", "b@x.co"], phones: [], tags: ["vip", "new"], notes: "" });
  });
});

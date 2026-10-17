import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INVOICING_ADMIN_ROUTES, INVOICING_PUBLIC_ROUTES } from "@adminigloo/invoicing";
import { describe, expect, it } from "vitest";
import { createInvoicingClient } from "../admin/client.js";
import { createInvoicePublicClient } from "../client.js";
import { response } from "./fixtures.js";

/**
 * The transports (Tenancy 2a, 10.9): every route at its address and method,
 * never throwing; and wire parity with @adminigloo/invoicing (the region
 * between the WIRE markers byte-identical, every route of the server's tables
 * spoken by a client). The devDependency on @adminigloo/invoicing is used
 * ONLY here.
 */

function fakeFetch(answer: (url: string, method: string) => { status?: number; body?: unknown; text?: string }) {
  const seen: { url: string; method: string; body: unknown }[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    seen.push({ url: input, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answer(input, method);
    return new Response(a.text ?? JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

describe("createInvoicingClient", () => {
  it("calls every staff route at its address and method", async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith("/status")) return { body: { emails: true, emailsOffReason: null, detailsComplete: true, detailsHref: null, format: {} } };
      if (url.includes("/v1/admin/invoices?") || url.endsWith("/v1/admin/invoices") && false) return { body: { invoices: [], nextCursor: null, format: {} } };
      if (url.endsWith("/link")) return { body: { url: "https://x/t", previewUrl: "https://x/t?preview=1" } };
      if (url.endsWith("/send")) return { body: { ...response(), delivery: "sent", message: "ok" } };
      return { body: response() };
    });
    const c = createInvoicingClient({ baseUrl: "/api/app/c1/invoices", fetch: f.fetch });
    await c.status();
    await c.list({ status: "overdue", cursor: "abc" });
    await c.create({ customerName: "Pat", items: [{ description: "x", quantity: 1, unitPrice: 100 }] });
    await c.get("inv/1");
    await c.addItem("inv-1", { description: "x", quantity: 1, unitPrice: 1 });
    await c.updateItem("line-1", { quantity: 2 });
    await c.removeItem("line-1");
    await c.setStatus("inv-1", { status: "void" });
    expect((await c.send("inv-1")).ok).toBe(true);
    expect((await c.link("inv-1")).ok).toBe(true);
    await c.recordPayment("inv-1", { amount: 100, method: "cash" });
    await c.reversePayment("p-1", { reason: "x" });
    expect(f.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/app/c1/invoices/v1/admin/status",
      "GET /api/app/c1/invoices/v1/admin/invoices?status=overdue&cursor=abc",
      "POST /api/app/c1/invoices/v1/admin/invoices",
      "GET /api/app/c1/invoices/v1/admin/invoices/inv%2F1",
      "POST /api/app/c1/invoices/v1/admin/invoices/inv-1/items",
      "POST /api/app/c1/invoices/v1/admin/items/line-1",
      "POST /api/app/c1/invoices/v1/admin/items/line-1/remove",
      "POST /api/app/c1/invoices/v1/admin/invoices/inv-1/status",
      "POST /api/app/c1/invoices/v1/admin/invoices/inv-1/send",
      "GET /api/app/c1/invoices/v1/admin/invoices/inv-1/link",
      "POST /api/app/c1/invoices/v1/admin/invoices/inv-1/payments",
      "POST /api/app/c1/invoices/v1/admin/payments/p-1/reverse",
    ]);
  });

  it("never throws: network, 401, HTML, odd shapes", async () => {
    const dead = createInvoicingClient({
      baseUrl: "/x",
      fetch: (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
    });
    expect(await dead.status()).toEqual({ ok: false, error: { code: "network", message: "Couldn't reach the server.", status: 0 } });
    const signedOut = createInvoicingClient({ baseUrl: "/x", fetch: fakeFetch(() => ({ status: 401, text: "Sign in" })).fetch });
    expect((await signedOut.get("i")).ok === false && (await signedOut.get("i")).ok).toBe(false);
    const res = await signedOut.get("i");
    expect(res.ok ? null : res.error.message).toBe("You've been signed out. Sign in again to keep working.");
    const html = createInvoicingClient({ baseUrl: "/x", fetch: fakeFetch(() => ({ status: 502, text: "<html>" })).fetch });
    const r2 = await html.get("i");
    expect(r2.ok ? null : r2.error.code).toBe("bad_response");
    const odd = createInvoicingClient({ baseUrl: "/x", fetch: fakeFetch(() => ({ body: { nope: 1 } })).fetch });
    const r3 = await odd.get("i");
    expect(r3.ok ? null : r3.error.code).toBe("bad_response");
  });

  it("a package refusal keeps its code and sentence", async () => {
    const c = createInvoicingClient({
      baseUrl: "/x",
      fetch: fakeFetch(() => ({ status: 409, body: { error: { code: "payment_refused", message: "This invoice is already paid in full." } } })).fetch,
    });
    expect(await c.recordPayment("i", { amount: 1, method: "cash" })).toEqual({
      ok: false,
      error: { code: "payment_refused", message: "This invoice is already paid in full.", status: 409 },
    });
  });
});

describe("createInvoicePublicClient", () => {
  it("GETs the invoice and POSTs the view", async () => {
    const f = fakeFetch((url) => (url.endsWith("/viewed") ? { body: { viewed: true } } : { body: { invoice: { number: "N" }, business: {}, format: {} } }));
    const c = createInvoicePublicClient({ baseUrl: "/api/t/green-acres/invoices", fetch: f.fetch });
    expect((await c.invoice("inv_abc")).ok).toBe(true);
    expect(await c.viewed("inv_abc")).toEqual({ ok: true, data: { viewed: true } });
    expect(f.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/t/green-acres/invoices/v1/invoice/inv_abc",
      "POST /api/t/green-acres/invoices/v1/invoice/inv_abc/viewed",
    ]);
  });

  it("unavailable keeps the server's message", async () => {
    const c = createInvoicePublicClient({
      baseUrl: "/x",
      fetch: fakeFetch(() => ({ status: 409, body: { error: { code: "unavailable", message: "Green Acres isn't taking requests online right now." } } })).fetch,
    });
    const res = await c.invoice("t");
    expect(res.ok ? null : res.error).toEqual({ code: "unavailable", message: "Green Acres isn't taking requests online right now.", status: 409 });
  });
});

describe("wire parity with @adminigloo/invoicing", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const region = (source: string): string | null => {
    const text = source.replace(/\r\n/g, "\n");
    if (text.split("// WIRE:BEGIN").length !== 2 || text.split("// WIRE:END").length !== 2) return null;
    return text.slice(text.indexOf("// WIRE:BEGIN"), text.indexOf("// WIRE:END") + "// WIRE:END".length);
  };

  it("the WIRE regions are byte-identical", () => {
    const mine = region(readFileSync(resolve(here, "../types.ts"), "utf8"));
    const theirs = region(readFileSync(resolve(here, "../../../invoicing/src/wire.ts"), "utf8"));
    expect(mine).not.toBeNull();
    expect(mine).toBe(theirs);
  });

  it("the clients speak every route of the server's tables", () => {
    const admin = readFileSync(resolve(here, "../admin/client.ts"), "utf8");
    for (const route of INVOICING_ADMIN_ROUTES) {
      const path = `/${route.path}`.replace("{invoice}", "${seg(id)}").replace("{item}", "${seg(itemId)}").replace("{payment}", "${seg(paymentId)}").replace("{card-alert}", "${seg(alertId)}");
      expect(admin.includes(path), `${route.kind}: ${path}`).toBe(true);
    }
    const pub = readFileSync(resolve(here, "../client.ts"), "utf8");
    expect(pub).toContain("/v1/invoice/${encodeURIComponent(token)}");
    expect(pub).toContain("${at(token)}/viewed");
    expect(pub).toContain("${at(token)}/pay");
    expect(INVOICING_PUBLIC_ROUTES.map((r) => r.path)).toEqual(["v1/invoice/{invoice-token}", "v1/invoice/{invoice-token}/viewed", "v1/invoice/{invoice-token}/pay"]);
  });
});

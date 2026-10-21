import { describe, expect, it } from "vitest";
import { createCommsClient } from "../client.js";

/**
 * The transport (Tenancy 2a, 9.7): one call per route, at the right address
 * and method, never throwing: a 401 is "signed out", an HTML page or a
 * strange shape is `bad_response`, a dead network is `network`.
 */

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(answer: (url: string) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }) {
  const seen: Seen[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    seen.push({ url: input, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answer(input);
    const payload = a.text ?? (a.body === undefined ? "" : JSON.stringify(a.body));
    return new Response(payload, { status: a.status ?? 200, headers: a.headers ?? { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const TEMPLATE = { key: "visit_reminder", channel: "email", subject: "Hi", body: "Body", active: true, updatedAt: "2026-10-01T00:00:00.000Z", variables: ["name"] };

describe("createCommsClient", () => {
  it("calls every route at its address and method", async () => {
    const f = fakeFetch((url) => {
      if (url.endsWith("/status")) return { body: { emails: true, emailsOffReason: null, fromName: "Green Acres", replyTo: null, scheduled: { pending: 1, behind: 0, late: 0 } } };
      if (url.endsWith("/templates")) return { body: { templates: [TEMPLATE] } };
      if (url.includes("/v1/admin/messages")) return { body: { messages: [] } };
      if (url.endsWith("/run-due")) return { body: { sent: 1, skipped: 0, failed: 0, retrying: 0, cancelled: 0, expired: 0, stoppedEarly: false } };
      return { body: { template: TEMPLATE } };
    });
    const client = createCommsClient({ baseUrl: "/api/app/c1/messages/", fetch: f.fetch });
    expect((await client.status()).ok).toBe(true);
    expect((await client.templates()).ok).toBe(true);
    expect((await client.saveTemplate("visit reminder/x", { subject: "S", body: "B" })).ok).toBe(true);
    expect((await client.setActive("visit_reminder", { active: false })).ok).toBe(true);
    expect((await client.messages({ limit: 50 })).ok).toBe(true);
    expect((await client.runDue()).ok).toBe(true);
    expect(f.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/app/c1/messages/v1/admin/status",
      "GET /api/app/c1/messages/v1/admin/templates",
      "POST /api/app/c1/messages/v1/admin/templates/visit%20reminder%2Fx",
      "POST /api/app/c1/messages/v1/admin/templates/visit_reminder/active",
      "GET /api/app/c1/messages/v1/admin/messages?limit=50",
      "POST /api/app/c1/messages/v1/admin/run-due",
    ]);
    expect(f.seen[2]!.body).toEqual({ subject: "S", body: "B" });
    expect(f.seen[3]!.body).toEqual({ active: false });
  });

  it("parses the shapes it is given and drops what doesn't fit", async () => {
    const f = fakeFetch(() => ({ body: { templates: [TEMPLATE, { nope: true }, { ...TEMPLATE, key: "visit_text", channel: "sms", subject: "" }] } }));
    const res = await createCommsClient({ baseUrl: "/x", fetch: f.fetch }).templates();
    expect(res.ok && res.data.templates.map((t) => [t.key, t.channel, t.subject])).toEqual([
      ["visit_reminder", "email", "Hi"],
      ["visit_text", "sms", null],
    ]);
  });

  it("a 401 is signed out, whatever the body", async () => {
    const f = fakeFetch(() => ({ status: 401, text: "Sign in", headers: { "content-type": "text/plain" } }));
    const res = await createCommsClient({ baseUrl: "/x", fetch: f.fetch }).status();
    expect(res).toEqual({ ok: false, error: { code: "forbidden", message: "You've been signed out. Sign in again to keep working.", status: 401 } });
  });

  it("the contract's error body becomes its code, message and issues", async () => {
    const f = fakeFetch(() => ({
      status: 400,
      body: { error: { code: "invalid", message: "Some details need another look.", issues: [{ path: ["subject"], message: "An email needs a subject." }] } },
    }));
    const res = await createCommsClient({ baseUrl: "/x", fetch: f.fetch }).saveTemplate("k", { subject: "", body: "b" });
    expect(res).toEqual({
      ok: false,
      error: { code: "invalid", message: "Some details need another look.", status: 400, issues: [{ path: ["subject"], message: "An email needs a subject." }] },
    });
  });

  it("an HTML page or an unknown shape is bad_response", async () => {
    const html = fakeFetch(() => ({ status: 500, text: "<html>oops</html>", headers: { "content-type": "text/html" } }));
    const res = await createCommsClient({ baseUrl: "/x", fetch: html.fetch }).status();
    expect(res.ok === false && res.error.code).toBe("bad_response");
    const weird = fakeFetch(() => ({ body: { whatever: 1 } }));
    const res2 = await createCommsClient({ baseUrl: "/x", fetch: weird.fetch }).status();
    expect(res2.ok === false && res2.error.code).toBe("bad_response");
  });

  it("a dead network is `network`, never a throw", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    const res = await createCommsClient({ baseUrl: "/x", fetch }).runDue();
    expect(res).toEqual({ ok: false, error: { code: "network", message: "Couldn't reach the server. Check your internet connection and try again.", status: 0 } });
  });
});

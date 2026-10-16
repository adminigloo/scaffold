import { describe, expect, it } from "vitest";
import { createAlertsClient } from "../client.js";

/**
 * The transport (Tenancy 2b-1, section 5): one call per route, at the right
 * address and method, never throwing: a 401 is "signed out", an HTML page or
 * a strange shape is `bad_response`, a dead network is `network`.
 */

interface Seen {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(answer: (url: string, method: string) => { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }) {
  const seen: Seen[] = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    seen.push({ url: input, method, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const a = answer(input, method);
    const payload = a.text ?? (a.body === undefined ? "" : JSON.stringify(a.body));
    return new Response(payload, { status: a.status ?? 200, headers: a.headers ?? { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const COUNT = { unread: 3, reachable: true };
const ALERT = { id: "a1", kind: "estimator.lead", category: "Estimates", title: "Pat asked", body: null, href: "/app/estimates/e1", at: "2026-10-15T15:00:00.000Z", read: false };
const LIST = { alerts: [ALERT], nextCursor: "abc", unread: 3, reachable: true, links: { inbox: "/app/alerts", settings: "/app/alerts/settings" } };
const PREFS = {
  emailAddress: "gail@x.test",
  emailAvailable: true,
  emailOffReason: null,
  categories: ["Estimates"],
  choices: [{ kind: "estimator.lead", label: "Someone asks", description: null, category: "Estimates", channel: "email", emailOffered: true, emailNote: null, emailOffInMessages: false, routed: null, receives: true, emailTo: "office@x.test" }],
  canManageRouting: true,
  reachable: true,
  links: { messages: "/app/messages" },
};
const ROUTING = {
  groups: [
    {
      key: "estimates",
      label: "New estimate requests",
      description: null,
      covers: ["Someone asks"],
      mode: "chosen",
      userIds: ["u1"],
      extraEmails: [],
      candidates: [{ userId: "u1", name: "Mo", email: "mo@x.test", isOwner: false }],
      ownerEmail: null,
      ownerEmailIsBusiness: false,
      emailNote: null,
      ownerInAppOnly: ["Someone asks"],
      ownerIsYou: false,
    },
  ],
};

describe("createAlertsClient", () => {
  it("calls every route at its address and method", async () => {
    const f = fakeFetch((url) => {
      const route = url.slice(url.indexOf("/v1/admin/") + "/v1/admin/".length);
      if (route.startsWith("count") || route.endsWith("read") || route === "read-all") return { body: COUNT };
      if (route.startsWith("alerts")) return { body: LIST };
      if (route.startsWith("preferences")) return { body: PREFS };
      return { body: ROUTING };
    });
    const client = createAlertsClient({ baseUrl: "/api/app/c1/alerts/", fetch: f.fetch });
    expect(await client.count()).toEqual({ ok: true, data: COUNT });
    expect(await client.list({ unread: true, cursor: "abc", limit: 10 })).toEqual({ ok: true, data: LIST });
    expect((await client.list()).ok).toBe(true);
    expect((await client.markRead("a/1")).ok).toBe(true);
    expect((await client.markAllRead()).ok).toBe(true);
    expect(await client.preferences()).toEqual({ ok: true, data: PREFS });
    expect((await client.setPreference({ kind: "estimator.lead", channel: "in_app" })).ok).toBe(true);
    expect(await client.routing()).toEqual({ ok: true, data: ROUTING });
    expect((await client.setRouting({ key: "estimates", mode: "owner", userIds: [], extraEmails: [] })).ok).toBe(true);
    expect(f.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/app/c1/alerts/v1/admin/count",
      "GET /api/app/c1/alerts/v1/admin/alerts?unread=1&cursor=abc&limit=10",
      "GET /api/app/c1/alerts/v1/admin/alerts",
      "POST /api/app/c1/alerts/v1/admin/alerts/a%2F1/read",
      "POST /api/app/c1/alerts/v1/admin/read-all",
      "GET /api/app/c1/alerts/v1/admin/preferences",
      "POST /api/app/c1/alerts/v1/admin/preferences",
      "GET /api/app/c1/alerts/v1/admin/routing",
      "POST /api/app/c1/alerts/v1/admin/routing",
    ]);
    expect(f.seen[6]?.body).toEqual({ kind: "estimator.lead", channel: "in_app" });
    expect(f.seen[8]?.body).toEqual({ key: "estimates", mode: "owner", userIds: [], extraEmails: [] });
  });

  it("a 401 is signed out, whatever the body", async () => {
    const f = fakeFetch(() => ({ status: 401, text: "<html>Sign in</html>", headers: { "content-type": "text/html" } }));
    const answer = await createAlertsClient({ baseUrl: "/b", fetch: f.fetch }).count();
    expect(answer).toEqual({ ok: false, error: { code: "forbidden", message: "You've been signed out. Sign in again to keep working.", status: 401 } });
  });

  it("the server's error body is read as is, issues included", async () => {
    const f = fakeFetch(() => ({ status: 400, body: { error: { code: "invalid", message: "Pick people from your company.", issues: [{ path: ["userIds"], message: "Pick people from your company." }] } } }));
    const answer = await createAlertsClient({ baseUrl: "/b", fetch: f.fetch }).setRouting({ key: "x", mode: "chosen", userIds: ["u"], extraEmails: [] });
    expect(answer).toEqual({
      ok: false,
      error: { code: "invalid", message: "Pick people from your company.", status: 400, issues: [{ path: ["userIds"], message: "Pick people from your company." }] },
    });
  });

  it("an HTML page, or a shape it doesn't know, is bad_response; a 403 keeps its status", async () => {
    const html = fakeFetch(() => ({ status: 500, text: "<html>oops</html>", headers: { "content-type": "text/html" } }));
    expect(await createAlertsClient({ baseUrl: "/b", fetch: html.fetch }).count()).toMatchObject({ ok: false, error: { code: "bad_response", status: 500 } });
    const odd = fakeFetch(() => ({ body: { nope: true } }));
    expect(await createAlertsClient({ baseUrl: "/b", fetch: odd.fetch }).list()).toMatchObject({ ok: false, error: { code: "bad_response" } });
    const gate = fakeFetch(() => ({ status: 403, text: "Not a member" }));
    expect(await createAlertsClient({ baseUrl: "/b", fetch: gate.fetch }).count()).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it("an answer it can't read is a plain sentence: never 'server', never a status code; the status stays for logs (review BO-4)", async () => {
    const cases: [number, string][] = [
      [500, "That didn't go through. Please try again in a minute."],
      [502, "That didn't go through. Please try again in a minute."],
      [504, "That didn't go through. Please try again in a minute."],
      [403, "You don't have permission to do that."],
      [404, "That isn't here."],
      [429, "That's a lot of tries at once. Please wait a minute and try again."],
    ];
    for (const [status, message] of cases) {
      const f = fakeFetch(() => ({ status, text: "<html>An error occurred</html>", headers: { "content-type": "text/html" } }));
      const answer = await createAlertsClient({ baseUrl: "/b", fetch: f.fetch }).markAllRead();
      expect(answer).toEqual({ ok: false, error: { code: "bad_response", message, status } });
    }
    const odd = await createAlertsClient({ baseUrl: "/b", fetch: fakeFetch(() => ({ body: { nope: true } })).fetch }).list();
    const dead = await createAlertsClient({
      baseUrl: "/b",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof globalThis.fetch,
    }).count();
    for (const answer of [odd, dead]) {
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.error.message).not.toMatch(/server|\d{3}/i);
    }
  });

  it("a redirect to a sign-in page is signed out", async () => {
    const fetch = (async () => {
      const res = new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    }) as unknown as typeof globalThis.fetch;
    expect(await createAlertsClient({ baseUrl: "/b", fetch }).count()).toMatchObject({ ok: false, error: { status: 401 } });
  });

  it("never throws: a dead network is `network`", async () => {
    const fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    const client = createAlertsClient({ baseUrl: "/b", fetch });
    for (const call of [client.count(), client.list(), client.markRead("x"), client.markAllRead(), client.preferences(), client.routing()]) {
      expect(await call).toEqual({ ok: false, error: { code: "network", message: "Couldn't connect. Check your internet connection and try again.", status: 0 } });
    }
  });

  it("reads defensively: an alert without a title is dropped, a missing reachable is true", async () => {
    const f = fakeFetch(() => ({ body: { ...LIST, reachable: undefined, alerts: [ALERT, { id: "x" }, null] } }));
    const answer = await createAlertsClient({ baseUrl: "/b", fetch: f.fetch }).list();
    expect(answer.ok && answer.data.alerts.map((a) => a.id)).toEqual(["a1"]);
    expect(answer.ok && answer.data.reachable).toBe(true);
  });
});

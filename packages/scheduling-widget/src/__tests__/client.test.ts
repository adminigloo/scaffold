import { describe, expect, it } from "vitest";
import { createSchedulingAdminClient } from "../admin/client.js";
import { createSchedulingClient } from "../client.js";
import { joinUrl, toClientError } from "../http.js";
import { CONFIG, publicVisit, SLOTS } from "./fakes.js";

/**
 * The transports (contract 8.1): exact URLs and methods, no custom headers on
 * a GET, JSON on a POST, and never a throw — a thrown fetch is `network`
 * (status 0), a proxy's HTML page is `bad_response`, the contract's error body
 * is its own code with its issues.
 */

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({
      url,
      method: init.method ?? "GET",
      headers: (init.headers as Record<string, string> | undefined) ?? {},
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return answer(url, init);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("joinUrl", () => {
  it("puts exactly one slash between base and path", () => {
    expect(joinUrl("/api/schedule/", "/v1/config")).toBe("/api/schedule/v1/config");
    expect(joinUrl("https://x.test/api", "v1/config")).toBe("https://x.test/api/v1/config");
  });
});

describe("createSchedulingClient", () => {
  it("asks the public routes at their exact URLs, GETs with no custom headers", async () => {
    const { fetchImpl, seen } = fakeFetch((url) =>
      url.endsWith("/config") ? json(CONFIG) : url.includes("/slots") ? json({ timeZone: "America/Denver", service: "estimate", from: "2026-10-30", to: "2026-11-12", closed: false, slots: SLOTS }) : json({ visit: publicVisit() }),
    );
    const client = createSchedulingClient({ baseUrl: "https://acme.test/api/schedule/", fetch: fetchImpl });
    const config = await client.config();
    expect(config.ok && config.data.businessName).toBe("Acme Windows");
    await client.slots({ service: "estimate", days: 14 });
    await client.slots({ manage: "tok/en+1", from: "2026-11-02" });
    await client.visit("tok/en+1");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET https://acme.test/api/schedule/v1/config",
      "GET https://acme.test/api/schedule/v1/slots?service=estimate&days=14",
      "GET https://acme.test/api/schedule/v1/slots?from=2026-11-02&manage=tok%2Fen%2B1",
      "GET https://acme.test/api/schedule/v1/visit/tok%2Fen%2B1",
    ]);
    for (const request of seen) expect(request.headers).toEqual({});
    expect(client.icsUrl("tok/en+1")).toBe("https://acme.test/api/schedule/v1/visit/tok%2Fen%2B1/ics");
  });

  it("POSTs JSON to request, reschedule and cancel", async () => {
    const { fetchImpl, seen } = fakeFetch((url) =>
      url.endsWith("/request")
        ? json({ visit: publicVisit(), manageToken: "t1", manageUrl: "https://acme.test/visit/t1", repeated: false }, 201)
        : json({ visit: publicVisit() }),
    );
    const client = createSchedulingClient({ baseUrl: "/api/schedule", fetch: fetchImpl });
    const made = await client.request({ slotId: "s1", service: "estimate", name: "Jane", email: "jane@example.com", fillMs: 4000 });
    expect(made.ok && made.data.manageToken).toBe("t1");
    await client.reschedule("t1", { slotId: "s2" });
    await client.cancel("t1", { reason: "Away" });
    expect(seen.map((s) => [s.method, s.url, s.headers["content-type"], s.body])).toEqual([
      ["POST", "/api/schedule/v1/request", "application/json", { slotId: "s1", service: "estimate", name: "Jane", email: "jane@example.com", fillMs: 4000 }],
      ["POST", "/api/schedule/v1/visit/t1/reschedule", "application/json", { slotId: "s2" }],
      ["POST", "/api/schedule/v1/visit/t1/cancel", "application/json", { reason: "Away" }],
    ]);
  });

  it("never throws: a thrown fetch is network (status 0)", async () => {
    const client = createSchedulingClient({
      baseUrl: "/api",
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    const result = await client.config();
    expect(result).toEqual({ ok: false, error: { code: "network", message: "Couldn't reach the server.", status: 0 } });
  });

  it("a proxy's HTML error page is bad_response, never a TypeError", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }));
    const client = createSchedulingClient({ baseUrl: "/api", fetch: fetchImpl });
    const result = await client.slots({ service: "estimate" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("bad_response");
    expect(!result.ok && result.error.status).toBe(502);
  });

  it("a 200 whose body isn't the contract's shape is bad_response too", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<!doctype html><p>Login</p>", { status: 200 }));
    const client = createSchedulingClient({ baseUrl: "/api", fetch: fetchImpl });
    const result = await client.visit("t");
    expect(!result.ok && result.error.code).toBe("bad_response");
    const broken = createSchedulingClient({ baseUrl: "/api", fetch: (async () => ({}) as Response) as typeof fetch });
    expect((await broken.config()).ok).toBe(false);
  });

  it("the contract's error body keeps its code, message and issues", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ error: { code: "invalid", message: "Check the form.", issues: [{ path: ["email"], message: "Enter an email." }] } }, 400),
    );
    const client = createSchedulingClient({ baseUrl: "/api", fetch: fetchImpl });
    const result = await client.request({ slotId: "s", service: "estimate", name: "J", email: "x" });
    expect(result).toEqual({
      ok: false,
      error: { code: "invalid", message: "Check the form.", status: 400, issues: [{ path: ["email"], message: "Enter an email." }] },
    });
  });

  it("toClientError tolerates junk: unknown codes become bad_response", () => {
    expect(toClientError(418, { error: { code: "teapot" } }).code).toBe("bad_response");
    expect(toClientError(409, { error: { code: "slot_unavailable", message: "Taken" } })).toEqual({ code: "slot_unavailable", message: "Taken", status: 409 });
    expect(toClientError(500, null).code).toBe("bad_response");
  });

  it("parses narrowly: a slot missing its id is dropped, the rest kept", async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ timeZone: "America/Denver", service: "estimate", from: "a", to: "b", closed: false, slots: [SLOTS[0], { date: "2026-11-02" }, "x"] }),
    );
    const client = createSchedulingClient({ baseUrl: "/api", fetch: fetchImpl });
    const result = await client.slots({ service: "estimate" });
    expect(result.ok && result.data.slots.map((s) => s.slotId)).toEqual(["s-mon-0900"]);
  });

  it("only an explicit emailsEnabled: true promises email", async () => {
    const { fetchImpl } = fakeFetch(() => json({ ...CONFIG, emailsEnabled: undefined }));
    const result = await createSchedulingClient({ baseUrl: "/api", fetch: fetchImpl }).config();
    expect(result.ok && result.data.emailsEnabled).toBe(false);
  });

  it("sends the host's own headers when given", async () => {
    const { fetchImpl, seen } = fakeFetch(() => json(CONFIG));
    await createSchedulingClient({ baseUrl: "/api", fetch: fetchImpl, headers: { "x-tenant": "acme" } }).config();
    expect(seen[0]!.headers).toEqual({ "x-tenant": "acme" });
  });
});

describe("createSchedulingAdminClient", () => {
  const visit = { id: "v 1", status: "confirmed", nextStatuses: ["in_progress", "expired"], date: "2026-11-02", startTime: "09:00", endTime: "10:00" };

  it("routes every method to its exact URL and method", async () => {
    const { fetchImpl, seen } = fakeFetch((url, init) => {
      if (url.includes("/calendar")) return json({ timeZone: "America/Denver", today: "2026-11-02", from: "2026-11-02", to: "2026-11-08", resources: [], visits: [], pending: [], windows: [], slotStepMinutes: 30 });
      if (url.includes("/crew-day")) return json({ timeZone: "UTC", date: "2026-11-02", resource: { id: "a", name: "A" }, stops: [] });
      if (url.includes("/suggest")) return json({ timeZone: "UTC", estimated: true, slots: [] });
      if (url.endsWith("/expire")) return json({ expired: 2 });
      if (url.includes("/settings")) return json({ settings: { timeZone: "UTC", services: [] } });
      if (url.includes("/availability") || url.includes("/remove")) return json({ resourceId: "a", weekly: [] });
      if (url.includes("/time-off")) return json({ resourceId: "a", weekly: [], visitsOnThoseDays: [visit] });
      if (url.includes("/resources") && init.method === "GET") return json({ resources: [{ id: "a", name: "A" }] });
      if (url.includes("/resources")) return json({ resource: { id: "a", name: "A" } });
      return json({ visit, warnings: ["Tight drive"] });
    });
    const admin = createSchedulingAdminClient({ baseUrl: "/api/admin/schedule", fetch: fetchImpl });
    await admin.calendar({ from: "2026-11-02", to: "2026-11-08", resources: ["a", "b"], includeInactive: true });
    await admin.crewDay({ date: "2026-11-02" });
    await admin.suggest({ service: "estimate", address: "1 Main St", days: 7 });
    await admin.getVisit("v 1");
    await admin.createVisit({ resourceId: null, date: "2026-11-02", startTime: "09:00" });
    await admin.accept("v 1", { notify: true });
    await admin.decline("v 1", { reason: "Full", notify: false });
    await admin.setStatus("v 1", { status: "in_progress" });
    await admin.reschedule("v 1", { date: "2026-11-03", startTime: "10:00" });
    await admin.assign("v 1", { resourceId: "b" });
    await admin.updateDetails("v 1", { notes: "Gate code 12" });
    expect((await admin.expire()).ok).toBe(true);
    await admin.getSettings();
    await admin.updateSettings({ autoConfirm: true });
    await admin.listResources({ includeInactive: true });
    await admin.createResource({ name: "Crew C" });
    await admin.updateResource("a", { name: "Crew A1" });
    await admin.deactivateResource("a");
    await admin.reactivateResource("a");
    await admin.getAvailability("a");
    await admin.setWeekly("a", { weekly: [] });
    const off = await admin.addTimeOff("a", { from: "2026-11-02", to: "2026-11-03" });
    await admin.removeTimeOff("a", "ex 1");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /api/admin/schedule/v1/admin/calendar?from=2026-11-02&to=2026-11-08&resources=a%2Cb&include=inactive",
      "GET /api/admin/schedule/v1/admin/crew-day?date=2026-11-02",
      "GET /api/admin/schedule/v1/admin/suggest?service=estimate&address=1+Main+St&days=7",
      "GET /api/admin/schedule/v1/admin/visits/v%201",
      "POST /api/admin/schedule/v1/admin/visits",
      "POST /api/admin/schedule/v1/admin/visits/v%201/accept",
      "POST /api/admin/schedule/v1/admin/visits/v%201/decline",
      "POST /api/admin/schedule/v1/admin/visits/v%201/status",
      "POST /api/admin/schedule/v1/admin/visits/v%201/reschedule",
      "POST /api/admin/schedule/v1/admin/visits/v%201/assign",
      "POST /api/admin/schedule/v1/admin/visits/v%201/details",
      "POST /api/admin/schedule/v1/admin/expire",
      "GET /api/admin/schedule/v1/admin/settings",
      "POST /api/admin/schedule/v1/admin/settings",
      "GET /api/admin/schedule/v1/admin/resources?include=inactive",
      "POST /api/admin/schedule/v1/admin/resources",
      "POST /api/admin/schedule/v1/admin/resources/a",
      "POST /api/admin/schedule/v1/admin/resources/a/deactivate",
      "POST /api/admin/schedule/v1/admin/resources/a/reactivate",
      "GET /api/admin/schedule/v1/admin/resources/a/availability",
      "POST /api/admin/schedule/v1/admin/resources/a/availability",
      "POST /api/admin/schedule/v1/admin/resources/a/time-off",
      "POST /api/admin/schedule/v1/admin/resources/a/time-off/ex%201/remove",
    ]);
    expect(off.ok && off.data.visitsOnThoseDays.map((v) => v.id)).toEqual(["v 1"]);
    for (const request of seen.filter((s) => s.method === "GET")) expect(request.headers).toEqual({});
    for (const request of seen.filter((s) => s.method === "POST")) expect(request.headers["content-type"]).toBe("application/json");
  });

  it("drops 'expired' from nextStatuses (staff never set it) and unknown statuses", async () => {
    const { fetchImpl } = fakeFetch(() => json({ visit }));
    const result = await createSchedulingAdminClient({ baseUrl: "/x", fetch: fetchImpl }).getVisit("v 1");
    expect(result.ok && result.data.visit.nextStatuses).toEqual(["in_progress"]);
  });

  it("a refusal keeps the server's plain-words reason", async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: { code: "slot_unavailable", message: "Overlaps 10:00–12:00" } }, 409));
    const result = await createSchedulingAdminClient({ baseUrl: "/x", fetch: fetchImpl }).reschedule("v", { date: "2026-11-02", startTime: "10:00" });
    expect(result).toEqual({ ok: false, error: { code: "slot_unavailable", message: "Overlaps 10:00–12:00", status: 409 } });
  });

  it("a 401 from the host's auth — plain text or its own JSON — is 'signed out', not a cryptic bad_response (RL-11)", async () => {
    const signedOut = { code: "forbidden", message: "You've been signed out. Sign in again to keep working.", status: 401 };
    for (const answer of [new Response("Unauthorized", { status: 401 }), json({ error: { code: "forbidden", message: "Sign in to see the schedule." } }, 401)]) {
      const { fetchImpl } = fakeFetch(() => answer);
      const result = await createSchedulingAdminClient({ baseUrl: "/x", fetch: fetchImpl }).calendar({ from: "2026-11-02", to: "2026-11-02" });
      expect(!result.ok && result.error).toEqual(signedOut);
    }
  });
});

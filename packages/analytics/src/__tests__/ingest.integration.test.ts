import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createAnalytics } from "../instance.js";
import { isAnalyticsError, type AnalyticsDb } from "../context.js";
import type { AnalyticsHandlerConfig } from "../ingest.js";
import { recordConversion as legacyRecordConversion } from "../legacy.js";
import { analyticsTables } from "../schema.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * The write side's promises, each pinned against the way it used to break:
 * the beacon answers 204 whatever the app's hook or reporter does, and
 * promptly; what the hook returns is checked before it is stored, and stored
 * once; a body is measured in bytes and read no further than the cap; a
 * server-side conversion honours the same privacy signals the beacon does.
 */

const NOW = new Date("2026-10-08T12:00:00Z");
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const IP = "203.0.113.7";
/** A keyed digest the way the audience's userKey(userId) makes one: HMAC-SHA256, base64url, 43 characters. */
const ACTOR_KEY = "c3RhZmYtYWN0b3Ita2V5LWhtYWMtc2hhMjU2LTAxMjM";
const s = analyticsTables.sessions;

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
  // Every write of the verdict columns is counted, and for a "verdictfail-" tenant refused —
  // a row-level trigger fires only for rows the UPDATE really writes.
  await tdb.client.exec(`
    CREATE TABLE verdict_writes (session_id text NOT NULL);
    CREATE FUNCTION verdict_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.tenant_id LIKE 'verdictfail-%' THEN RAISE EXCEPTION 'verdict write refused'; END IF;
      INSERT INTO verdict_writes (session_id) VALUES (NEW.id);
      RETURN NEW;
    END $$;
    CREATE TRIGGER verdict_write BEFORE UPDATE OF internal_reason, actor_key ON analytics_sessions
      FOR EACH ROW EXECUTE FUNCTION verdict_write();
  `);
});
afterAll(async () => {
  await tdb?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function beacon(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request("https://adminigloo.com/api/analytics", {
    method: "POST",
    headers: { origin: "https://adminigloo.com", "user-agent": CHROME, "x-forwarded-for": IP, ...headers },
    body: JSON.stringify(body),
  });
}

function handlerFor(tenantId: string, config: Partial<AnalyticsHandlerConfig> = {}, db: AnalyticsDb = tdb.db, limits = {}) {
  const errors: Array<{ error: unknown; where: string }> = [];
  const analytics = createAnalytics({ db, limits, onError: (error, where) => errors.push({ error, where }) });
  const handler = analytics.createHandler({
    tenantId,
    allowedHosts: ["adminigloo.com"],
    clientIp: (req) => req.headers.get("x-forwarded-for"),
    now: () => NOW,
    ...config,
  });
  return { analytics, handler, errors };
}

const sessionsOf = (tenantId: string) => tdb.db.select().from(s).where(eq(s.tenantId, tenantId));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

describe("the onSession hook cannot hold or fail the beacon", () => {
  it("a hook that never answers: 204 at the deadline, the page view kept, the hang reported", async () => {
    const tenantId = tenant("hang");
    const { handler, errors } = handlerFor(tenantId, { onSessionTimeoutMs: 50, onSession: () => new Promise(() => undefined) });
    const started = Date.now();
    const response = await handler.handle(beacon({ t: "pageview", d: "doc_hang_000001", p: "/" }));
    expect(response.status).toBe(204);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(errors.map((e) => e.where)).toEqual(["onSession"]);
    expect(messageOf(errors[0]!.error)).toMatch(/did not answer within 50 ms/);
    const [row] = await sessionsOf(tenantId);
    expect(row).toMatchObject({ pageViewCount: 1, internalReason: null });
  });

  it("a hook that fails after the deadline is still reported, never left unhandled", async () => {
    const tenantId = tenant("late");
    const { handler, errors } = handlerFor(tenantId, {
      onSessionTimeoutMs: 20,
      onSession: () => new Promise((_, reject) => setTimeout(() => reject(new Error("auth answered late")), 80)),
    });
    expect((await handler.handle(beacon({ t: "pageview", d: "doc_late_000001", p: "/" }))).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(errors.map((e) => [e.where, messageOf(e.error).split(";")[0]])).toEqual([
      ["onSession", "onSession did not answer within 20 ms"],
      ["onSession", "auth answered late"],
    ]);
  });

  it("refuses a timeout that is not a positive whole number of milliseconds", () => {
    for (const onSessionTimeoutMs of [0, -5, 1.5, Number.NaN]) {
      let caught: unknown;
      try {
        handlerFor(tenant("cfg"), { onSessionTimeoutMs });
      } catch (error) {
        caught = error;
      }
      expect(isAnalyticsError(caught)).toBe(true);
    }
  });

  it("a reporter that throws never turns a 204 into a 500 — after a hook failure or a database failure", async () => {
    const throwingReporter = () => {
      throw new Error("the error tracker is down too");
    };
    const tenantId = tenant("reporter");
    const analytics = createAnalytics({ db: tdb.db, onError: throwingReporter });
    const handler = analytics.createHandler({
      tenantId,
      allowedHosts: ["adminigloo.com"],
      clientIp: (req) => req.headers.get("x-forwarded-for"),
      now: () => NOW,
      onSession: () => {
        throw new Error("auth is down");
      },
    });
    expect((await handler.handle(beacon({ t: "pageview", d: "doc_report_00001", p: "/" }))).status).toBe(204);
    expect(await sessionsOf(tenantId)).toHaveLength(1);

    // A database with no tables: every write fails, and the reporter fails with it.
    const empty = new PGlite();
    try {
      const broken = createAnalytics({ db: drizzle(empty) as unknown as AnalyticsDb, onError: throwingReporter });
      const brokenHandler = broken.createHandler({ tenantId, allowedHosts: ["adminigloo.com"], clientIp: () => IP, now: () => NOW });
      expect((await brokenHandler.handle(beacon({ t: "pageview", d: "doc_report_00002", p: "/" }))).status).toBe(204);
    } finally {
      await empty.close();
    }
  });

  it("a verdict that cannot be written is reported as onSession:write — the page view stands", async () => {
    const tenantId = tenant("verdictfail");
    const { handler, errors } = handlerFor(tenantId, { onSession: () => "role" });
    expect((await handler.handle(beacon({ t: "pageview", d: "doc_vfail_000001", p: "/" }))).status).toBe(204);
    expect(errors.map((e) => e.where)).toEqual(["onSession:write"]);
    // Drizzle wraps the driver's error; the trigger's own message is its cause.
    expect(messageOf((errors[0]!.error as { cause?: unknown }).cause)).toMatch(/verdict write refused/);
    const [row] = await sessionsOf(tenantId);
    expect(row).toMatchObject({ pageViewCount: 1, internalReason: null });
  });

  it("an answer already recorded is not written again on the visit's later page views", async () => {
    const tenantId = tenant("noop");
    const answers = [{ reason: "role", actorKey: ACTOR_KEY }, { reason: "role", actorKey: ACTOR_KEY }, { reason: "role", actorKey: ACTOR_KEY }, "automation"];
    let call = 0;
    const { handler, errors } = handlerFor(tenantId, { onSession: () => answers[call++] });
    for (const p of ["/", "/a", "/b", "/c"]) await handler.handle(beacon({ t: "pageview", d: "doc_noop_000001", p }));
    expect(errors).toEqual([]);
    const [row] = await sessionsOf(tenantId);
    expect(row).toMatchObject({ pageViewCount: 4, internalReason: "role", actorKey: ACTOR_KEY });
    const writes = await tdb.client.query<{ n: number }>("SELECT count(*)::int AS n FROM verdict_writes WHERE session_id = $1", [row!.id]);
    expect(writes.rows[0]?.n).toBe(1);
  });
});

describe("what the hook returns is checked before it is stored", () => {
  it("refuses an actor key that is not a keyed digest — a Clerk id, an email, a UUID, a number — and never echoes it", async () => {
    const BAD_KEYS = [
      "user_2NNEqL2nrIRdJ194ndJqAHwEfxC", // a Clerk user id (32)
      "sam@adminigloo.com",
      "3f1c9a3e-2b7d-4c1e-9f0a-8d6b5e4c3a21", // a UUID (36)
      "12345",
      "k".repeat(129),
    ];
    for (const [i, actorKey] of BAD_KEYS.entries()) {
      const tenantId = tenant("actorkey");
      const { handler, errors } = handlerFor(tenantId, { onSession: () => ({ reason: "role", actorKey }) });
      await handler.handle(beacon({ t: "pageview", d: `doc_actor_bad_${i}0`, p: "/" }));
      const [row] = await sessionsOf(tenantId);
      expect([actorKey, row?.actorKey, row?.internalReason]).toEqual([actorKey, null, "role"]);
      expect(errors.map((e) => e.where)).toEqual(["onSession:actorKey"]);
      expect(messageOf(errors[0]!.error)).not.toContain(actorKey);
    }
    // The audience's own userKey shape, and a hex HMAC-SHA256, are kept.
    for (const [i, actorKey] of [ACTOR_KEY, "9f".repeat(32)].entries()) {
      const tenantId = tenant("actorkey");
      const { handler, errors } = handlerFor(tenantId, { onSession: () => ({ actorKey }) });
      await handler.handle(beacon({ t: "pageview", d: `doc_actor_good_${i}`, p: "/" }));
      expect((await sessionsOf(tenantId))[0]?.actorKey).toBe(actorKey);
      expect(errors).toEqual([]);
    }
  });

  it("refuses a reason that is not one verdict word (an email, a sentence)", async () => {
    for (const [i, reason] of ["sam@adminigloo.com", "Signed in as Sam Smith"].entries()) {
      const tenantId = tenant("reason");
      const { handler, errors } = handlerFor(tenantId, { onSession: () => reason });
      await handler.handle(beacon({ t: "pageview", d: `doc_reason_bad_${i}`, p: "/" }));
      expect((await sessionsOf(tenantId))[0]?.internalReason).toBeNull();
      expect(errors.map((e) => e.where)).toEqual(["onSession:reason"]);
      expect(messageOf(errors[0]!.error)).not.toContain(reason);
    }
  });

  it("a browser that sent GPC is never linked to an account, even where the app counts it", async () => {
    const tenantId = tenant("gpc");
    const { handler } = handlerFor(tenantId, { honorPrivacySignals: false, onSession: () => ({ reason: "role", actorKey: ACTOR_KEY }) });
    await handler.handle(beacon({ t: "pageview", d: "doc_gpc_0000001", p: "/" }, { "sec-gpc": "1" }));
    const [row] = await sessionsOf(tenantId);
    expect(row).toMatchObject({ internalReason: "role", actorKey: null });
  });
});

describe("the beacon body", () => {
  it("is capped in bytes, not characters", async () => {
    const tenantId = tenant("bytes");
    const { handler } = handlerFor(tenantId, {}, tdb.db, { maxBodyBytes: 200 });
    // ~141 characters, ~241 bytes: under the cap by length, over it in bytes.
    const wide = JSON.stringify({ t: "pageview", d: "doc_bytes_000001", p: `/${"é".repeat(100)}` });
    expect(wide.length).toBeLessThan(200);
    expect(new TextEncoder().encode(wide).byteLength).toBeGreaterThan(200);
    await handler.handle(beacon(JSON.parse(wide) as Record<string, unknown>));
    expect(await sessionsOf(tenantId)).toHaveLength(0);
    // The same length in one-byte characters is kept.
    await handler.handle(beacon({ t: "pageview", d: "doc_bytes_000002", p: `/${"e".repeat(100)}` }));
    expect(await sessionsOf(tenantId)).toHaveLength(1);
  });

  /** A body that counts how often it is read from. */
  function countingBody(chunks: number, chunkBytes: number) {
    const state = { pulls: 0 };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          state.pulls += 1;
          controller.enqueue(new TextEncoder().encode("x".repeat(chunkBytes)));
          if (state.pulls >= chunks) controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    return { stream, state };
  }

  function streamed(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
    return new Request("https://adminigloo.com/api/analytics", {
      method: "POST",
      headers: { origin: "https://adminigloo.com", "user-agent": CHROME, "x-forwarded-for": IP, ...headers },
      body: stream,
      duplex: "half",
    } as RequestInit);
  }

  it("a declared Content-Length over the cap is dropped without reading a byte", async () => {
    const tenantId = tenant("declared");
    const { handler } = handlerFor(tenantId);
    const { stream, state } = countingBody(5, 100);
    expect((await handler.handle(streamed(stream, { "content-length": "999999" }))).status).toBe(204);
    expect(state.pulls).toBe(0);
    expect(await sessionsOf(tenantId)).toHaveLength(0);
  });

  it("a body that turns out larger is cut off as soon as it passes the cap", async () => {
    const tenantId = tenant("undeclared");
    const { handler } = handlerFor(tenantId, {}, tdb.db, { maxBodyBytes: 200 });
    const { stream, state } = countingBody(50, 100);
    expect((await handler.handle(streamed(stream))).status).toBe(204);
    expect(state.pulls).toBe(3);
    expect(await sessionsOf(tenantId)).toHaveLength(0);
  });
});

describe("server-side conversions honour the visitor's privacy signals", () => {
  it("an opted-out request records nothing, though a visit with its key is live", async () => {
    const tenantId = tenant("conv");
    const { analytics, handler } = handlerFor(tenantId);
    await handler.handle(beacon({ t: "pageview", d: "doc_conv_0000001", p: "/pricing" }));
    const base = { tenantId, ip: IP, userAgent: CHROME, name: "call_booked", at: NOW };

    expect(await analytics.recordConversion({ ...base, headers: new Headers({ "sec-gpc": "1" }) })).toBeNull();
    expect(await analytics.recordConversion({ ...base, headers: { get: (name: string) => (name === "dnt" ? "1" : null) } })).toBeNull();
    expect(await analytics.recordConversion({ ...base, privacyOptOut: true })).toBeNull();
    expect(await legacyRecordConversion(tdb.db, { ...base, headers: new Headers({ "sec-gpc": "1" }) })).toBe(false);
    const events = await tdb.db.select().from(analyticsTables.events).where(eq(analyticsTables.events.tenantId, tenantId));
    expect(events).toEqual([]);
    expect((await sessionsOf(tenantId))[0]?.converted).toBe(false);

    // A request that did not opt out, or an app that counts opted-out requests, records it.
    expect(await analytics.recordConversion({ ...base, headers: new Headers({ "user-agent": CHROME }) })).not.toBeNull();
    expect(await analytics.recordConversion({ ...base, headers: new Headers({ "sec-gpc": "1" }), honorPrivacySignals: false })).not.toBeNull();
    const [row] = await tdb.db.select({ converted: s.converted }).from(s).where(and(eq(s.tenantId, tenantId)));
    expect(row?.converted).toBe(true);
  });
});

describe("the default reporter", () => {
  it("logs a failure that repeats on every beacon once a minute, not once per beacon", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const empty = new PGlite();
    try {
      // No onError: the default. A database with no tables fails every beacon the same way.
      const analytics = createAnalytics({ db: drizzle(empty) as unknown as AnalyticsDb });
      const handler = analytics.createHandler({ tenantId: "site", allowedHosts: ["adminigloo.com"], clientIp: () => IP, now: () => NOW });
      for (let i = 0; i < 3; i++) expect((await handler.handle(beacon({ t: "pageview", d: `doc_quiet_00000${i}`, p: "/" }))).status).toBe(204);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("beacon");
      // The driver's reason is in the line, not hidden behind Drizzle's "Failed query".
      expect(String(warn.mock.calls[0]?.[1])).toMatch(/does not exist/);
    } finally {
      await empty.close();
    }
  });

  it("the same failure for different visitors is one failure (per-request params do not defeat the quiet minute)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { tableDdl } = await import("./pglite.js");
    const partial = new PGlite();
    try {
      // Only the salts: keys resolve, then the throttle write fails with each network's own key in its params.
      for (const statement of tableDdl([analyticsTables.salts])) await partial.exec(statement);
      const analytics = createAnalytics({ db: drizzle(partial) as unknown as AnalyticsDb });
      const handler = analytics.createHandler({ tenantId: "site", allowedHosts: ["adminigloo.com"], clientIp: (req) => req.headers.get("x-forwarded-for"), now: () => NOW });
      for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
        await handler.handle(beacon({ t: "pageview", d: "doc_quiet_params", p: "/" }, { "x-forwarded-for": ip }));
      }
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await partial.close();
    }
  });

  it("license mode warn never denies, and says so once per instance", async () => {
    const errors: Array<{ error: unknown; where: string }> = [];
    const analytics = createAnalytics({ db: tdb.db, license: { mode: "warn" }, onError: (error, where) => errors.push({ error, where }) });
    const q = { tenantId: tenant("warn"), from: new Date("2026-10-08T00:00:00Z"), to: new Date("2026-10-09T00:00:00Z") };
    expect((await analytics.getOverview(q)).visits.current).toBe(0);
    expect((await analytics.getSources(q)).length).toBe(8);
    expect(errors.map((e) => e.where)).toEqual(["license"]);
    expect(isAnalyticsError(errors[0]!.error)).toBe(true);
    // "off" stays silent.
    const quiet: unknown[] = [];
    await createAnalytics({ db: tdb.db, license: { mode: "off" }, onError: (error) => quiet.push(error) }).getOverview(q);
    expect(quiet).toEqual([]);
  });
});


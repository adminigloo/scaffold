import { aiUsage } from "@adminigloo/ai/schema";
import { releaseAiReservation, reserveAiAllowance, settleAiReservation } from "@adminigloo/ai/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AnswerEngine, EngineAnswer } from "../engines.js";
import { createAeoHandlers, type CreateAeoHandlersOptions } from "../handlers.js";
import { AEO_ADMIN_ROUTES } from "../routes.js";
import type { MentionSpend } from "../runner.js";
import { addQuestion, checkCosts, deactivateQuery, getQuery, listChecks, saveProfile, type AeoDb } from "../store.js";
import type { MentionsOverviewWire, QuestionDetailWire, RunResultWire } from "../wire.js";
import { createTestDb, tableDdl } from "./pglite.js";

/**
 * EACH COMPANY'S AI MENTIONS ARE ITS OWN, AND EVERY ANSWER IS PAID FOR ONCE
 * (0.2), on a real Postgres: another company's question is "not found" for
 * every route; every answer is held before it's asked, settled with the
 * provider's counts and the web-search fees after (on @adminigloo/ai's real
 * ledger in the last block); a closed plan, a used-up month or a missing
 * engine asks nothing. The engine is a fake: no paid call is made.
 */

let db: AeoDb;
let close: () => Promise<void>;
beforeAll(async () => {
  const test = await createTestDb();
  db = test.db;
  close = test.close;
  for (const statement of tableDdl([aiUsage])) await test.client.exec(statement);
});
afterAll(() => close());

/** A scripted engine: answers name whoever the question says, and counts what it was asked. */
function fakeEngine(script: (question: string) => Partial<EngineAnswer> | Promise<Partial<EngineAnswer>> = () => ({})): AnswerEngine & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    key: "claude",
    label: "Claude",
    model: "claude-haiku-4-5",
    worstCaseMicros: 75_120n,
    feesMicros: (usage) => BigInt(usage.webSearches) * 10_000n,
    async ask(question) {
      asked.push(question);
      const scripted = await script(question);
      return {
        text: scripted.text ?? `For ${question}, try Ramp Masters or TruGreen.`,
        citedUrls: scripted.citedUrls ?? ["https://rampmasters.com/rentals"],
        usage: scripted.usage ?? { model: "claude-haiku-4-5", inputTokens: 10_000, outputTokens: 200, cachedInputTokens: 0, cachedWriteTokens: 0, webSearches: 2, reported: true },
      };
    },
  };
}

/** An in-memory ledger that says what happened, in order. */
function fakeSpend(limit = Infinity): MentionSpend & { log: string[] } {
  const log: string[] = [];
  let held = 0;
  return {
    log,
    async reserve({ tenantId }) {
      if (held >= limit) {
        log.push(`refuse ${tenantId}`);
        return { ok: false, message: "This month's AI mention checks are used up." };
      }
      held += 1;
      log.push(`reserve ${tenantId}`);
      return { ok: true, reservationId: `r${held}` };
    },
    async settle(id, outcome) {
      log.push(`settle ${id} ${outcome.status} fees=${outcome.usage?.feesMicros ?? "none"}`);
      return { costMicros: outcome.usage ? 1_000n + outcome.usage.feesMicros : null };
    },
    async release(id) {
      log.push(`release ${id}`);
    },
  };
}

function handlers(overrides: Partial<CreateAeoHandlersOptions> = {}) {
  return createAeoHandlers({
    db,
    resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
    authorize: () => ({ userId: "u1" }),
    engine: fakeEngine(),
    spend: fakeSpend(),
    ...overrides,
  });
}

function call(h: ReturnType<typeof handlers>, tenantId: string, path: string, body?: unknown) {
  return h.handle(
    new Request(`http://app.test/api/app/${tenantId}/ai-mentions/${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
  );
}

async function company(tenantId: string, brand: string, question: string) {
  await saveProfile(db, tenantId, { brand, domain: `${brand.toLowerCase().replace(/\s+/g, "")}.com`, competitors: ["TruGreen"] });
  return addQuestion(db, tenantId, question);
}

describe("a company's AI mentions", () => {
  it("checks its questions, reads the answer in code, and keeps the result as its own", async () => {
    const q = await company("alpha", "Ramp Masters", "wheelchair ramp rental Raleigh");
    const engine = fakeEngine();
    const spend = fakeSpend();
    const res = await call(handlers({ engine, spend }), "alpha", "v1/check", {});
    expect(res.status, await res.clone().text()).toBe(200);
    const run = (await res.json()) as RunResultWire;
    expect(run).toMatchObject({ checked: 1, cited: 1, failed: 0, waiting: 0, stopped: null });
    expect(engine.asked).toEqual(["wheelchair ramp rental Raleigh"]);
    // Held before it was asked, settled after — with the two searches' fees.
    expect(spend.log).toEqual(["reserve alpha", "settle r1 completed fees=20000"]);
    const latest = run.overview.questions.find((x) => x.id === q.id)!.latest!;
    expect(latest).toMatchObject({ cited: true, mentioned: true, sourceCited: true, matchedUrl: "https://rampmasters.com/rentals", competitorsNamed: ["TruGreen"] });
    expect(latest.snippet).toContain("Ramp Masters");
    const thisWeek = run.overview.questions[0]!.trend.at(-1)!;
    expect(thisWeek).toMatchObject({ checks: 1, cited: 1 });
    const [row] = await listChecks(db, "alpha", q.id);
    expect(row?.costMicros).toBe(21_000n);
  });

  it("another company's question is “not found” on every route, and changes nothing", async () => {
    const a = await company("acme", "Acme Ramps", "acme ramp question");
    await company("bravo", "Bravo Glass", "bravo glass question");
    const engine = fakeEngine();
    const spend = fakeSpend();
    const h = handlers({ engine, spend });
    for (const route of AEO_ADMIN_ROUTES.filter((r) => r.path.includes("{question}"))) {
      const res = await call(h, "bravo", route.path.replace("{question}", a.id), route.method === "POST" ? {} : undefined);
      expect(res.status, route.kind).toBe(404);
      expect(await res.text(), route.kind).not.toContain("acme");
    }
    expect(engine.asked).toEqual([]);
    expect(spend.log).toEqual([]);
    expect(await getQuery(db, "acme", a.id)).not.toBeNull();
    expect(await deactivateQuery(db, "bravo", a.id)).toBe(false);
    expect(await listChecks(db, "bravo", a.id)).toEqual([]);
    const overview = (await (await call(h, "bravo", "v1/mentions")).json()) as MentionsOverviewWire;
    expect(JSON.stringify(overview)).not.toMatch(/acme/i);
    // And the check can fail: Acme sees and removes its own.
    expect((await call(h, "acme", `v1/questions/${a.id}`)).status).toBe(200);
    expect((await call(h, "acme", `v1/questions/${a.id}/remove`, {})).status).toBe(200);
  });

  it("drives every route in AEO_ADMIN_ROUTES for the company itself", async () => {
    const q = await company("charlie", "Charlie Ramps", "charlie question");
    for (const route of AEO_ADMIN_ROUTES) {
      const res = await call(handlers(), "charlie", route.path.replace("{question}", q.id), route.method === "POST" ? (route.body ?? {}) : undefined);
      expect([200, 201], route.kind).toContain(res.status);
    }
  });

  it("asks nothing when checking is off, the plan is closed, Check now is pressed too often, or the month is used up", async () => {
    await company("delta", "Delta Ramps", "delta question");
    const off = await call(handlers({ engine: null, spend: undefined }), "delta", "v1/check", {});
    expect(off.status).toBe(409);
    expect(((await off.json()) as { error: { code: string } }).error.code).toBe("off");
    const engine = fakeEngine();
    const spend = fakeSpend();
    expect((await call(handlers({ engine, spend, admit: () => "This company's plan has ended." }), "delta", "v1/check", {})).status).toBe(403);
    expect((await call(handlers({ engine, spend, rateLimit: () => "Give it a minute." }), "delta", "v1/check", {})).status).toBe(429);
    expect(engine.asked).toEqual([]);
    expect(spend.log).toEqual([]);
    const usedUp = fakeSpend(0);
    const refused = await call(handlers({ engine, spend: usedUp }), "delta", "v1/check", {});
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("This month's AI mention checks are used up.");
    expect(engine.asked).toEqual([]);
  });

  it("refuses an engine without metering at construction", () => {
    expect(() => createAeoHandlers({ db, tenantId: "*", authorize: () => true, engine: fakeEngine() })).toThrow(/unmetered/);
  });

  it("stops at the deadline, releasing a hold it didn't use, and says the rest wait", async () => {
    await company("echo", "Echo Ramps", "echo one");
    await addQuestion(db, "echo", "echo two");
    await addQuestion(db, "echo", "echo three");
    let clock = 0;
    const spend = fakeSpend();
    const engine = fakeEngine(async () => {
      clock += 30_000;
      return {};
    });
    const h = handlers({ engine, spend, budgetMs: 45_000, callTimeoutMs: 20_000, now: () => new Date(Date.UTC(2026, 9, 17) + clock) });
    const run = (await (await call(h, "echo", "v1/check", {})).json()) as RunResultWire;
    expect(run.checked).toBe(1);
    expect(run.waiting).toBe(2);
    expect(run.stopped).toMatch(/Out of time/);
    expect(engine.asked).toHaveLength(1);
    // Two holds were taken at once; the second came back with too little time left, so it was given back unused.
    expect([...spend.log].sort()).toEqual(["release r2", "reserve echo", "reserve echo", "settle r1 completed fees=20000"]);
  });

  it("keeps an answer that didn't come as failed, and settles its hold as errored", async () => {
    await company("foxtrot", "Foxtrot Ramps", "foxtrot question");
    const spend = fakeSpend();
    const engine = fakeEngine(() => {
      throw new Error("529 overloaded");
    });
    const run = (await (await call(handlers({ engine, spend }), "foxtrot", "v1/check", {})).json()) as RunResultWire;
    expect(run).toMatchObject({ checked: 0, failed: 1 });
    expect(spend.log).toEqual(["reserve foxtrot", "settle r1 errored fees=none"]);
    expect(run.overview.questions[0]?.latest).toMatchObject({ status: "failed", cited: false });
    expect(run.overview.questions[0]?.latest?.problem).toMatch(/didn't answer/);
  });

  it("the weekly job asks only questions not answered this week, and nothing for a closed plan", async () => {
    await company("golf", "Golf Ramps", "golf question");
    const engine = fakeEngine();
    const h = handlers({ engine });
    expect(await h.runScheduled("golf")).toMatchObject({ ran: true, checked: 1 });
    expect(await h.runScheduled("golf")).toEqual({ ran: false, reason: "nothing_due" });
    expect(engine.asked).toHaveLength(1);
    expect(await handlers({ admit: () => "closed" }).runScheduled("golf")).toEqual({ ran: false, reason: "closed" });
    expect(await handlers().runScheduled("no-profile-co")).toEqual({ ran: false, reason: "no_profile" });
  });

  it("saves who the business is in plain words, and refuses what isn't a web address", async () => {
    const h = handlers();
    const saved = await call(h, "hotel", "v1/profile", { brand: "  Hotel   Ramps ", domain: "https://www.HotelRamps.com/contact", aliases: "Hotel, HR Ramps", competitors: ["TruGreen", "TruGreen"] });
    expect(((await saved.json()) as { profile: unknown }).profile).toMatchObject({ brand: "Hotel Ramps", domain: "hotelramps.com", aliases: ["Hotel", "HR Ramps"], competitors: ["TruGreen"] });
    const bad = await call(h, "hotel", "v1/profile", { brand: "Hotel", domain: "not a site" });
    expect(bad.status).toBe(400);
    const dup = await call(h, "hotel", "v1/questions", { question: "ramp rental" });
    expect(dup.status).toBe(201);
    expect((await call(h, "hotel", "v1/questions", { question: "Ramp   Rental" })).status).toBe(400);
    const detail = (await (await call(h, "hotel", `v1/questions/${((await dup.json()) as { question: { id: string } }).question.id}`)).json()) as QuestionDetailWire;
    expect(detail.question.question).toBe("ramp rental");
  });
});

describe("review fixes (M1, M2, M4, L5)", () => {
  it("releases a hold whose call it stopped at its time limit, and charges nothing", async () => {
    await company("juliet", "Juliet Ramps", "juliet question");
    const spend = fakeSpend();
    const engine = fakeEngine(() => new Promise<never>(() => undefined));
    const slow: AnswerEngine = {
      ...engine,
      ask: (_q, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    };
    const run = (await (await call(handlers({ engine: slow, spend, callTimeoutMs: 1_000, budgetMs: 10_000 }), "juliet", "v1/check", {})).json()) as RunResultWire;
    expect(run).toMatchObject({ checked: 0, failed: 1 });
    expect(spend.log).toEqual(["reserve juliet", "release r1"]);
    expect(run.overview.questions[0]?.latest?.problem).toMatch(/took too long/);
  });

  it("never starts a call whose time limit doesn't fit before the deadline", async () => {
    await company("kilo", "Kilo Ramps", "kilo question");
    const engine = fakeEngine();
    const spend = fakeSpend();
    // 2.5 s for the run: even the shortest call (1 s) and the 2 s margin don't fit, so nothing starts and nothing is held.
    const fixed = new Date(Date.UTC(2026, 9, 17, 12));
    const run = (await (await call(handlers({ engine, spend, budgetMs: 2_500, callTimeoutMs: 2_500, now: () => fixed }), "kilo", "v1/check", {})).json()) as RunResultWire;
    expect(engine.asked).toEqual([]);
    expect(spend.log).toEqual([]);
    expect(run.waiting).toBe(1);
  });

  it("holds the plan's question limit, also for adds sent at once, in plain words", async () => {
    await saveProfile(db, "lima", { brand: "Lima Ramps" });
    const h = handlers({ questionLimit: () => 2 });
    const results = await Promise.all(["one", "two", "three", "four"].map((q) => call(h, "lima", "v1/questions", { question: `lima ${q}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const refused = results.find((r) => r.status === 409)!;
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Your plan tracks up to 2 questions. Remove one to add another, or choose a bigger plan.");
    const overview = (await (await call(h, "lima", "v1/mentions")).json()) as MentionsOverviewWire;
    expect(overview.maxQuestions).toBe(2);
  });

  it("the weekly job skips a company whose month is used up without holding anything, and the screen says so", async () => {
    await company("mike", "Mike Ramps", "mike question");
    const engine = fakeEngine();
    const spend = fakeSpend();
    const h = handlers({ engine, spend, automatic: true, allowanceNotice: () => "This month's AI mention checks are used up. They start again on November 1." });
    expect(await h.runScheduled("mike")).toEqual({ ran: false, reason: "used_up" });
    expect(spend.log).toEqual([]);
    const overview = (await (await call(h, "mike", "v1/mentions")).json()) as MentionsOverviewWire;
    expect(overview.notice).toMatch(/used up/);
    expect(overview.automatic).toBe(true);
    expect(overview.questions[0]?.nextAutomaticAt).not.toBeNull();
  });

  it("measures the real cost per check", async () => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const all = await checkCosts(db, { since });
    expect(all.checks).toBeGreaterThan(0);
    expect(BigInt(all.averageMicros!)).toBeGreaterThan(0n);
    expect(await checkCosts(db, { since, tenantId: "nobody" })).toEqual({ checks: 0, totalMicros: "0", averageMicros: null });
  });
});

describe("on @adminigloo/ai's real ledger", () => {
  const RATES = { "claude-haiku-4-5": { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 } };
  function ledgerSpend(monthlyChecks: number): MentionSpend {
    const allowance = { tenantId: "", operations: ["aeo_check"], allowance: { monthlyMessages: monthlyChecks, monthlyCents: 1_000 }, siteDailyCents: 500 };
    return {
      async reserve({ tenantId, userId, model, reserveMicros }) {
        const verdict = await reserveAiAllowance(db, { ...allowance, tenantId, userId, operation: "aeo_check", model, reserveMicros });
        return verdict.ok ? { ok: true, reservationId: verdict.reservationId } : { ok: false, message: verdict.message };
      },
      async settle(id, outcome) {
        const settled = await settleAiReservation(db, RATES, id, {
          usage: outcome.usage ? { ...outcome.usage, reported: outcome.usage.reported } : null,
          status: outcome.status,
          latencyMs: outcome.latencyMs,
        });
        return { costMicros: settled.costMicros };
      },
      release: (id) => releaseAiReservation(db, id),
    };
  }

  it("holds the worst case, settles tokens AND web searches, and stops at the month's checks", async () => {
    await company("india", "India Ramps", "india question one");
    await addQuestion(db, "india", "india question two");
    const engine = fakeEngine();
    const run = (await (await call(handlers({ engine, spend: ledgerSpend(1) }), "india", "v1/check", {})).json()) as RunResultWire;
    expect(run.checked).toBe(1);
    expect(run.waiting).toBe(1);
    expect(run.stopped).toMatch(/allowance is used up/);
    const rows = await db.select().from(aiUsage).where(eq(aiUsage.tenantId, "india"));
    expect(rows).toHaveLength(1);
    // 10,000 in × $1/M = 10,000 micros; 200 out × $5/M = 1,000; 2 searches × 10,000.
    expect(rows[0]).toMatchObject({ status: "completed", operation: "aeo_check", costMicros: 31_000n, inputTokens: 10_000, outputTokens: 200 });
    const [check] = await listChecks(db, "india", run.overview.questions[0]!.id);
    expect(check?.costMicros).toBe(31_000n);
  });
});

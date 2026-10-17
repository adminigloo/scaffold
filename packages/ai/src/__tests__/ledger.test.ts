import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  aiCallCostMicros,
  aiSpendSince,
  checkAiAllowance,
  DEFAULT_AI_MODEL,
  recordAiUsage,
  releaseAiReservation,
  reserveAiAllowance,
  settleAiReservation,
  startOfMonthUtc,
  startOfNextMonthUtc,
  sweepStaleReservations,
  type AiDb,
  type AiRates,
} from "../server.js";
import { DEFAULT_AI_MODEL as ROOT_DEFAULT } from "../index.js";
import { aiUsage } from "../schema.js";
import { createTestDb, type TestDb } from "./pglite.js";

/**
 * THE LEDGER (0.2.0), on a real Postgres: costs come from the provider's token
 * counts and the app's rate table — never from a model — and the allowance is
 * counted from the rows themselves, per company, and refuses in plain words,
 * failing closed when it can't count.
 */

const RATES: AiRates = {
  // Claude Haiku 4.5: $1 in, $5 out, cache reads a tenth, cache writes 1.25x.
  "claude-haiku-4-5": {
    inputMicrosPerMTok: 1_000_000,
    outputMicrosPerMTok: 5_000_000,
    cachedInputMicrosPerMTok: 100_000,
    cachedWriteMicrosPerMTok: 1_250_000,
  },
};

const NOW = new Date("2026-10-16T15:00:00Z");

let t: TestDb;
let db: AiDb;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await db.execute(sql`delete from ai_usage`);
});

async function used(tenantId: string, input: number, output: number, operation = "assistant_chat", at: Date = NOW) {
  await recordAiUsage(db, RATES, {
    tenantId,
    userId: "u1",
    operation,
    usage: { model: DEFAULT_AI_MODEL, inputTokens: input, outputTokens: output, reported: true },
    status: "completed",
  });
  // Date the row the test just wrote, so a month or a day boundary can be checked.
  await db.execute(sql`update ai_usage set created_at = ${at.toISOString()} where id = (select max(id) from ai_usage)`);
}

describe("the default model", () => {
  it("is Claude Haiku 4.5, the cheapest capable model, from both entries", () => {
    expect(DEFAULT_AI_MODEL).toBe("claude-haiku-4-5");
    expect(ROOT_DEFAULT).toBe(DEFAULT_AI_MODEL);
  });
});

describe("recordAiUsage: the cost is code's, from the provider's counts", () => {
  it("prices every kind of token in integer micros, cache writes included", async () => {
    const out = await recordAiUsage(db, RATES, {
      tenantId: "green-acres",
      userId: "u1",
      operation: "assistant_chat",
      usage: {
        model: DEFAULT_AI_MODEL,
        inputTokens: 1_000,
        outputTokens: 200,
        cachedInputTokens: 2_000,
        cachedWriteTokens: 400,
        reported: true,
      },
      status: "completed",
      latencyMs: 812,
    });
    // 1000×1 + 200×5 + 2000×0.1 + 400×1.25 = 1000 + 1000 + 200 + 500 micros.
    expect(out).toEqual({ recorded: true, costMicros: 2_700n });
    const [row] = await db.select().from(aiUsage);
    expect(row).toMatchObject({
      tenantId: "green-acres",
      operation: "assistant_chat",
      inputTokens: 1_000,
      outputTokens: 200,
      cachedInputTokens: 2_000,
      cachedWriteTokens: 400,
      costMicros: 2_700n,
      latencyMs: 812,
      status: "completed",
    });
  });

  it("writes an unknown cost (null), never zero, when the provider didn't report or the model isn't priced", () => {
    expect(aiCallCostMicros(RATES, { model: DEFAULT_AI_MODEL, inputTokens: 0, outputTokens: 0, reported: false })).toBeNull();
    expect(aiCallCostMicros(RATES, { model: "some-new-model", inputTokens: 10, outputTokens: 10, reported: true })).toBeNull();
  });

  it("adds a call's fees beyond tokens (0.3: web searches), and never subtracts a negative one", () => {
    const tokens = aiCallCostMicros(RATES, { model: DEFAULT_AI_MODEL, inputTokens: 1_000, outputTokens: 200, reported: true })!;
    expect(aiCallCostMicros(RATES, { model: DEFAULT_AI_MODEL, inputTokens: 1_000, outputTokens: 200, reported: true, feesMicros: 20_000n })).toBe(tokens + 20_000n);
    expect(aiCallCostMicros(RATES, { model: DEFAULT_AI_MODEL, inputTokens: 1_000, outputTokens: 200, reported: true, feesMicros: -5n })).toBe(tokens);
    // Unknown stays unknown, fees or not.
    expect(aiCallCostMicros(RATES, { model: DEFAULT_AI_MODEL, inputTokens: 0, outputTokens: 0, reported: false, feesMicros: 20_000n })).toBeNull();
  });

  it("never throws when the row can't be written, and says so to onError", async () => {
    const broken = {
      insert: () => {
        throw new Error("pool exhausted");
      },
    } as unknown as AiDb;
    const seen: unknown[] = [];
    const out = await recordAiUsage(
      broken,
      RATES,
      {
        tenantId: "x",
        userId: null,
        operation: "assistant_chat",
        usage: { model: DEFAULT_AI_MODEL, inputTokens: 1, outputTokens: 1, reported: true },
        status: "completed",
      },
      { onError: (error) => seen.push(error) },
    );
    expect(out.recorded).toBe(false);
    expect(seen).toHaveLength(1);
  });
});

describe("aiSpendSince: per company, or the whole site", () => {
  it("sums one company only, and rounds to cents once, on the total", async () => {
    await used("a", 1_000_000, 0); // $1.00
    await used("a", 0, 100_000); // $0.50
    await used("b", 1_000_000, 0);
    const a = await aiSpendSince(db, { tenantId: "a", since: startOfMonthUtc(NOW) });
    expect(a).toMatchObject({ micros: "1500000", minorUnits: "150", requests: 2 });
    const site = await aiSpendSince(db, { since: startOfMonthUtc(NOW) });
    expect(site).toMatchObject({ micros: "2500000", requests: 3 });
    expect((await aiSpendSince(db, { tenantId: "nobody", since: startOfMonthUtc(NOW) })).micros).toBe("0");
  });

  it("counts only the operations asked for", async () => {
    await used("a", 1_000, 0, "assistant_chat");
    await used("a", 1_000, 0, "estimator_takeoff");
    const spend = await aiSpendSince(db, { tenantId: "a", since: startOfMonthUtc(NOW), operations: ["assistant_chat"] });
    expect(spend.requests).toBe(1);
  });
});

describe("checkAiAllowance: a company's month, the site's day, failing closed", () => {
  const allowance = { monthlyMessages: 3, monthlyCents: 100 };
  const ops = ["assistant_chat"];

  it("lets a company in while it's inside its month, with the numbers code counted", async () => {
    await used("a", 1_000, 100);
    const verdict = await checkAiAllowance(db, { tenantId: "a", operations: ops, allowance, siteDailyCents: 500, now: NOW });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.usage).toMatchObject({ messages: 1, messageLimit: 3, centLimit: 100, cents: "0" });
      expect(verdict.usage.resetsAt).toEqual(startOfNextMonthUtc(NOW));
    }
  });

  it("refuses the message after the month's last, in a plain sentence, and lets the company next door in", async () => {
    for (let i = 0; i < 3; i++) await used("a", 10, 10);
    const a = await checkAiAllowance(db, { tenantId: "a", operations: ops, allowance, siteDailyCents: null, now: NOW });
    expect(a).toMatchObject({ ok: false, reason: "company_messages" });
    if (!a.ok) expect(a.message).toBe("This month's assistant allowance is used up (3 messages). It starts again on November 1.");
    const b = await checkAiAllowance(db, { tenantId: "b", operations: ops, allowance, siteDailyCents: null, now: NOW });
    expect(b.ok).toBe(true);
  });

  it("refuses once the month's cents are spent, compared in micros", async () => {
    const byCents = { monthlyMessages: null, monthlyCents: 100 };
    await used("a", 999_000, 0); // 99.9 cents: inside a 100-cent month
    expect((await checkAiAllowance(db, { tenantId: "a", operations: ops, allowance: byCents, siteDailyCents: null, now: NOW })).ok).toBe(true);
    await used("a", 1_000, 0); // 100.0 cents
    const verdict = await checkAiAllowance(db, { tenantId: "a", operations: ops, allowance: byCents, siteDailyCents: null, now: NOW });
    expect(verdict).toMatchObject({ ok: false, reason: "company_spend" });
  });

  it("starts again on the first of the month (last month's messages don't count)", async () => {
    for (let i = 0; i < 3; i++) await used("a", 10, 10, "assistant_chat", new Date("2026-09-30T23:00:00Z"));
    expect((await checkAiAllowance(db, { tenantId: "a", operations: ops, allowance, siteDailyCents: null, now: NOW })).ok).toBe(true);
  });

  it("refuses every company once the SITE's day is spent, whatever their own month says", async () => {
    await used("big-spender", 5_000_000, 0, "chat"); // $5 today, on another operation
    const verdict = await checkAiAllowance(db, { tenantId: "small", operations: ops, allowance, siteDailyCents: 500, now: NOW });
    expect(verdict).toMatchObject({
      ok: false,
      reason: "site_ceiling",
      message: "This site's AI has reached its limit for today — that's the whole site, not just your account. It starts again at midnight UTC (October 17).",
      usage: { limitedBy: "site", siteResetsAt: new Date("2026-10-17T00:00:00Z") },
    });
    // Yesterday's spend doesn't count against today.
    await db.execute(sql`update ai_usage set created_at = ${new Date("2026-10-15T12:00:00Z").toISOString()}`);
    expect((await checkAiAllowance(db, { tenantId: "small", operations: ops, allowance, siteDailyCents: 500, now: NOW })).ok).toBe(true);
  });

  it("FAILS CLOSED: a ledger it can't read refuses rather than lets the call through", async () => {
    const down = {
      select: () => {
        throw new Error("connection refused");
      },
    } as unknown as AiDb;
    const verdict = await checkAiAllowance(down, { tenantId: "a", operations: ops, allowance, siteDailyCents: 500, now: NOW });
    expect(verdict).toMatchObject({ ok: false, reason: "unavailable" });
    if (!verdict.ok) expect(verdict.message).toMatch(/can't check its allowance right now/);
  });

  it("takes the product's own words", async () => {
    for (let i = 0; i < 3; i++) await used("a", 10, 10);
    const verdict = await checkAiAllowance(db, {
      tenantId: "a",
      operations: ops,
      allowance,
      siteDailyCents: null,
      now: NOW,
      words: { company_messages: (usage) => `Green Acres has used its ${usage?.messageLimit} messages.` },
    });
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.message).toBe("Green Acres has used its 3 messages.");
  });
});

describe("reserveAiAllowance: check and hold as one step, so calls in flight count", () => {
  const base = (tenantId: string) => ({
    tenantId,
    userId: "u1",
    operations: ["assistant_chat"],
    operation: "assistant_chat",
    model: DEFAULT_AI_MODEL,
    allowance: { monthlyMessages: 3, monthlyCents: 10_000 },
    siteDailyCents: null,
    reserveMicros: 50_000n,
    now: NOW,
  });

  it("lets three of FORTY questions sent at once through on a three-question month", async () => {
    const verdicts = await Promise.all(Array.from({ length: 40 }, () => reserveAiAllowance(db, base("burst"))));
    expect(verdicts.filter((v) => v.ok)).toHaveLength(3);
    expect(verdicts.filter((v) => !v.ok && v.reason === "company_messages")).toHaveLength(37);
    const month = await aiSpendSince(db, { tenantId: "burst", since: startOfMonthUtc(NOW) });
    expect(month).toMatchObject({ answered: 3, micros: "150000" });
  });

  it("holds the worst case against the cents cap and the site's day while in flight", async () => {
    const big = { ...base("cents"), allowance: { monthlyMessages: null, monthlyCents: 10 }, reserveMicros: 60_000n };
    expect((await reserveAiAllowance(db, big)).ok).toBe(true); // 6 cents held
    expect((await reserveAiAllowance(db, big)).ok).toBe(true); // 12 > 10 after this one
    expect(await reserveAiAllowance(db, big)).toMatchObject({ ok: false, reason: "company_spend", usage: { limitedBy: "cents" } });
    const site = { ...base("other"), siteDailyCents: 12 };
    expect(await reserveAiAllowance(db, site)).toMatchObject({ ok: false, reason: "site_ceiling" });
  });

  it("settles to the real, priced cost; keeps the worst case when the cost is unknown; never null", async () => {
    const r = await reserveAiAllowance(db, base("settle"));
    if (!r.ok) throw new Error("refused");
    const real = await settleAiReservation(db, RATES, r.reservationId, {
      usage: { model: DEFAULT_AI_MODEL, inputTokens: 1_000, outputTokens: 100, reported: true },
      status: "completed",
    });
    expect(real).toEqual({ settled: true, costMicros: 1_500n });
    // Settling twice does nothing (the row is no longer reserved).
    expect((await settleAiReservation(db, RATES, r.reservationId, { usage: null, status: "completed" })).settled).toBe(false);

    const unknown = await reserveAiAllowance(db, base("settle"));
    if (!unknown.ok) throw new Error("refused");
    expect(
      await settleAiReservation(db, RATES, unknown.reservationId, {
        usage: { model: DEFAULT_AI_MODEL, inputTokens: 0, outputTokens: 0, reported: false },
        status: "cancelled",
      }),
    ).toEqual({ settled: true, costMicros: 50_000n });
    const rows = await db.select().from(aiUsage);
    expect(rows.every((row) => row.costMicros !== null)).toBe(true);
  });

  it("a failed question stops counting as a message, but its tokens still count as money", async () => {
    const r = await reserveAiAllowance(db, base("failed"));
    if (!r.ok) throw new Error("refused");
    await settleAiReservation(db, RATES, r.reservationId, {
      usage: { model: DEFAULT_AI_MODEL, inputTokens: 2_000, outputTokens: 0, reported: true },
      status: "errored",
      error: new Error("overloaded"),
    });
    const month = await aiSpendSince(db, { tenantId: "failed", since: startOfMonthUtc(NOW) });
    expect(month).toMatchObject({ answered: 0, requests: 1, micros: "2000" });
  });

  it("releases a reservation the call never used", async () => {
    const r = await reserveAiAllowance(db, base("released"));
    if (!r.ok) throw new Error("refused");
    await releaseAiReservation(db, r.reservationId);
    expect((await aiSpendSince(db, { tenantId: "released", since: startOfMonthUtc(NOW) })).requests).toBe(0);
  });

  it("tells the site owner when the site's day is spent, and says a spending cap was the reason in plain words", async () => {
    await used("whale", 5_000_000, 0, "chat");
    const alerts: unknown[] = [];
    await checkAiAllowance(db, { tenantId: "x", operations: ["assistant_chat"], allowance: { monthlyMessages: 10, monthlyCents: 10 }, siteDailyCents: 100, now: NOW, onSiteCeiling: (info) => alerts.push(info) });
    expect(alerts).toEqual([expect.objectContaining({ tenantId: "x", ceilingCents: 100, spentMicros: "5000000" })]);
    const spent = await checkAiAllowance(db, { tenantId: "whale", operations: ["chat"], allowance: { monthlyMessages: 500, monthlyCents: 100 }, siteDailyCents: null, now: NOW });
    if (spent.ok) throw new Error("expected a refusal");
    expect(spent.message).toBe("This month's assistant allowance is used up: it reached its $1.00 spending limit before its messages ran out. It starts again on November 1.");
  });

  it("holds every company to a share of the site's day, so one can't close AI for everyone (review M4)", async () => {
    await used("whale2", 2_000_000, 0); // $2 today
    const whale = await checkAiAllowance(db, { tenantId: "whale2", operations: ["assistant_chat"], allowance: { monthlyMessages: null, monthlyCents: 5_000, dailyCents: 125 }, siteDailyCents: 500, now: NOW });
    expect(whale).toMatchObject({ ok: false, reason: "company_day", usage: { limitedBy: "day" } });
    if (!whale.ok) expect(whale.message).toBe("Your account has used today's share of this site's AI. It starts again at midnight UTC.");
    // Everyone else still has the rest of the site's day.
    const minnow = await checkAiAllowance(db, { tenantId: "minnow", operations: ["assistant_chat"], allowance: { monthlyMessages: 100, monthlyCents: 700, dailyCents: 125 }, siteDailyCents: 500, now: NOW });
    expect(minnow.ok).toBe(true);
  });

  it("FAILS CLOSED when it can't hold the place", async () => {
    const down = { transaction: () => Promise.reject(new Error("down")) } as unknown as AiDb;
    expect(await reserveAiAllowance(down, base("x"))).toMatchObject({ ok: false, reason: "unavailable" });
  });
});

describe("a feature's share of the site's day, and holds nobody settled (0.3.0)", () => {
  it("refuses a feature past its own daily cents across every company, and leaves other features alone", async () => {
    // Two companies spend 6 cents of AI mentions between them today.
    await used("co-a", 30_000, 0, "aeo_check");
    await used("co-b", 30_000, 0, "aeo_check");
    const input = (tenantId: string, operations: string[]) => ({
      tenantId,
      operations,
      allowance: { monthlyMessages: null, monthlyCents: null },
      siteDailyCents: 500,
      operationsDailyCents: 5,
      now: NOW,
    });
    const mentions = await checkAiAllowance(db, input("co-c", ["aeo_check"]));
    expect(mentions).toMatchObject({ ok: false, reason: "feature_day" });
    // The assistant has its own day: the feature share never closes it.
    expect((await checkAiAllowance(db, input("co-c", ["assistant_chat"]))).ok).toBe(true);
  });

  it("sweeps a hold nobody settled, for its own operation only, after the time given", async () => {
    const hold = await reserveAiAllowance(db, {
      tenantId: "sweep",
      userId: null,
      operations: ["aeo_check"],
      operation: "aeo_check",
      model: DEFAULT_AI_MODEL,
      allowance: { monthlyMessages: null, monthlyCents: null },
      siteDailyCents: null,
      reserveMicros: 90_000n,
      now: NOW,
    });
    expect(hold.ok).toBe(true);
    await db.execute(sql`update ai_usage set created_at = now() - interval '15 minutes'`);
    expect(await sweepStaleReservations(db, { operations: ["assistant_chat"], olderThanMs: 10 * 60_000 })).toBe(0);
    expect(await sweepStaleReservations(db, { operations: ["aeo_check"], olderThanMs: 10 * 60_000 })).toBe(1);
    const left = await db.select().from(aiUsage);
    expect(left).toEqual([]);
  });
});

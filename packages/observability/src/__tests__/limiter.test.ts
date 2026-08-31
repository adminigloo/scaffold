import { describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  rateLimitHeaders,
  RATE_LIMIT_POLICIES,
  type RateLimitFetch,
} from "../limiter.js";
import type { RateLimitStore } from "../ratelimit.js";

const WINDOW = 60_000;
/** Exactly on a window boundary, so the arithmetic is easy to read. */
const T0 = 1_756_382_400_000;
const POLICY = { limit: 3, windowMs: WINDOW } as const;

function silent() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe("with no credentials", () => {
  it("counts in memory and says so", async () => {
    // Boots with nothing set. No throw, no null, and a real limiter — the
    // `createEmailSender().configured` pattern applied to a store.
    const limiter = createRateLimiter({ logger: silent() });
    expect(limiter.distributed).toBe(false);

    const seen: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      seen.push((await limiter.limit({ key: "u_1", policy: POLICY, now: T0 })).allowed);
    }
    expect(seen).toEqual([true, true, true, false]);
  });

  it("keeps two keys apart", async () => {
    const limiter = createRateLimiter({ logger: silent() });
    await limiter.limit({ key: "u_1", policy: POLICY, now: T0 });
    await limiter.limit({ key: "u_1", policy: POLICY, now: T0 });
    await limiter.limit({ key: "u_1", policy: POLICY, now: T0 });
    const other = await limiter.limit({ key: "u_2", policy: POLICY, now: T0 });
    expect(other.allowed).toBe(true);
  });

  it("warns but still works when only half the Upstash group is set", async () => {
    // The state a deployment is legitimately in between pasting one variable
    // into a dashboard and pasting the other. Refusing to boot there takes
    // production down over a feature that is optional by definition.
    const logger = silent();
    const limiter = createRateLimiter({ url: "https://x.upstash.io", logger });
    expect(limiter.distributed).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await expect(
      limiter.limit({ key: "u_1", policy: POLICY, now: T0 }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("says nothing when neither variable is set", () => {
    const logger = silent();
    createRateLimiter({ logger });
    // Absent is the supported state, not a misconfiguration to nag about on
    // every cold start.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("the Upstash adapter", () => {
  function upstash(reply: unknown, ok = true) {
    const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
    const fetchImpl: RateLimitFetch = (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) as unknown, headers: init.headers });
      return Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        json: () => Promise.resolve(reply),
      });
    };
    return { calls, fetchImpl };
  }

  it("pipelines INCR and a non-sliding PEXPIRE", async () => {
    const { calls, fetchImpl } = upstash([{ result: 1 }, { result: 1 }]);
    const limiter = createRateLimiter({
      url: "https://example.upstash.io/",
      token: "tok",
      fetch: fetchImpl,
      logger: silent(),
      namespace: "test",
    });
    expect(limiter.distributed).toBe(true);

    const result = await limiter.limit({ key: "u_1", policy: POLICY, now: T0 });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("no request was made");
    // Trailing slash stripped, so the endpoint is not `//pipeline`.
    expect(call.url).toBe("https://example.upstash.io/pipeline");
    expect(call.headers["Authorization"]).toBe("Bearer tok");
    // `NX` is the whole correctness argument: a plain PEXPIRE slides the
    // expiry forward for as long as traffic continues, the counter never
    // resets, and the caller stays locked out permanently.
    expect(call.body).toEqual([
      ["INCR", `test:u_1:${T0 / WINDOW}`],
      ["PEXPIRE", `test:u_1:${T0 / WINDOW}`, String(WINDOW), "NX"],
    ]);
  });

  it("namespaces every key, so a preview cannot spend production's budget", async () => {
    const { calls, fetchImpl } = upstash([{ result: 1 }]);
    const limiter = createRateLimiter({
      url: "https://example.upstash.io",
      token: "tok",
      fetch: fetchImpl,
      logger: silent(),
    });
    await limiter.limit({ key: "u_1", policy: POLICY, now: T0 });
    expect(JSON.stringify(calls[0]?.body)).toContain("rl:u_1:");
  });

  it("refuses to read a malformed reply as a count", async () => {
    // Coercing it would mean treating a broken Redis as "0 requests so far",
    // which allows everything and looks exactly like a working limiter.
    const logger = silent();
    const { fetchImpl } = upstash([{ error: "WRONGTYPE" }]);
    const limiter = createRateLimiter({
      url: "https://example.upstash.io",
      token: "tok",
      fetch: fetchImpl,
      logger,
    });
    await limiter.limit({ key: "u_1", policy: POLICY, now: T0 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe("when the store fails", () => {
  const broken: RateLimitStore = {
    incr: () => Promise.reject(new Error("ECONNRESET")),
  };

  it("allows by default, and says why", async () => {
    // Failing closed takes the whole application down over an outage in the
    // component that protects it.
    const logger = silent();
    const limiter = createRateLimiter({ store: broken, logger });
    const result = await limiter.limit({ key: "u_1", policy: POLICY, now: T0 });
    expect(result.allowed).toBe(true);
    expect(result.resetAt.getTime()).toBe(T0 + WINDOW);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("denies when the caller asked it to", async () => {
    // The AI route. An unlimited request there costs real money, so a 429
    // during a Redis outage is the cheap option.
    const limiter = createRateLimiter({
      store: broken,
      onStoreFailure: "deny",
      logger: silent(),
    });
    await expect(
      limiter.limit({ key: "u_1", policy: RATE_LIMIT_POLICIES.ai, now: T0 }),
    ).resolves.toMatchObject({ allowed: false, remaining: 0 });
  });

  it("never rejects", async () => {
    const limiter = createRateLimiter({ store: broken, logger: silent() });
    await expect(
      limiter.limit({ key: "u_1", policy: POLICY, now: T0 }),
    ).resolves.toBeDefined();
  });
});

describe("the named budgets", () => {
  it("bounds the day as well as the minute for AI", () => {
    // A per-minute cap alone is 28,800 calls a day. The daily one is the one
    // that bounds the invoice, and a route is expected to check both.
    expect(RATE_LIMIT_POLICIES.ai.windowMs).toBe(60_000);
    expect(RATE_LIMIT_POLICIES.aiDaily.windowMs).toBe(86_400_000);
    expect(RATE_LIMIT_POLICIES.aiDaily.limit).toBeLessThan(
      (RATE_LIMIT_POLICIES.ai.limit * 86_400_000) / 60_000,
    );
  });

  it("gives writes a tighter budget than reads", () => {
    expect(RATE_LIMIT_POLICIES.mutation.limit).toBeLessThan(
      RATE_LIMIT_POLICIES.authenticated.limit,
    );
  });
});

describe("rateLimitHeaders", () => {
  it("reports the budget on a request that was allowed", () => {
    // A client that only learns its budget once it has run out cannot back off
    // before it does, which is how a limit becomes a retry storm.
    const headers = rateLimitHeaders(
      { allowed: true, remaining: 2, resetAt: new Date(T0 + WINDOW) },
      POLICY,
      T0,
    );
    expect(headers).toEqual({
      "X-RateLimit-Limit": "3",
      "X-RateLimit-Remaining": "2",
      "X-RateLimit-Reset": String((T0 + WINDOW) / 1000),
    });
  });

  it("adds Retry-After on a refusal", () => {
    const headers = rateLimitHeaders(
      { allowed: false, remaining: 0, resetAt: new Date(T0 + 30_000) },
      POLICY,
      T0,
    );
    expect(headers["Retry-After"]).toBe("30");
  });

  it("never says Retry-After: 0", () => {
    // Which reads as "retry immediately", so a client on the last millisecond
    // of a window would spin.
    const headers = rateLimitHeaders(
      { allowed: false, remaining: 0, resetAt: new Date(T0) },
      POLICY,
      T0,
    );
    expect(headers["Retry-After"]).toBe("1");
  });
});

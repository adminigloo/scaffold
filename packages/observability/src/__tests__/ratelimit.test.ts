import { describe, expect, it } from "vitest";
import {
  RateLimitConfigError,
  checkRateLimit,
  createMemoryRateLimitStore,
  type RateLimitStore,
} from "../ratelimit.js";

const WINDOW = 60_000;
/** Exactly on a window boundary, so the arithmetic is easy to read. */
const T0 = 1_756_382_400_000;

describe("checkRateLimit — the boundary", () => {
  it("allows the limit-th request and refuses the next", async () => {
    // The off-by-one that turns a documented "5 per minute" into four. The
    // counter is post-increment, so the fifth request sees count === 5.
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const results: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      const result = await checkRateLimit({
        key: "u_1",
        limit: 5,
        windowMs: WINDOW,
        store,
        now: T0,
      });
      results.push(result.allowed);
    }
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it("counts down remaining and never goes negative", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const remaining: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = await checkRateLimit({
        key: "u_1",
        limit: 3,
        windowMs: WINDOW,
        store,
        now: T0,
      });
      remaining.push(result.remaining);
    }
    // Straight into X-RateLimit-Remaining, where a negative number is a bug
    // report from whoever wrote the client.
    expect(remaining).toEqual([2, 1, 0, 0, 0]);
  });

  it("refuses everything when the limit is zero", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const result = await checkRateLimit({
      key: "u_1",
      limit: 0,
      windowMs: WINDOW,
      store,
      now: T0,
    });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("reports when the window ends, for Retry-After", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const result = await checkRateLimit({
      key: "u_1",
      limit: 1,
      windowMs: WINDOW,
      store,
      now: T0 + 15_000,
    });
    expect(result.resetAt.getTime()).toBe(T0 + WINDOW);
  });
});

describe("checkRateLimit — window rollover", () => {
  it("forgives a refused caller once the window turns over", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const spend = (now: number) =>
      checkRateLimit({ key: "u_1", limit: 2, windowMs: WINDOW, store, now });

    expect((await spend(T0)).allowed).toBe(true);
    expect((await spend(T0 + 1)).allowed).toBe(true);
    expect((await spend(T0 + 2)).allowed).toBe(false);
    // One millisecond into the next window.
    expect((await spend(T0 + WINDOW)).allowed).toBe(true);
  });

  it("does not roll over one millisecond early", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const spend = (now: number) =>
      checkRateLimit({ key: "u_1", limit: 1, windowMs: WINDOW, store, now });

    expect((await spend(T0)).allowed).toBe(true);
    expect((await spend(T0 + WINDOW - 1)).allowed).toBe(false);
    expect((await spend(T0 + WINDOW)).allowed).toBe(true);
  });

  it("puts the window in the key, so rollover needs no expiry", async () => {
    // Rollover is arithmetic on the clock, not a TTL the store has to honour.
    // A store that gets its TTL wrong leaks keys; it cannot break the limit.
    const seen: string[] = [];
    const store: RateLimitStore = {
      incr(key) {
        seen.push(key);
        return Promise.resolve(1);
      },
    };
    await checkRateLimit({ key: "u_1", limit: 1, windowMs: WINDOW, store, now: T0 });
    await checkRateLimit({
      key: "u_1",
      limit: 1,
      windowMs: WINDOW,
      store,
      now: T0 + WINDOW,
    });
    expect(seen[0]).not.toBe(seen[1]);
    expect(new Set(seen).size).toBe(2);
  });
});

describe("checkRateLimit — isolation and failure", () => {
  it("keeps separate keys separate", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const args = { limit: 1, windowMs: WINDOW, store, now: T0 };
    expect((await checkRateLimit({ ...args, key: "u_1" })).allowed).toBe(true);
    expect((await checkRateLimit({ ...args, key: "u_2" })).allowed).toBe(true);
    expect((await checkRateLimit({ ...args, key: "u_1" })).allowed).toBe(false);
  });

  it("counts concurrent requests correctly", async () => {
    // A read-then-write store lets two callers both read 9 and both write 10.
    // A limiter that undercounts under concurrency fails exactly when needed.
    const store = createMemoryRateLimitStore({ now: () => T0 });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        checkRateLimit({ key: "u_1", limit: 4, windowMs: WINDOW, store, now: T0 }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(4);
  });

  it("lets a store failure propagate rather than deciding fail-open for you", async () => {
    // Fail-open and fail-closed are both defensible. Picking one here would
    // hide the choice in a package nobody reads during an incident.
    const store: RateLimitStore = {
      incr: () => Promise.reject(new Error("upstash unreachable")),
    };
    await expect(
      checkRateLimit({ key: "u_1", limit: 5, windowMs: WINDOW, store, now: T0 }),
    ).rejects.toThrow("upstash unreachable");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects windowMs=%s instead of producing a NaN key",
    async (windowMs) => {
      const store = createMemoryRateLimitStore();
      await expect(
        checkRateLimit({ key: "u_1", limit: 5, windowMs, store }),
      ).rejects.toThrow(RateLimitConfigError);
    },
  );

  it.each([-1, 2.5])("rejects limit=%s", async (limit) => {
    const store = createMemoryRateLimitStore();
    await expect(
      checkRateLimit({ key: "u_1", limit, windowMs: WINDOW, store }),
    ).rejects.toThrow(RateLimitConfigError);
  });
});

describe("createMemoryRateLimitStore", () => {
  it("returns 1 on the first increment and counts up from there", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    expect(await store.incr("k", WINDOW)).toBe(1);
    expect(await store.incr("k", WINDOW)).toBe(2);
    expect(await store.incr("k", WINDOW)).toBe(3);
  });

  it("restarts an expired counter rather than resuming it", async () => {
    // Resuming would carry the previous window's count forward, and the first
    // caller after a quiet period would be refused for traffic already
    // forgiven.
    let now = T0;
    const store = createMemoryRateLimitStore({ now: () => now });
    expect(await store.incr("k", 1_000)).toBe(1);
    expect(await store.incr("k", 1_000)).toBe(2);
    now = T0 + 1_000;
    expect(await store.incr("k", 1_000)).toBe(1);
  });

  it("drops expired keys without a timer", async () => {
    // No setInterval: a repeating timer keeps the event loop alive, and a dev
    // server or test runner that never exits is the worse bug.
    let now = T0;
    const store = createMemoryRateLimitStore({ now: () => now, sweepThreshold: 3 });
    await store.incr("a", 1_000);
    await store.incr("b", 1_000);
    expect(store.size()).toBe(2);
    now = T0 + 1_001;
    expect(store.size()).toBe(0);
  });

  it("sweeps once the map grows past the threshold", async () => {
    let now = T0;
    const store = createMemoryRateLimitStore({ now: () => now, sweepThreshold: 4 });
    for (const key of ["a", "b", "c", "d"]) await store.incr(key, 1_000);
    now = T0 + 1_001;
    // The fifth write triggers the sweep, so the map holds the new key alone
    // instead of growing without bound.
    await store.incr("e", 1_000);
    expect(store.size()).toBe(1);
  });

  it("clears on demand, so one test cannot leak into the next", async () => {
    const store = createMemoryRateLimitStore({ now: () => T0 });
    await store.incr("k", WINDOW);
    store.clear();
    expect(store.size()).toBe(0);
    expect(await store.incr("k", WINDOW)).toBe(1);
  });
});

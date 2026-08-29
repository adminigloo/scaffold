/**
 * The one thing a limiter needs from its backing store.
 *
 * Deliberately this small, and deliberately not `@upstash/ratelimit`. Upstash
 * is the likely production answer, but hard-depending on it drags a Redis
 * client into every consumer of this package — including the tests of packages
 * that never rate-limit anything — and pins an app to one vendor for a
 * behaviour that is four lines of Redis.
 *
 * An Upstash-backed store is the whole adapter:
 *
 *   const store: RateLimitStore = {
 *     async incr(key, windowMs) {
 *       const [count] = await redis
 *         .multi().incr(key).pexpire(key, windowMs, "NX").exec();
 *       return count;
 *     },
 *   };
 *
 * `pexpire … NX` rather than a plain `pexpire`, because setting the TTL on
 * every increment slides the window forward for as long as traffic continues
 * and the counter then never resets — a caller hammering the endpoint stays
 * locked out permanently, which is the bug that looks like the limiter working.
 */
export interface RateLimitStore {
  /**
   * Increment the counter at `key` and return its NEW value. The first call
   * for a key returns 1.
   *
   * MUST be atomic. A read-then-write store lets two concurrent requests both
   * read 9 and both write 10, and a limiter that undercounts under concurrency
   * is one that fails exactly when it is needed.
   *
   * `windowMs` is passed so the store can set a TTL. Correctness does not
   * depend on it — `checkRateLimit` puts the window into the key — so a store
   * that ignores it is merely one that leaks keys.
   */
  incr(key: string, windowMs: number): Promise<number>;
}

export interface RateLimitInput {
  /** Whatever is being limited: a user id, an IP, `${tenantId}:export`. */
  readonly key: string;
  /** Requests permitted per window. The limit-th request is allowed. */
  readonly limit: number;
  readonly windowMs: number;
  readonly store: RateLimitStore;
  /** Injected so window rollover is testable without waiting out a window. */
  readonly now?: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** Never negative — it goes straight into `X-RateLimit-Remaining`. */
  readonly remaining: number;
  /** When the current window ends. The value for `Retry-After`. */
  readonly resetAt: Date;
}

export class RateLimitConfigError extends Error {
  readonly name = "RateLimitConfigError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Fixed window. One counter per (key, window), reset by the window moving on.
 *
 * Fixed rather than sliding because the window is derived arithmetically from
 * the clock, which means the store needs nothing but an atomic increment — no
 * sorted sets, no Lua, no clock of its own — and any store on earth can back
 * it. The cost is the known burst at a boundary: a caller can spend a full
 * limit in the last millisecond of one window and another in the first of the
 * next. For the things this protects — password resets, invite sends, exports
 * — 2x for one instant is not the threat, and paying for a sliding window in
 * store complexity buys a guarantee nobody asked for.
 *
 * The window lives IN THE KEY (`user_42:1756382400`), so rollover needs no
 * expiry, no sweep and no coordination: at the boundary every caller simply
 * starts writing to a different key. Store TTLs become garbage collection
 * rather than correctness, which is why a store that gets its TTL wrong cannot
 * silently break the limit.
 *
 * Store failures are NOT caught here. Fail-open and fail-closed are both
 * defensible and the choice is not this function's to make: failing closed
 * takes the whole app down when Redis blips, failing open removes the
 * protection during exactly the incident that caused the blip. The caller
 * decides, in a try/catch, where the decision is visible.
 */
export async function checkRateLimit(
  input: RateLimitInput,
): Promise<RateLimitResult> {
  if (!Number.isFinite(input.windowMs) || input.windowMs <= 0) {
    throw new RateLimitConfigError(
      `windowMs must be a positive number of milliseconds, got ${String(input.windowMs)}. ` +
        `A zero or negative window makes the bucket arithmetic produce Infinity or NaN, ` +
        `and every request would then share one key that never rolls over.`,
    );
  }
  if (!Number.isInteger(input.limit) || input.limit < 0) {
    throw new RateLimitConfigError(
      `limit must be a non-negative integer, got ${String(input.limit)}. ` +
        `A fractional limit makes the boundary unpredictable: which of the two ` +
        `requests around 2.5 is the one that gets refused is not something a ` +
        `caller can reason about.`,
    );
  }

  const now = input.now ?? Date.now();
  const window = Math.floor(now / input.windowMs);
  const resetAt = new Date((window + 1) * input.windowMs);

  const count = await input.store.incr(
    `${input.key}:${window}`,
    input.windowMs,
  );

  // `<=`, not `<`. The counter is post-increment, so the limit-th request sees
  // count === limit and must be allowed; treating that as over-limit turns a
  // documented "5 per minute" into four.
  return {
    allowed: count <= input.limit,
    remaining: Math.max(0, input.limit - count),
    resetAt,
  };
}

export interface MemoryRateLimitStore extends RateLimitStore {
  /** Live keys. For tests, and for asserting the sweep actually sweeps. */
  size(): number;
  clear(): void;
}

export interface MemoryRateLimitStoreOptions {
  /** Injected so expiry is testable without waiting. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Expired keys are swept once the map grows past this. */
  readonly sweepThreshold?: number;
}

const DEFAULT_SWEEP_THRESHOLD = 1024;

/**
 * An in-process store, for tests and for a single-process dev server.
 *
 * NOT SUITABLE FOR A DEPLOYED FLEET, and the reason is the same one that sinks
 * riddler-go's process-local idempotency `Set`: a counter in a Map is not
 * shared memory. Across N serverless instances the effective limit is N times
 * what was configured, and every cold start silently resets it to zero — so
 * the limiter is weakest at exactly the moment traffic scales the fleet out,
 * which is the moment it is being attacked. A limit that holds under load is
 * the only kind worth having; use a real store in production.
 *
 * No `setInterval`. A repeating timer keeps the Node event loop alive, and a
 * dev server or a test runner that never exits is a worse bug than a Map with
 * some dead keys in it. Expiry is lazy on read, with an opportunistic sweep
 * once the map grows, which bounds memory with no timer at all.
 */
export function createMemoryRateLimitStore(
  options: MemoryRateLimitStoreOptions = {},
): MemoryRateLimitStore {
  const clock = options.now ?? Date.now;
  const threshold = options.sweepThreshold ?? DEFAULT_SWEEP_THRESHOLD;
  const counters = new Map<string, { count: number; expiresAt: number }>();

  function sweep(now: number): void {
    for (const [key, entry] of counters) {
      if (entry.expiresAt <= now) counters.delete(key);
    }
  }

  return {
    incr(key, windowMs) {
      const now = clock();
      if (counters.size >= threshold) sweep(now);

      const existing = counters.get(key);
      // An expired entry is treated as absent rather than resumed. Reusing it
      // would carry a previous window's count into the new one, and the first
      // caller after a quiet period would be refused for traffic that was
      // already forgiven.
      if (existing === undefined || existing.expiresAt <= now) {
        counters.set(key, { count: 1, expiresAt: now + windowMs });
        return Promise.resolve(1);
      }

      existing.count += 1;
      return Promise.resolve(existing.count);
    },
    size() {
      sweep(clock());
      return counters.size;
    },
    clear() {
      counters.clear();
    },
  };
}

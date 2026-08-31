import {
  checkRateLimit,
  createMemoryRateLimitStore,
  type RateLimitResult,
  type RateLimitStore,
} from "./ratelimit.js";
import { consoleLogSink, type LogSink } from "./logger.js";

/**
 * The limiter an application actually holds, as opposed to the arithmetic.
 *
 * `checkRateLimit` has existed in this package since the first commit and has
 * never had a single caller, and the reason is visible from its signature: it
 * takes a store, and building the store is the part nobody wants to write
 * twice. This module is that part — one object, constructed once per process,
 * that resolves Upstash when the credentials are there and an in-process Map
 * when they are not, so a call site is `limiter.limit({ key, policy })` and
 * nothing else.
 *
 * Boots with no credentials, like everything else here. No Upstash URL is not
 * a misconfiguration and never throws; it degrades to `createMemoryRateLimitStore`
 * and says so on `distributed`, which is the `createEmailSender().configured`
 * pattern applied to a limiter.
 */

export interface RateLimitPolicy {
  /** Requests permitted per window. The limit-th request is allowed. */
  readonly limit: number;
  readonly windowMs: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * The budgets, named once.
 *
 * Named rather than written at each call site so that the tRPC ladder, a
 * webhook route and the AI route cannot disagree about what "reasonable" is,
 * and so that raising a limit is one edit rather than a search.
 *
 * The two AI entries are the point of this whole file. An unthrottled model
 * route is the omission that produces a same-day invoice: a loop in someone's
 * client, or one person with a script, and the bill arrives before the alert
 * does. A per-minute cap alone does not fix it — 20/minute is still 28,800
 * calls a day — so the route is expected to check BOTH, minute and day, and
 * refuse if either says no. The daily one is the one that bounds the money.
 */
export const RATE_LIMIT_POLICIES = {
  /** Anonymous traffic, keyed by IP. Generous: this is a floor, not a quota. */
  anonymous: { limit: 60, windowMs: MINUTE },
  /** A signed-in user's reads. High enough that a busy dashboard never trips it. */
  authenticated: { limit: 300, windowMs: MINUTE },
  /** A signed-in user's writes. */
  mutation: { limit: 60, windowMs: MINUTE },
  /**
   * Provider webhooks, keyed by provider rather than by caller.
   *
   * High, and it is not really abuse protection: Stripe and Clerk retry with
   * backoff, so the thing being bounded is a redelivery storm after an outage
   * hammering the database. A limit low enough to stop a determined attacker
   * would drop legitimate events, and those are the ones that never come back.
   */
  webhook: { limit: 600, windowMs: MINUTE },
  /** Model calls per user per minute — the burst guard. */
  ai: { limit: 20, windowMs: MINUTE },
  /** Model calls per user per day — the invoice guard. */
  aiDaily: { limit: 200, windowMs: DAY },
} as const satisfies Record<string, RateLimitPolicy>;

/**
 * The subset of `fetch` this module uses.
 *
 * Structural, so a test can pass an object literal; the global `fetch` is
 * assignable to it because every parameter here is narrower and every return
 * member is present on `Response`.
 */
export type RateLimitFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface RateLimiterOptions {
  /** `UPSTASH_REDIS_REST_URL`. Absent means the in-memory store. */
  readonly url?: string | undefined;
  /** `UPSTASH_REDIS_REST_TOKEN`. Absent means the in-memory store. */
  readonly token?: string | undefined;
  /**
   * Replaces both of the above.
   *
   * The seam for a deployment on something other than Upstash, and the seam
   * the tests use. Same role `send` plays in `createEmailSender`: supplying a
   * store counts as being configured, because a caller who hands us somewhere
   * shared to count has said so.
   */
  readonly store?: RateLimitStore | undefined;
  /**
   * Prefixed to every key.
   *
   * Defaults to `rl`. Set it per environment when preview deployments share a
   * Redis with production, or a preview branch's traffic spends production's
   * budget and the incident looks like an attack.
   */
  readonly namespace?: string | undefined;
  /**
   * What to do when the STORE fails — Redis unreachable, a 500 from the REST
   * endpoint, a timeout. Not a missing credential; that is not a failure.
   *
   * Defaults to `allow`, because the alternative takes the whole application
   * down over an outage in the component that protects it, and for password
   * resets and invite sends the exposure is a few minutes of no limiting.
   *
   * Set `deny` on the AI route and anywhere else where an unlimited request
   * costs real money. That is the case where failing open is the expensive
   * option and a 429 during a Redis outage is the cheap one.
   */
  readonly onStoreFailure?: "allow" | "deny";
  readonly logger?: LogSink | undefined;
  readonly fetch?: RateLimitFetch | undefined;
}

export interface RateLimitCheck {
  /** Whatever is being limited: a user id, an IP, `${tenantId}:export`. */
  readonly key: string;
  readonly policy: RateLimitPolicy;
  /** Injected so window rollover is testable without waiting out a window. */
  readonly now?: number | undefined;
}

export interface RateLimiter {
  /**
   * False when the counters live in this process only.
   *
   * Read it on a diagnostics page. It is not a health check — an in-memory
   * limiter is the correct and supported state on a laptop — it is the
   * difference between "5 per minute" and "5 per minute per instance, reset by
   * every cold start", and a deployment should be able to see which one it has
   * without reading the environment.
   */
  readonly distributed: boolean;
  limit(check: RateLimitCheck): Promise<RateLimitResult>;
}

/**
 * A hung Redis call must not hang the request it is protecting.
 *
 * Two seconds is far longer than a healthy Upstash round trip and far shorter
 * than a user's patience. Without it, an Upstash partition converts a limiter
 * into a hang on every single request, which is a worse outage than the one
 * failing open would have caused.
 */
const UPSTASH_TIMEOUT_MS = 2_000;

export function createRateLimiter(
  options: RateLimiterOptions = {},
): RateLimiter {
  const logger = options.logger ?? consoleLogSink;
  const namespace = options.namespace ?? "rl";
  const onStoreFailure = options.onStoreFailure ?? "allow";

  const upstash = resolveUpstash(options, logger);
  const store = options.store ?? upstash ?? createMemoryRateLimitStore();
  const distributed = options.store !== undefined || upstash !== null;

  return {
    distributed,
    async limit(check: RateLimitCheck): Promise<RateLimitResult> {
      const key = `${namespace}:${check.key}`;
      try {
        return await checkRateLimit({
          key,
          limit: check.policy.limit,
          windowMs: check.policy.windowMs,
          store,
          ...(check.now === undefined ? {} : { now: check.now }),
        });
      } catch (cause) {
        // `checkRateLimit` deliberately does not catch, because fail-open and
        // fail-closed are not its decision. This is where the decision is made,
        // once, visibly, per limiter.
        logger.warn(
          {
            err: cause instanceof Error ? cause.message : String(cause),
            onStoreFailure,
            distributed,
          },
          "rate limit store failed; applying the configured failure policy",
        );
        const now = check.now ?? Date.now();
        const resetAt = new Date(
          (Math.floor(now / check.policy.windowMs) + 1) * check.policy.windowMs,
        );
        return {
          allowed: onStoreFailure === "allow",
          remaining: 0,
          resetAt,
        };
      }
    },
  };
}

/**
 * `X-RateLimit-*` and `Retry-After` for a route handler's response.
 *
 * Set them on the 200s as well as the 429s. A client that only learns its
 * budget when it has already run out cannot back off before it does, which is
 * the behaviour that turns a limit into a retry storm.
 */
export function rateLimitHeaders(
  result: RateLimitResult,
  policy: RateLimitPolicy,
  now: number = Date.now(),
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(policy.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    // Unix seconds, which is what every client library expects here.
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt.getTime() / 1000)),
  };
  if (!result.allowed) {
    // At least 1: `Retry-After: 0` reads as "retry immediately", so a client on
    // the last millisecond of a window would spin.
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil((result.resetAt.getTime() - now) / 1000)),
    );
  }
  return headers;
}

/**
 * The Upstash REST adapter, written out rather than depending on
 * `@upstash/ratelimit`.
 *
 * Two commands over the pipeline endpoint. `INCR` is atomic on its own, which
 * is the only atomicity a fixed window needs — the window is part of the key,
 * so the TTL is garbage collection rather than correctness and a pipeline
 * without transaction semantics is fine here.
 *
 * `PEXPIRE … NX` rather than a plain `PEXPIRE`: setting the TTL on every
 * increment slides the expiry forward for as long as traffic continues, the
 * counter never resets, and a caller who hammered the endpoint once stays
 * locked out permanently. That is the bug that looks exactly like the limiter
 * working.
 */
function resolveUpstash(
  options: RateLimiterOptions,
  logger: LogSink,
): RateLimitStore | null {
  const url = options.url?.trim();
  const token = options.token?.trim();

  // Both or neither. Half the group is the state `groupComplete` warns about;
  // here it degrades to the memory store rather than throwing at request time
  // on the endpoints that were supposed to be the protected ones.
  if (!url || !token) {
    if (url || token) {
      logger.warn(
        { hasUrl: Boolean(url), hasToken: Boolean(token) },
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set; " +
          "falling back to an in-process rate limit store",
      );
    }
    return null;
  }

  const fetchImpl = options.fetch ?? (globalThis.fetch as RateLimitFetch | undefined);
  if (fetchImpl === undefined) {
    logger.warn(
      {},
      "Upstash credentials are set but this runtime has no global fetch; " +
        "falling back to an in-process rate limit store",
    );
    return null;
  }

  const endpoint = `${url.replace(/\/+$/, "")}/pipeline`;

  return {
    async incr(key: string, windowMs: number): Promise<number> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([
          ["INCR", key],
          ["PEXPIRE", key, String(windowMs), "NX"],
        ]),
        signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Upstash returned HTTP ${response.status}`);
      }

      const body: unknown = await response.json();
      if (!Array.isArray(body) || body.length === 0) {
        throw new Error("Upstash pipeline returned an unexpected body");
      }
      const first: unknown = body[0];
      const count =
        typeof first === "object" && first !== null
          ? (first as { result?: unknown }).result
          : undefined;
      if (typeof count !== "number") {
        // Thrown rather than coerced. A limiter that silently treats a
        // malformed reply as "0 so far" is one that allows everything, and
        // nothing about the application's behaviour would reveal it.
        throw new Error("Upstash INCR did not return a number");
      }
      return count;
    },
  };
}

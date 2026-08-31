import { createRateLimiter, type RateLimiter } from "__SCOPE__/observability";
import { env } from "@/env";
import { log } from "./logger";

/**
 * The two limiters this application spends its budgets against.
 *
 * THERE USED TO BE A THIRD IMPLEMENTATION HERE. This file held its own Upstash
 * REST adapter — the same two commands, the same `PEXPIRE … NX` reasoning, the
 * same fallback to an in-process Map — written out beside the one already
 * published in `createRateLimiter`. Two copies of a limiter is the arrangement
 * where a fix to the pipeline body, the timeout or the malformed-reply guard
 * lands in one of them, and the endpoint protected by the other keeps the bug.
 * The package's copy is the one that survives: it is tested against a fake
 * transport, it is the one `@__SCOPE_NAME__/trpc` installs on the procedure
 * ladder, and it carries the failure policy as a construction argument rather
 * than as a `try`/`catch` somebody has to remember to write.
 *
 * WITH NO UPSTASH CREDENTIALS BOTH COUNT IN MEMORY, and that is a real
 * behaviour rather than a disabled one: a single dev server is a single
 * process, so the limit is exactly the configured limit. It is wrong the moment
 * the app is deployed to a fleet — N instances is N counters and an effective
 * limit of N times what was configured, reset to zero by every cold start — so
 * the limiter is weakest precisely when traffic has scaled the fleet out. Read
 * `limiter.distributed` to see which of the two you have; /setup says the same
 * thing under "Rate limiting".
 *
 * No `@upstash/redis` dependency, and no adapter of our own either. One HTTP
 * call to the REST endpoint is the entire integration and it lives in the
 * package.
 */

/** Both limiters share one Redis, so a namespace change moves both at once. */
const shared = {
  url: env.UPSTASH_REDIS_REST_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN,
  logger: log,
} as const;

/**
 * The default. FAILS OPEN when the store is unreachable.
 *
 * A Redis outage must not take the product down with it. Everything on this
 * limiter — every tRPC procedure, both webhook routes — is either
 * authenticated, signature-verified, or retried by a provider with backoff, so
 * a few minutes of no limiting is an accepted exposure and a few minutes of no
 * application is not. The limiter logs a warning through `log` on every such
 * request, which is how the outage is visible without being fatal.
 */
export const limiter: RateLimiter = createRateLimiter({
  ...shared,
  onStoreFailure: "allow",
});

/**
 * The other one. FAILS CLOSED, and the two endpoints on it are the reason.
 *
 * `/api/error-report` is an unauthenticated write, and `/api/ai/chat` spends
 * money per request. For both, "the store is down so allow everything" is the
 * expensive answer: an open write endpoint during the incident that took the
 * store out, or an unmetered model route and an invoice that arrives the same
 * day. Refusing while the store is unreachable costs telemetry and a chat
 * session; allowing costs a table full of junk or a five-figure bill.
 *
 * The cost is stated plainly because it is real: a caller who is well within
 * budget is refused for as long as Redis is unreachable, and cannot tell that
 * from being over budget — the 429 is the same either way, because there is
 * nothing the caller could usefully do differently. The distinction is in the
 * log line the limiter writes, which is where an operator looks.
 */
export const failClosedLimiter: RateLimiter = createRateLimiter({
  ...shared,
  onStoreFailure: "deny",
});

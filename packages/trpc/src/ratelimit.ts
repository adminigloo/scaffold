import type { RateLimiter, RateLimitPolicy } from "@adminigloo/observability";
import { RATE_LIMIT_POLICIES } from "@adminigloo/observability";
import type { ScaffoldContext } from "./context.js";
import type { ProcedureScope } from "./scope.js";
import { tooManyRequests } from "./errors.js";

/**
 * Rate limiting as a rung of the ladder rather than as something a handler
 * remembers.
 *
 * The same argument as `createProcedures` itself: a check written per
 * procedure is a check that is present on the twenty procedures somebody
 * thought about and absent on the twenty-first, and the twenty-first is
 * whichever one turns out to be expensive. Installed here it applies to every
 * procedure built from a rung, and the only way to opt out is to return null
 * from `policyFor`, which is a decision written down in one file.
 *
 * IT IS OPTIONAL, and it is optional in the generator sense: with no
 * `rateLimit` option `createProcedures` never installs the middleware at all.
 * There is no runtime flag inside the chain asking whether limiting is
 * switched on — a rung either has the middleware or it does not.
 */

/** Everything the policy and key functions are given about one call. */
export interface RateLimitLadderInfo {
  /** The rung the procedure was built from. */
  readonly scope: ProcedureScope;
  readonly type: "query" | "mutation" | "subscription";
  /** Dotted procedure path, e.g. `billing.invoices.void`. */
  readonly path: string;
  /**
   * The request context as the ladder guarantees it.
   *
   * Typed as the base `ScaffoldContext` rather than the app's own context,
   * because tRPC's `Overwrite<TContext, …>` cannot be proved equal to
   * `TContext` for an arbitrary subtype and the alternative is a cast in four
   * places to buy field access almost nobody needs. An app whose context
   * carries more can narrow inside its own `keyFor`.
   */
  readonly ctx: ScaffoldContext;
}

export interface RateLimitLadderOptions {
  /**
   * Built once per process with `createRateLimiter`. With no Upstash
   * credentials it counts in memory, which is documented on the limiter and is
   * the correct behaviour on a laptop.
   */
  readonly limiter: RateLimiter;
  /**
   * The budget for one call, or null to leave it unlimited.
   *
   * Defaults to `defaultPolicyFor` below. Override it to give one expensive
   * procedure its own budget — `info.path === "reports.export"` — without
   * hand-rolling a second limiter.
   */
  readonly policyFor?: (info: RateLimitLadderInfo) => RateLimitPolicy | null;
  /**
   * What the budget is spent against, or null to leave the call unlimited.
   *
   * Defaults to `defaultKeyFor` below. The returned key is namespaced by rung
   * and call type before it reaches the store, so an override only has to name
   * the caller.
   */
  readonly keyFor?: (info: RateLimitLadderInfo) => string | null;
}

/**
 * Which budget applies, by rung and by call type.
 *
 * Reads and writes are separated because they are not the same risk. A
 * dashboard that fans out to thirty queries on load is normal and a limit tight
 * enough to catch a write loop would break it; thirty writes a second is not
 * normal from anybody. Giving them one shared budget means picking a number
 * that is either too loose for writes or too tight for reads.
 *
 * Subscriptions get no limit here. Long-lived, one per connection, and counting
 * them per minute measures the connection rather than the traffic.
 */
function defaultPolicyFor(info: RateLimitLadderInfo): RateLimitPolicy | null {
  if (info.type === "subscription") return null;
  if (info.scope === "public") return RATE_LIMIT_POLICIES.anonymous;
  return info.type === "mutation"
    ? RATE_LIMIT_POLICIES.mutation
    : RATE_LIMIT_POLICIES.authenticated;
}

/**
 * Who is spending the budget.
 *
 * An authenticated call is keyed by USER: the account is the thing being
 * limited, it survives a change of network, and a NAT'd office does not share
 * one budget between forty people. An anonymous call has no user, so it is
 * keyed by IP, which is the only handle there is.
 *
 * The tenant is deliberately NOT in the key. Keying a tenant rung by tenant
 * would let one member of a large organisation exhaust the budget for all of
 * their colleagues, and the caller — not the organisation — is who a limiter
 * is aimed at.
 *
 * Null means unlimited, and it is returned for an anonymous caller with no
 * resolvable IP. That is a laptop with no proxy in front of it: every platform
 * this deploys to sets `x-forwarded-for`. The alternative, a shared "unknown"
 * bucket, rate-limits a developer out of their own dev server and teaches them
 * to switch the whole thing off.
 */
function defaultKeyFor(info: RateLimitLadderInfo): string | null {
  const userId = info.ctx.principal?.userId;
  if (info.scope !== "public" && userId !== undefined && userId !== "") {
    return `user:${userId}`;
  }
  const ip = info.ctx.ipAddress;
  return ip === null || ip === "" ? null : `ip:${ip}`;
}

/**
 * Check one call against its budget, and throw TOO_MANY_REQUESTS if it is over.
 *
 * Called from inside each rung's middleware rather than being a middleware
 * itself, because tRPC infers the `opts` type from the builder it is attached
 * to and a standalone middleware would have to be typed against every rung.
 *
 * The key carries the rung and the call type: `authenticated:mutation:user:u_1`.
 * Without that, a rung's reads and writes would share one counter while being
 * measured against two different limits, and the tighter of the two would
 * silently govern both.
 */
export async function enforceRateLimit(
  options: RateLimitLadderOptions,
  info: RateLimitLadderInfo,
): Promise<void> {
  const policyFor = options.policyFor ?? defaultPolicyFor;
  const policy = policyFor(info);
  if (policy === null) return;

  const keyFor = options.keyFor ?? defaultKeyFor;
  const key = keyFor(info);
  if (key === null) return;

  const result = await options.limiter.limit({
    key: `${info.scope}:${info.type}:${key}`,
    policy,
  });
  if (!result.allowed) throw tooManyRequests(result.resetAt);
}

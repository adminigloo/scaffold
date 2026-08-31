import type { Principal } from "@adminigloo/auth";
import type { PermissionSet } from "@adminigloo/permissions";
import {
  clientIpFromHeaders,
  resolveRequestId,
  type HeaderSource,
} from "@adminigloo/observability";
import { createRequestCache } from "./cache.js";

/**
 * What every procedure starts with.
 *
 * Deliberately thin. It carries identity and the request-scoped cache, and
 * nothing that has been authorized yet — `can` only appears on the context
 * after a middleware has resolved it, so a handler that reads `ctx.can` is
 * provably running below a rung of the ladder that resolved one. A context
 * with an always-present `can` would typecheck in a public procedure, which is
 * the same class of mistake this package exists to make impossible.
 */
export interface ScaffoldContext {
  principal: Principal | null;
  /**
   * The tenant the request arrived for — subdomain, header, path segment,
   * whatever the app uses. A hint only: `tenantProcedure` takes the tenant it
   * authorizes from the procedure input, and overwrites this so the two can
   * never name different tenants.
   */
  tenantId: string | null;
  /**
   * One id for everything this request does.
   *
   * NEVER NULL. `createScaffoldContext` mints one when the inbound headers do
   * not carry an `x-request-id`, so no handler has to decide what to log when
   * there is no id — a correlation key present on some lines and absent on
   * others correlates nothing, and the missing ones are the ones written by
   * the error paths nobody exercised.
   *
   * Put it on the logger for the request (`log.child({ requestId })`) and hand
   * it to `report()`. That pairing is what makes a row on `/admin/errors`
   * joinable to the log lines around it; without it the viewer tells you a
   * `TypeError` fired forty thousand times and nothing about any one of them.
   */
  requestId: string;
  /**
   * The caller's address as the platform's proxy reported it, or null when
   * nothing does — a laptop, a cron invocation, a test caller.
   *
   * Nullable on purpose: it is the rate-limit key for anonymous traffic, and
   * an "unknown" placeholder would file every unattributable request into one
   * shared bucket. See `clientIpFromHeaders` for when the header can be
   * trusted at all.
   */
  ipAddress: string | null;
  permissionCache: ReturnType<typeof createRequestCache<PermissionSet | null>>;
}

export interface ScaffoldContextInput {
  readonly principal?: Principal | null;
  readonly tenantId?: string | null;
  /**
   * The inbound request's headers. `x-request-id` and the client IP are read
   * from here.
   *
   * Taken rather than left to the app, because the request id only pays for
   * itself if EVERY request has one, and anything a call site has to remember
   * gets forgotten in the adapter that was copied from somewhere else.
   */
  readonly headers?: HeaderSource | null;
  /** Overrides what `headers` would give. For tests and non-HTTP entry points. */
  readonly requestId?: string | undefined;
  readonly ipAddress?: string | null;
}

/**
 * Build the per-request context.
 *
 * Call this once per request, in the adapter's `createContext`. The cache is
 * constructed here, on purpose: hoisting it to module scope to "save an
 * allocation" would share one user's resolved permission sets with the next
 * request the process handles, and on a warm serverless instance that is a
 * cross-tenant read that never touches the database and so never shows up in
 * query logs.
 */
export function createScaffoldContext(
  input: ScaffoldContextInput = {},
): ScaffoldContext {
  return {
    principal: input.principal ?? null,
    tenantId: input.tenantId ?? null,
    // `??` on a value that is already always a string, so that an explicit
    // requestId wins and the header path is still taken when it is absent.
    requestId: input.requestId ?? resolveRequestId(input.headers),
    ipAddress: input.ipAddress ?? clientIpFromHeaders(input.headers),
    permissionCache: createRequestCache<PermissionSet | null>(),
  };
}

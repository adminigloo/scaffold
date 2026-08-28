import type { Principal } from "@adminigloo/auth";
import type { PermissionSet } from "@adminigloo/permissions";
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
  permissionCache: ReturnType<typeof createRequestCache<PermissionSet | null>>;
}

export interface ScaffoldContextInput {
  readonly principal?: Principal | null;
  readonly tenantId?: string | null;
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
    permissionCache: createRequestCache<PermissionSet | null>(),
  };
}

import type { Scope } from "./catalog.js";
import type { PermissionSet } from "./resolve.js";

export class PermissionDeniedError extends Error {
  readonly name = "PermissionDeniedError";
  constructor(
    readonly permission: string,
    readonly scope: Scope,
  ) {
    super(`Permission denied: ${permission}`);
  }
}

/**
 * Gate an operation on a resolved set.
 *
 * Transport-agnostic on purpose. `@adminigloo/trpc` maps this to a FORBIDDEN
 * TRPCError and route handlers map it to a 403, but the check itself does not
 * know which one it is running under — the same call works in a server action,
 * a cron job, and a background worker.
 */
export function requirePermission(
  set: PermissionSet,
  permission: string,
  scope: Scope,
): void {
  if (!set.can(permission)) throw new PermissionDeniedError(permission, scope);
}

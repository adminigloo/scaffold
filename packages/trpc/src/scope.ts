/**
 * The authorization scope a procedure runs under.
 *
 * One closed set, declared per procedure, so "who is allowed to call this" is
 * answerable by reading the procedure's meta rather than by reading its body.
 * `authenticated` is deliberately distinct from `tenant` and `staff`: a signed
 * in user with no resolved permission set can still call things like "list my
 * own memberships", and collapsing that into `tenant` would force those
 * procedures to fake a tenant id.
 */
export type ProcedureScope = "public" | "authenticated" | "tenant" | "staff";

/**
 * Declared per procedure with `.meta({ scope })`, and read back by
 * `auditProcedureScopes`.
 *
 * The ladder in `createProcedures` does not set this for you, because the app
 * owns the tRPC instance and therefore owns the meta type — a package that
 * called `.meta()` would have to assume the app's meta is exactly
 * `ProcedureMeta` and would break every app that also puts, say, OpenAPI
 * annotations there.
 *
 * Metadata rather than a naming convention because the audit has to be able to
 * read it. A convention ("...ProtectedRouter") is invisible to CI, and the
 * failure this package exists to prevent — a router quietly calling a raw
 * permission check instead of the sanctioned middleware — is exactly the kind
 * that only a machine notices.
 */
export interface ProcedureMeta {
  scope: ProcedureScope;
}

/**
 * Property stamped on the middleware function each rung installs.
 *
 * tRPC keeps the exact function you hand to `.use()` in
 * `procedure._def.middlewares`, and every later `.meta()` / `.input()` / `.use()`
 * in the chain carries the array forward. So a tag put here survives all the way
 * to the built procedure, which is what lets `scopeOfProcedure` report the rung
 * a procedure was ACTUALLY built from rather than the scope its author claimed.
 * Verified against @trpc/server 11 rather than assumed.
 */
export const SCOPE_TAG = "__adminiglooScope" as const;

export type ScopeTagged = { readonly [SCOPE_TAG]?: ProcedureScope };

/** Stamp a middleware function with the rung that installed it. */
export function tagScope<TFn extends object>(
  fn: TFn,
  scope: ProcedureScope,
): TFn {
  Object.defineProperty(fn, SCOPE_TAG, {
    value: scope,
    enumerable: false,
    configurable: true,
  });
  return fn;
}

/**
 * Most privileged first. A procedure built from `tenantProcedure` also carries
 * the `authenticated` tag underneath it, so the ranking is what turns a list of
 * tags into a single answer.
 */
export const SCOPE_RANK: Record<ProcedureScope, number> = {
  public: 0,
  authenticated: 1,
  tenant: 2,
  staff: 2,
};

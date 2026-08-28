# @adminigloo/trpc

## 0.1.0

### Minor Changes

- The procedure ladder: public, protected, tenant and staff, with permission
  checks as middleware rather than inline in handlers.
  
  - `tenantProcedure` and `staffProcedure` DENY non-members. The loader contract
    returns `PermissionSet | null`, because the obvious implementation
    (`grants[tenantId] ?? []`) yields an empty set for a tenant the caller has
    nothing to do with — indistinguishable from a member with no grants, and
    enough to admit any signed-in user to any tenant id they typed.
  - `scopeOfProcedure()` derives the scope a procedure was ACTUALLY built from by
    walking tRPC's preserved middleware chain, so `auditBuiltProcedures` catches
    the real failure: a procedure copied inside a tenant router keeps its correct
    `.meta({ scope: "tenant" })` while the rung silently becomes public.
  - Per-request cache memoises the promise and evicts on rejection, so concurrent
    router hops share one lookup and a transient DB error cannot pin a FORBIDDEN
    for the rest of the request.

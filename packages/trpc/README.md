# @adminigloo/trpc

The procedure ladder for an AdminIgloo app's tRPC routers: `publicProcedure`,
`protectedProcedure` (signed in), `requireTenant(key)` (a member of the company
named in the input, holding the key) and `requireStaff(key)` (platform staff
holding the key). Every rung is a middleware the scope audit can SEE, so a
procedure that lost its authorization fails a test instead of shipping.

```
@adminigloo/trpc   createProcedures, createScaffoldContext, the refusal errors,
                   the scope audit (auditBuiltProcedures, inventoryOf, scopeOfProcedure)
```

Peers: `@trpc/server` (^11) and `zod`.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/trpc` | The four rungs, with permission sets cached per request; plain refusals (`notAMember`, `notStaff`, `companySuspended`); per-procedure rate limits; and the scope audit over a BUILT router. | The two permission loaders (`@adminigloo/permissions/server` builds them) and, optionally, `explainTenantDenial`. |

## Install

Add the scope to your project's `.npmrc` (`@adminigloo:registry=https://npm.pkg.github.com`)
and a token with `read:packages` to your user-level `~/.npmrc`, then
`npm install @adminigloo/trpc`.

## Quick start

```ts
import { initTRPC } from "@trpc/server";
import { createProcedures, type ProcedureMeta, type ScaffoldContext } from "@adminigloo/trpc";
import { explainTenantDenial, loadStaffPermissions, loadTenantPermissions } from "./permissions";

const t = initTRPC.context<ScaffoldContext>().meta<ProcedureMeta>().create();
export const { publicProcedure, protectedProcedure, requireTenant, requireStaff } = createProcedures(t, {
  loadTenantPermissions,
  loadStaffPermissions,
  // Optional: a SUSPENDED company's people get "Access to this account is
  // suspended. Contact support to restore it." instead of "not a member".
  explainTenantDenial,
});
```

## The scope audit, as a test

```ts
import { auditBuiltProcedures, inventoryOf } from "@adminigloo/trpc";

const result = auditBuiltProcedures(inventoryOf(appRouter), {
  health: "public",
  members: "tenant",
  admin: "staff",
  invoicing: "staff",
  "invoicing.byToken": "public",   // a full path wins over its router
});
expect(result.violations).toEqual([]);
```

`inventoryOf(router)` flattens a built router into its procedures;
`auditBuiltProcedures` reads the rung each was built from (not its `.meta`
label) and fails a procedure built from a lower rung than its row says, a
procedure whose label disagrees with its rung, and a router with no row at all.
create-app emits this test into every project (`procedure-scopes.test.ts`).

## Upgrading from 0.2

Additive: `PermissionLoaders.explainTenantDenial` (optional), `companySuspended`,
`inventoryOf`, and dotted-path rows in the audit map.

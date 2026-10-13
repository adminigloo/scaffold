# @adminigloo/permissions

Who may do what, in two ladders: a company's own people (owner, admin, member,
viewer — the TENANT scope) and the platform's staff (administrator, customer
service lead, customer service agent — the STAFF scope). A permission key is
declared once in a catalog, granted by role templates, and changed for one
person by an override that can never reopen a SEALED key. Nothing is implicit: a
key nobody's template grants is denied to everyone, including you.

```
@adminigloo/permissions          client-safe: definePermissions, the resolver, PermissionSet,
                                 STAFF_ROLE_TEMPLATES, FIRM_WIDE, BootstrapPolicy (no database import)
@adminigloo/permissions/schema   the drizzle tables (role_template, role_template_grant,
                                 principal_role, principal_override)
@adminigloo/permissions/server   the database half: loaders, the seed, the first administrator,
                                 role assignment with the rank rules
```

Peers: `drizzle-orm` (^0.45). The root imports no database code, so a client
component can use the catalog and `PermissionSet` without pulling in a driver.

## What each install gets you

| You install / import | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/permissions` | `definePermissions(scope, map, { contributedBy })` — one catalog per scope, refusing two packages that claim one key; `resolvePermissionSet` (template grants, then overrides; a seal wins); `createPermissionSet` (`can`, `canAll`, `canAny`, `toArray`); `STAFF_ROLE_TEMPLATES`. | Your catalogs: spread each package's fragment into the scope it was written for. |
| `@adminigloo/permissions/server` | `createDrizzlePermissionLoaders(db, { membership })`: `loadTenantPermissions` (null when not a member — never an empty set), `loadStaffPermissions` (null when not staff), `explainTenantDenial` ("company-suspended" or "not-a-member"). `seedPermissionCatalog`: one transaction under a lock, insert-only, never touching a customised template, reporting keys nobody holds — safe on every deploy. `ensureBootstrapAdmin`: the first administrator, retried whenever none exists, pinned to the STAFF admin template. `assignRoleTemplate`, `listRoleTemplates`, `roleOf`: the one write path for role rows, with the rank rules. | The membership gate (`@adminigloo/tenancy/server` exports `tenancyMembershipGate`), and running the seed after your migrations. |

## Install

Add the scope to your project's `.npmrc` (`@adminigloo:registry=https://npm.pkg.github.com`)
and a token with `read:packages` to your user-level `~/.npmrc`, then
`npm install @adminigloo/permissions`.

## Quick start

```ts
// src/permissions/catalog.ts
import { definePermissions } from "@adminigloo/permissions";
import { tenancyPermissions } from "@adminigloo/tenancy";

export const tenantCatalog = definePermissions("tenant", { ...tenancyPermissions }, { contributedBy: [tenancyPermissions] });
export const staffCatalog = definePermissions("staff", {
  "staff.tenants.view": { label: "View companies", defaultFor: ["admin", "cs_lead", "cs_agent"] },
  "staff.roles.manage": { label: "Give staff roles", defaultFor: ["admin"], sealed: true },
});
```

```ts
// src/server/permissions.ts
import { createDrizzlePermissionLoaders } from "@adminigloo/permissions/server";
import { tenancyMembershipGate } from "@adminigloo/tenancy/server";

export const { loadTenantPermissions, loadStaffPermissions, explainTenantDenial } =
  createDrizzlePermissionLoaders(db, { membership: tenancyMembershipGate });
```

```ts
// scripts/seed-deploy.ts — run after migrations, on every deploy
import { STAFF_ROLE_TEMPLATES } from "@adminigloo/permissions";
import { seedPermissionCatalog } from "@adminigloo/permissions/server";
import { TENANT_ROLE_TEMPLATES } from "@adminigloo/tenancy";

const report = await seedPermissionCatalog(db, {
  staff: { catalog: staffCatalog, templates: STAFF_ROLE_TEMPLATES },
  tenant: { catalog: tenantCatalog, templates: TENANT_ROLE_TEMPLATES },
});
console.log(report.created, report.ungrantedKeys);
```

## The rank rules (`assignRoleTemplate`)

- A person changes only someone whose role ranks strictly below theirs, and only
  to a role below theirs. A named system actor (`{ system: "admin:grant" }`)
  skips the guard; that is how a recovery script and the first administrator
  work.
- `topRankPeers: true` lets the highest rank give or take that same rank from
  someone else (never themselves): an administrator can make another
  administrator. `protectLastKey: "admin"` refuses removing the last one.
- `clearOverrides` deletes a person's per-person changes when their role changes
  (company roles) or is removed (staff).
- A company role and a staff role are both called "admin"; every lookup is by
  scope, so the first administrator is never handed the company one.

## The first administrator (`ensureBootstrapAdmin`)

`{ mode: "first-user" }` (a laptop), `{ mode: "email", email }` (a deployment;
only that VERIFIED address), or `{ mode: "off" }`. It runs under an advisory lock,
grants only while no administrator exists (deleted accounts don't count), and
answers why when it doesn't: `"off"`, `"not-eligible"`, `"admin-exists"` or
`"templates-missing"` (seed first).

## Upgrading from 0.1

No schema change. The database half moved here from create-app's template
(`src/server/permissions.ts`, `src/server/bootstrap.ts`, `scripts/seed-roles.ts`),
so a fix reaches every project by `npm update`.

## Not included

- A custom role editor for companies, and per-person permission changes for
  company members. The owner/admin/member/viewer roles are fixed.
- Viewing as a customer (impersonation). `staff.tenants.impersonate` is declared
  and sealed, and nothing implements it.
- Table prefixes, or a dedicated Postgres schema.

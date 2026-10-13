---
"@adminigloo/permissions": minor
---

`./server`: the database half of the permission engine, moved here from the
create-app template so a fix reaches every project by `npm update`.

- `createDrizzlePermissionLoaders(db, { membership })`: the tenant and staff
  loaders plus `explainTenantDenial`. The membership gate is required (a loader
  without one admits anyone holding a stray role row).
- `seedPermissionCatalog`: one transaction under an advisory lock, insert-only
  except for lifting a seal the catalog now grants; customised templates are
  never touched; reports the keys nobody holds. Safe on every deploy.
- `ensureBootstrapAdmin`: the first administrator, retried whenever no admin
  exists (deleted users don't count), the policy checked before any query, and
  pinned to the STAFF admin template (a company role is also called "admin").
- `assignRoleTemplate`, `listRoleTemplates`, `roleOf`: the one write path for
  role rows, with the rank guard (ranks read from the database),
  `protectLastKey`, `clearOverrides`, and `topRankPeers` so an administrator can
  make another administrator.

Root: `STAFF_ROLE_TEMPLATES`, `RoleTemplateSpec`, `BootstrapPolicy`, and
`FIRM_WIDE` from a module with no imports, so the root no longer loads
`drizzle-orm/pg-core` or the database driver.

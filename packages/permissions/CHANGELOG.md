# @adminigloo/permissions

## 0.1.0

### Minor Changes

- Two-layer permission engine — staff and tenant, one resolver.
  
  - Catalog declared in code (`definePermissions`), assignments in the database.
    Packages export plain permission records; the app spreads them, and a
    duplicate-key guard catches two packages claiming the same key.
  - Four tables: `role_template`, `role_template_grant`, `principal_role`,
    `principal_override`. `tenant_id` is NOT NULL with a `'*'` sentinel so the
    Postgres NULL-distinctness trap cannot produce duplicate firm-wide templates.
  - Resolution: deny by default, template grants, per-user overrides, any deny
    wins. A template `deny` is a seal an override cannot reopen.
  - `explainPermission()` returns why, so the checklist can distinguish "sealed by
    the template" from "nobody granted it yet".
  - `resolveAgainstCatalog()` refuses stored rows referencing a removed
    permission rather than silently resolving them to denied.

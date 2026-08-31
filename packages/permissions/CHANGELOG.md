# @adminigloo/permissions

## 0.1.2

### Patch Changes

- Shared dependency versions moved to pnpm's `catalog:` protocol.
  
  `drizzle-orm` was written out in eleven manifests and `zod` in nine, so bumping
  either was a bulk edit nobody could review — and the failure mode of a missed
  line is silent: two packages built against two different minors of drizzle emit
  .d.ts files whose column types are structurally incompatible, and the error
  surfaces in a generated project as an unreadable mismatch between two packages
  that each look correct on their own. `pnpm-workspace.yaml` now names each
  version once.
  
  **Nothing changes in the published tarballs.** pnpm rewrites `catalog:` to the
  literal range when a package is packed, and the packed manifests were compared
  against the previous ones to confirm it: every dependency, devDependency and
  peerDependency range is byte-for-byte what it was. This is recorded because the
  manifests changed and because the replacement is a publish-time behaviour worth
  being able to find in a changelog, not because a consumer will see anything.
  
  There are TWO catalogs on purpose. The default names the single version this
  workspace builds and tests against; the `peers` catalog names the wider range
  published packages promise their consumers — `drizzle-orm` is built against
  `^0.45.2` and accepts `^0.45.0`, `zod` is built against v4 and still accepts
  v3.25+. Collapsing them into one entry would silently narrow every published
  peer range, which is a breaking change for every consumer one patch behind.
  
  A new test in `@adminigloo/create-app` fails if any workspace manifest goes back
  to spelling a catalogued range out, and if the ranges the generator writes into
  a new project drift from the catalog.
- Updated dependencies
  - @adminigloo/db@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies
  - @adminigloo/db@0.2.0

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

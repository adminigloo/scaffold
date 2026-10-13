---
"@adminigloo/testing": minor
---

- `@adminigloo/testing/pglite`: `createPgliteDb({ schema })` builds a real
  in-process Postgres (PGlite) from a project's own Drizzle schema object
  (enums, tables, composite keys, unique constraints, checks, foreign keys with
  ON DELETE, partial and expression indexes), with a query log; `schemaDdl`
  gives the DDL alone. PGlite is an optional peer, loaded only when called.
- Factories learn the new columns: `buildUser().provisionedAt`, and
  `buildTenant()`'s `createdBy`, `creationKey`, `suspendedAt`,
  `suspendedReason`, `suspendedBy` and `setupState`.
- The fake identity provider marks its addresses verified by default
  (`unverifiedEmailIndexes` models one that isn't), matching auth 0.2.

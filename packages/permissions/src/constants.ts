/**
 * Sentinel tenant for firm-wide rows (all staff rows, and default tenant
 * presets).
 *
 * NOT NULL with a sentinel rather than a nullable column, deliberately.
 * Postgres treats NULLs as distinct in a unique index, so
 * `UNIQUE (scope, tenant_id, key)` with a nullable tenant_id would happily
 * accept two firm-wide templates with the same key. Removing the trap beats
 * working around it with partial indexes.
 *
 * ITS OWN MODULE, with no imports, so the package root can export it without
 * importing `./schema` — which would drag `drizzle-orm/pg-core` and
 * `@adminigloo/db` (and through it the Neon driver) into every client bundle
 * that only wanted the resolver.
 */
export const FIRM_WIDE = "*";

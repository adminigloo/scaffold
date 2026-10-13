import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Catalog, Scope } from "../catalog.js";
import { FIRM_WIDE } from "../constants.js";
import type { RoleTemplateSpec } from "../roles.js";
import { roleTemplate, roleTemplateGrant } from "../schema.js";
import { inTransaction, type PermissionsDb } from "./db.js";

export interface SeedScopeInput {
  readonly catalog: Catalog;
  readonly templates: readonly RoleTemplateSpec[];
}

export interface SeedPermissionCatalogInput {
  readonly staff?: SeedScopeInput;
  readonly tenant?: SeedScopeInput;
}

export interface SeedReport {
  /** Templates this run created, as "scope/key": "staff/admin", "tenant/owner". */
  readonly created: readonly string[];
  /** Templates found under a shipped key that are NOT system templates (customised, or deleted): never touched. */
  readonly skippedCustomised: readonly string[];
  readonly grantsAdded: number;
  readonly sealsAdded: number;
  /** Deny rows on SYSTEM templates turned to allow because the catalog now grants the key. */
  readonly sealsLifted: number;
  /** Catalog keys no template in that scope grants after the run (the /admin/access health card, PC-09). */
  readonly ungrantedKeys: readonly { readonly scope: Scope; readonly key: string }[];
}

/**
 * The advisory-lock key text. Every seed — the deploy job, `pnpm db:seed`, and
 * `createCompany`'s self-seed on an empty database (D10) — takes the same
 * lock, so two of them never interleave their inserts.
 */
export const SEED_LOCK_KEY = "adminigloo:permissions:seed";

/**
 * Write the shipped role templates and their default grants. Idempotent: safe
 * on every deploy, which is where create-app runs it (`pnpm db:seed:deploy`
 * after migrations, PC-09).
 *
 * Moved here from create-app's `scripts/seed-roles.ts` and hardened:
 *
 *   - ONE TRANSACTION, under an advisory lock, so a seed racing a seed (two
 *     deploys, or a deploy and the first company's self-seed) can't
 *     interleave.
 *   - INSERT-ONLY, with one deliberate exception (sealsLifted below). A
 *     customised template — `is_system = false` under a shipped key — is
 *     never touched: a catalog upgrade that rewrote a hand-edited template
 *     would silently revoke access somebody granted on purpose.
 *   - For each system template: every `defaultFor` key gets an allow row,
 *     and every SEALED key it isn't given gets a deny row. Since omission
 *     already denies, a deny row means something stronger: an override cannot
 *     reopen it.
 */
export async function seedPermissionCatalog(
  db: PermissionsDb,
  input: SeedPermissionCatalogInput,
): Promise<SeedReport> {
  return inTransaction(db, async (tx) => {
    await tx.execute(
      sql`/* adminigloo:permissions/seed-lock */ select pg_advisory_xact_lock(hashtextextended(${SEED_LOCK_KEY}, 0))`,
    );

    const created: string[] = [];
    const skippedCustomised: string[] = [];
    let grantsAdded = 0;
    let sealsAdded = 0;
    let sealsLifted = 0;
    const ungrantedKeys: { scope: Scope; key: string }[] = [];

    for (const scope of ["staff", "tenant"] as const) {
      const spec = input[scope];
      if (!spec) continue;
      if (spec.catalog.scope !== scope) {
        throw new TypeError(
          `seedPermissionCatalog was given the ${spec.catalog.scope} catalog for the ${scope} scope. ` +
            "Each scope's templates must be seeded from that scope's own catalog.",
        );
      }

      if (spec.templates.length > 0) {
        const inserted = await tx
          .insert(roleTemplate)
          .values(
            spec.templates.map((t) => ({
              scope,
              tenantId: FIRM_WIDE,
              key: t.key,
              name: t.name,
              description: t.description ?? null,
              rank: t.rank,
              isSystem: true,
            })),
          )
          .onConflictDoNothing({ target: [roleTemplate.scope, roleTemplate.tenantId, roleTemplate.key] })
          .returning({ key: roleTemplate.key });
        for (const row of inserted) created.push(`${scope}/${row.key}`);
      }

      const rows = spec.templates.length
        ? await tx
            .select({
              id: roleTemplate.id,
              key: roleTemplate.key,
              isSystem: roleTemplate.isSystem,
              deletedAt: roleTemplate.deletedAt,
            })
            .from(roleTemplate)
            .where(
              and(
                eq(roleTemplate.scope, scope),
                eq(roleTemplate.tenantId, FIRM_WIDE),
                inArray(
                  roleTemplate.key,
                  spec.templates.map((t) => t.key),
                ),
              ),
            )
        : [];

      for (const template of spec.templates) {
        const row = rows.find((r) => r.key === template.key);
        if (!row) continue;
        if (!row.isSystem || row.deletedAt !== null) {
          // A customised template (or one an operator deleted) keeps exactly
          // what somebody chose for it.
          skippedCustomised.push(`${scope}/${template.key}`);
          continue;
        }

        const defaults = spec.catalog.defaultsFor(template.key);
        if (defaults.length > 0) {
          const added = await tx
            .insert(roleTemplateGrant)
            .values(defaults.map((permission) => ({ templateId: row.id, permission, effect: "allow" as const })))
            .onConflictDoNothing()
            .returning({ permission: roleTemplateGrant.permission });
          grantsAdded += added.length;

          // THE ONE UPDATE THIS SEED PERFORMS, and the only exception to
          // insert-only. A key that was sealed (deny) on this system template
          // and that the catalog now grants it must become allow: otherwise a
          // catalog change granting a previously sealed key could never take
          // effect, because `on conflict do nothing` would keep the old deny
          // row forever. System templates only — the check above skipped
          // customised ones.
          const lifted = await tx
            .update(roleTemplateGrant)
            .set({ effect: "allow" })
            .where(
              and(
                eq(roleTemplateGrant.templateId, row.id),
                eq(roleTemplateGrant.effect, "deny"),
                inArray(roleTemplateGrant.permission, [...defaults]),
              ),
            )
            .returning({ permission: roleTemplateGrant.permission });
          sealsLifted += lifted.length;
        }

        const sealed = spec.catalog.keys.filter((k) => spec.catalog.isSealed(k) && !defaults.includes(k));
        if (sealed.length > 0) {
          const added = await tx
            .insert(roleTemplateGrant)
            .values(sealed.map((permission) => ({ templateId: row.id, permission, effect: "deny" as const })))
            .onConflictDoNothing()
            .returning({ permission: roleTemplateGrant.permission });
          sealsAdded += added.length;
        }
      }

      // Keys nobody in this scope can use after the run: a health signal (a
      // new feature's keys that no role was given), not an error.
      const granted = await tx
        .selectDistinct({ permission: roleTemplateGrant.permission })
        .from(roleTemplateGrant)
        .innerJoin(roleTemplate, eq(roleTemplate.id, roleTemplateGrant.templateId))
        .where(
          and(
            eq(roleTemplate.scope, scope),
            eq(roleTemplateGrant.effect, "allow"),
            isNull(roleTemplate.deletedAt),
          ),
        );
      const grantedSet = new Set(granted.map((g) => g.permission));
      for (const key of spec.catalog.keys) if (!grantedSet.has(key)) ungrantedKeys.push({ scope, key });
    }

    return { created, skippedCustomised, grantsAdded, sealsAdded, sealsLifted, ungrantedKeys };
  });
}

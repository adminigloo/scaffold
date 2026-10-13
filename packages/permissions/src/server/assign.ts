import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Scope } from "../catalog.js";
import { FIRM_WIDE } from "../constants.js";
import { principalOverride, principalRole, roleTemplate } from "../schema.js";
import { inTransaction, type PermissionsDb } from "./db.js";

export type RoleAssignmentErrorCode = "self" | "rank" | "unknown-template" | "last-holder";

export class RoleAssignmentError extends Error {
  readonly name = "RoleAssignmentError";
  constructor(
    readonly code: RoleAssignmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface AssignRoleTemplateInput {
  readonly scope: Scope;
  /** FIRM_WIDE for staff (the default). */
  readonly tenantId?: string;
  readonly principalId: string;
  /** null removes the role. */
  readonly templateKey: string | null;
  /** A person (rank-guarded) or a named system actor (admin:grant, bootstrap, createCompany): no rank guard. */
  readonly actor: { readonly principalId: string } | { readonly system: string };
  /** Refuse leaving zero holders of this key in this scope+tenant ("admin" for staff). */
  readonly protectLastKey?: string;
  /** Delete the principal's overrides in this scope+tenant when the role changes (tenant: on-change; staff: on-removal). */
  readonly clearOverrides?: "never" | "on-change" | "on-removal";
  /**
   * Let a person holding the HIGHEST-ranked template in the scope give or
   * take that same rank from someone else (never themselves).
   *
   * WHY, and why only at the top (review T1-09). Ranks are strictly greater
   * everywhere else (`canManageTemplate`), so equal ranks never manage each
   * other. Applied to the staff ladder that meant nobody could ever make a
   * second administrator from the People screen — nobody outranks an admin —
   * and the founder needed shell access (`pnpm admin:grant`) to add a
   * co-administrator. The top rung is the one place where "peers manage
   * peers" is the only workable rule; `protectLastKey` keeps the last one
   * from being removed. The company ladder does NOT use this: owner is
   * reached only by creation or transfer (D5).
   */
  readonly topRankPeers?: boolean;
}

export interface RoleAssignment {
  readonly previous: { readonly key: string; readonly rank: number } | null;
  readonly next: { readonly key: string; readonly rank: number } | null;
  readonly changed: boolean;
  /** The permission keys of the overrides this call deleted (D12: the audit lists them). */
  readonly clearedOverrides: readonly string[];
}

interface TemplateFacts {
  readonly id: string;
  readonly key: string;
  readonly rank: number;
}

/** A template by key, preferring a tenant's own over the firm-wide preset. Deleted ones don't count. */
async function templateByKey(tx: PermissionsDb, scope: Scope, tenantId: string, key: string): Promise<TemplateFacts | null> {
  const rows = await tx
    .select({ id: roleTemplate.id, key: roleTemplate.key, rank: roleTemplate.rank, tenantId: roleTemplate.tenantId })
    .from(roleTemplate)
    .where(
      and(
        eq(roleTemplate.scope, scope),
        eq(roleTemplate.key, key),
        isNull(roleTemplate.deletedAt),
        tenantId === FIRM_WIDE ? eq(roleTemplate.tenantId, FIRM_WIDE) : inArray(roleTemplate.tenantId, [tenantId, FIRM_WIDE]),
      ),
    );
  const own = rows.find((r) => r.tenantId === tenantId) ?? rows[0];
  return own ? { id: own.id, key: own.key, rank: own.rank } : null;
}

/** What a principal holds in this scope+tenant, with the template's rank. */
async function heldBy(tx: PermissionsDb, scope: Scope, tenantId: string, principalId: string): Promise<TemplateFacts | null> {
  const rows = await tx
    .select({ id: roleTemplate.id, key: roleTemplate.key, rank: roleTemplate.rank })
    .from(principalRole)
    .innerJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
    .where(
      and(
        eq(principalRole.principalId, principalId),
        eq(principalRole.scope, scope),
        eq(principalRole.tenantId, tenantId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Give, change or take away one principal's role in one scope+tenant, under
 * the rank guard. The ONE write path for role rows: the team page, the People
 * screen, ownership transfer, company creation and admin:grant all come
 * through here, so a guard fixed here is fixed everywhere.
 *
 * LOCKED per scope+tenant (`pg_advisory_xact_lock`) in the caller's
 * transaction, so two changes to the same roster serialise and the "last
 * holder" count can't be raced. Opened as a transaction (a savepoint when the
 * caller is already in one), so it composes with the tenancy lifecycle
 * functions' company lock (D7: the role lock is taken AFTER the company row).
 *
 * THE RANK GUARD READS RANKS FROM THE DATABASE (`role_template.rank`), so a
 * custom template or the crew role ranks correctly without a code table. A
 * person actor must hold a role here, must not be the target, and must
 * strictly outrank both the target's current role (no role = rank 0) and the
 * new one. A system actor (a script, createCompany, a transfer) is not
 * guarded: its own caller decided.
 */
export async function assignRoleTemplate(db: PermissionsDb, input: AssignRoleTemplateInput): Promise<RoleAssignment> {
  const scope = input.scope;
  const tenantId = input.tenantId ?? FIRM_WIDE;
  const clear = input.clearOverrides ?? "never";

  return inTransaction(db, async (tx) => {
    await tx.execute(
      sql`/* adminigloo:permissions/role-lock */ select pg_advisory_xact_lock(hashtextextended(${`adminigloo:roles:${scope}:${tenantId}`}, 0))`,
    );

    const next = input.templateKey === null ? null : await templateByKey(tx, scope, tenantId, input.templateKey);
    if (input.templateKey !== null && !next) {
      throw new RoleAssignmentError(
        "unknown-template",
        `There is no ${scope} role "${input.templateKey}". Seed the role templates (pnpm db:seed) or pick a role that exists.`,
      );
    }
    const previous = await heldBy(tx, scope, tenantId, input.principalId);

    if ("principalId" in input.actor) {
      if (input.actor.principalId === input.principalId) {
        throw new RoleAssignmentError("self", "Nobody can change their own role.");
      }
      const actorRole = await heldBy(tx, scope, tenantId, input.actor.principalId);
      if (!actorRole) {
        throw new RoleAssignmentError("rank", "Only someone with a role here can change roles.");
      }
      const targetRank = previous?.rank ?? 0;
      const newRank = next?.rank ?? 0;
      let allowed = actorRole.rank > targetRank && actorRole.rank > newRank;
      if (!allowed && input.topRankPeers) {
        const top = await tx
          .select({ rank: roleTemplate.rank })
          .from(roleTemplate)
          .where(and(eq(roleTemplate.scope, scope), isNull(roleTemplate.deletedAt), or(eq(roleTemplate.tenantId, FIRM_WIDE), eq(roleTemplate.tenantId, tenantId))))
          .orderBy(desc(roleTemplate.rank))
          .limit(1);
        const topRank = top[0]?.rank;
        allowed = topRank !== undefined && actorRole.rank === topRank && actorRole.rank >= targetRank && actorRole.rank >= newRank;
      }
      if (!allowed) {
        throw new RoleAssignmentError("rank", "You can only change people whose role is below yours, and only to a role below yours.");
      }
    }

    if (previous?.id === next?.id) {
      return {
        previous: previous ? { key: previous.key, rank: previous.rank } : null,
        next: next ? { key: next.key, rank: next.rank } : null,
        changed: false,
        clearedOverrides: [],
      };
    }

    if (input.protectLastKey !== undefined && previous?.key === input.protectLastKey && next?.key !== input.protectLastKey) {
      const others = await tx
        .select({ principalId: principalRole.principalId })
        .from(principalRole)
        .innerJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
        .where(
          and(
            eq(principalRole.scope, scope),
            eq(principalRole.tenantId, tenantId),
            eq(roleTemplate.key, input.protectLastKey),
            ne(principalRole.principalId, input.principalId),
          ),
        )
        .limit(1);
      if (others.length === 0) {
        throw new RoleAssignmentError("last-holder", `That's the only ${input.protectLastKey}. Give someone else that role first.`);
      }
    }

    if (next) {
      await tx
        .insert(principalRole)
        .values({ principalId: input.principalId, scope, tenantId, templateId: next.id })
        .onConflictDoUpdate({
          target: [principalRole.principalId, principalRole.scope, principalRole.tenantId],
          set: { templateId: next.id, updatedAt: sql`now()` },
        });
    } else {
      await tx
        .delete(principalRole)
        .where(and(eq(principalRole.principalId, input.principalId), eq(principalRole.scope, scope), eq(principalRole.tenantId, tenantId)));
    }

    let clearedOverrides: string[] = [];
    if (clear === "on-change" || (clear === "on-removal" && next === null)) {
      const deleted = await tx
        .delete(principalOverride)
        .where(
          and(
            eq(principalOverride.principalId, input.principalId),
            eq(principalOverride.scope, scope),
            eq(principalOverride.tenantId, tenantId),
          ),
        )
        .returning({ permission: principalOverride.permission });
      clearedOverrides = deleted.map((d) => d.permission).sort();
    }

    return {
      previous: previous ? { key: previous.key, rank: previous.rank } : null,
      next: next ? { key: next.key, rank: next.rank } : null,
      changed: true,
      clearedOverrides,
    };
  });
}

export interface RoleTemplateRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly rank: number;
  readonly isSystem: boolean;
}

/** The templates of one scope (firm-wide presets plus the tenant's own), highest rank first, deleted excluded. */
export async function listRoleTemplates(
  db: PermissionsDb,
  input: { readonly scope: Scope; readonly tenantId?: string },
): Promise<readonly RoleTemplateRow[]> {
  const tenantId = input.tenantId ?? FIRM_WIDE;
  const rows = await db
    .select({
      id: roleTemplate.id,
      key: roleTemplate.key,
      name: roleTemplate.name,
      description: roleTemplate.description,
      rank: roleTemplate.rank,
      isSystem: roleTemplate.isSystem,
      tenantId: roleTemplate.tenantId,
    })
    .from(roleTemplate)
    .where(
      and(
        eq(roleTemplate.scope, input.scope),
        isNull(roleTemplate.deletedAt),
        tenantId === FIRM_WIDE ? eq(roleTemplate.tenantId, FIRM_WIDE) : inArray(roleTemplate.tenantId, [tenantId, FIRM_WIDE]),
      ),
    )
    .orderBy(desc(roleTemplate.rank), roleTemplate.key);
  // A tenant's own template shadows the firm-wide preset with the same key.
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const seen = byKey.get(row.key);
    if (!seen || (seen.tenantId === FIRM_WIDE && row.tenantId === tenantId)) byKey.set(row.key, row);
  }
  return [...byKey.values()]
    .sort((a, b) => b.rank - a.rank || a.key.localeCompare(b.key))
    .map(({ tenantId: _t, ...rest }) => rest);
}

/** The role a principal holds in one scope+tenant, or null. */
export async function roleOf(
  db: PermissionsDb,
  input: { readonly principalId: string; readonly scope: Scope; readonly tenantId?: string },
): Promise<{ templateId: string; key: string; name: string; rank: number } | null> {
  const rows = await db
    .select({ templateId: roleTemplate.id, key: roleTemplate.key, name: roleTemplate.name, rank: roleTemplate.rank })
    .from(principalRole)
    .innerJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
    .where(
      and(
        eq(principalRole.principalId, input.principalId),
        eq(principalRole.scope, input.scope),
        eq(principalRole.tenantId, input.tenantId ?? FIRM_WIDE),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

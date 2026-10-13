import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { users } from "__SCOPE__/auth/schema";
import { auditEntry } from "__SCOPE__/observability";
import { auditLog, errorLog } from "__SCOPE__/observability/schema";
import {
  explainPermission,
  FIRM_WIDE,
  type Catalog,
  type PermissionRule,
  type Scope,
} from "__SCOPE__/permissions";
import {
  principalOverride,
  principalRole,
  roleTemplate,
  roleTemplateGrant,
} from "__SCOPE__/permissions/schema";
import { listRoleTemplates, roleOf } from "__SCOPE__/permissions/server";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import { staffCatalog, tenantCatalog } from "@/permissions/catalog";
import { auditRegistry } from "../audit";
import { requestContext } from "../request-context";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * Everything the admin panel reads and writes.
 *
 * The panel's pages are copied source and every client restyles them. This
 * router is not: it is the boundary. Every procedure below is built from
 * `requireStaff(...)`, never from a permission check written inside a handler —
 * an inline check is invisible to `auditProcedureScopes`, so the one procedure
 * that forgot it looks exactly like the twenty that did not.
 */

/**
 * The audit vocabulary this router writes through lives in `src/server/audit.ts`.
 *
 * It used to be declared here, as `adminAuditedActions`, and it moved the
 * moment a second router started auditing. Two registries cannot detect a
 * collision between them, and `recentAudit` below could only label the keys its
 * own registry held — so an action declared anywhere else rendered in the audit
 * viewer as a raw string, in the one screen whose entire job is to be read.
 * `src/server/audit.ts` is generated because which routers exist depends on
 * what the project installed.
 */

export type OverrideEffect = "inherit" | "allow" | "deny";

/**
 * One catalog key, as `PermissionChecklist` renders it.
 *
 * Declared here rather than imported from the component: the component is
 * overlay source that a project without the admin shell never receives, and a
 * router that imports it would fail to compile in exactly those projects.
 * Structurally identical on purpose — the component's props contract is the
 * one that matters, and it is already correct.
 */
export interface AdminPermissionRow {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly category: string;
  /** What the assigned template grants, before overrides. */
  readonly fromTemplate: boolean;
  /** No override can grant it. */
  readonly sealed: boolean;
  readonly override: OverrideEffect;
}

const scopeInput = z.enum(["staff", "tenant"]);

/**
 * Staff rows are firm-wide, so their tenant id is the sentinel and not a real
 * tenant. Defaulted here rather than at each call site: a missing tenant id
 * that fell through as `""` would write an override row nothing ever reads,
 * and the permission would quietly fail to take effect.
 */
const tenantIdInput = z.string().min(1).default(FIRM_WIDE);

function catalogFor(scope: Scope): Catalog {
  return scope === "staff" ? staffCatalog : tenantCatalog;
}

/** `db`, or a transaction: a write decides on what its own transaction reads. */
type Handle = Pick<typeof db, "select">;

/** The template a principal holds in one scope, and what it grants. */
async function loadTemplateFor(
  input: {
    principalId: string;
    scope: Scope;
    tenantId: string;
  },
  on: Handle = db,
) {
  const [assignment] = await on
    .select({ templateId: principalRole.templateId })
    .from(principalRole)
    .where(
      and(
        eq(principalRole.principalId, input.principalId),
        eq(principalRole.scope, input.scope),
        eq(principalRole.tenantId, input.tenantId),
      ),
    );

  if (!assignment) return { template: null, grants: [] as PermissionRule[] };

  const [template] = await on
    .select()
    .from(roleTemplate)
    .where(eq(roleTemplate.id, assignment.templateId));

  const grants = await on
    .select({
      permission: roleTemplateGrant.permission,
      effect: roleTemplateGrant.effect,
    })
    .from(roleTemplateGrant)
    .where(eq(roleTemplateGrant.templateId, assignment.templateId));

  return { template: template ?? null, grants };
}

async function loadOverridesFor(input: {
  principalId: string;
  scope: Scope;
  tenantId: string;
}): Promise<PermissionRule[]> {
  return db
    .select({
      permission: principalOverride.permission,
      effect: principalOverride.effect,
    })
    .from(principalOverride)
    .where(
      and(
        eq(principalOverride.principalId, input.principalId),
        eq(principalOverride.scope, input.scope),
        eq(principalOverride.tenantId, input.tenantId),
      ),
    );
}

/**
 * May an override touch this key at all?
 *
 * The union of two sources, deliberately. `sealed: true` in the catalog is the
 * DECLARATION; the template's `deny` row is how the seeder STORES it. A
 * template seeded before the flag was added has no deny row, so trusting the
 * stored form alone would let an override reopen a capability the catalog says
 * must never be handed out one person at a time.
 *
 * A key that is both `sealed` and listed in some template's `defaultFor` is a
 * catalog contradiction. It reads as sealed here, so the checklist cannot offer
 * an override that `setOverride` would then refuse.
 */
function isSealedFor(
  catalog: Catalog,
  permission: string,
  reason: string,
): boolean {
  return reason === "sealed-by-template" || catalog.isSealed(permission);
}

/**
 * An override was attempted on a permission the catalog seals.
 *
 * A named class rather than a bare message so a caller can tell this apart from
 * every other FORBIDDEN. `readonly name` as an own property, matching the rest
 * of this codebase: pnpm can install two physical copies of a package, and
 * `instanceof` is false across them while the name survives.
 */
export class SealedPermissionError extends Error {
  readonly name = "SealedPermissionError";
  constructor(readonly permission: string) {
    super(
      `"${permission}" is sealed and cannot be granted or revoked for one ` +
        `person. Change the role template, or unseal it in the catalog.`,
    );
  }
}

/**
 * Why a per-person change was refused, in words the RoleEditor shows as is.
 */
export class OverrideNotAllowedError extends Error {
  readonly name = "OverrideNotAllowedError";
}

/**
 * THE RANK RULES, APPLIED TO PER-PERSON CHANGES TOO (review T1-05).
 *
 * Staff roles are rank-guarded where they are given (People, through
 * `assignRoleTemplate`): a customer service lead can't make anyone an
 * administrator. This procedure is a second way into the same permissions, and
 * until now it had no ranks at all — anyone holding `staff.roles.manage` could
 * give THEMSELVES `staff.tenants.suspend` and every other unsealed staff key,
 * which is administrator in all but name, or quietly hand a company member
 * access their role never gave them. Two ways to do one thing, one guarded and
 * one not, is the gap this closes:
 *
 *   - never on yourself — ask another administrator;
 *   - staff: only on someone you strictly outrank, who HOLDS a staff role (an
 *     override on someone with none changes nothing: there is no staff set for
 *     it to sit on top of), and you may only GRANT a key you hold yourself;
 *   - a company member's access: only the top staff rank may grant extra
 *     access (taking it away, or clearing an override, is any rank's to do).
 *
 * Checked on the server because the checklist's disabled rows are a courtesy:
 * this procedure is reachable with a hand-written request.
 */
async function assertMayOverride(input: {
  readonly actorId: string;
  readonly actorCan: { can(key: string): boolean };
  readonly principalId: string;
  readonly scope: Scope;
  readonly tenantId: string;
  readonly permission: string;
  readonly effect: OverrideEffect;
}): Promise<void> {
  if (input.principalId === input.actorId) {
    throw new OverrideNotAllowedError(
      "You can't change your own access. Ask another administrator to do it.",
    );
  }
  const actor = await roleOf(db, { principalId: input.actorId, scope: "staff" });
  const actorRank = actor?.rank ?? 0;
  if (input.scope === "staff") {
    const target = await roleOf(db, { principalId: input.principalId, scope: "staff" });
    if (!target) {
      throw new OverrideNotAllowedError(
        "This person has no staff role. Give them one on People first; per-person changes only apply on top of a role.",
      );
    }
    if (target.rank >= actorRank) {
      throw new OverrideNotAllowedError(
        `Only someone above ${target.name} can change their access.`,
      );
    }
    if (input.effect === "allow" && !input.actorCan.can(input.permission)) {
      throw new OverrideNotAllowedError(
        "You can only give someone access you have yourself.",
      );
    }
    return;
  }
  if (input.effect === "allow") {
    const templates = await listRoleTemplates(db, { scope: "staff" });
    const top = Math.max(0, ...templates.map((template) => template.rank));
    if (actorRank < top) {
      throw new OverrideNotAllowedError(
        "Only an administrator can give a customer's team member extra access.",
      );
    }
  }
}

export const adminRouter = createTRPCRouter({
  /**
   * Role templates in one scope, with how many principals hold each.
   *
   * The count is what makes the list actionable: "3 people hold this" is the
   * difference between editing a template and quietly changing what three
   * people can do. LEFT JOIN, so a template nobody holds still appears — an
   * unheld template is usually the interesting one.
   */
  listTemplates: requireStaff("staff.roles.view")
    .meta({ scope: "staff" })
    .input(z.object({ scope: scopeInput }))
    .query(async ({ input }) => {
      const templates = await db
        .select({
          id: roleTemplate.id,
          key: roleTemplate.key,
          name: roleTemplate.name,
          description: roleTemplate.description,
          rank: roleTemplate.rank,
          isSystem: roleTemplate.isSystem,
          tenantId: roleTemplate.tenantId,
          holders: count(principalRole.principalId),
        })
        .from(roleTemplate)
        .leftJoin(principalRole, eq(principalRole.templateId, roleTemplate.id))
        .where(
          and(eq(roleTemplate.scope, input.scope), isNull(roleTemplate.deletedAt)),
        )
        .groupBy(roleTemplate.id)
        .orderBy(desc(roleTemplate.rank), roleTemplate.key);

      return { templates };
    }),

  /**
   * People, with the staff template each one holds.
   *
   * `limit + 1` rather than a COUNT(*): the only thing the picker needs is
   * whether to offer "next", and a count over a users table that only grows
   * costs a full scan to answer a yes/no question.
   */
  listPeople: requireStaff("staff.people.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      // `%` and `_` are wildcards in LIKE. Unescaped, a search for "%" matches
      // every row and a search for "a_b" matches "axb" — the second returns the
      // wrong people rather than none, which nobody notices.
      const search = input.search
        ? `%${input.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
        : null;

      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          createdAt: users.createdAt,
          templateKey: roleTemplate.key,
          templateName: roleTemplate.name,
        })
        .from(users)
        .leftJoin(
          principalRole,
          and(
            eq(principalRole.principalId, users.id),
            eq(principalRole.scope, "staff"),
            eq(principalRole.tenantId, FIRM_WIDE),
          ),
        )
        .leftJoin(roleTemplate, eq(roleTemplate.id, principalRole.templateId))
        .where(
          and(
            isNull(users.deletedAt),
            search
              ? or(ilike(users.email, search), ilike(users.displayName, search))
              : undefined,
          ),
        )
        // `users.id` is a UUID v7, so it breaks ties in creation order rather
        // than arbitrarily. Without a tiebreak, two users created in the same
        // millisecond can swap places between pages and one is never shown.
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(input.limit + 1)
        .offset(input.offset);

      return {
        people: rows.slice(0, input.limit),
        hasMore: rows.length > input.limit,
      };
    }),

  /**
   * Every catalog key for one principal, as the checklist renders it.
   *
   * EVERY key, not only the ones with rows. A checklist that lists only what
   * has been granted cannot be used to grant anything, and "not granted" is a
   * state an admin has to see to trust the answer.
   *
   * The flags come from `explainPermission`, called twice: once with the
   * overrides removed, which is the definition of `fromTemplate`, and once with
   * them applied. Deriving them by re-reading the rows here would be a second
   * implementation of the resolver, and the two would disagree the first time
   * the precedence rules changed.
   */
  permissionsFor: requireStaff("staff.roles.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        principalId: z.string().min(1),
        scope: scopeInput,
        tenantId: tenantIdInput,
      }),
    )
    .query(async ({ input }) => {
      const catalog = catalogFor(input.scope);
      const { template, grants } = await loadTemplateFor(input);
      const overrides = await loadOverridesFor(input);

      const rows: AdminPermissionRow[] = catalog.keys.map((key) => {
        const definition = catalog.get(key);
        const baseline = explainPermission(key, {
          templateGrants: grants,
          overrides: [],
        });
        const resolved = explainPermission(key, {
          templateGrants: grants,
          overrides,
        });

        return {
          key,
          label: definition.label,
          description: definition.description,
          category: definition.category ?? "General",
          fromTemplate: baseline.allowed,
          sealed: isSealedFor(catalog, key, resolved.reason),
          override:
            resolved.reason === "granted-by-override"
              ? "allow"
              : resolved.reason === "denied-by-override"
                ? "deny"
                : "inherit",
        };
      });

      // Rows stored against keys the catalog no longer declares. The resolver
      // refuses these outright (`resolveAgainstCatalog` throws), so surfacing
      // them is the only warning anyone gets that a permission was renamed
      // without a migration rewriting the stored rows.
      const stale = [...grants, ...overrides]
        .map((rule) => rule.permission)
        .filter((permission) => !catalog.has(permission));

      return {
        template: template
          ? {
              id: template.id,
              key: template.key,
              name: template.name,
              rank: template.rank,
              isSystem: template.isSystem,
            }
          : null,
        rows,
        stalePermissions: [...new Set(stale)],
      };
    }),

  /**
   * Grant, revoke, or clear one permission for one person.
   *
   * "inherit" DELETES the row. Storing a third effect would put a value in
   * `permission_effect` that `resolvePermissionSet` has no branch for, and its
   * fallthroughs — `else allowed.add(...)` for a template grant, `else
   * allowed.delete(...)` for an override — would then read the same stored
   * value as allow in one table and deny in the other.
   */
  setOverride: requireStaff("staff.roles.manage")
    .meta({ scope: "staff" })
    .input(
      z.object({
        principalId: z.string().min(1),
        scope: scopeInput,
        tenantId: tenantIdInput,
        permission: z.string().min(1),
        effect: z.enum(["inherit", "allow", "deny"]),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const catalog = catalogFor(input.scope);

      // A key the catalog has never heard of is a typo or a stale client. It
      // has to fail here: written through, it becomes a stored row the resolver
      // refuses to resolve, which denies the person every permission at once.
      if (!catalog.has(input.permission)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${input.permission}" is not in the ${input.scope} catalog.`,
        });
      }

      const { grants } = await loadTemplateFor(input);
      const sealed = isSealedFor(
        catalog,
        input.permission,
        explainPermission(input.permission, {
          templateGrants: grants,
          overrides: [],
        }).reason,
      );

      // The checklist disables these rows. That is a courtesy, not the rule:
      // the browser is not the boundary, and this procedure is reachable with a
      // hand-written request by anyone holding `staff.roles.manage`.
      if (sealed) {
        const error = new SealedPermissionError(input.permission);
        throw new TRPCError({
          code: "FORBIDDEN",
          message: error.message,
          cause: error,
        });
      }

      try {
        await assertMayOverride({
          actorId: ctx.principal.userId,
          actorCan: ctx.can,
          principalId: input.principalId,
          scope: input.scope,
          tenantId: input.tenantId,
          permission: input.permission,
          effect: input.effect,
        });
      } catch (error) {
        if (!(error instanceof OverrideNotAllowedError)) throw error;
        throw new TRPCError({ code: "FORBIDDEN", message: error.message, cause: error });
      }

      const request = await requestContext();

      // One transaction. An override that lands without its audit row is
      // precisely the change somebody asks about six months later, and the
      // answer would be that the database says it was always that way.
      return db.transaction(async (tx) => {
        // A COMPANY MEMBER'S ACCESS IS DECIDED UNDER THE COMPANY LOCK, ON WHAT
        // IS TRUE NOW (review R2 F3; decision D7). Removing someone, changing
        // their role and accepting an invitation all serialise on the
        // company's row; without taking it here, an override decided from a
        // screen opened before a removal landed after it, on a person who was
        // no longer there — and lay dormant until they were re-invited. So:
        // the row first, then the person must still be an active member (an
        // override on anyone else is refused; clearing one is always allowed),
        // and whether the key is sealed is read again, on this transaction.
        if (input.scope === "tenant") {
          await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, input.tenantId)).for("update");
          if (input.effect !== "inherit") {
            const [member] = await tx
              .select({ status: tenantMembers.status })
              .from(tenantMembers)
              .where(and(eq(tenantMembers.tenantId, input.tenantId), eq(tenantMembers.userId, input.principalId)));
            if (member?.status !== "active") {
              const error = new OverrideNotAllowedError(
                "This person isn't on that company's team, so there is no access to change. Their access starts from their role when they join.",
              );
              throw new TRPCError({ code: "FORBIDDEN", message: error.message, cause: error });
            }
            const now = await loadTemplateFor(input, tx);
            if (
              isSealedFor(
                catalog,
                input.permission,
                explainPermission(input.permission, { templateGrants: now.grants, overrides: [] }).reason,
              )
            ) {
              const error = new SealedPermissionError(input.permission);
              throw new TRPCError({ code: "FORBIDDEN", message: error.message, cause: error });
            }
          }
        }

        const identity = and(
          eq(principalOverride.principalId, input.principalId),
          eq(principalOverride.scope, input.scope),
          eq(principalOverride.tenantId, input.tenantId),
          eq(principalOverride.permission, input.permission),
        );

        const [previous] = await tx
          .select({ effect: principalOverride.effect })
          .from(principalOverride)
          .where(identity);

        if (input.effect === "inherit") {
          await tx.delete(principalOverride).where(identity);
        } else {
          await tx
            .insert(principalOverride)
            .values({
              principalId: input.principalId,
              scope: input.scope,
              tenantId: input.tenantId,
              permission: input.permission,
              effect: input.effect,
              grantedBy: ctx.principal.userId,
              reason: input.reason ?? null,
            })
            .onConflictDoUpdate({
              target: [
                principalOverride.principalId,
                principalOverride.scope,
                principalOverride.tenantId,
                principalOverride.permission,
              ],
              set: {
                effect: input.effect,
                grantedBy: ctx.principal.userId,
                reason: input.reason ?? null,
                // `updatedAt()` supplies a default on INSERT only. Without this
                // line a flipped override keeps the timestamp of the day it was
                // first set, and reads as untouched since.
                updatedAt: new Date(),
              },
            });
        }

        await tx.insert(auditLog).values(
          auditEntry(auditRegistry, {
            action:
              input.effect === "allow"
                ? "permission.override.granted"
                : input.effect === "deny"
                  ? "permission.override.revoked"
                  : "permission.override.cleared",
            actor: ctx.principal,
            // The rung this ran under, which is what the column means. The
            // scope of the permission that changed is a different thing and
            // goes in the metadata below.
            scope: "staff",
            // Only a real tenant belongs here. This column indexes the
            // per-organisation activity feed, and the firm-wide sentinel would
            // drop every staff change into whichever feed queries `tenant_id`.
            tenantId: input.scope === "tenant" ? input.tenantId : null,
            resourceType: "user",
            resourceId: input.principalId,
            request,
            metadata: {
              permission: input.permission,
              effect: input.effect,
              previousEffect: previous?.effect ?? "inherit",
              targetScope: input.scope,
              targetTenantId: input.tenantId,
              reason: input.reason ?? null,
            },
          }),
        );

        return {
          permission: input.permission,
          effect: input.effect,
          previousEffect: previous?.effect ?? "inherit",
        };
      });
    }),

  /** The trail, newest first, with the actor's name joined in where it exists. */
  recentAudit: requireStaff("staff.audit.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        /** Reads the partial index the sensitive slice exists for. */
        sensitiveOnly: z.boolean().default(false),
      }),
    )
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          isSensitive: auditLog.isSensitive,
          scope: auditLog.scope,
          tenantId: auditLog.tenantId,
          resourceType: auditLog.resourceType,
          resourceId: auditLog.resourceId,
          metadata: auditLog.metadata,
          createdAt: auditLog.createdAt,
          actorUserId: auditLog.actorUserId,
          actorImpersonatedBy: auditLog.actorImpersonatedBy,
          // LEFT JOIN, with the id kept alongside. The audit tables carry no
          // foreign keys on purpose — the trail has to outlive the rows it
          // describes — so a deleted user misses the join and the viewer shows
          // the id, which is the honest thing to render.
          actorEmail: users.email,
          actorName: users.displayName,
        })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(input.sensitiveOnly ? eq(auditLog.isSensitive, true) : undefined)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(input.limit);

      return {
        entries: rows.map((row) => ({
          ...row,
          // The registry's label where it knows the action, the raw key where
          // it does not. An action named with a bare string literal at a call
          // site shows up here as its key — the visible symptom of the thing
          // `defineAuditedActions` exists to prevent.
          label: auditRegistry.has(row.action)
            ? auditRegistry.get(row.action).label
            : row.action,
        })),
      };
    }),

  /**
   * Distinct bugs, unresolved first.
   *
   * One row per fingerprint, not per occurrence, so `occurrences` is the triage
   * signal — "this happened 40,000 times since Tuesday" is what decides what
   * gets fixed, and it is only available because writes upsert.
   */
  recentErrors: requireStaff("staff.audit.view")
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
    .query(async ({ input }) => {
      const errors = await db
        .select({
          id: errorLog.id,
          fingerprint: errorLog.fingerprint,
          message: errorLog.message,
          source: errorLog.source,
          occurrences: errorLog.occurrences,
          firstSeenAt: errorLog.firstSeenAt,
          lastSeenAt: errorLog.lastSeenAt,
          resolvedAt: errorLog.resolvedAt,
        })
        .from(errorLog)
        // Unresolved first, then most recent. Ordering by `last_seen_at` alone
        // buries a live incident under a resolved error that fired an hour ago.
        .orderBy(
          sql`${errorLog.resolvedAt} is null desc`,
          desc(errorLog.lastSeenAt),
        )
        .limit(input.limit);

      return { errors };
    }),
});

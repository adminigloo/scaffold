import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, deletedAt, idColumn, updatedAt } from "@adminigloo/db";

export const permissionScope = pgEnum("permission_scope", ["staff", "tenant"]);
export const permissionEffect = pgEnum("permission_effect", ["allow", "deny"]);

/**
 * Sentinel tenant for firm-wide rows (all staff rows, and default tenant
 * presets).
 *
 * NOT NULL with a sentinel rather than a nullable column, deliberately.
 * Postgres treats NULLs as distinct in a unique index, so
 * `UNIQUE (scope, tenant_id, key)` with a nullable tenant_id would happily
 * accept two firm-wide templates with the same key. Removing the trap beats
 * working around it with partial indexes.
 */
export const FIRM_WIDE = "*";

/** A named preset: "CS Lead", "Client Admin". Assigned to principals. */
export const roleTemplate = pgTable(
  "role_template",
  {
    id: idColumn(),
    scope: permissionScope("scope").notNull(),
    tenantId: text("tenant_id").notNull().default(FIRM_WIDE),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Higher outranks lower. Drives the privilege-escalation guards. */
    rank: integer("rank").notNull().default(0),
    /**
     * Shipped by a package rather than authored by a client. Catalog upgrades
     * apply `defaultFor` grants to these and ONLY these — a customised template
     * is never rewritten by an upgrade.
     */
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex("role_template_scope_tenant_key_idx").on(t.scope, t.tenantId, t.key),
    index("role_template_tenant_idx").on(t.tenantId),
  ],
);

/**
 * What a template grants.
 *
 * `allow` adds. `deny` SEALS — it is the one thing a per-user override cannot
 * reopen. Since omission already denies, a `deny` row here is always a
 * deliberate seal, never bookkeeping.
 */
export const roleTemplateGrant = pgTable(
  "role_template_grant",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => roleTemplate.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    effect: permissionEffect("effect").notNull(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.permission] })],
);

/**
 * Which template a principal holds, per scope and tenant.
 *
 * One template per (principal, scope, tenant) — enforced by the primary key.
 * Multiple simultaneous roles would make "what can this person do" a merge
 * question with no obvious answer for conflicting seals; per-user overrides
 * cover the cases multiple roles would otherwise be reached for.
 *
 * `onDelete: restrict` on the template: deleting a template that people still
 * hold must fail loudly rather than silently stripping their access.
 */
export const principalRole = pgTable(
  "principal_role",
  {
    principalId: text("principal_id").notNull(),
    scope: permissionScope("scope").notNull(),
    tenantId: text("tenant_id").notNull().default(FIRM_WIDE),
    templateId: text("template_id")
      .notNull()
      .references(() => roleTemplate.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.scope, t.tenantId] }),
    index("principal_role_template_idx").on(t.templateId),
  ],
);

/** Per-person adjustments on top of the template. The checklist writes here. */
export const principalOverride = pgTable(
  "principal_override",
  {
    principalId: text("principal_id").notNull(),
    scope: permissionScope("scope").notNull(),
    tenantId: text("tenant_id").notNull().default(FIRM_WIDE),
    permission: text("permission").notNull(),
    effect: permissionEffect("effect").notNull(),
    /** Who set it, and why — an override without provenance is unauditable. */
    grantedBy: text("granted_by"),
    reason: text("reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      columns: [t.principalId, t.scope, t.tenantId, t.permission],
    }),
    index("principal_override_lookup_idx").on(
      t.principalId,
      t.scope,
      t.tenantId,
    ),
  ],
);

export const permissionsSchema = {
  permissionScope,
  permissionEffect,
  roleTemplate,
  roleTemplateGrant,
  principalRole,
  principalOverride,
};

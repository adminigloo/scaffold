import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { randomBytes } from "node:crypto";
import type { AudienceReason, MarkSource, RuleKind, RunAction, SubjectKind } from "./core/labels.js";

/**
 * A UUID v7 (time-ordered, the AdminIgloo convention for entity ids), made
 * here rather than imported from `@adminigloo/db`: that package brings the
 * Neon driver, `ws` and the env stack, which a MySQL app using only `./core`
 * should not have to install.
 */
export function newAudienceId(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const idColumn = () => text("id").primaryKey().$defaultFn(newAudienceId);

/**
 * The four tables, under a prefix the app chooses (default `aig_audience_`,
 * which collides with nothing in Riddler Go, Road Rally or the AdminIgloo
 * template). Every table, index and constraint name is built from the prefix,
 * so two sets can live in one database and a migration generated from the
 * default reproduces these names exactly.
 *
 *   rules — what an admin said ("everyone @riddlergo.com"). Never deleted:
 *           removing sets disabled_at.
 *   marks — what does not count: a subject (a visitor, a user, an org, an
 *           event, an order, a session) and why. Reports leave out rows whose
 *           subject has an UNCLEARED mark — a NOT EXISTS anti-join, so app rows
 *           are never rewritten. Never deleted: removing sets cleared_at. At
 *           most one active mark per (tenant, subject, rule — or reason when no
 *           rule owns it), enforced by a partial unique index.
 *   links — which devices a signed-in person used: visitor id + HMAC(secret,
 *           user id). Never the user id itself, never an IP, never a UA.
 *   runs  — the audit trail: every apply, remove, backfill and hand mark, with
 *           how many subjects and sessions it changed.
 *
 * No table has a tenant FK (tenancy is a plain text column, as in every
 * AdminIgloo package) and NO table has an IP column — there is nowhere to put
 * one.
 */

export interface DefineAudienceTablesOptions {
  /** Default "aig_audience_". Lower-case letters, digits and underscores. */
  prefix?: string;
}

export function defineAudienceTables(options: DefineAudienceTablesOptions = {}) {
  const prefix = options.prefix ?? "aig_audience_";
  if (!/^[a-z_][a-z0-9_]*$/.test(prefix)) {
    throw new Error(`@adminigloo/audience: table prefix must be lower-case letters, digits and underscores (got ${JSON.stringify(prefix)}).`);
  }
  const name = (suffix: string) => `${prefix}${suffix}`;

  const rules = pgTable(
    name("rules"),
    {
      id: idColumn(),
      tenantId: text("tenant_id").notNull(),
      kind: text("kind").$type<RuleKind>().notNull(),
      /** Normalised (lower-cased email, canonical CIDR, bare domain…). */
      value: text("value").notNull(),
      reasonLabel: text("reason_label"),
      note: text("note"),
      createdBy: text("created_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      disabledAt: timestamp("disabled_at", { withTimezone: true }),
      disabledBy: text("disabled_by"),
      appliesFrom: timestamp("applies_from", { withTimezone: true }),
    },
    (t) => [
      index(name("rules_tenant_idx")).on(t.tenantId),
      // One ACTIVE rule per thing it names; a removed rule can be added again.
      uniqueIndex(name("rules_active_uq")).on(t.tenantId, t.kind, t.value).where(sql`disabled_at is null`),
    ],
  );

  const marks = pgTable(
    name("marks"),
    {
      id: idColumn(),
      tenantId: text("tenant_id").notNull(),
      subjectKind: text("subject_kind").$type<SubjectKind>().notNull(),
      subjectId: text("subject_id").notNull(),
      reason: text("reason").$type<AudienceReason>().notNull(),
      /** Null when set at intake by a default/the callback, by hand, or by a backfill verdict. */
      ruleId: text("rule_id"),
      source: text("source").$type<MarkSource>().notNull(),
      markedBy: text("marked_by"),
      markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
      clearedAt: timestamp("cleared_at", { withTimezone: true }),
      clearedBy: text("cleared_by"),
      /** Copied from the rule: rows before this instant stay counted. */
      appliesFrom: timestamp("applies_from", { withTimezone: true }),
    },
    (t) => [
      foreignKey({ name: name("marks_rule_fk"), columns: [t.ruleId], foreignColumns: [rules.id] }),
      // The idempotency key AND the anti-join's index: its leading columns are
      // exactly what NOT EXISTS (… subject_kind = ? AND subject_id = s.col
      // AND cleared_at IS NULL) looks up.
      uniqueIndex(name("marks_active_uq"))
        .on(t.tenantId, t.subjectKind, t.subjectId, sql`coalesce(rule_id, reason)`)
        .where(sql`cleared_at is null`),
      index(name("marks_rule_idx")).on(t.tenantId, t.ruleId),
    ],
  );

  const links = pgTable(
    name("links"),
    {
      tenantId: text("tenant_id").notNull(),
      visitorId: text("visitor_id").notNull(),
      /** HMAC-SHA256(AUDIENCE_SECRET, tenant ‖ user id), base64url. */
      userKey: text("user_key").notNull(),
      firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
      lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ name: name("links_pk"), columns: [t.tenantId, t.visitorId, t.userKey] }),
      index(name("links_user_idx")).on(t.tenantId, t.userKey),
    ],
  );

  const runs = pgTable(
    name("runs"),
    {
      id: idColumn(),
      tenantId: text("tenant_id").notNull(),
      ruleId: text("rule_id"),
      action: text("action").$type<RunAction>().notNull(),
      subjectsChanged: integer("subjects_changed").notNull().default(0),
      sessionsAffected: integer("sessions_affected"),
      rangeFrom: timestamp("range_from", { withTimezone: true }),
      rangeTo: timestamp("range_to", { withTimezone: true }),
      runBy: text("run_by"),
      runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
      summary: text("summary"),
    },
    (t) => [index(name("runs_tenant_at_idx")).on(t.tenantId, t.runAt)],
  );

  return { prefix, rules, marks, links, runs };
}

export type AudienceTables = ReturnType<typeof defineAudienceTables>;

/** The default set (`aig_audience_*`) — spread these into your Drizzle schema. */
const defaults = defineAudienceTables();
export const audienceRules = defaults.rules;
export const audienceMarks = defaults.marks;
export const audienceLinks = defaults.links;
export const audienceRuns = defaults.runs;
export const audienceTables: AudienceTables = defaults;

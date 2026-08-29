import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, logIdColumn } from "@adminigloo/db";

/**
 * What happened, who did it, and to whom.
 *
 * Append-only. Nothing in this package updates or deletes a row, and nothing
 * should: an audit trail that can be edited answers a different question than
 * the one it is kept for.
 *
 * `bigserial` rather than a UUID, per the column conventions — nothing
 * references these rows, and the volume is the highest of any table here.
 *
 * No foreign keys on `actor_user_id` or `tenant_id`, deliberately. The trail
 * has to outlive the rows it describes: a `tenant.deleted` entry whose FK
 * cascades away with the tenant destroys the record of the deletion, and a
 * hard-deleted user must not take their history with them. The cost is that a
 * viewer joins defensively and renders an id when the join misses, which is
 * the correct thing to show anyway.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: logIdColumn(),
    /**
     * The local `users.id`, not the identity provider's id. Nullable: a cron
     * job, a webhook and a migration all write here and none of them is a
     * person.
     */
    actorUserId: text("actor_user_id"),
    /**
     * The staff user who was impersonating `actor_user_id` at the time.
     *
     * A SEPARATE COLUMN, never folded into the actor. Writing the staff id
     * into `actor_user_id` loses which customer's data was touched; writing
     * only the customer's id produces a log that says the customer did it.
     * Both are needed, and the second is the entire reason an impersonation
     * feature is allowed to exist.
     */
    actorImpersonatedBy: text("actor_impersonated_by"),
    /** A key from `defineAuditedActions`. Free text here, enforced in code. */
    action: text("action").notNull(),
    /** "staff" or "tenant", matching the permission scope the action ran in. */
    scope: text("scope"),
    tenantId: text("tenant_id"),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    /**
     * Copied from the registry at write time by `auditEntry`, never passed in
     * by the caller.
     *
     * Denormalised on purpose: it is the predicate of the partial index below,
     * and recomputing it at read time from today's registry would give a
     * different answer about last year's facts every time the registry changes.
     */
    isSensitive: boolean("is_sensitive").notNull().default(false),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** Redacted by `auditEntry` before it gets here. */
    metadata: jsonb("metadata"),
    createdAt: createdAt(),
  },
  (t) => [
    /** The tenant-facing activity feed: this org, newest first. */
    index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt),
    /** "What did this person do", the first question of every investigation. */
    index("audit_log_actor_created_idx").on(t.actorUserId, t.createdAt),
    /**
     * The compliance question is always "who read sensitive data, and when",
     * and the answer is a small slice of a very large table — every page view
     * and settings change shares it with a handful of exports. Partial, so the
     * index stays proportional to the slice being queried rather than to the
     * table; a full index on `created_at` would be almost entirely rows this
     * query never wants and would age into the most expensive object in the
     * database.
     */
    index("audit_log_sensitive_created_idx")
      .on(t.createdAt)
      .where(sql`${t.isSensitive}`),
  ],
);

/**
 * One row per distinct bug, not one row per occurrence.
 *
 * The unique index on `fingerprint` is what makes that true, and it only
 * works if writes go through an upsert:
 *
 *   INSERT INTO error_log
 *     (fingerprint, message, stack, source, tenant_id, user_id, context)
 *   VALUES ($1, $2, $3, $4, $5, $6, $7)
 *   ON CONFLICT (fingerprint) DO UPDATE
 *     SET occurrences = error_log.occurrences + 1,
 *         last_seen_at = now(),
 *         resolved_at  = NULL
 *
 * A plain insert per occurrence turns one bad deploy into millions of rows
 * that push the useful ones off the first page, and the count — the number
 * that decides what gets fixed first — has to be recovered with a GROUP BY
 * over the whole table.
 *
 * `resolved_at` is cleared by the upsert on purpose: a bug marked fixed that
 * fires again is not resolved, and leaving the stamp in place hides a
 * regression behind the checkbox someone ticked last month.
 */
export const errorLog = pgTable(
  "error_log",
  {
    id: logIdColumn(),
    /** From `errorFingerprint`. Stable across deploys and across machines. */
    fingerprint: text("fingerprint").notNull(),
    /**
     * The message as thrown, for a human. Not what the fingerprint is computed
     * from — that is a normalised form — so two rows can never disagree about
     * their own identity.
     */
    message: text("message").notNull(),
    stack: text("stack"),
    /** Where it was caught: "trpc", "webhook:stripe", "cron:reconcile". */
    source: text("source"),
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    context: jsonb("context"),
    /**
     * Incremented by the upsert above. The whole point of the unique index:
     * "this happened 40,000 times since Tuesday" is the triage signal, and
     * without a counter it is a query nobody runs.
     */
    occurrences: integer("occurrences").notNull().default(1),
    /**
     * Spelled out rather than reusing `createdAt()` / `updatedAt()`: those
     * helpers hardcode the column names `created_at` and `updated_at`, and
     * neither word is honest about a row that stands for N occurrences spread
     * over months.
     */
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    /**
     * The index the upsert conflicts against. Without it, `ON CONFLICT
     * (fingerprint)` is not merely slow — Postgres refuses the statement
     * outright, so the deduplication silently reverts to one row per
     * occurrence the first time someone recreates this table by hand.
     */
    uniqueIndex("error_log_fingerprint_idx").on(t.fingerprint),
    /**
     * The dashboard query: unresolved errors, most recent first. Partial,
     * because a healthy table is mostly resolved rows and an index covering
     * them is weight nothing reads.
     */
    index("error_log_unresolved_idx")
      .on(t.lastSeenAt)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

export const observabilitySchema = { auditLog, errorLog };

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type ErrorLogRow = typeof errorLog.$inferSelect;
export type NewErrorLogRow = typeof errorLog.$inferInsert;

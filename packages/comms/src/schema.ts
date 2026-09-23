import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";
import type { TemplateVars } from "./render.js";

/**
 * Communications tables. Templates are editable rows (like the assistant's
 * personality), every send is written to a delivery log whatever became of it,
 * and future messages sit in a scheduled queue a cron drains. `tenantId` is
 * plain text, no cross-package FK.
 */

/** An editable message template, keyed and channel-typed. */
export const commsTemplates = pgTable(
  "comms_templates",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /** Stable machine key: "booking_reminder", "review_request". */
    key: text("key").notNull(),
    /** "email" | "sms" */
    channel: text("channel").notNull().default("email"),
    /** Email only — required for an email template (enforced on upsert). */
    subject: text("subject"),
    body: text("body").notNull(),
    /**
     * The kill switch. An inactive template's queued messages end `skipped`
     * rather than sending. Set only through setTemplateActive — editing the
     * wording does NOT switch a template back on.
     */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("comms_templates_tenant_key_idx").on(t.tenantId, t.key)],
);

/**
 * One row per message the package decided about — append-only. `body` is the
 * text actually handed to the provider (for SMS that is AFTER the compliance
 * prefix and opt-out line were added), so the log is evidence of what the
 * customer received, not of what the template said.
 */
export const commsMessages = pgTable(
  "comms_messages",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    channel: text("channel").notNull(),
    toAddress: text("to_address").notNull(),
    templateKey: text("template_key"),
    subject: text("subject"),
    body: text("body").notNull(),
    /**
     * sent | skipped (no provider, template switched off, too soon since the
     * last one) | failed | cancelled (a beforeSend hook said no) | expired
     */
    status: text("status").notNull(),
    /** Why it failed — or, for a skipped/cancelled/expired row, why it did not go. */
    error: text("error"),
    providerId: text("provider_id"),
    /**
     * Placeholders the template used that the send had no value for. They
     * render blank (never as visible braces), so this is the only trace of a
     * "Hi ," — recorded, not enforced.
     */
    missingVars: jsonb("missing_vars").$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("comms_messages_tenant_idx").on(t.tenantId, t.createdAt),
    // The minIntervalMs lookup — "did this template reach this recipient
    // recently". Without it that check scans the tenant's whole log per send.
    index("comms_messages_recipient_idx").on(t.tenantId, t.toAddress, t.templateKey, t.createdAt),
  ],
);

/**
 * A message queued to send later; a cron drains the due ones.
 *
 * Lifecycle: pending → sending (claimed) → sent | skipped | failed | cancelled
 * | expired — or back to pending with a later send_at after a transient
 * failure, bounded by `attempts`. Rows are never deleted: a cancel is a status,
 * so "why didn't the reminder go out" always has an answer.
 */
export const commsScheduled = pgTable(
  "comms_scheduled",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    channel: text("channel").notNull().default("email"),
    toAddress: text("to_address").notNull(),
    templateKey: text("template_key").notNull(),
    vars: jsonb("vars").$type<TemplateVars>().notNull().default({}),
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    /** pending | sending | sent | skipped | failed | cancelled | expired */
    status: text("status").notNull().default("pending"),
    /**
     * What the message is about — ("booking", "b_123"). Lets the host cancel
     * every pending reminder for a booking that was cancelled or moved, instead
     * of the customer getting "see you tomorrow" for a visit that isn't happening.
     */
    refType: text("ref_type"),
    refId: text("ref_id"),
    /**
     * Idempotency key, unique per tenant while set. Enqueueing the same key
     * twice (a retried request, a replayed webhook) returns the first row
     * instead of queueing a second copy of the message.
     */
    dedupeKey: text("dedupe_key"),
    /** Don't send if this template reached this recipient within the window. */
    minIntervalMs: bigint("min_interval_ms", { mode: "number" }),
    /** Past this the message is pointless ("your visit is in an hour") — expire, never send late. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Claims so far. Counted AT claim time, so a worker that dies mid-send still uses one up. */
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** When a worker flipped it to `sending`. A stale claim is a dead worker, and is reclaimed. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("comms_scheduled_due_idx").on(t.status, t.sendAt),
    index("comms_scheduled_ref_idx").on(t.tenantId, t.refType, t.refId),
    // Partial: most rows carry no key, and NULLs must never collide.
    uniqueIndex("comms_scheduled_dedupe_idx")
      .on(t.tenantId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

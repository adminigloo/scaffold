import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    /** Email only. */
    subject: text("subject"),
    body: text("body").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("comms_templates_tenant_key_idx").on(t.tenantId, t.key)],
);

/** One row per attempted send — sent, skipped (no provider), or failed. */
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
    /** sent | skipped | failed */
    status: text("status").notNull(),
    error: text("error"),
    providerId: text("provider_id"),
    createdAt: createdAt(),
  },
  (t) => [index("comms_messages_tenant_idx").on(t.tenantId, t.createdAt)],
);

/** A message queued to send later; a cron drains the due ones. */
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
    /** pending | sent | cancelled */
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("comms_scheduled_due_idx").on(t.status, t.sendAt)],
);

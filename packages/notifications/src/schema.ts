import { sql } from "drizzle-orm";
import { index, integer, pgSchema, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "./columns.js";
import { notificationTableNames, type DefineNotificationTablesOptions, type NotificationTableNames } from "./sql.js";

export { InvalidTableNameError, notificationsSql } from "./sql.js";
export type { DefineNotificationTablesOptions } from "./sql.js";

/**
 * The alert tables (Tenancy 2b-1, 4.1), durable in the app's own database for
 * 0.1's reason: an inbox rented from a vendor is your customers' activity
 * stream on someone else's servers, and it disappears with the subscription.
 *
 * ONE ROW PER ALERT PER PERSON, PER COMPANY (D2). Fan-out happens at WRITE
 * time: "who should see this" is answered when the alert is written, from who
 * holds what NOW, and never re-run on a poll. `tenant_id` is on every row and
 * in the WHERE of every read, mark and delete, beside `recipient_id`.
 * `recipient_id` is plain text naming a person in the HOST's user system (the
 * cross-package no-FK rule), or `email:{address}` for an email-only address
 * the owner added (born read: no bell ever shows it).
 *
 * TABLE NAMES come from the host (D14, review G1): `defineNotificationTables({
 * prefix, schema })`. The default set reproduces 0.1's names exactly
 * (`notifications` and its two index names), so a 0.1 install upgrades with
 * ALTERs (`sql/upgrade-0.1-to-0.2.sql`). Under a prefix, export the prefixed
 * tables BY NAME from your drizzle schema file: `export *` from this module
 * would also hand drizzle-kit the default set and create a second, unused
 * `notifications` table (the analytics README's rule).
 */

/**
 * The table function for the names' schema. `pgSchema(name).table` has the
 * same call shape as `pgTable`; the cast only widens its schema type
 * parameter, which nothing here reads. drizzle refuses `pgSchema("public")`
 * (public is the default), so "public" builds plain tables.
 */
function tableFn(names: NotificationTableNames): typeof pgTable {
  return (names.schema && names.schema !== "public" ? pgSchema(names.schema).table : pgTable) as unknown as typeof pgTable;
}

function alertsTable(names: NotificationTableNames) {
  return tableFn(names)(
    names.alerts,
    {
      /** uuidv7, the package's own (D14: no @adminigloo/db). */
      id: idColumn(),
      /** The company. `'*'` only for 0.1 rows and 0.1 calls: the firm-wide staff inbox. */
      tenantId: text("tenant_id").notNull().default("*"),
      /** A person's id as text, or `email:{address}` for an email-only address (D2). */
      recipientId: text("recipient_id").notNull(),
      /**
       * How the row reached the person (review G4): `audience` (the kind's
       * permission, routed or not), `assigned` (only through the record's
       * assigned people), `address` (an email-only address). What every read,
       * `prune` and the retry's re-check test against.
       */
      reachedVia: text("reached_via").notNull().default("audience"),
      /** A registered kind key, `{package}.{thing}.{what}`. */
      kind: text("kind").notNull(),
      title: text("title").notNull(),
      body: text("body"),
      /** A path on this site (D18's pattern). */
      href: text("href"),
      /** D7: built from the durable fact. Null only for 0.1 rows. */
      dedupeKey: text("dedupe_key"),
      subjectType: text("subject_type"),
      subjectId: text("subject_id"),
      /** Who caused it (never alerted about it). */
      actorId: text("actor_id"),
      /** Null = unread (0.1). */
      readAt: timestamp("read_at", { withTimezone: true }),
      createdAt: createdAt(),
      /** none · pending · sending · sent · skipped · failed · expired · owed (the producer sends it, D6) · claimed (the producer took it). */
      emailStatus: text("email_status").notNull().default("none"),
      /** Where the copy goes; the cron re-derives it before a retry (D9) and updates it. */
      emailTo: text("email_to"),
      emailAttempts: integer("email_attempts").notNull().default(0),
      /** When the cron may try again. */
      emailNextAt: timestamp("email_next_at", { withTimezone: true }),
      emailClaimedAt: timestamp("email_claimed_at", { withTimezone: true }),
      emailedAt: timestamp("emailed_at", { withTimezone: true }),
      /** The log's words, cut to 500. */
      emailError: text("email_error"),
    },
    (table) => [
      // 0.1's two, names kept exactly.
      index(names.index.recipientCreated).on(table.recipientId, table.createdAt),
      index(names.index.recipientRead).on(table.recipientId, table.readAt),
      uniqueIndex(names.index.dedupe).on(table.tenantId, table.recipientId, table.dedupeKey),
      // The bell's list, newest first, per company per person.
      index(names.index.inbox).on(table.tenantId, table.recipientId, table.createdAt, table.id),
      // The badge: its own query on every poll.
      index(names.index.unread).on(table.tenantId, table.recipientId).where(sql.raw(`"read_at" is null`)),
      // The alerts cron's due rows.
      index(names.index.emailDue).on(table.emailNextAt).where(sql.raw(`"email_status" in ('pending', 'sending')`)),
      // claimEmails / releaseClaim (D6).
      index(names.index.dedupeLookup).on(table.tenantId, table.dedupeKey),
      // cleanup (D9).
      index(names.index.created).on(table.createdAt),
    ],
  );
}

function choicesTable(names: NotificationTableNames) {
  return tableFn(names)(
    names.choices,
    {
      tenantId: text("tenant_id").notNull(),
      userId: text("user_id").notNull(),
      kind: text("kind").notNull(),
      /** `in_app` | `email`. Only explicit choices are stored (D5): the kind's default covers the rest. */
      channel: text("channel").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [primaryKey({ name: names.choicesPk, columns: [table.tenantId, table.userId, table.kind] })],
  );
}

function routingTable(names: NotificationTableNames) {
  return tableFn(names)(
    names.routing,
    {
      tenantId: text("tenant_id").notNull(),
      /** A routing group key ("estimates", "visits", "invoices"). */
      routing: text("routing").notNull(),
      /** `owner` | `chosen`. No row = the owner (D4). */
      mode: text("mode").notNull().default("owner"),
      userIds: text("user_ids").array().notNull().default(sql`'{}'`),
      /** Up to five email-only addresses (an office mailbox that isn't a login). */
      extraEmails: text("extra_emails").array().notNull().default(sql`'{}'`),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      updatedBy: text("updated_by"),
    },
    (table) => [primaryKey({ name: names.routingPk, columns: [table.tenantId, table.routing] })],
  );
}

export type NotificationAlertsTable = ReturnType<typeof alertsTable>;
export type NotificationChoicesTable = ReturnType<typeof choicesTable>;
export type NotificationRoutingTable = ReturnType<typeof routingTable>;

export interface NotificationTables {
  readonly prefix: string;
  readonly schema: string | null;
  /** "{prefix}notifications" */
  readonly alerts: NotificationAlertsTable;
  /** "{prefix}notification_choices" */
  readonly choices: NotificationChoicesTable;
  /** "{prefix}notification_routing" */
  readonly routing: NotificationRoutingTable;
}

/** The alert tables under `options` (a prefix, a Postgres schema, or both). Throws InvalidTableNameError on a bad name. */
export function defineNotificationTables(options: DefineNotificationTablesOptions = {}): NotificationTables {
  const names = notificationTableNames(options);
  return Object.freeze({
    prefix: names.prefix,
    schema: names.schema,
    alerts: alertsTable(names),
    choices: choicesTable(names),
    routing: routingTable(names),
  });
}

/** The default set: 0.1's names. */
export const notificationTables: NotificationTables = defineNotificationTables();

/** 0.1's export name: the same table as notificationTables.alerts. */
export const notifications: NotificationTables["alerts"] = notificationTables.alerts;
export const notificationChoices: NotificationTables["choices"] = notificationTables.choices;
export const notificationRouting: NotificationTables["routing"] = notificationTables.routing;

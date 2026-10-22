import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, idColumn, updatedAt } from "@adminigloo/db";

/**
 * The digest tables (digest 0.1), in the app's own database. Three, each
 * keyed by the PERSON — a person's email choices are theirs, not a
 * company's, and follow them wherever they sign in:
 *
 *   preferences    when their digests come: the zone (from their browser at
 *                  sign-up, or set by them; none means the site's zone) and
 *                  the local hour (7 by default)
 *   subscriptions  one row per email kind they have ever chosen or refused:
 *                  a digest ("morning") or an alert kind ("price-alerts").
 *                  NO ROW IS NOT SUBSCRIBED — nothing is sent until a person
 *                  says yes — and an unsubscribe is kept as a row that says
 *                  no, with how and when, so it is never undone by accident
 *   sends          THE LEDGER: one row per person, kind and key (a digest's
 *                  key is the person's local day, "2026-10-21"), claimed
 *                  before anything is built, so a second run, a retried cron
 *                  or two instances at once never send anybody two
 *
 * `user_id` is plain text naming a person in the host's own user system (no
 * foreign key: the package never imports the host's tables).
 *
 * TABLE NAMES come from the host: `defineDigestTables({ prefix })`. The
 * default set is `digest_preferences`, `digest_subscriptions` and
 * `digest_sends`. Under a prefix, export the prefixed tables BY NAME from
 * your drizzle schema file, never `export *` from this module (which would
 * also hand drizzle-kit the default set).
 */

export class InvalidDigestTablePrefixError extends Error {
  readonly name = "InvalidDigestTablePrefixError";
  constructor(prefix: string) {
    super(`"${prefix}" can't start a table name: use lowercase letters, digits and underscores, starting with a letter (at most 30), or "".`);
  }
}

export interface DefineDigestTablesOptions {
  /** Put before every table and index name ("aig_" → aig_digest_sends). Default "". */
  readonly prefix?: string;
}

function preferencesTable(p: string) {
  return pgTable(`${p}digest_preferences`, {
    userId: text("user_id").primaryKey(),
    /** An IANA zone ("America/Chicago"); null is the site's zone. */
    timeZone: text("time_zone"),
    /** How the zone was set: "browser" (at sign-up, or "use this browser's") or "person" (chosen). */
    timeZoneSource: text("time_zone_source"),
    /** The local hour, 0–23, every digest comes at or after. */
    deliveryHour: smallint("delivery_hour").notNull().default(7),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  });
}

function subscriptionsTable(p: string) {
  return pgTable(
    `${p}digest_subscriptions`,
    {
      userId: text("user_id").notNull(),
      /** A registered kind key: a digest's or an alert kind's. */
      kind: text("kind").notNull(),
      subscribed: boolean("subscribed").notNull(),
      /** How it was last changed: sign-up · preferences · link · one-click · staff. */
      source: text("source").notNull(),
      changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ name: `${p}digest_subscriptions_pk`, columns: [t.userId, t.kind] }),
      // The run's one question: who has said yes to this digest.
      index(`${p}digest_subscriptions_kind_idx`).on(t.kind, t.subscribed),
    ],
  );
}

function sendsTable(p: string) {
  return pgTable(
    `${p}digest_sends`,
    {
      id: idColumn(),
      userId: text("user_id").notNull(),
      kind: text("kind").notNull(),
      /** A digest's local day ("2026-10-21"), or an alert's own key from the fact it reports. */
      dedupeKey: text("dedupe_key").notNull(),
      /** sending · sent · skipped (no email provider) · empty (nothing to say that day) · failed. */
      status: text("status").notNull(),
      attempts: integer("attempts").notNull().default(0),
      /** A failure the provider may accept later (a timeout, a 429, a 5xx), tried again while the day lasts. */
      retryable: boolean("retryable").notNull().default(false),
      nextAt: timestamp("next_at", { withTimezone: true }),
      claimedAt: timestamp("claimed_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
      /** The sections the email carried, by key. */
      sections: text("sections").array().notNull().default(sql`'{}'`),
      /** The provider's words, cut to 500. */
      error: text("error"),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
    },
    (t) => [
      // AT MOST ONE per person, kind and key: the claim is an insert into this.
      uniqueIndex(`${p}digest_sends_once_idx`).on(t.userId, t.kind, t.dedupeKey),
      // The run's ledger read for a day.
      index(`${p}digest_sends_day_idx`).on(t.kind, t.dedupeKey),
      // The retries still owed.
      index(`${p}digest_sends_retry_idx`).on(t.status, t.nextAt),
    ],
  );
}

export type DigestPreferencesTable = ReturnType<typeof preferencesTable>;
export type DigestSubscriptionsTable = ReturnType<typeof subscriptionsTable>;
export type DigestSendsTable = ReturnType<typeof sendsTable>;

export interface DigestTables {
  readonly prefix: string;
  readonly preferences: DigestPreferencesTable;
  readonly subscriptions: DigestSubscriptionsTable;
  readonly sends: DigestSendsTable;
}

/** The digest tables under a prefix. Throws InvalidDigestTablePrefixError on a bad one. */
export function defineDigestTables(options: DefineDigestTablesOptions = {}): DigestTables {
  const prefix = options.prefix ?? "";
  if (prefix !== "" && !/^[a-z][a-z0-9_]{0,29}$/.test(prefix)) throw new InvalidDigestTablePrefixError(prefix);
  return Object.freeze({
    prefix,
    preferences: preferencesTable(prefix),
    subscriptions: subscriptionsTable(prefix),
    sends: sendsTable(prefix),
  });
}

/** The default set: digest_preferences, digest_subscriptions, digest_sends. */
export const digestTables: DigestTables = defineDigestTables();
export const digestPreferences: DigestTables["preferences"] = digestTables.preferences;
export const digestSubscriptions: DigestTables["subscriptions"] = digestTables.subscriptions;
export const digestSends: DigestTables["sends"] = digestTables.sends;

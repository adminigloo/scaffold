import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createdAt, idColumn } from "@adminigloo/db";

/**
 * One row per notification per recipient — durable, in the app's own
 * database, for the same reason the error log and the SEO reports are: an
 * inbox rented from a vendor is your customers' activity stream on someone
 * else's servers, and it disappears with the subscription.
 *
 * `recipientId` is plain text naming a principal in the CONSUMING app's user
 * system (the cross-package no-FK rule: this schema must not force the auth
 * package on anyone). Fan-out is done at WRITE time — notifying five staff
 * members inserts five rows — because read-time fan-out ("who should see
 * this?") re-answers an authorization question on every poll, and the write
 * path is where the answer was already known.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: idColumn(),
    /** A principal id in the consuming app. Who sees this row. */
    recipientId: text("recipient_id").notNull(),
    /** Stable machine kind, e.g. "feedback.ticket-created" — what filters key on. */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** Where clicking goes. Null for purely informational rows. */
    href: text("href"),
    /**
     * Null = unread. A timestamp rather than a boolean because "when did
     * they see it" is the question the next feature always asks, and a
     * boolean column answers it never.
     */
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    // The badge query and the inbox query, which run on every shell render.
    index("notifications_recipient_created_idx").on(table.recipientId, table.createdAt),
    index("notifications_recipient_read_idx").on(table.recipientId, table.readAt),
  ],
);

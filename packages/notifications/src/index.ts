import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { notifications } from "./schema.js";

/**
 * The in-app inbox as a primitive.
 *
 * Three design rules, each the residue of a bug somebody else ships:
 *
 * FAN-OUT AT WRITE TIME. `notify` takes the recipient list and inserts one
 * row each. The alternative — one event row plus a read-time "who should see
 * this" query — re-answers an authorization question on every poll and gets
 * it differently after every role change, including for events from before
 * the change.
 *
 * READS ARE RECIPIENT-SCOPED IN THE WHERE CLAUSE, not by trusting the
 * caller. `markNotificationRead` takes the recipient alongside the id, so a
 * guessed id belonging to somebody else updates zero rows instead of one.
 *
 * NOTIFYING MUST NEVER BREAK THE THING IT ANNOUNCES. This module only
 * writes rows; it throws only on real database failure. The pattern for
 * producers is to call it fire-and-forget with their own catch — a feedback
 * submit that fails because the inbox insert failed has inverted its job.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NotificationsDb = PgDatabase<any, any, any>;

export const notifySchema = z.object({
  recipientIds: z.array(z.string().min(1)).min(1).max(500),
  kind: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  href: z.string().max(500).optional(),
});

export type NotifyInput = z.infer<typeof notifySchema>;

/** Insert one row per recipient. Deduplicates the recipient list first. */
export async function notify(db: NotificationsDb, input: NotifyInput): Promise<number> {
  const parsed = notifySchema.parse(input);
  const recipients = [...new Set(parsed.recipientIds)];
  await db.insert(notifications).values(
    recipients.map((recipientId) => ({
      recipientId,
      kind: parsed.kind,
      title: parsed.title,
      body: parsed.body ?? null,
      href: parsed.href ?? null,
    })),
  );
  return recipients.length;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export async function listNotifications(
  db: NotificationsDb,
  recipientId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const limit = options.limit ?? 30;
  const where = options.unreadOnly
    ? and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt))
    : eq(notifications.recipientId, recipientId);
  return db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      href: notifications.href,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit);
}

/** The badge number. Its own query because it runs on every shell render. */
export async function unreadCount(db: NotificationsDb, recipientId: string): Promise<number> {
  const rows: Array<{ count: number }> = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)));
  return rows[0]?.count ?? 0;
}

/** Recipient-scoped: somebody else's id updates nothing and reports false. */
export async function markNotificationRead(
  db: NotificationsDb,
  input: { id: string; recipientId: string },
): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, input.id),
        eq(notifications.recipientId, input.recipientId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length > 0;
}

export async function markAllRead(db: NotificationsDb, recipientId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { notifications } from "./schema.js";
import type { NotificationsDb } from "./types.js";

/**
 * 0.1's API, kept (Tenancy 2b-1, 4.10): the same signatures, on the DEFAULT
 * tables (the only place the default is implicit, D14), with `tenant_id =
 * '*'` written and filtered. 0.1's rows became the firm-wide staff inbox when
 * the table was upgraded; these functions keep reading and writing exactly
 * that inbox, and no company's bell ever shows it.
 *
 * Each is deprecated in favour of the instance (`createNotifications`), which
 * knows the company, the person's permissions, choices and email copies.
 */

/** 0.1's firm-wide inbox: the tenant every 0.1 row and 0.1 call has. */
export const LEGACY_TENANT = "*";

/** @deprecated Use `createNotifications(...).notify(drafts)`, whose drafts are 3.3's `AlertDraft`. */
export const notifySchema = z.object({
  recipientIds: z.array(z.string().min(1)).min(1).max(500),
  kind: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).optional(),
  href: z.string().max(500).optional(),
});

/** @deprecated Use `AlertDraft` with `createNotifications(...).notify`. */
export type NotifyInput = z.infer<typeof notifySchema>;

/**
 * Insert one row per recipient. Deduplicates the recipient list first.
 * @deprecated Use `createNotifications(...).notify(drafts)`: it works out who
 * gets an alert from the company's people, and sends the email copies.
 */
export async function notify(db: NotificationsDb, input: NotifyInput): Promise<number> {
  const parsed = notifySchema.parse(input);
  const recipients = [...new Set(parsed.recipientIds)];
  await db.insert(notifications).values(
    recipients.map((recipientId) => ({
      tenantId: LEGACY_TENANT,
      recipientId,
      kind: parsed.kind,
      title: parsed.title,
      body: parsed.body ?? null,
      href: parsed.href ?? null,
    })),
  );
  return recipients.length;
}

/** @deprecated Use `AlertRow` from `createNotifications(...).list`. */
export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/** @deprecated Use `createNotifications(...).list({ tenantId, userId, permissions })`. */
export async function listNotifications(
  db: NotificationsDb,
  recipientId: string,
  options: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const limit = options.limit ?? 30;
  const mine = and(eq(notifications.tenantId, LEGACY_TENANT), eq(notifications.recipientId, recipientId));
  const where = options.unreadOnly ? and(mine, isNull(notifications.readAt)) : mine;
  return (await db
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
    .limit(limit)) as NotificationRow[];
}

/**
 * The badge number. Its own query because it runs on every shell render.
 * @deprecated Use `createNotifications(...).unreadCount(reader)`.
 */
export async function unreadCount(db: NotificationsDb, recipientId: string): Promise<number> {
  const rows = (await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.tenantId, LEGACY_TENANT), eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))) as {
    count: number;
  }[];
  return Number(rows[0]?.count ?? 0);
}

/**
 * Recipient-scoped: somebody else's id updates nothing and reports false.
 * @deprecated Use `createNotifications(...).markRead({ ...reader, alertId })`.
 */
export async function markNotificationRead(db: NotificationsDb, input: { id: string; recipientId: string }): Promise<boolean> {
  const rows = (await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, input.id),
        eq(notifications.tenantId, LEGACY_TENANT),
        eq(notifications.recipientId, input.recipientId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id })) as { id: string }[];
  return rows.length > 0;
}

/** @deprecated Use `createNotifications(...).markAllRead(reader)`. */
export async function markAllRead(db: NotificationsDb, recipientId: string): Promise<number> {
  const rows = (await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.tenantId, LEGACY_TENANT), eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
    .returning({ id: notifications.id })) as { id: string }[];
  return rows.length;
}

import { z } from "zod";
import {
  listNotifications,
  markAllRead,
  markNotificationRead,
  unreadCount,
} from "__SCOPE__/notifications";
import { db } from "@/db";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * The signed-in staff member's own inbox, and nobody else's: every procedure
 * derives the recipient from the session principal, never from input, so
 * there is no id a client could vary to read a colleague's rows. The package
 * repeats the same discipline one layer down — recipient in the WHERE clause
 * of the mark-read update.
 */
export const notificationsRouter = createTRPCRouter({
  list: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(100).default(30) }).optional())
    .query(({ ctx, input }) =>
      listNotifications(db, ctx.principal.userId, { limit: input?.limit ?? 30 }),
    ),

  unreadCount: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(({ ctx }) => unreadCount(db, ctx.principal.userId)),

  markRead: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => ({
      marked: await markNotificationRead(db, {
        id: input.id,
        recipientId: ctx.principal.userId,
      }),
    })),

  markAllRead: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .mutation(async ({ ctx }) => ({
      marked: await markAllRead(db, ctx.principal.userId),
    })),
});

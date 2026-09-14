import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  addTicketMessage,
  assignTicket,
  listBoardData,
  listTicketMessages,
  moveTicket,
} from "__SCOPE__/feedback";
import { feedbackTickets } from "__SCOPE__/feedback/schema";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * The feedback queue's server half.
 *
 * Tickets arrive through the public intake handlers in
 * `app/api/igloo/[...path]` (key-authenticated, not Clerk); this router is the
 * STAFF side that reads and works them. Gated on `staff.dashboard.view` — the
 * key that says you may use the shell — rather than a key of its own, the same
 * call the Support placeholder makes and for the same reason: mint a dedicated
 * permission when the queue grows actions not every staff member should hold,
 * not before.
 *
 * Mounted in every project generated with the feedback answer, including one
 * with no admin shell: the triage pages are only one caller, and a headless
 * project still reads its queue over tRPC.
 */
export const feedbackRouter = createTRPCRouter({
  /** Newest first, with the owning tenant's name joined in where it exists. */
  list: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(200).default(100) }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: feedbackTickets.id,
          ticketNumber: feedbackTickets.ticketNumber,
          title: feedbackTickets.title,
          description: feedbackTickets.description,
          priority: feedbackTickets.priority,
          category: feedbackTickets.category,
          status: feedbackTickets.status,
          screenshotUrl: feedbackTickets.screenshotUrl,
          annotatedScreenshotUrl: feedbackTickets.annotatedScreenshotUrl,
          reporterName: feedbackTickets.reporterName,
          reporterEmail: feedbackTickets.reporterEmail,
          pagePathname: feedbackTickets.pagePathname,
          clientMetadata: feedbackTickets.clientMetadata,
          recentErrors: feedbackTickets.recentErrors,
          createdAt: feedbackTickets.createdAt,
          tenantId: feedbackTickets.tenantId,
          // LEFT JOIN: the ticket table carries no FK (cross-package rule), so
          // a deleted tenant misses the join and the viewer shows the raw id.
          tenantName: tenants.name,
        })
        .from(feedbackTickets)
        .leftJoin(tenants, eq(tenants.id, feedbackTickets.tenantId))
        .orderBy(desc(feedbackTickets.createdAt), desc(feedbackTickets.id))
        .limit(input.limit);

      return { tickets: rows };
    }),

  /** Columns + tickets for the Kanban view. Seeds the default columns on first read. */
  board: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => listBoardData(db)),

  /** Drag-and-drop lands here. False from the package means a stale client, not a write. */
  move: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ ticketId: z.string(), statusKey: z.string().max(50) }))
    .mutation(async ({ input }) => {
      const moved = await moveTicket(db, input);
      return { moved };
    }),

  /** The conversation on one ticket, oldest first. */
  messages: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ ticketId: z.string() }))
    .query(({ input }) => listTicketMessages(db, input.ticketId)),

  addMessage: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        ticketId: z.string(),
        // The display name the panel shows beside the message. CLIENT-SUPPLIED
        // for now, which is honest about its strength: it is a label, not an
        // identity — the identity check is the requireStaff rung above. Derive
        // it server-side from the principal when messages start carrying
        // authority.
        senderName: z.string().min(1).max(120),
        body: z.string().min(1).max(5000),
      }),
    )
    .mutation(({ input }) =>
      addTicketMessage(db, { ...input, senderType: "staff" }),
    ),

  assign: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        ticketId: z.string(),
        assignee: z.string().max(120).nullable(),
        actorName: z.string().min(1).max(120),
      }),
    )
    .mutation(async ({ input }) => {
      await assignTicket(db, input);
      return { ok: true };
    }),
});

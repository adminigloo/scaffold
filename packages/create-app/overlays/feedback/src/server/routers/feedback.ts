import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  addTicketMessage,
  archiveTerminalTickets,
  archiveTicket,
  assignTicket,
  createCategory,
  createCategorySchema,
  createStatus,
  createStatusSchema,
  deleteCategory,
  deleteStatus,
  listBoardData,
  listCategories,
  listTicketMessages,
  markTicketRead,
  moveTicket,
  moveTickets,
  reorderCategories,
  reorderStatuses,
  unarchiveTicket,
  updateCategory,
  updateCategorySchema,
  updateStatus,
  updateStatusSchema,
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
    .input(z.object({ includeArchived: z.boolean().default(false) }).optional())
    .query(({ input }) => listBoardData(db, { includeArchived: input?.includeArchived ?? false })),

  /** Drag-and-drop lands here. False from the package means a stale client, not a write. */
  move: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ ticketId: z.string(), statusKey: z.string().max(50) }))
    .mutation(async ({ input }) => {
      const moved = await moveTicket(db, input);
      return { moved };
    }),

  /** The selection's move (0.7.0) — one statement server-side, one event on the board. */
  moveMany: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        ticketIds: z.array(z.string()).min(1).max(200),
        statusKey: z.string().max(50),
      }),
    )
    .mutation(({ input }) => moveTickets(db, input)),

  // Archive (0.7.0): tickets leave the board without leaving the record.
  archive: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ ticketId: z.string(), archivedBy: z.string().min(1).max(120) }))
    .mutation(async ({ input }) => ({ archived: await archiveTicket(db, input) })),

  unarchive: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ ticketId: z.string() }))
    .mutation(async ({ input }) => ({
      unarchived: await unarchiveTicket(db, input.ticketId),
    })),

  /** "Archive Done (N)": sweep every finished column in one statement. */
  archiveTerminal: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ archivedBy: z.string().min(1).max(120) }))
    .mutation(({ input }) => archiveTerminalTickets(db, input)),

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

  /**
   * Stamp the ticket as seen by the team — the board's unread mark reads
   * against this. Fired when the workspace panel opens, so the pill clears
   * itself the way an inbox does: by looking, not by an extra chore.
   */
  markRead: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ ticketId: z.string() }))
    .mutation(async ({ input }) => {
      await markTicketRead(db, input.ticketId);
      return { ok: true };
    }),

  // Column administration (0.5.0). The board renders whatever rows exist, so
  // these four ARE the board settings screen's whole server side. Same key
  // as the rest of the router: configuring columns is triage work, not a
  // separate privilege — mint one if that stops being true for your team.
  createStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createStatusSchema)
    .mutation(({ input }) => createStatus(db, input)),

  updateStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(updateStatusSchema)
    .mutation(async ({ input }) => {
      await updateStatus(db, input);
      return { ok: true };
    }),

  deleteStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ statusId: z.string() }))
    .mutation(({ input }) => deleteStatus(db, input.statusId)),

  reorderStatuses: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ orderedIds: z.array(z.string()).min(1).max(50) }))
    .mutation(async ({ input }) => {
      await reorderStatuses(db, input.orderedIds);
      return { ok: true };
    }),

  // Category administration (0.7.0). Same shape as the four above, because
  // it is the same feature one field over: rows are the widget's dropdown,
  // and the delete refusal names the tickets still carrying the key.
  listCategories: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => listCategories(db)),

  createCategory: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createCategorySchema)
    .mutation(({ input }) => createCategory(db, input)),

  updateCategory: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(updateCategorySchema)
    .mutation(async ({ input }) => {
      await updateCategory(db, input);
      return { ok: true };
    }),

  deleteCategory: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ categoryId: z.string() }))
    .mutation(({ input }) => deleteCategory(db, input.categoryId)),

  reorderCategories: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ orderedIds: z.array(z.string()).min(1).max(50) }))
    .mutation(async ({ input }) => {
      await reorderCategories(db, input.orderedIds);
      return { ok: true };
    }),
});

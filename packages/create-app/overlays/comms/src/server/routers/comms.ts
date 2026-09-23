import { z } from "zod";
import {
  listMessages,
  listTemplates,
  requireEmailSubject,
  runDueMessages,
  setTemplateActive,
  upsertTemplate,
  upsertTemplateSchema,
} from "__SCOPE__/comms";
import { db } from "@/db";
import { COMMS_TENANT, commsSenders, ensureCommsTemplates } from "@/server/comms-senders";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * Communications automation, from __SCOPE__/comms. Staff edit templates, switch
 * them off and on, and read the delivery log; the scheduled queue is drained by
 * the cron route (/api/cron/comms) and can be triggered here for a demo.
 * Default templates seed on first read. Senders are injected from
 * `comms-senders` — with no provider wired, a send logs a clean skip instead of
 * a fake success.
 */
export const commsRouter = createTRPCRouter({
  templates: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => {
      await ensureCommsTemplates(db);
      return listTemplates(db, COMMS_TENANT);
    }),

  // The subject rule applied here too, so an email template saved without a
  // subject is a validation error the editor can show — the package would
  // refuse it anyway, but as a server error.
  upsertTemplate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(upsertTemplateSchema.omit({ tenantId: true }).superRefine(requireEmailSubject))
    .mutation(({ input }) => upsertTemplate(db, { ...input, tenantId: COMMS_TENANT })),

  /** The kill switch: a switched-off template's queued messages end "skipped". */
  setTemplateActive: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ key: z.string().min(1).max(80), active: z.boolean() }))
    .mutation(({ input }) => setTemplateActive(db, COMMS_TENANT, input.key, input.active)),

  messages: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => listMessages(db, COMMS_TENANT)),

  /** Send everything currently due — the button that stands in for the cron in a demo. */
  runDue: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .mutation(() => runDueMessages(db, commsSenders, { timeBudgetMs: 20_000 })),
});

import {
  listMessages,
  listTemplates,
  runDueMessages,
  upsertTemplate,
  upsertTemplateSchema,
} from "__SCOPE__/comms";
import { db } from "@/db";
import { COMMS_TENANT, commsSenders, ensureCommsTemplates } from "@/server/comms-senders";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * Communications automation, from __SCOPE__/comms. Staff edit templates and read
 * the delivery log; the scheduled queue is drained by the cron route
 * (/api/cron/comms) and can be triggered here for a demo. Default templates seed
 * on first read. Senders are injected from `comms-senders` — with no provider
 * wired, a send logs a clean skip instead of a fake success.
 */
export const commsRouter = createTRPCRouter({
  templates: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => {
      await ensureCommsTemplates(db);
      return listTemplates(db, COMMS_TENANT);
    }),

  upsertTemplate: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(upsertTemplateSchema.omit({ tenantId: true }))
    .mutation(({ input }) => upsertTemplate(db, { ...input, tenantId: COMMS_TENANT })),

  messages: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => listMessages(db, COMMS_TENANT)),

  /** Send everything currently due — the button that stands in for the cron in a demo. */
  runDue: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .mutation(() => runDueMessages(db, commsSenders)),
});

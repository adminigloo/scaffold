import { z } from "zod";
import {
  createQuery,
  createQuerySchema,
  deactivateQuery,
  listChecks,
  queriesWithLatest,
  runCitationChecks,
} from "__SCOPE__/aeo";
import { db } from "@/db";
import { AEO_TENANT, makeAeoAsker } from "@/server/aeo-asker";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * Answer-engine citation tracking, from __SCOPE__/aeo. Staff track the
 * questions their customers ask an assistant and see whether the answer
 * mentions them. "Run checks" asks the injected model each query and records the
 * result — the honest, doable version of "does an AI engine cite us." All
 * staff-gated; the model asker is injected from aeo-asker (a no-op until you
 * wire a model, so a check run never throws).
 */
export const aeoRouter = createTRPCRouter({
  dashboard: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => queriesWithLatest(db, AEO_TENANT)),

  createQuery: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createQuerySchema.omit({ tenantId: true }))
    .mutation(({ input }) => createQuery(db, { ...input, tenantId: AEO_TENANT })),

  deactivateQuery: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => ({ ok: await deactivateQuery(db, input.id) })),

  history: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ queryId: z.string().min(1) }))
    .query(({ input }) => listChecks(db, input.queryId)),

  runChecks: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .mutation(() => runCitationChecks(db, AEO_TENANT, makeAeoAsker(), "model")),
});

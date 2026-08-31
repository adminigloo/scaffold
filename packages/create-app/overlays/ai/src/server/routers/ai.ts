import { z } from "zod";
import { createTRPCRouter, requireTenant } from "../trpc";
import { tenantSpendSince } from "../ai";
import type { TenantPermission } from "@/permissions/catalog";

/**
 * What the AI route cost, read back.
 *
 * The streaming handler at `app/api/ai/chat/route.ts` writes one `ai_usage` row
 * per authorized request; this is the only thing that reads them. Without it
 * the table is the error log all over again — written on every request,
 * indexed, kept for the life of the tenant, and never once looked at.
 *
 * A PROCEDURE RATHER THAN A PAGE, because who should see spend differs per
 * product: some clients put it in their own billing screen, some only ever
 * query it from a script at month end, and a page shipped here would be the
 * one file every one of them deletes. The boundary — which tenant, which
 * permission — is the part that must not be re-derived, so it lives here.
 *
 * `ai.chat.history.view` and not `ai.chat.use`. Being allowed to spend money is
 * not the same capability as being allowed to see what everybody in the
 * organisation spent, and the package's own defaults draw the line in the same
 * place: `use` reaches member, `history.view` stops at admin.
 */
export const aiRouter = createTRPCRouter({
  spend: requireTenant("ai.chat.history.view" satisfies TenantPermission)
    .meta({ scope: "tenant" })
    .input(
      z.object({
        /**
         * How far back to sum. Bounded, because an unbounded window is a
         * sequential scan of the largest table in the schema offered to
         * anybody with the permission.
         */
        days: z.number().int().min(1).max(366).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const since = new Date(Date.now() - input.days * 86_400_000);
      // `ctx.tenantId`, never the input's. The rung overwrote it with the
      // tenant the permission set was resolved for, so the two cannot name
      // different organisations.
      return tenantSpendSince(ctx.tenantId, since);
    }),
});

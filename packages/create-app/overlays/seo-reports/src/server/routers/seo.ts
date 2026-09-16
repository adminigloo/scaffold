import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getSeoReport,
  listSeoReports,
  runSeoReport,
  saveSeoReport,
} from "__SCOPE__/seo-reports";
import { db } from "@/db";
import { env } from "@/env";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * SEO & AEO audits of THIS deployment, run on demand from the admin.
 *
 * The crawl targets NEXT_PUBLIC_APP_URL — the site auditing itself over the
 * public internet, exactly the way a search or answer engine reaches it. No
 * shortcut through the app's own renderer, deliberately: the audit must see
 * what a crawler sees, headers, redirects and all.
 *
 * Ten pages per run, not the package's default fifteen: the run happens
 * inside one serverless invocation and a timeout half-way would store
 * nothing. The cap is recorded in the report itself as a warn, never silent.
 */
export const seoRouter = createTRPCRouter({
  list: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(() => listSeoReports(db)),

  get: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ reportId: z.string() }))
    .query(({ input }) => getSeoReport(db, input.reportId)),

  run: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .mutation(async () => {
      // Optional-until-deployed, so a laptop can genuinely lack it — and an
      // audit that does not know its own address has nothing to crawl. Named
      // plainly rather than letting the crawler fail on `new URL(undefined)`.
      if (!env.NEXT_PUBLIC_APP_URL) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Set NEXT_PUBLIC_APP_URL first — the audit crawls this deployment's own address.",
        });
      }
      const report = await runSeoReport({
        baseUrl: env.NEXT_PUBLIC_APP_URL,
        maxPages: 10,
        timeoutMs: 4000,
      });
      const id = await saveSeoReport(db, report);
      return { id, score: report.score };
    }),
});

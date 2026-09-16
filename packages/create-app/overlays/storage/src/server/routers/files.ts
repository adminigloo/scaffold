import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { deleteFile, listFiles } from "__SCOPE__/storage";
import { db } from "@/db";
import { getBlobStore } from "@/server/blob-store";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * The staff file library, from @__SCOPE_NAME__/storage.
 *
 * Listing and deleting live here; the UPLOAD does not — it is a plain route
 * handler at /api/files, because a file has no business being serialised
 * through superjson (the rule the root router states). Everything is pinned
 * to FIRM_WIDE: this is the firm's library, not a tenant's, and the tenant
 * variant should arrive together with the feature that needs it rather than
 * as an input somebody forgets to check.
 */
export const filesRouter = createTRPCRouter({
  overview: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => ({
      // Absent token = the page explains itself instead of half-working.
      configured: getBlobStore() !== null,
      files: await listFiles(db, { tenantId: FIRM_WIDE, limit: 100 }),
    })),

  remove: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const store = getBlobStore();
      if (!store) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "File storage is not configured — set BLOB_READ_WRITE_TOKEN.",
        });
      }
      return deleteFile(db, store, { id: input.id, tenantId: FIRM_WIDE });
    }),
});

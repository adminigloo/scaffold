import { adminRouter } from "./admin";
import { createTRPCRouter, publicProcedure, requireTenant } from "../trpc";

/**
 * The root router.
 *
 * tRPC for CRUD and admin. AI, streaming and large payloads go through plain
 * route handlers instead — a streamed response has no useful shape for tRPC to
 * type, and a large upload should not be serialised through superjson.
 */
export const appRouter = createTRPCRouter({
  health: publicProcedure.meta({ scope: "public" }).query(() => ({ ok: true })),

  // Every tenant-scoped procedure goes through requireTenant, never an inline
  // check inside a handler. The rung is what the scope audit can actually see.
  members: createTRPCRouter({
    list: requireTenant("members.view")
      .meta({ scope: "tenant" })
      .query(({ ctx }) => ({ tenantId: ctx.tenantId, granted: ctx.can.toArray() })),
  }),

  // The admin panel's pages are copied source that every client restyles; this
  // router is not, and it is where the staff permission checks and the audit
  // writes actually live. Mounted unconditionally, even in a project generated
  // without the admin shell, so the panel can be added later without also
  // having to re-derive its boundary.
  admin: adminRouter,
});

export type AppRouter = typeof appRouter;

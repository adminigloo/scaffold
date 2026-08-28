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
});

export type AppRouter = typeof appRouter;

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { createProcedures, createScaffoldContext } from "__SCOPE__/trpc";
import type { ProcedureMeta } from "__SCOPE__/trpc";
import type { ScaffoldContext } from "__SCOPE__/trpc";
import { loadStaffPermissions, loadTenantPermissions } from "./permissions";
import { currentPrincipal } from "./auth";

export async function createContext(): Promise<ScaffoldContext> {
  return createScaffoldContext({ principal: await currentPrincipal() });
}

const t = initTRPC.context<ScaffoldContext>().meta<ProcedureMeta>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

/**
 * The procedure ladder.
 *
 * Use `requireTenant(...)` / `requireStaff(...)` rather than checking a
 * permission inside a handler. An inline check is the drift that leaves half a
 * codebase enforced and half not, and the scope audit cannot see it.
 */
export const {
  publicProcedure,
  protectedProcedure,
  tenantProcedure,
  staffProcedure,
  requireTenant,
  requireStaff,
} = createProcedures(t, { loadTenantPermissions, loadStaffPermissions });

export { TRPCError };

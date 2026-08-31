import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";
import { createProcedures, createScaffoldContext } from "__SCOPE__/trpc";
import type { ProcedureMeta } from "__SCOPE__/trpc";
import type { ScaffoldContext } from "__SCOPE__/trpc";
import type { HeaderSource } from "__SCOPE__/observability";
import { loadStaffPermissions, loadTenantPermissions } from "./permissions";
import { currentPrincipal } from "./auth";
import { limiter } from "./rate-limit";

/**
 * The per-request context, built from the request's own headers.
 *
 * TAKING THE HEADERS IS THE WHOLE POINT OF THE PARAMETER. Called with nothing,
 * `createScaffoldContext` mints a fresh `requestId` per call and reports
 * `ipAddress: null` — which typechecks, boots, and quietly undoes the join the
 * id exists for: the proxy stamped `x-request-id`, the page render logged under
 * it, and the tRPC call the page made would have invented a different one. An
 * error row would then carry an id that appears in no log line. `ipAddress`
 * fails the same way and takes the anonymous rate-limit key with it, because a
 * null IP means `defaultKeyFor` returns null and a public procedure is
 * unlimited.
 *
 * Both entry points supply them: the fetch handler passes `req.headers`, and
 * `src/trpc/server.ts` passes Next's `headers()` so a server component's call
 * runs under the same id as the page rendering it.
 */
export async function createContext(
  input: { readonly headers?: HeaderSource | null } = {},
): Promise<ScaffoldContext> {
  return createScaffoldContext({
    principal: await currentPrincipal(),
    headers: input.headers ?? null,
  });
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
 *
 * RATE LIMITED AS A RUNG, not as something each handler remembers. The third
 * argument installs the middleware on every rung the factory builds, so a
 * procedure added next year is limited by existing rather than by somebody
 * having read this comment. Omit it and no middleware is installed at all —
 * which is what this project shipped, with the limiter constructed, the
 * policies named and not one procedure measured against them.
 *
 * The budgets come from `RATE_LIMIT_POLICIES` inside the package: anonymous
 * traffic keyed by IP, authenticated traffic keyed by user, reads and writes
 * on separate counters. Override `policyFor` here to give one expensive
 * procedure its own budget rather than hand-rolling a second limiter.
 */
export const {
  publicProcedure,
  protectedProcedure,
  tenantProcedure,
  staffProcedure,
  requireTenant,
  requireStaff,
} = createProcedures(
  t,
  { loadTenantPermissions, loadStaffPermissions },
  { rateLimit: { limiter } },
);

export { TRPCError };

import { tagScope } from "./scope.js";
import { TRPCError } from "@trpc/server";
import type { TRPCProcedureBuilder, TRPCUnsetMarker } from "@trpc/server";
import { z } from "zod";
import type { Principal } from "@adminigloo/auth";
import type { PermissionSet } from "@adminigloo/permissions";
import type { ScaffoldContext } from "./context.js";
import { notAMember, notStaff, permissionDenied, permissionDeniedToTRPCError } from "./errors.js";

/** Input every tenant-scoped procedure carries, merged with the caller's own. */
export interface TenantInput {
  tenantId: string;
}

/** What `protectedProcedure` adds to the context. */
export interface AuthenticatedOverrides {
  principal: Principal;
}

/** What `tenantProcedure` adds to the context. */
export interface TenantOverrides {
  principal: Principal;
  tenantId: string;
  can: PermissionSet;
}

/** What `staffProcedure` adds to the context. */
export interface StaffOverrides {
  principal: Principal;
  can: PermissionSet;
}

/**
 * The builder types are spelled out rather than inferred.
 *
 * `tsup --dts` has to be able to name the return type of `createProcedures`,
 * and an inferred `ProcedureBuilder<..., Overwrite<...>, ...>` drags in tRPC
 * internals that the declaration emit cannot reference by name. Naming them
 * here also means a change to the ladder that accidentally drops a context
 * override fails to compile in this file, rather than a year later in an app
 * whose handler suddenly sees `ctx.can` as `unknown`.
 */
type Builder<
  TContext extends ScaffoldContext,
  TMeta extends object,
  TOverrides,
  TInput,
> = TRPCProcedureBuilder<
  TContext,
  TMeta,
  TOverrides,
  TInput,
  TInput,
  TRPCUnsetMarker,
  TRPCUnsetMarker,
  false
>;

export type PublicProcedure<
  TContext extends ScaffoldContext,
  TMeta extends object,
> = Builder<TContext, TMeta, object, TRPCUnsetMarker>;

export type ProtectedProcedure<
  TContext extends ScaffoldContext,
  TMeta extends object,
> = Builder<TContext, TMeta, AuthenticatedOverrides, TRPCUnsetMarker>;

export type TenantProcedure<
  TContext extends ScaffoldContext,
  TMeta extends object,
> = Builder<TContext, TMeta, TenantOverrides, TenantInput>;

export type StaffProcedure<
  TContext extends ScaffoldContext,
  TMeta extends object,
> = Builder<TContext, TMeta, StaffOverrides, TRPCUnsetMarker>;

/**
 * The part of the `initTRPC` root object this factory touches.
 *
 * Narrow on purpose: the app owns the tRPC instance, its transformer, its
 * error formatter and its router, and this package has no business reaching
 * any of them. Taking only `procedure` also means an app can hand us a
 * pre-configured builder instead of the root object when it needs to.
 */
export interface TRPCLike<
  TContext extends ScaffoldContext,
  TMeta extends object,
> {
  readonly procedure: PublicProcedure<TContext, TMeta>;
}

/**
 * How the app reads permissions out of its own database.
 *
 * Injected rather than imported. `@adminigloo/permissions` deliberately ships a
 * resolver and no queries — the tables live in the app's Drizzle schema, and
 * an app is free to resolve from a cached snapshot instead of a live read. It
 * also keeps this package free of a database dependency, which is what lets
 * the ladder be tested end to end with no Postgres anywhere.
 *
 * Both loaders run at most once per (principal, scope, tenant) per request;
 * see `createRequestCache`.
 */
export interface PermissionLoaders {
  /**
   * Resolve this principal's grants in this tenant, or NULL if they are not a
   * member of it.
   *
   * THE NULL IS LOad-BEARING. The obvious implementation —
   * `createPermissionSet(grantsByTenant[tenantId] ?? [])` — returns an EMPTY
   * SET for a tenant the caller has nothing to do with, and an empty set is
   * indistinguishable from "a member with no permissions yet". The rung would
   * then admit any signed-in user to any tenant id they cared to type, with
   * `ctx.tenantId` set to their string. Returning null forces the distinction
   * into the type, where it cannot be forgotten.
   */
  loadTenantPermissions(input: {
    readonly principal: Principal;
    readonly tenantId: string;
  }): Promise<PermissionSet | null>;
  /** Resolve staff grants, or NULL if this principal is not staff at all. */
  loadStaffPermissions(input: {
    readonly principal: Principal;
  }): Promise<PermissionSet | null>;
}

export interface Procedures<
  TContext extends ScaffoldContext,
  TMeta extends object,
> {
  readonly publicProcedure: PublicProcedure<TContext, TMeta>;
  readonly protectedProcedure: ProtectedProcedure<TContext, TMeta>;
  readonly tenantProcedure: TenantProcedure<TContext, TMeta>;
  readonly staffProcedure: StaffProcedure<TContext, TMeta>;
  /** `staffProcedure` plus a check that the staff set grants `permission`. */
  requireStaff(permission: string): StaffProcedure<TContext, TMeta>;
  /** `tenantProcedure` plus a check that the tenant set grants `permission`. */
  requireTenant(permission: string): TenantProcedure<TContext, TMeta>;
}

const tenantInput = z.object({
  // `.min(1)` rather than a bare string: an empty tenant id is falsy, and the
  // handful of places that would go on to write `WHERE tenant_id = ''` or fall
  // back to a default tenant are not places you want reached by input.
  tenantId: z.string().min(1),
});

/**
 * Build the procedure ladder against the app's tRPC instance.
 *
 * Each rung resolves what the rung above could not know, and puts the answer on
 * the context:
 *
 *   publicProcedure     nothing
 *   protectedProcedure  + principal, guaranteed non-null
 *   tenantProcedure     + tenantId (from input) and can, for that tenant
 *   staffProcedure      + can, for the staff scope
 *   requireTenant/Staff + the permission itself must be granted
 *
 * This factory is the only sanctioned way to check a permission on a
 * procedure. askLou shows what the alternative costs: it grew a custom-role
 * aware checker, `hasAccessPermission`, wired into three routers, while about
 * twenty others kept calling `hasCustomerPermission(ctx.access.role, ...)`
 * directly — reading the role off the context and ignoring the custom
 * permissions the resolver had already loaded onto the very same object. Both
 * spellings compile, both look right in review, and the two disagree for any
 * user whose access was customised. The client asks one of them and the server
 * asks the other, so the UI shows a button the API then refuses.
 *
 * Nothing here stops a handler from writing its own check. `auditProcedureScopes`
 * is the half that does, by refusing a router whose declared scope does not
 * match the rung it was built from.
 */
export function createProcedures<
  TContext extends ScaffoldContext,
  TMeta extends object,
>(
  t: TRPCLike<TContext, TMeta>,
  loaders: PermissionLoaders,
): Procedures<TContext, TMeta> {
  const publicProcedure: PublicProcedure<TContext, TMeta> = t.procedure;

  const protectedProcedure: ProtectedProcedure<TContext, TMeta> =
    publicProcedure.use(tagScope(async (opts) => {
      const { principal } = opts.ctx;
      if (!principal) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Sign-in required.",
        });
      }

      // Re-supplying `principal` is what narrows it from `Principal | null` to
      // `Principal` for everything below, so no handler needs a null check
      // that would compile away to nothing anyway.
      const result = await opts.next({ ctx: { principal } });

      // The outermost rung is the only place that sees every error raised
      // beneath it, so the PermissionDeniedError mapping lives here rather
      // than being repeated in requireTenant and requireStaff. It catches the
      // denial thrown by a service function three call frames into a handler,
      // which is where `requirePermission` is most useful and where tRPC would
      // otherwise report a 500.
      if (!result.ok) {
        const mapped = permissionDeniedToTRPCError(result.error.cause);
        if (mapped) throw mapped;
      }
      return result;
    }, "authenticated"));

  const tenantProcedure: TenantProcedure<TContext, TMeta> = protectedProcedure
    .input(tenantInput)
    .use(tagScope(async (opts) => {
      const { principal, permissionCache } = opts.ctx;
      const { tenantId } = opts.input;

      const can = await permissionCache.get(
        // The tenant id belongs in the key. Keying by user alone is how a
        // cache hands tenant A's answer to a hop that asked about tenant B —
        // and it would only misfire for users who belong to more than one
        // tenant, which is a rounding error in dev data and most of production.
        `tenant:${principal.userId}:${tenantId}`,
        () => loaders.loadTenantPermissions({ principal, tenantId }),
      );

      // Not a member. This rung is exported and usable on its own, so it must
      // deny here rather than relying on a later `requireTenant` to notice an
      // empty set — otherwise `tenantProcedure.query(...)` is an open door.
      if (can === null) throw notAMember(tenantId);

      // Overwrite `ctx.tenantId`, which arrived from the host or a header. The
      // permission set below was resolved for the tenant named in the input, so
      // if a handler reads the tenant from anywhere else it can query one
      // tenant's rows while holding another tenant's grants. Making them the
      // same value removes the discrepancy instead of documenting it.
      return opts.next({ ctx: { tenantId, can } });
    }, "tenant"));

  const staffProcedure: StaffProcedure<TContext, TMeta> =
    protectedProcedure.use(tagScope(async (opts) => {
      const { principal, permissionCache } = opts.ctx;
      const can = await permissionCache.get(
        `staff:${principal.userId}`,
        () => loaders.loadStaffPermissions({ principal }),
      );

      // Same reasoning as the tenant rung: reaching the staff surface at all
      // is a privilege, separate from which staff permissions you hold.
      if (can === null) throw notStaff();

      return opts.next({ ctx: { can } });
    }, "staff"));

  return {
    publicProcedure,
    protectedProcedure,
    tenantProcedure,
    staffProcedure,
    requireTenant(permission) {
      return tenantProcedure.use(async (opts) => {
        if (!opts.ctx.can.can(permission)) throw permissionDenied(permission);
        return opts.next();
      });
    },
    requireStaff(permission) {
      return staffProcedure.use(async (opts) => {
        if (!opts.ctx.can.can(permission)) throw permissionDenied(permission);
        return opts.next();
      });
    },
  };
}

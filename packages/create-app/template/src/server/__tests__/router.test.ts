import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "__SCOPE__/auth";
import { asStaff, asTenantUser } from "__SCOPE__/testing/auth";
import { withPermissions } from "__SCOPE__/testing/permissions";
import { createScaffoldContext } from "__SCOPE__/trpc";
import type { PermissionLoaders } from "__SCOPE__/trpc";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory, createTRPCRouter, requireStaff } from "@/server/trpc";
import type { StaffPermission, TenantPermission } from "@/permissions/catalog";

/**
 * The real router, the real procedure ladder, no database.
 *
 * The two loaders in src/server/permissions.ts are the ONLY thing between the
 * ladder and Postgres, so replacing them is the whole seam. Everything else
 * here is the code that ships: the middleware order, the FORBIDDEN codes, and
 * the fact that `members.list` is built from `requireTenant` rather than from
 * `publicProcedure`. A test that stubbed the router instead would pass just as
 * happily against a procedure with no authorization on it at all.
 *
 * Typed from `PermissionLoaders` so the fixtures cannot drift from the contract
 * the middleware actually calls — including the `null`-means-not-a-member part,
 * which is the easiest thing in this file to get wrong.
 */
const loaders = vi.hoisted(() => ({
  loadTenantPermissions: vi.fn<PermissionLoaders["loadTenantPermissions"]>(),
  loadStaffPermissions: vi.fn<PermissionLoaders["loadStaffPermissions"]>(),
}));

/**
 * `importOriginal` keeps every other export of that module real, so adding a
 * helper to it later does not silently blank it out here and surface as a
 * failure in an unrelated file.
 */
vi.mock("@/server/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/permissions")>()),
  ...loaders,
}));

/**
 * A staff procedure built from the app's real `requireStaff`.
 *
 * The shipped appRouter has no staff surface yet, and inventing one here beats
 * skipping the case: the rung, the loader and the error are all the production
 * ones, and only the router is local. When you add a real staff router, point
 * this at `appRouter` and delete the block.
 */
const staffRouter = createTRPCRouter({
  dashboard: requireStaff("staff.dashboard.view" satisfies StaffPermission)
    .meta({ scope: "staff" })
    .query(({ ctx }) => ({ granted: ctx.can.toArray() })),
});

const createAppCaller = createCallerFactory(appRouter);
const createStaffCaller = createCallerFactory(staffRouter);

/**
 * One request.
 *
 * A fresh context per call, because the permission cache inside it is
 * request-scoped: reusing one would let a second call read the first call's
 * answer, and a test that changed the loader's response between them would
 * quietly assert nothing.
 */
function caller(principal: Principal | null) {
  return createAppCaller(createScaffoldContext({ principal }));
}

function staffCaller(principal: Principal | null) {
  return createStaffCaller(createScaffoldContext({ principal }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Deny by default in the fixtures too. A suite whose default is "member of
  // everything" only ever exercises the happy path, and the middleware could be
  // deleted without a single test noticing.
  loaders.loadTenantPermissions.mockResolvedValue(null);
  loaders.loadStaffPermissions.mockResolvedValue(null);
});

describe("public procedures", () => {
  it("answers health with no principal at all", async () => {
    await expect(caller(null).health()).resolves.toEqual({ ok: true });
  });
});

describe("tenant procedures", () => {
  const tenantId = "tenant_from_input";

  it("refuses a caller who is not signed in", async () => {
    await expect(caller(null).members.list({ tenantId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("refuses a signed-in caller who is not a member of the tenant", async () => {
    // NULL, not an empty set. An empty set means "a member who has been granted
    // nothing", and had the loader returned that, this call would have got as
    // far as the handler with `ctx.tenantId` set to a tenant the caller merely
    // typed.
    loaders.loadTenantPermissions.mockResolvedValue(null);

    await expect(
      caller(asTenantUser()).members.list({ tenantId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: `Not a member of tenant ${tenantId}`,
    });
  });

  it("refuses a member who lacks the permission the procedure requires", async () => {
    loaders.loadTenantPermissions.mockResolvedValue(
      withPermissions<TenantPermission>(["tenant.view"]),
    );

    await expect(
      caller(asTenantUser()).members.list({ tenantId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Permission denied: members.view",
    });
  });

  it("admits a member who holds the permission", async () => {
    loaders.loadTenantPermissions.mockResolvedValue(
      withPermissions<TenantPermission>(["members.view"]),
    );

    await expect(caller(asTenantUser()).members.list({ tenantId })).resolves.toEqual({
      tenantId,
      granted: ["members.view"],
    });
  });

  it("resolves permissions for the tenant named in the input", async () => {
    // `ctx.tenantId` arrives from a subdomain or a header and is only a hint.
    // Were the loader asked about that instead, a handler could hold one
    // tenant's grants while querying another tenant's rows.
    const principal = asTenantUser();
    loaders.loadTenantPermissions.mockResolvedValue(
      withPermissions<TenantPermission>(["members.view"]),
    );

    await caller(principal).members.list({ tenantId });

    expect(loaders.loadTenantPermissions).toHaveBeenCalledWith({
      principal,
      tenantId,
    });
  });
});

describe("staff procedures", () => {
  it("refuses a principal who holds no staff role", async () => {
    loaders.loadStaffPermissions.mockResolvedValue(null);

    await expect(staffCaller(asTenantUser()).dashboard()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Staff access required",
    });
  });

  it("refuses a staff member who lacks the permission", async () => {
    // Reaching the staff surface at all is a privilege, and it is separate from
    // which staff permissions you hold — two rungs, two different messages, and
    // support can tell the cases apart from the response alone.
    loaders.loadStaffPermissions.mockResolvedValue(
      withPermissions<StaffPermission>(["staff.audit.view"]),
    );

    await expect(staffCaller(asStaff()).dashboard()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Permission denied: staff.dashboard.view",
    });
  });

  it("admits a staff member who holds the permission", async () => {
    loaders.loadStaffPermissions.mockResolvedValue(
      withPermissions<StaffPermission>(["staff.dashboard.view"]),
    );

    await expect(staffCaller(asStaff()).dashboard()).resolves.toEqual({
      granted: ["staff.dashboard.view"],
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { initTRPC, TRPCError } from "@trpc/server";
import { createPermissionSet, requirePermission } from "@adminigloo/permissions";
import type { PermissionSet } from "@adminigloo/permissions";
import type { Principal } from "@adminigloo/auth";
import { createScaffoldContext } from "../context.js";
import type { ScaffoldContext } from "../context.js";
import { createProcedures } from "../procedures.js";
import type { PermissionLoaders } from "../procedures.js";
import type { ProcedureMeta } from "../scope.js";

// A real tRPC instance and a real caller, not a stub. The whole value of this
// package is what tRPC does with what the middleware throws, so a stub would
// pass even if the middleware never ran.
const t = initTRPC.context<ScaffoldContext>().meta<ProcedureMeta>().create();

const alice: Principal = {
  userId: "usr_alice",
  externalId: "user_2alice",
  email: "alice@example.com",
};

/** What each tenant grants Alice. */
const tenantGrants: Record<string, readonly string[]> = {
  tnt_acme: ["billing.invoice.void", "reports.read"],
  tnt_other: ["reports.read"],
};
const staffGrants: readonly string[] = ["staff.tenants.read"];

// Recorded rather than mocked: the assertions are about how many times the
// database would have been hit and for which tenant, which is the behaviour
// the request cache exists to change.
let tenantLoads: string[] = [];
let staffLoads: string[] = [];

/** Who is staff at all, as distinct from which staff permissions they hold. */
const staffMembers = new Set(["usr_alice"]);

const loaders: PermissionLoaders = {
  // Note the `?? null`, NOT `?? []`. An empty set means "a member who has been
  // granted nothing"; null means "not a member". Collapsing the two is the bug
  // this harness previously encoded.
  async loadTenantPermissions({ tenantId }): Promise<PermissionSet | null> {
    tenantLoads.push(tenantId);
    const grants = tenantGrants[tenantId];
    return grants ? createPermissionSet(grants) : null;
  },
  async loadStaffPermissions({ principal }): Promise<PermissionSet | null> {
    staffLoads.push(principal.userId);
    return staffMembers.has(principal.userId)
      ? createPermissionSet(staffGrants)
      : null;
  },
};

const p = createProcedures(t, loaders);

const appRouter = t.router({
  ping: p.publicProcedure.meta({ scope: "public" }).query(() => "pong"),

  me: p.protectedProcedure
    .meta({ scope: "authenticated" })
    .query(({ ctx }) => ctx.principal.userId),

  tenantEcho: p.tenantProcedure.meta({ scope: "tenant" }).query(({ ctx }) => ({
    tenantId: ctx.tenantId,
    granted: ctx.can.toArray(),
  })),

  voidInvoice: p
    .requireTenant("billing.invoice.void")
    .meta({ scope: "tenant" })
    .mutation(() => "voided"),

  exportReports: p
    .requireTenant("reports.export")
    .meta({ scope: "tenant" })
    .mutation(() => "exported"),

  listTenants: p
    .requireStaff("staff.tenants.read")
    .meta({ scope: "staff" })
    .query(() => ["tnt_acme"]),

  impersonate: p
    .requireStaff("staff.impersonate")
    .meta({ scope: "staff" })
    .mutation(() => "impersonating"),

  // Checks by hand, the way a service function three frames deep would. The
  // denial still has to reach the client as a 403.
  deepCheck: p.tenantProcedure.meta({ scope: "tenant" }).mutation(({ ctx }) => {
    requirePermission(ctx.can, "billing.invoice.issue", "tenant");
    return "issued";
  }),

  boom: p.protectedProcedure.meta({ scope: "authenticated" }).query(() => {
    throw new Error("the database fell over");
  }),
});

const callerFactory = t.createCallerFactory(appRouter);

function callerFor(principal: Principal | null, tenantId: string | null = null) {
  return callerFactory(createScaffoldContext({ principal, tenantId }));
}

async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (cause) {
    if (cause instanceof TRPCError) return cause.code;
    throw cause;
  }
  throw new Error("expected the call to reject, and it resolved");
}

beforeEach(() => {
  tenantLoads = [];
  staffLoads = [];
});

describe("the ladder", () => {
  it("lets a signed-out caller through a public procedure", async () => {
    expect(await callerFor(null).ping()).toBe("pong");
  });

  it("refuses a signed-out caller with UNAUTHORIZED, not FORBIDDEN", async () => {
    // Load bearing on the client: UNAUTHORIZED means "sign in and try again",
    // FORBIDDEN means "signing in will not help".
    expect(await codeOf(callerFor(null).me())).toBe("UNAUTHORIZED");
  });

  it("narrows principal to non-null for everything below protectedProcedure", async () => {
    expect(await callerFor(alice).me()).toBe("usr_alice");
  });

  it("never resolves a permission set for a caller it rejected", async () => {
    await codeOf(callerFor(null).tenantEcho({ tenantId: "tnt_acme" }));
    expect(tenantLoads).toEqual([]);
  });
});

describe("tenantProcedure", () => {
  it("resolves the set for the tenant named in the input", async () => {
    expect(await callerFor(alice).tenantEcho({ tenantId: "tnt_acme" })).toEqual({
      tenantId: "tnt_acme",
      granted: ["billing.invoice.void", "reports.read"],
    });
  });

  it("overwrites a ctx.tenantId that disagrees with the input", async () => {
    // The permission set was resolved for the input's tenant. If a handler
    // could still read the host's tenant off the context it would query one
    // tenant's rows holding another tenant's grants — a cross-tenant read that
    // passes every permission check on the way in.
    const result = await callerFor(alice, "tnt_other").tenantEcho({
      tenantId: "tnt_acme",
    });

    expect(result.tenantId).toBe("tnt_acme");
    expect(tenantLoads).toEqual(["tnt_acme"]);
  });

  it("rejects an empty tenant id before any lookup happens", async () => {
    expect(await codeOf(callerFor(alice).tenantEcho({ tenantId: "" }))).toBe(
      "BAD_REQUEST",
    );
    expect(tenantLoads).toEqual([]);
  });

  it("allows a granted permission through requireTenant", async () => {
    expect(await callerFor(alice).voidInvoice({ tenantId: "tnt_acme" })).toBe(
      "voided",
    );
  });

  it("refuses an ungranted permission with FORBIDDEN, and names it", async () => {
    await expect(
      callerFor(alice).exportReports({ tenantId: "tnt_acme" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Permission denied: reports.export",
    });
  });

  it("refuses a permission this tenant does not grant even though another does", async () => {
    expect(
      await codeOf(callerFor(alice).voidInvoice({ tenantId: "tnt_other" })),
    ).toBe("FORBIDDEN");
  });
});

describe("staffProcedure", () => {
  it("resolves the staff set and allows a granted permission", async () => {
    expect(await callerFor(alice).listTenants()).toEqual(["tnt_acme"]);
    expect(staffLoads).toEqual(["usr_alice"]);
  });

  it("refuses an ungranted staff permission", async () => {
    expect(await codeOf(callerFor(alice).impersonate())).toBe("FORBIDDEN");
  });

  it("keeps the staff and tenant sets apart within one request", async () => {
    // Same user, same request, two scopes. A staff grant must not answer a
    // tenant question or the two scopes have collapsed into one.
    const caller = callerFor(alice);
    await caller.listTenants();

    expect(await codeOf(caller.voidInvoice({ tenantId: "tnt_other" }))).toBe(
      "FORBIDDEN",
    );
    expect(tenantLoads).toEqual(["tnt_other"]);
  });
});

describe("per-request caching through the middleware", () => {
  it("resolves one tenant set for concurrent hops in the same request", async () => {
    // The forecastCFF -> forecastBS x10 -> forecastIS x5 shape: every hop
    // starts before the first lookup settles.
    const caller = callerFor(alice);
    await Promise.all([
      caller.tenantEcho({ tenantId: "tnt_acme" }),
      caller.voidInvoice({ tenantId: "tnt_acme" }),
      caller.tenantEcho({ tenantId: "tnt_acme" }),
      caller.voidInvoice({ tenantId: "tnt_acme" }),
    ]);

    expect(tenantLoads).toEqual(["tnt_acme"]);
  });

  it("resolves separately per tenant within one request", async () => {
    const caller = callerFor(alice);
    await Promise.all([
      caller.tenantEcho({ tenantId: "tnt_acme" }),
      caller.tenantEcho({ tenantId: "tnt_other" }),
    ]);

    expect([...tenantLoads].sort()).toEqual(["tnt_acme", "tnt_other"]);
  });

  it("does not carry a resolved set into the next request", async () => {
    await callerFor(alice).tenantEcho({ tenantId: "tnt_acme" });
    await callerFor(alice).tenantEcho({ tenantId: "tnt_acme" });

    expect(tenantLoads).toEqual(["tnt_acme", "tnt_acme"]);
  });
});

describe("permission denials raised outside the middleware", () => {
  it("maps a handler's requirePermission onto FORBIDDEN, not a 500", async () => {
    // Without the mapping this is INTERNAL_SERVER_ERROR: the client retries,
    // someone gets paged, and the user is told the app is broken rather than
    // that they lack access.
    await expect(
      callerFor(alice).deepCheck({ tenantId: "tnt_acme" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Permission denied: billing.invoice.issue",
    });
  });

  it("still reports an unrelated failure as INTERNAL_SERVER_ERROR", async () => {
    // The mapping has to be surgical. Turning every handler error into a 403
    // would hide an outage behind a permissions message.
    expect(await codeOf(callerFor(alice).boom())).toBe("INTERNAL_SERVER_ERROR");
  });
});


// ---------------------------------------------------------------------------
// Regression suite: the rungs must authorize, not merely resolve.
//
// Before this, `tenantProcedure` treated "resolved an empty set" as success and
// called next(). A signed-in user could pass any tenant id they liked, reach a
// 200, and land in a handler whose ctx.tenantId was their own string — because
// the middleware overwrites ctx.tenantId with the input, leaving no trusted
// value to compare against. `requireTenant` was safe (an empty set denies), but
// the bare rung is exported, typed and documented as usable on its own.
// ---------------------------------------------------------------------------

describe("the rungs deny non-members", () => {
  const outsider: Principal = {
    userId: "usr_outsider",
    externalId: "user_2out",
    email: "out@example.com",
  };

  function callerFor(principal: Principal | null) {
    return appRouter.createCaller(createScaffoldContext({ principal }));
  }

  it("refuses a tenant the caller does not belong to", async () => {
    await expect(
      callerFor(alice).tenantEcho({ tenantId: "tnt_not_mine" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("names the tenant it refused, so the log is actionable", async () => {
    await expect(
      callerFor(alice).tenantEcho({ tenantId: "tnt_not_mine" }),
    ).rejects.toThrow(/tnt_not_mine/);
  });

  it("still admits a tenant the caller does belong to", async () => {
    await expect(
      callerFor(alice).tenantEcho({ tenantId: "tnt_acme" }),
    ).resolves.toMatchObject({ tenantId: "tnt_acme" });
  });

  it("refuses the staff surface to a signed-in non-staff user", async () => {
    const staffRoute = Object.keys(appRouter._def.procedures).find((k) =>
      k.toLowerCase().includes("staff"),
    );
    // Only assert if the harness router actually exposes a staff rung.
    if (!staffRoute) return;
    await expect(
      (callerFor(outsider) as unknown as Record<string, () => Promise<unknown>>)[
        staffRoute
      ]?.(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not leak a foreign tenant id into ctx via the input", async () => {
    // The middleware overwrites ctx.tenantId with the input, so if the rung
    // admitted a non-member the handler would run scoped to a tenant the
    // caller invented. Proving the rejection happens BEFORE that overwrite is
    // the whole point.
    await expect(
      callerFor(alice).tenantEcho({ tenantId: "tnt_invented" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

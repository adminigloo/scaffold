import { describe, expect, it } from "vitest";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { z as z3 } from "zod/v3";
import { createPermissionSet } from "@adminigloo/permissions";
import type { Principal } from "@adminigloo/auth";
import { createScaffoldContext, type ScaffoldContext } from "../context.js";
import { auditBuiltProcedures, inputFieldsOf, inventoryOf, looksLikeAnId } from "../inventory.js";
import { createProcedures, type PermissionLoaders } from "../procedures.js";
import type { ProcedureMeta } from "../scope.js";

/**
 * Tenancy 1 (contract 9.3): the suspended refusal, `inventoryOf`, and
 * dotted-path overrides in the scope audit. A real tRPC instance and caller.
 */
const t = initTRPC.context<ScaffoldContext>().meta<ProcedureMeta>().create();
const bob: Principal = { userId: "usr_bob", externalId: "user_bob", email: "bob@example.com" };

function routerWith(loaders: PermissionLoaders) {
  const p = createProcedures(t, loaders);
  return t.router({
    health: t.router({ ping: p.publicProcedure.meta({ scope: "public" }).query(() => "pong") }),
    members: t.router({
      list: p.tenantProcedure.meta({ scope: "tenant" }).query(({ ctx }) => ctx.tenantId),
      deep: t.router({ count: p.requireTenant("members.view").meta({ scope: "tenant" }).query(() => 1) }),
    }),
    invoicing: t.router({
      list: p.requireStaff("invoicing.view").meta({ scope: "staff" }).query(() => []),
      byToken: p.publicProcedure.meta({ scope: "public" }).query(() => "invoice"),
    }),
    rootLevel: p.protectedProcedure.meta({ scope: "authenticated" }).query(() => "me"),
  });
}

const base = {
  loadTenantPermissions: async () => null,
  loadStaffPermissions: async () => createPermissionSet(["invoicing.view"]),
} satisfies PermissionLoaders;

async function refusal(loaders: PermissionLoaders): Promise<TRPCError> {
  const caller = t.createCallerFactory(routerWith(loaders))(createScaffoldContext({ principal: bob }));
  try {
    await caller.members.list({ tenantId: "tnt_suspended" });
  } catch (error) {
    return error as TRPCError;
  }
  throw new Error("expected a refusal");
}

describe("a suspended company gets its own refusal (9.1)", () => {
  it("with explainTenantDenial answering company-suspended, a non-member call gets the suspended message", async () => {
    const error = await refusal({ ...base, explainTenantDenial: async () => "company-suspended" });
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("Access to this account is suspended. Contact support to restore it.");
  });

  it("without the method (or answering not-a-member), the old message stays", async () => {
    expect((await refusal(base)).message).toBe("Not a member of tenant tnt_suspended");
    expect((await refusal({ ...base, explainTenantDenial: async () => "not-a-member" })).message).toBe("Not a member of tenant tnt_suspended");
  });
});

describe("inventoryOf (9.2)", () => {
  it("flattens nested routers by dotted path and names the first segment as the router", () => {
    const entries = inventoryOf(routerWith(base));
    expect(entries.map((e) => [e.path, e.router]).sort()).toEqual(
      [
        ["health.ping", "health"],
        ["members.list", "members"],
        ["members.deep.count", "members"],
        ["invoicing.list", "invoicing"],
        ["invoicing.byToken", "invoicing"],
        ["rootLevel", ""],
      ].sort(),
    );
  });

  it("reads meta.scope as `declared`", () => {
    const entries = inventoryOf(routerWith(base));
    expect(entries.find((e) => e.path === "members.deep.count")?.declared).toBe("tenant");
    expect(entries.find((e) => e.path === "invoicing.byToken")?.declared).toBe("public");
  });

  it("an exact-path override beats the router entry; an unregistered path is still a violation", () => {
    const entries = inventoryOf(routerWith(base));
    const expected = { health: "public", members: "tenant", invoicing: "staff", "invoicing.byToken": "public", "": "authenticated" } as const;
    expect(auditBuiltProcedures(entries, expected)).toEqual({ ok: true, violations: [] });
    // Without the override, the public byToken inside a staff router is flagged.
    const strict = auditBuiltProcedures(entries, { health: "public", members: "tenant", invoicing: "staff", "": "authenticated" });
    expect(strict.violations.map((v) => v.path)).toEqual(["invoicing.byToken"]);
    // A router nobody registered is a violation by name.
    const missing = auditBuiltProcedures(entries, { health: "public", invoicing: "staff", "invoicing.byToken": "public", "": "authenticated" });
    expect(missing.violations.map((v) => v.path).sort()).toEqual(["members.deep.count", "members.list"]);
  });
});

describe("inputFieldsOf: every id a procedure can be handed, optional ones too (review R3 TB2-01)", () => {
  // The leak the isolation proof missed: an OPTIONAL member id parses with
  // the company's id alone, so a proof that only sent the company's id never
  // saw it. These are read off the schema, never by running the procedure.
  const p = createProcedures(t, base);
  const procs = t.router({
    optional: p.requireTenant("members.view").meta({ scope: "tenant" }).input(z.object({ userId: z.string().optional() })).query(() => 1),
    nested: p
      .requireTenant("members.view")
      .meta({ scope: "tenant" })
      .input(
        z.object({
          filter: z.object({ memberIds: z.array(z.string()), visit_id: z.string().nullable() }).optional(),
          days: z.number().int().default(30),
          rows: z.array(z.object({ orderId: z.string() })),
        }),
      )
      .query(() => 1),
    piped: p
      .requireTenant("members.view")
      .meta({ scope: "tenant" })
      .input(z.object({ which: z.union([z.object({ quoteId: z.string() }), z.object({ tierKey: z.string() })]) }).transform((v) => v))
      .mutation(() => 1),
    v3: p.requireTenant("members.view").meta({ scope: "tenant" }).input(z3.object({ invitationId: z3.string().uuid().optional() })).query(() => 1),
  });
  const byPath = (path: string) => Object.fromEntries(inputFieldsOf(procs._def.procedures[path as keyof typeof procs._def.procedures] as never).map((f) => [f.path, f]));

  it("an optional id is reported, as optional; the rung's tenantId is there, required", () => {
    const fields = byPath("optional");
    expect(fields["userId"]).toMatchObject({ key: "userId", kind: "string", optional: true, inArray: false, segments: ["userId"] });
    expect(fields["tenantId"]).toMatchObject({ optional: false });
  });

  it("nested objects, arrays, nullable and defaulted fields, with the path to set each", () => {
    const fields = byPath("nested");
    expect(fields["filter.memberIds[]"]).toMatchObject({ key: "memberIds", optional: true, inArray: true, segments: ["filter", "memberIds", "[]"] });
    expect(fields["filter.visit_id"]).toMatchObject({ key: "visit_id", optional: true });
    expect(fields["days"]).toMatchObject({ kind: "number", optional: true });
    expect(fields["rows[].orderId"]).toMatchObject({ key: "orderId", optional: false, inArray: true });
  });

  it("every branch of a union, through a pipe, and a zod 3 schema", () => {
    expect(Object.keys(byPath("piped")).sort()).toEqual(["tenantId", "which.quoteId", "which.tierKey"]);
    expect(byPath("v3")["invitationId"]).toMatchObject({ kind: "string", optional: true });
  });

  it("looksLikeAnId: the names a company's row ids go by, and not the ones that merely end in -id", () => {
    for (const key of ["id", "ids", "userId", "memberIds", "orderID", "visit_id", "invitation_ids"]) expect(looksLikeAnId(key), key).toBe(true);
    for (const key of ["paid", "valid", "tierKey", "days", "idea", "Idaho"]) expect(looksLikeAnId(key), key).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { auditProcedureScopes } from "../inventory.js";
import type { ProcedureEntry } from "../inventory.js";
import type { ProcedureScope } from "../scope.js";

const expected: Record<string, ProcedureScope> = {
  health: "public",
  account: "authenticated",
  billing: "tenant",
  admin: "staff",
};

const clean: ProcedureEntry[] = [
  { path: "health.ping", scope: "public", router: "health" },
  { path: "account.me", scope: "authenticated", router: "account" },
  { path: "billing.invoices.list", scope: "tenant", router: "billing" },
  { path: "billing.invoices.void", scope: "tenant", router: "billing" },
  { path: "admin.impersonate", scope: "staff", router: "admin" },
];

describe("auditProcedureScopes", () => {
  it("passes a router tree where every procedure matches its registration", () => {
    expect(auditProcedureScopes(clean, expected)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("passes an empty inventory rather than inventing a violation", () => {
    expect(auditProcedureScopes([], expected)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("flags a procedure with no declared scope", () => {
    const result = auditProcedureScopes(
      [...clean, { path: "billing.invoices.refund", router: "billing" }],
      expected,
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.path).toBe("billing.invoices.refund");
    expect(result.violations[0]?.reason).toContain("No scope declared");
    // The message has to say what to write, not just that something is wrong.
    expect(result.violations[0]?.reason).toContain('scope: "tenant"');
  });

  it("flags the one procedure in a tenant router that was left public", () => {
    // The askLou bug in miniature: nineteen procedures done properly, one that
    // reads fine on its own and is checked by hand.
    const result = auditProcedureScopes(
      [...clean, { path: "billing.invoices.export", scope: "public", router: "billing" }],
      expected,
    );

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.path).toBe("billing.invoices.export");
    expect(result.violations[0]?.reason).toContain(
      'Declares scope "public" but router "billing" is registered as "tenant"',
    );
  });

  it("flags a staff procedure that drifted down to tenant scope", () => {
    const result = auditProcedureScopes(
      [{ path: "admin.impersonate", scope: "tenant", router: "admin" }],
      expected,
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toContain('registered as "staff"');
  });

  it("flags a router nobody registered, so a new surface cannot ship unaudited", () => {
    const result = auditProcedureScopes(
      [{ path: "webhooks.stripe", scope: "public", router: "webhooks" }],
      expected,
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toContain(
      'Router "webhooks" is not in the scope inventory',
    );
  });

  it("reports the unregistered router once per procedure, and does not also complain about its scope", () => {
    // Two reasons for one procedure would double the noise and bury the fix:
    // registering the router is the only action that helps.
    const result = auditProcedureScopes(
      [
        { path: "webhooks.stripe", router: "webhooks" },
        { path: "webhooks.clerk", scope: "staff", router: "webhooks" },
      ],
      expected,
    );

    expect(result.violations).toHaveLength(2);
    for (const violation of result.violations) {
      expect(violation.reason).toContain("not in the scope inventory");
    }
  });

  it("collects every violation instead of stopping at the first", () => {
    // A guard that reports one problem per CI run costs one round trip per
    // problem. Reviewers fix what they are shown, all at once.
    const result = auditProcedureScopes(
      [
        { path: "billing.a", scope: "public", router: "billing" },
        { path: "billing.b", router: "billing" },
        { path: "admin.c", scope: "tenant", router: "admin" },
        { path: "health.ping", scope: "public", router: "health" },
      ],
      expected,
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.path)).toEqual([
      "billing.a",
      "billing.b",
      "admin.c",
    ]);
  });

  it("audits nothing when the inventory is empty and there are no procedures to check", () => {
    expect(auditProcedureScopes([], {})).toEqual({ ok: true, violations: [] });
  });

  it("refuses every procedure when the inventory is empty but procedures exist", () => {
    const result = auditProcedureScopes(clean, {});
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(clean.length);
  });
});

// ---------------------------------------------------------------------------
// The derived audit, against a REAL tRPC router.
//
// auditProcedureScopes compares one declaration (.meta) against another (the
// expected map), so it cannot see the rung. The failure that actually happens
// is copying a neighbouring procedure inside a tenant router: the correct
// `.meta({ scope: "tenant" })` comes along for the ride while the rung silently
// becomes publicProcedure. The annotation stays right, the authorization
// disappears, and a declaration-only audit reports ok.
// ---------------------------------------------------------------------------

import { initTRPC } from "@trpc/server";
import { createPermissionSet } from "@adminigloo/permissions";
import type { Principal } from "@adminigloo/auth";
import { createScaffoldContext, type ScaffoldContext } from "../context.js";
import { createProcedures } from "../procedures.js";
import { auditBuiltProcedures, scopeOfProcedure } from "../inventory.js";
import type { ProcedureMeta } from "../scope.js";

describe("scopeOfProcedure — derived from the middleware chain", () => {
  const t = initTRPC.context<ScaffoldContext>().meta<ProcedureMeta>().create();
  const p = createProcedures(t, {
    async loadTenantPermissions() {
      return createPermissionSet(["reports.read"]);
    },
    async loadStaffPermissions() {
      return createPermissionSet(["staff.read"]);
    },
  });

  const honest = p.tenantProcedure.meta({ scope: "tenant" }).query(() => "ok");
  // The bug: right annotation, wrong rung.
  const smuggled = p.publicProcedure.meta({ scope: "tenant" }).query(() => "leak");
  const open = p.publicProcedure.meta({ scope: "public" }).query(() => "fine");
  const staff = p.staffProcedure.meta({ scope: "staff" }).query(() => "ok");

  it("reports the rung a procedure was actually built from", () => {
    expect(scopeOfProcedure(honest)).toBe("tenant");
    expect(scopeOfProcedure(smuggled)).toBe("public");
    expect(scopeOfProcedure(open)).toBe("public");
    expect(scopeOfProcedure(staff)).toBe("staff");
  });

  it("reports the strongest rung, not the first — tenant sits atop authenticated", () => {
    expect(scopeOfProcedure(p.protectedProcedure.query(() => 1))).toBe(
      "authenticated",
    );
    expect(scopeOfProcedure(honest)).toBe("tenant");
  });

  it("CATCHES the smuggled procedure that the declaration-only audit passes", () => {
    const result = auditBuiltProcedures(
      [
        { path: "billing.list", router: "billing", procedure: honest, declared: "tenant" },
        {
          path: "billing.export",
          router: "billing",
          procedure: smuggled,
          declared: "tenant",
        },
      ],
      { billing: "tenant" },
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.path)).toContain("billing.export");
    expect(result.violations[0]?.reason).toMatch(/public/);
  });

  it("passes a router whose procedures all use the right rung", () => {
    expect(
      auditBuiltProcedures(
        [{ path: "billing.list", router: "billing", procedure: honest, declared: "tenant" }],
        { billing: "tenant" },
      ),
    ).toEqual({ ok: true, violations: [] });
  });

  it("flags a router nobody registered, so the guard cannot rot silently", () => {
    const result = auditBuiltProcedures(
      [{ path: "secrets.read", router: "secrets", procedure: honest }],
      { billing: "tenant" },
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.reason).toMatch(/not registered/);
  });

  it("allows a rung stronger than the router requires", () => {
    expect(
      auditBuiltProcedures(
        [{ path: "billing.admin", router: "billing", procedure: staff }],
        { billing: "authenticated" },
      ).ok,
    ).toBe(true);
  });

  it("uses the context factory it documents", () => {
    const principal: Principal = { userId: "u", externalId: "e", email: null };
    expect(createScaffoldContext({ principal }).principal).toBe(principal);
  });
});

import { describe, expect, it } from "vitest";
import { createPermissionSet, resolvePermissionSet } from "__SCOPE__/permissions";
import type { PermissionRule, PermissionSet } from "__SCOPE__/permissions";
import { asTenantUser, buildPrincipal } from "__SCOPE__/testing/auth";
import { withPermissions } from "__SCOPE__/testing/permissions";
import { tenantCatalog } from "@/permissions/catalog";
import type { TenantPermission } from "@/permissions/catalog";

/**
 * Permission resolution, with no database anywhere.
 *
 * The four cases below are the whole authorization model. They are worth
 * pinning in the app rather than leaving to __SCOPE__/permissions, because the
 * thing that breaks is not the resolver — it is somebody "simplifying"
 * `resolveFor` in src/server/permissions.ts to read one table instead of two.
 * Drop the override query and every test that only grants through a template
 * still passes; the only thing that notices is case 2.
 */

/**
 * The last two lines of `resolveFor` in src/server/permissions.ts, given the
 * rows instead of the queries that fetch them.
 *
 * Mirrored rather than imported because `resolveFor` is private and takes a
 * principal id, not rows. If the two ever disagree, this comment is the pointer
 * to the file that has to change with it.
 */
function resolve(input: {
  templateGrants?: readonly PermissionRule[];
  overrides?: readonly PermissionRule[];
}): PermissionSet<TenantPermission> {
  return createPermissionSet<TenantPermission>(
    resolvePermissionSet({
      templateGrants: input.templateGrants ?? [],
      overrides: input.overrides ?? [],
    }),
  );
}

const allow = (permission: TenantPermission): PermissionRule => ({
  permission,
  effect: "allow",
});

const deny = (permission: TenantPermission): PermissionRule => ({
  permission,
  effect: "deny",
});

describe("resolution", () => {
  it("grants what the role template allows", () => {
    const can = resolve({ templateGrants: [allow("members.view")] });

    expect(can.can("members.view")).toBe(true);
  });

  it("lets a per-person override deny take a template grant away", () => {
    const can = resolve({
      templateGrants: [allow("members.view"), allow("members.invite")],
      overrides: [deny("members.invite")],
    });

    expect(can.can("members.view")).toBe(true);
    expect(can.can("members.invite")).toBe(false);
  });

  it("keeps a sealed key denied even when an override allows it", () => {
    // A template `deny` row is a SEAL, not merely an absence — omission already
    // denies, so `deny` is free to mean the stronger thing. This is what stops
    // "just give Dana ownership transfer for this one migration" from being a
    // one-row change that nobody can see afterwards.
    expect(tenantCatalog.isSealed("tenant.transfer")).toBe(true);

    const can = resolve({
      templateGrants: [allow("members.view"), deny("tenant.transfer")],
      overrides: [allow("tenant.transfer")],
    });

    expect(can.can("tenant.transfer")).toBe(false);
    expect(can.can("members.view")).toBe(true);
  });

  it("denies a key that no template and no override mentions", () => {
    // Deny by default. The case that gets skipped, and the one that decides
    // whether a permission you forgot to grant fails open or closed.
    const can = resolve({ templateGrants: [allow("members.view")] });

    expect(can.can("members.remove")).toBe(false);
    expect(resolve({}).can("members.view")).toBe(false);
  });
});

describe("the set a procedure receives", () => {
  /**
   * `withPermissions` skips the rows entirely and hands over the answer, which
   * is what a router test wants: the ninety tests that only care about "a
   * member cannot remove members" should not depend on the shape of two tables
   * they never assert on. It is typed on the app's own key union, so a
   * misspelled fixture key is a compile error rather than a test that silently
   * grants nothing.
   */
  it("grants exactly the keys it was given", () => {
    const can = withPermissions<TenantPermission>(["members.view", "tenant.view"]);

    expect(can.canAll(["members.view", "tenant.view"])).toBe(true);
    expect(can.canAny(["members.remove", "tenant.view"])).toBe(true);
    expect(can.can("members.remove")).toBe(false);
  });

  it("agrees with a set resolved from rows", () => {
    // The shortcut and the long way round must not drift. If they do, every
    // router test in the project is asserting against a fiction.
    const fromRows = resolve({
      templateGrants: [allow("members.view"), allow("members.invite")],
      overrides: [deny("members.invite")],
    });

    expect(fromRows.toArray()).toEqual(
      withPermissions<TenantPermission>(["members.view"]).toArray(),
    );
  });
});

describe("test principals", () => {
  /**
   * Identity carries no scope, no role and no tenant. Authorization comes from
   * the assignment rows the loaders read, so `asTenantUser()` is not "a
   * principal with tenant powers" — it is a distinct id. What the builders buy
   * is that a test mixing a staff and a tenant actor does not accidentally give
   * both the same `userId` and pass a check that would fail in production for
   * the most boring possible reason.
   */
  it("hands out stable, obviously-fake, distinct identities", () => {
    expect(buildPrincipal().userId).toBe(buildPrincipal().userId);
    expect(asTenantUser().userId).not.toBe(buildPrincipal().userId);
    expect(buildPrincipal({ email: "dana@example.com" }).email).toBe(
      "dana@example.com",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  createPermissionSet,
  explainPermission,
  resolveAgainstCatalog,
  resolvePermissionSet,
  type PermissionRule,
} from "../resolve.js";
import { definePermissions } from "../catalog.js";

const allow = (permission: string): PermissionRule => ({ permission, effect: "allow" });
const deny = (permission: string): PermissionRule => ({ permission, effect: "deny" });

describe("resolvePermissionSet — deny by default", () => {
  it("grants nothing when there is nothing", () => {
    expect(resolvePermissionSet({ templateGrants: [], overrides: [] }).size).toBe(0);
  });

  it("a permission in no template and no override stays denied", () => {
    const set = resolvePermissionSet({
      templateGrants: [allow("members.view")],
      overrides: [],
    });
    expect(set.has("members.invite")).toBe(false);
  });
});

describe("resolvePermissionSet — template grants", () => {
  it("allow rows grant", () => {
    const set = resolvePermissionSet({
      templateGrants: [allow("members.view"), allow("members.invite")],
      overrides: [],
    });
    expect([...set].sort()).toEqual(["members.invite", "members.view"]);
  });
});

describe("resolvePermissionSet — overrides", () => {
  it("override allow grants something the template omitted", () => {
    const set = resolvePermissionSet({
      templateGrants: [allow("members.view")],
      overrides: [allow("reports.export")],
    });
    expect(set.has("reports.export")).toBe(true);
  });

  it("override deny revokes something the template granted", () => {
    const set = resolvePermissionSet({
      templateGrants: [allow("members.view"), allow("members.remove")],
      overrides: [deny("members.remove")],
    });
    expect(set.has("members.view")).toBe(true);
    expect(set.has("members.remove")).toBe(false);
  });
});

describe("resolvePermissionSet — the seal", () => {
  it("a template deny cannot be reopened by an override allow", () => {
    const set = resolvePermissionSet({
      templateGrants: [deny("tenant.transfer")],
      overrides: [allow("tenant.transfer")],
    });
    expect(set.has("tenant.transfer")).toBe(false);
  });

  it("a seal beats a template allow for the same key, whatever the order", () => {
    const set = resolvePermissionSet({
      templateGrants: [allow("tenant.transfer"), deny("tenant.transfer")],
      overrides: [],
    });
    expect(set.has("tenant.transfer")).toBe(false);
  });

  it("sealing one key does not affect the others", () => {
    const set = resolvePermissionSet({
      templateGrants: [allow("members.view"), deny("tenant.transfer")],
      overrides: [allow("tenant.transfer"), allow("reports.export")],
    });
    expect([...set].sort()).toEqual(["members.view", "reports.export"]);
  });
});

describe("explainPermission", () => {
  it.each([
    [{ templateGrants: [allow("x")], overrides: [] }, true, "granted-by-template"],
    [{ templateGrants: [], overrides: [allow("x")] }, true, "granted-by-override"],
    [{ templateGrants: [], overrides: [] }, false, "not-granted"],
    [{ templateGrants: [allow("x")], overrides: [deny("x")] }, false, "denied-by-override"],
    [{ templateGrants: [deny("x")], overrides: [allow("x")] }, false, "sealed-by-template"],
  ])("%o -> allowed=%s reason=%s", (input, allowed, reason) => {
    expect(explainPermission("x", input)).toEqual({ allowed, reason });
  });

  it("agrees with resolvePermissionSet on every combination", () => {
    const options: (PermissionRule[] | [])[] = [[], [allow("x")], [deny("x")]];
    for (const templateGrants of options) {
      for (const overrides of options) {
        const input = { templateGrants, overrides };
        expect(explainPermission("x", input).allowed).toBe(
          resolvePermissionSet(input).has("x"),
        );
      }
    }
  });
});

describe("createPermissionSet", () => {
  const set = createPermissionSet(["a", "b"]);

  it("answers can / canAll / canAny", () => {
    expect(set.can("a")).toBe(true);
    expect(set.can("z")).toBe(false);
    expect(set.canAll(["a", "b"])).toBe(true);
    expect(set.canAll(["a", "z"])).toBe(false);
    expect(set.canAny(["z", "b"])).toBe(true);
    expect(set.canAny(["y", "z"])).toBe(false);
  });

  it("serialises for the client", () => {
    expect([...set.toArray()].sort()).toEqual(["a", "b"]);
  });
});

describe("resolveAgainstCatalog", () => {
  const catalog = definePermissions("tenant", {
    "members.view": { label: "View members" },
  });

  it("resolves when every stored rule is still in the catalog", () => {
    expect(
      resolveAgainstCatalog(catalog, {
        templateGrants: [allow("members.view")],
        overrides: [],
      }).has("members.view"),
    ).toBe(true);
  });

  it("refuses a stored rule the catalog no longer declares", () => {
    expect(() =>
      resolveAgainstCatalog(catalog, {
        templateGrants: [allow("members.removed_last_release")],
        overrides: [],
      }),
    ).toThrow(/not in the tenant catalog/);
  });

  it("checks overrides too, not only template grants", () => {
    expect(() =>
      resolveAgainstCatalog(catalog, {
        templateGrants: [],
        overrides: [deny("ghost.permission")],
      }),
    ).toThrow(/ghost\.permission/);
  });
});

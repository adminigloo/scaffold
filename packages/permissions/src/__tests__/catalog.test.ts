import { describe, expect, it } from "vitest";
import {
  definePermissions,
  DuplicatePermissionError,
  UnknownPermissionError,
} from "../catalog.js";
import { PermissionDeniedError, requirePermission } from "../errors.js";
import { createPermissionSet } from "../resolve.js";

const tenancyPermissions = {
  "members.view": { label: "View members", category: "Team" },
  "members.invite": { label: "Invite members", category: "Team" },
  "tenant.transfer": {
    label: "Transfer ownership",
    category: "Danger",
    sealed: true,
    defaultFor: ["owner"],
  },
} as const;

const commercePermissions = {
  "orders.view": { label: "View orders", category: "Commerce", defaultFor: ["owner", "admin"] },
} as const;

const catalog = definePermissions("tenant", {
  ...tenancyPermissions,
  ...commercePermissions,
});

describe("definePermissions", () => {
  it("exposes the declared keys", () => {
    expect([...catalog.keys].sort()).toEqual([
      "members.invite",
      "members.view",
      "orders.view",
      "tenant.transfer",
    ]);
  });

  it("narrows an unknown key with has()", () => {
    expect(catalog.has("members.view")).toBe(true);
    expect(catalog.has("nope")).toBe(false);
  });

  it("throws on an unknown key rather than returning undefined", () => {
    expect(() => catalog.get("nope" as never)).toThrow(UnknownPermissionError);
  });

  it("reports sealed permissions", () => {
    expect(catalog.isSealed("tenant.transfer")).toBe(true);
    expect(catalog.isSealed("members.view")).toBe(false);
  });

  it("groups by category for the checklist", () => {
    const grouped = catalog.byCategory();
    expect([...(grouped.get("Team") ?? [])].sort()).toEqual([
      "members.invite",
      "members.view",
    ]);
    expect(grouped.get("Danger")).toEqual(["tenant.transfer"]);
  });

  it("lists the defaults a system template should receive", () => {
    expect([...catalog.defaultsFor("owner")].sort()).toEqual([
      "orders.view",
      "tenant.transfer",
    ]);
    expect(catalog.defaultsFor("admin")).toEqual(["orders.view"]);
    expect(catalog.defaultsFor("viewer")).toEqual([]);
  });

  it("catches two packages claiming the same key, which a spread would hide", () => {
    const colliding = { "members.view": { label: "Something else" } } as const;
    expect(() =>
      definePermissions(
        "tenant",
        { ...tenancyPermissions, ...colliding },
        { contributedBy: [tenancyPermissions, colliding] },
      ),
    ).toThrow(DuplicatePermissionError);
  });

  it("allows non-colliding fragments through the same guard", () => {
    expect(() =>
      definePermissions(
        "tenant",
        { ...tenancyPermissions, ...commercePermissions },
        { contributedBy: [tenancyPermissions, commercePermissions] },
      ),
    ).not.toThrow();
  });
});

describe("requirePermission", () => {
  const set = createPermissionSet(["members.view"]);

  it("passes when granted", () => {
    expect(() => requirePermission(set, "members.view", "tenant")).not.toThrow();
  });

  it("throws a typed error when denied", () => {
    expect(() => requirePermission(set, "members.remove", "tenant")).toThrow(
      PermissionDeniedError,
    );
  });

  it("carries the permission and scope for the transport layer to map", () => {
    try {
      requirePermission(set, "members.remove", "tenant");
      expect.unreachable();
    } catch (err) {
      const e = err as PermissionDeniedError;
      expect(e.permission).toBe("members.remove");
      expect(e.scope).toBe("tenant");
    }
  });
});

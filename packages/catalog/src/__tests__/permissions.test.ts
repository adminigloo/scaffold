import { describe, expect, it } from "vitest";
import { definePermissions } from "@adminigloo/permissions";
import type { PermissionMap } from "@adminigloo/permissions";
import { catalogPermissions } from "../permissions.js";

const keys = Object.keys(catalogPermissions);

/**
 * Read back through the interface every consumer sees. The `as const` literal
 * type knows which keys carry `sealed`; a catalog assembled at runtime does
 * not, and that is the shape these guarantees have to hold in.
 */
const definitions: PermissionMap = catalogPermissions;

describe("the catalog permission namespace", () => {
  it("declares exactly the keys the package promises", () => {
    expect(keys.sort()).toEqual([
      "catalog.prices.edit",
      "catalog.products.archive",
      "catalog.products.create",
      "catalog.products.edit",
      "catalog.products.publish",
      "catalog.products.view",
    ]);
  });

  it("claims nothing under billing.*, which @adminigloo/stripe owns", () => {
    // `definePermissions` only rejects byte-identical keys, so a
    // `billing.prices.edit` declared here would coexist with stripe's own keys
    // and whichever one a route happened to check would decide the answer.
    for (const key of keys) {
      expect(key.startsWith("billing.")).toBe(false);
    }
  });

  it("claims nothing under the namespaces commerce and tenancy own", () => {
    for (const key of keys) {
      expect(key.startsWith("orders.")).toBe(false);
      expect(key.startsWith("discounts.")).toBe(false);
      expect(key.startsWith("members.")).toBe(false);
      expect(key.startsWith("tenant.")).toBe(false);
    }
  });

  it("puts everything in one category, so the checklist has one section", () => {
    for (const key of keys) {
      expect(definitions[key]?.category).toBe("Catalog");
    }
  });
});

describe("publishing is sealed", () => {
  it("cannot be reopened by a per-user override", () => {
    // Publishing is the moment a row stops being a form somebody is filling in
    // and becomes something a card is charged for. The failure mode is not
    // malice: it is granting it "just for this launch" and nobody taking it
    // away.
    const catalog = definePermissions("tenant", catalogPermissions);
    expect(catalog.isSealed("catalog.products.publish")).toBe(true);
  });

  it("is the only sealed key here", () => {
    // Editing a price on a draft changes nothing anyone can buy, and sealing it
    // would mean a draft cannot be built without an owner in the room.
    const sealed = keys.filter((key) => definitions[key]?.sealed === true);
    expect(sealed).toEqual(["catalog.products.publish"]);
  });
});

describe("defaults", () => {
  it("gives a viewer read access but nothing else", () => {
    // A catalog holds no customer data — unlike commerce's `orders.view`, which
    // carries a postal address and a phone number.
    const catalog = definePermissions("tenant", catalogPermissions);
    expect(catalog.defaultsFor("viewer")).toEqual(["catalog.products.view"]);
  });

  it("does not hand a plain member the publish or price keys", () => {
    const catalog = definePermissions("tenant", catalogPermissions);
    const member = catalog.defaultsFor("member");
    expect(member).not.toContain("catalog.products.publish");
    expect(member).not.toContain("catalog.prices.edit");
    expect(member).not.toContain("catalog.products.archive");
  });

  it("composes into a catalog without colliding with itself", () => {
    const catalog = definePermissions("tenant", catalogPermissions, {
      contributedBy: [catalogPermissions],
    });
    expect(catalog.keys).toHaveLength(keys.length);
  });
});

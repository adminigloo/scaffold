import { describe, expect, it } from "vitest";
import { storefrontUrlFor } from "@/components/admin/storefrontUrl";

/**
 * The assertion that matters is the negative one. Linking an active product is
 * obvious and hard to get wrong; linking a draft is the bug — it hands an admin
 * a 404 for a product they can see in front of them, which is indistinguishable
 * from having lost it.
 */
describe("storefrontUrlFor", () => {
  it("links an active product to its public page", () => {
    expect(storefrontUrlFor({ slug: "field-notes", status: "active" })).toBe(
      "/products/field-notes",
    );
  });

  it("gives a draft no link at all", () => {
    expect(storefrontUrlFor({ slug: "field-notes", status: "draft" })).toBeNull();
  });

  it("gives an archived product no link either", () => {
    // Archived rows stay readable on old receipts and stay out of the shop.
    // They are the case that looks safest to link and is not: the slug is real,
    // the row is real, and the storefront still refuses to serve it.
    expect(storefrontUrlFor({ slug: "field-notes", status: "archived" })).toBeNull();
  });

  it("goes through productHref rather than building the path itself", () => {
    // Same encoding as the storefront route, which is the whole point of having
    // one definition: a slug that needs escaping must escape identically on
    // both sides or the admin link and the real page disagree.
    expect(storefrontUrlFor({ slug: "a b", status: "active" })).toBe("/products/a%20b");
  });
});

import { describe, expect, it } from "vitest";
import { productHref } from "@/storefront";

/**
 * Tiny, but it is the single definition of a route two overlays depend on, and
 * the interesting cases are the ones where a slug is not a bare word.
 */
describe("productHref", () => {
  it("names the storefront route the [slug] page actually serves", () => {
    expect(productHref("field-notes")).toBe("/products/field-notes");
  });

  it("keeps a slug inside one path segment", () => {
    // A slug with a slash in it would otherwise address /products/a/b, which is
    // not a route — the product reads as deleted rather than badly named.
    expect(productHref("a/b")).toBe("/products/a%2Fb");
    expect(productHref("field notes")).toBe("/products/field%20notes");
  });

  it("does not let a query or fragment escape the slug", () => {
    // `?` and `#` end the path in a URL. Unencoded, a slug containing either
    // links to the storefront index with junk attached, which renders a page
    // that is not the product and does not look broken.
    expect(productHref("a?b#c")).toBe("/products/a%3Fb%23c");
  });
});

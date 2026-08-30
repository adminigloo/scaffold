import { describe, expect, it } from "vitest";
import { canPublish, validateProduct } from "../validation.js";
import type {
  GrantDraft,
  ProblemCode,
  ProductDraft,
  VariantDraft,
} from "../validation.js";

function product(overrides: Partial<ProductDraft> = {}): ProductDraft {
  return {
    slug: "alpine-trail-deck",
    kind: "one_time",
    status: "active",
    name: "Alpine Trail Deck",
    ...overrides,
  };
}

function variant(overrides: Partial<VariantDraft> = {}): VariantDraft {
  return {
    name: "Standard",
    priceMinor: 1999n,
    currency: "usd",
    ...overrides,
  };
}

function codes(problems: readonly { readonly code: ProblemCode }[]): ProblemCode[] {
  return problems.map((problem) => problem.code);
}

describe("a valid product", () => {
  it("reports nothing and may be published", () => {
    const problems = validateProduct({
      product: product(),
      variants: [variant({ isDefault: true })],
    });
    expect(problems).toEqual([]);
    expect(canPublish(problems)).toBe(true);
  });
});

describe("an active product needs at least one variant", () => {
  it("flags an active product with none", () => {
    const problems = validateProduct({ product: product(), variants: [] });
    expect(codes(problems)).toContain("active-product-needs-variant");
    expect(problems[0]?.path).toBe("variants");
  });

  it("leaves a draft alone", () => {
    // A draft with no variants is the normal state of a product somebody is
    // halfway through creating. Flagging it turns the builder into a wall of
    // red before the admin has typed anything.
    const problems = validateProduct({
      product: product({ status: "draft" }),
      variants: [],
    });
    expect(problems).toEqual([]);
  });

  it("leaves an archived product alone", () => {
    // Archived is not deleted, and a retired product is not being republished.
    const problems = validateProduct({
      product: product({ status: "archived" }),
      variants: [],
    });
    expect(problems).toEqual([]);
  });
});

describe("exactly zero or one default variant", () => {
  it("accepts none", () => {
    expect(
      validateProduct({ product: product(), variants: [variant(), variant()] }),
    ).toEqual([]);
  });

  it("accepts exactly one", () => {
    expect(
      validateProduct({
        product: product(),
        variants: [variant({ isDefault: true }), variant()],
      }),
    ).toEqual([]);
  });

  it("flags the second default, not the first", () => {
    // With two defaults, which one the product page preselects depends on row
    // order, so the price on screen changes between page loads. Reporting the
    // later one points the admin at the switch to turn off.
    const problems = validateProduct({
      product: product(),
      variants: [
        variant({ name: "Standard", isDefault: true }),
        variant({ name: "Deluxe", isDefault: true }),
      ],
    });
    expect(codes(problems)).toEqual(["multiple-default-variants"]);
    expect(problems[0]?.path).toBe("variants[1].isDefault");
    expect(problems[0]?.message).toContain("Deluxe");
  });

  it("flags every default after the first, so three defaults give two problems", () => {
    const problems = validateProduct({
      product: product(),
      variants: [
        variant({ isDefault: true }),
        variant({ isDefault: true }),
        variant({ isDefault: true }),
      ],
    });
    expect(codes(problems)).toEqual([
      "multiple-default-variants",
      "multiple-default-variants",
    ]);
  });
});

describe("interval must agree with the product's kind", () => {
  // This is the rule a Postgres CHECK cannot express: `kind` is on `products`
  // and `interval` is on `product_variants`, and a check constraint may only
  // read columns of its own row.

  it("a subscription variant with no interval is flagged", () => {
    const problems = validateProduct({
      product: product({ kind: "subscription" }),
      variants: [variant({ interval: "month" }), variant({ name: "Team" })],
    });
    expect(codes(problems)).toEqual(["subscription-variant-missing-interval"]);
    expect(problems[0]?.path).toBe("variants[1].interval");
  });

  it("treats an explicit null the same as an absent interval", () => {
    const problems = validateProduct({
      product: product({ kind: "subscription" }),
      variants: [variant({ interval: null })],
    });
    expect(codes(problems)).toEqual(["subscription-variant-missing-interval"]);
  });

  it("a one-time variant with an interval is flagged", () => {
    // The expensive direction: a recurring price on a one-off purchase charges
    // the customer again next month for something they bought once.
    const problems = validateProduct({
      product: product({ kind: "one_time" }),
      variants: [variant({ interval: "year" })],
    });
    expect(codes(problems)).toEqual(["one-time-variant-has-interval"]);
    expect(problems[0]?.path).toBe("variants[0].interval");
  });

  it("accepts a fully recurring subscription product", () => {
    expect(
      validateProduct({
        product: product({ kind: "subscription" }),
        variants: [
          variant({ interval: "month" }),
          variant({ interval: "year", priceMinor: 19999n }),
        ],
      }),
    ).toEqual([]);
  });
});

describe("one currency per product", () => {
  it("flags a variant priced in a different currency", () => {
    const problems = validateProduct({
      product: product(),
      variants: [variant({ currency: "usd" }), variant({ currency: "eur" })],
    });
    expect(codes(problems)).toEqual(["mixed-currency"]);
    expect(problems[0]?.path).toBe("variants[1].currency");
  });

  it("does not treat a case difference as a different currency", () => {
    // A stored 'USD' beside a Stripe 'usd' is the same money. Flagging it would
    // block a save on a difference nobody can see.
    expect(
      validateProduct({
        product: product(),
        variants: [variant({ currency: "usd" }), variant({ currency: "USD " })],
      }),
    ).toEqual([]);
  });

  it("flags a currency code Intl and Stripe would both reject", () => {
    // `formatMinor` asks Intl for this currency's minor-unit exponent, and Intl
    // throws RangeError on anything that is not three letters. Caught here it
    // is a form error; missed, it is an uncaught exception on the product page.
    const problems = validateProduct({
      product: product(),
      variants: [variant({ currency: "dollars" })],
    });
    expect(codes(problems)).toEqual(["currency-invalid"]);
  });

  it("reports an invalid code once, not also as a mismatch", () => {
    const problems = validateProduct({
      product: product(),
      variants: [variant({ currency: "usd" }), variant({ currency: "$" })],
    });
    expect(codes(problems)).toEqual(["currency-invalid"]);
  });
});

describe("price", () => {
  it("allows a free variant", () => {
    // A free tier and an included accessory are both real variants.
    expect(
      validateProduct({ product: product(), variants: [variant({ priceMinor: 0n })] }),
    ).toEqual([]);
  });

  it("refuses a negative price", () => {
    // A negative price is a discount smuggled in as a product. Stripe rejects a
    // negative unit_amount outright, and the order total stops equalling the
    // sum of its lines.
    const problems = validateProduct({
      product: product(),
      variants: [variant({ priceMinor: -1n })],
    });
    expect(codes(problems)).toEqual(["negative-price"]);
    expect(problems[0]?.path).toBe("variants[0].priceMinor");
  });
});

describe("inventory", () => {
  it("treats absent and null as untracked, not as zero", () => {
    // NULL means untracked, 0 means genuinely out of stock. If these collapsed,
    // every digital product in the catalog would read as sold out.
    expect(
      validateProduct({
        product: product(),
        variants: [variant(), variant({ inventory: null })],
      }),
    ).toEqual([]);
  });

  it("allows zero, which is a real answer", () => {
    expect(
      validateProduct({ product: product(), variants: [variant({ inventory: 0 })] }),
    ).toEqual([]);
  });

  it("refuses negative stock", () => {
    const problems = validateProduct({
      product: product(),
      variants: [variant({ inventory: -1 })],
    });
    expect(codes(problems)).toEqual(["negative-inventory"]);
    expect(problems[0]?.path).toBe("variants[0].inventory");
  });

  it("refuses a fractional count, and says so only once", () => {
    // The column is an integer, so Postgres rejects the write and the whole
    // save fails with a driver error that names no field. Reporting it twice —
    // fractional AND negative — would put two errors on one input.
    const problems = validateProduct({
      product: product(),
      variants: [variant({ inventory: -1.5 })],
    });
    expect(codes(problems)).toEqual(["inventory-not-integer"]);
  });
});

describe("slug", () => {
  it("accepts a plain hyphenated slug", () => {
    expect(
      validateProduct({
        product: product({ slug: "alpine-trail-deck-2" }),
        variants: [variant()],
      }),
    ).toEqual([]);
  });

  it.each([
    ["Alpine-Deck", "uppercase"],
    ["alpine deck", "a space"],
    ["alpine_deck", "an underscore"],
    ["-alpine", "a leading hyphen"],
    ["alpine-", "a trailing hyphen"],
    ["alpine--deck", "a doubled hyphen"],
    ["", "empty"],
    ["alpine/deck", "a slash"],
    ["café", "a non-ascii letter"],
  ])("rejects %s (%s)", (slug) => {
    const problems = validateProduct({
      product: product({ slug }),
      variants: [variant()],
    });
    expect(codes(problems)).toEqual(["slug-invalid"]);
    expect(problems[0]?.path).toBe("product.slug");
  });

  it("rejects a slug longer than the limit", () => {
    const problems = validateProduct({
      product: product({ slug: "a".repeat(97) }),
      variants: [variant()],
    });
    expect(codes(problems)).toEqual(["slug-invalid"]);
  });

  it.each(["new", "checkout", "cart", "admin", "api", "products"])(
    "rejects the reserved slug %s",
    (slug) => {
      // A storefront routes /products/[slug], and the literal segment wins. A
      // product slugged "new" is unreachable; one slugged "checkout" shadows a
      // page the customer needs mid-purchase.
      const problems = validateProduct({
        product: product({ slug }),
        variants: [variant()],
      });
      expect(codes(problems)).toEqual(["slug-reserved"]);
    },
  );

  it("reports an unusable slug once, not as invalid AND reserved", () => {
    const problems = validateProduct({
      product: product({ slug: "New" }),
      variants: [variant()],
    });
    expect(codes(problems)).toEqual(["slug-invalid"]);
  });
});

describe("grants", () => {
  function grant(overrides: Partial<GrantDraft> = {}): GrantDraft {
    return { kind: "none", ...overrides };
  }

  it("accepts a well-formed entitlement grant", () => {
    expect(
      validateProduct({
        product: product(),
        variants: [variant()],
        grants: [grant({ kind: "entitlement", config: { feature: "seats", limit: 5 } })],
      }),
    ).toEqual([]);
  });

  it("flags an entitlement grant with no feature name", () => {
    // The one required field in the whole set, and the reason the check exists:
    // an entitlement with no feature writes a row keyed on nothing, grants the
    // customer nothing, and looks like a successful purchase from every angle
    // except theirs.
    const problems = validateProduct({
      product: product(),
      variants: [variant()],
      grants: [grant({ kind: "entitlement", config: { limit: 5 } })],
    });
    expect(codes(problems)).toEqual(["grant-config-invalid"]);
    expect(problems[0]?.path).toBe("grants[0].config.feature");
  });

  it("accepts a null entitlement limit, which means unlimited", () => {
    // NULL is unlimited, matching `entitlements.limit_value` in billing. Not
    // zero, which is a feature explicitly withheld.
    expect(
      validateProduct({
        product: product(),
        variants: [variant()],
        grants: [
          grant({ kind: "entitlement", config: { feature: "seats", limit: null } }),
        ],
      }),
    ).toEqual([]);
  });

  it("flags a negative entitlement limit", () => {
    const problems = validateProduct({
      product: product(),
      variants: [variant()],
      grants: [
        grant({ kind: "entitlement", config: { feature: "seats", limit: -1 } }),
      ],
    });
    expect(codes(problems)).toEqual(["grant-config-invalid"]);
  });

  it("accepts a `none` grant with no config at all", () => {
    // `none` is a real answer, not a placeholder: a donation grants nothing.
    expect(
      validateProduct({
        product: product(),
        variants: [variant()],
        grants: [grant({ kind: "none" })],
      }),
    ).toEqual([]);
  });

  it("flags a grant pointing at a variant that is not on this product", () => {
    // The purchase still succeeds, the customer is still charged, and they
    // receive nothing — which is the failure mode with no error message
    // anywhere.
    const problems = validateProduct({
      product: product(),
      variants: [variant({ id: "var_1" })],
      grants: [grant({ kind: "ship", variantId: "var_missing" })],
    });
    expect(codes(problems)).toEqual(["grant-unknown-variant"]);
    expect(problems[0]?.path).toBe("grants[0].variantId");
  });

  it("does not flag grants in a create form, where no variant has an id yet", () => {
    expect(
      validateProduct({
        product: product(),
        variants: [variant()],
        grants: [grant({ kind: "ship", variantId: "var_pending" })],
      }),
    ).toEqual([]);
  });
});

describe("problems accumulate rather than short-circuiting", () => {
  it("reports every issue at once", () => {
    // The whole reason this returns a list. One problem per save trains people
    // to fix-and-retry, and the fifth retry is where the product is abandoned
    // half-configured.
    const problems = validateProduct({
      product: product({ slug: "Bad Slug", kind: "subscription" }),
      variants: [
        variant({ isDefault: true, priceMinor: -5n }),
        variant({ isDefault: true, currency: "eur", inventory: -3 }),
      ],
    });

    expect(codes(problems)).toEqual([
      "slug-invalid",
      "subscription-variant-missing-interval",
      "negative-price",
      "multiple-default-variants",
      "subscription-variant-missing-interval",
      "mixed-currency",
      "negative-inventory",
    ]);
    expect(canPublish(problems)).toBe(false);
  });
});

describe("canPublish", () => {
  it("is true only for an empty list", () => {
    expect(canPublish([])).toBe(true);
  });

  it("is false for any problem, because there is no severity axis", () => {
    // The first "warning" anybody adds is always the one that ships a broken
    // price, so every rule blocks.
    expect(
      canPublish([{ code: "slug-reserved", message: "…", path: "product.slug" }]),
    ).toBe(false);
  });
});

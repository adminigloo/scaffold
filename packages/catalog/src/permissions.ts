import type { PermissionMap } from "@adminigloo/permissions";

/**
 * This package's contribution to the tenant catalog. The app spreads it into
 * its own `definePermissions("tenant", { ... })` call.
 *
 * EVERY KEY IS UNDER `catalog.*`, and none is under `billing.*`.
 * @adminigloo/stripe owns that namespace outright. `definePermissions` only
 * rejects byte-identical keys, so a `billing.prices.edit` declared here would
 * coexist happily with stripe's own keys and whichever one a given route
 * happened to check would decide the answer — the exact bug @adminigloo/tenancy
 * caused with `billing.manage`, where five keys meant one capability and a
 * seeded owner was told they could not do something they had been granted.
 *
 * `orders.*` and `discounts.*` belong to @adminigloo/commerce for the same
 * reason, which is why "can this person change a price" is `catalog.prices.edit`
 * and not a reuse of anything over there.
 */
export const catalogPermissions = {
  "catalog.products.view": {
    label: "View products",
    description: "See products, their variants, prices and what they grant.",
    category: "Catalog",
    // Viewers included, unlike commerce's `orders.view`. A catalog holds no
    // customer data — it is the shop window, and the prices in it are on the
    // public storefront anyway.
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "catalog.products.create": {
    label: "Create products",
    description: "Add a new product. It starts as a draft and sells nothing.",
    category: "Catalog",
    defaultFor: ["owner", "admin", "member"],
  },
  "catalog.products.edit": {
    label: "Edit products",
    description:
      "Change a product's name, description, images, variants and grants.",
    category: "Catalog",
    // Separate from `catalog.prices.edit` on purpose. Fixing a typo in a
    // product description and changing what a customer is charged are different
    // acts, and the person who does the copy is usually not the person who
    // signs off on the money.
    defaultFor: ["owner", "admin", "member"],
  },
  "catalog.products.archive": {
    label: "Archive products",
    description:
      "Retire a product so it can no longer be bought. Orders that already " +
      "reference it keep rendering; nothing is deleted.",
    category: "Catalog",
    defaultFor: ["owner", "admin"],
  },
  "catalog.products.publish": {
    label: "Publish products",
    description:
      "Make a draft product active, so it appears on the storefront and can " +
      "be charged for.",
    category: "Catalog",
    /**
     * SEALED. Publishing is the moment a row stops being a form somebody is
     * filling in and starts being something a customer's card is charged for,
     * and `sealed` is what stops a template's `deny` being reopened by a
     * per-user override.
     *
     * The failure mode is not malice. It is granting it to one person "just for
     * this launch" during a busy week and nobody ever taking it away — the same
     * reasoning behind stripe's `billing.refund.issue` and commerce's
     * `orders.refund`. A price with a decimal point in the wrong place is
     * cheaper to prevent than to refund.
     */
    sealed: true,
    defaultFor: ["owner", "admin"],
  },
  "catalog.prices.edit": {
    label: "Edit prices",
    description:
      "Change what a variant costs, in what currency, and how often it bills.",
    category: "Catalog",
    /**
     * Not sealed, unlike publishing. Editing a price on a DRAFT product changes
     * nothing anyone can buy, and blocking it outright would mean a draft
     * cannot be built without an owner present. What it does do is reach
     * Stripe: `planStripeSync` archives the old price and creates a new one,
     * because a Stripe price is immutable — so this is a narrower grant than
     * `catalog.products.edit` and deliberately not folded into it.
     */
    defaultFor: ["owner", "admin"],
  },
} as const satisfies PermissionMap;

export type CatalogPermission = keyof typeof catalogPermissions;

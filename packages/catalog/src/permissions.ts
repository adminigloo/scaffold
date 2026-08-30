import type { PermissionMap } from "@adminigloo/permissions";

/**
 * This package's contribution to the STAFF catalog. The app spreads it into its
 * own `definePermissions("staff", { ... })` call.
 *
 * STAFF, NOT TENANT, and the distinction is the whole point. Defining what is
 * for sale is an operator activity: you author the products, your customers buy
 * them. The admin router gates every one of these with `requireStaff(...)`, and
 * `AdminNav` filters against the staff permission set — so declared under
 * "tenant" these keys can never match anything, and the Products section is
 * invisible to everybody, forever, with no error to find. They were tenant
 * keys until the nav was wired and the conformance test caught it.
 *
 * A tenant-facing storefront needs no permission at all: an active product is
 * public, which is what "storefront" means.
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
    // Every staff role, including cs_agent. A catalog holds no customer data —
    // it is the shop window, and the prices are on the public storefront
    // anyway, so a support agent looking one up is reading nothing private.
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "catalog.products.create": {
    label: "Create products",
    description: "Add a new product. It starts as a draft and sells nothing.",
    category: "Catalog",
    defaultFor: ["admin", "cs_lead"],
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
    defaultFor: ["admin", "cs_lead"],
  },
  // Admin only. Archiving pulls something out of sale; a support lead
  // reclassifying a product mid-campaign is not a support-desk decision.
  "catalog.products.archive": {
    label: "Archive products",
    description:
      "Retire a product so it can no longer be bought. Orders that already " +
      "reference it keep rendering; nothing is deleted.",
    category: "Catalog",
    defaultFor: ["admin"],
  },
  // Admin only, and sealed. Publishing makes something chargeable.
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
    defaultFor: ["admin"],
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
    defaultFor: ["admin", "cs_lead"],
  },
} as const satisfies PermissionMap;

export type CatalogPermission = keyof typeof catalogPermissions;

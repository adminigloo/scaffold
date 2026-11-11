import type { PermissionMap } from "@adminigloo/permissions";

/**
 * This package's contribution to the tenant catalog. The app spreads it into
 * its own `definePermissions("tenant", { ... })` call.
 *
 * NOTHING HERE IS UNDER `billing.*`. @adminigloo/stripe owns that namespace
 * outright, and `definePermissions` only rejects byte-identical keys — a
 * `billing.orders.refund` declared here would coexist happily with stripe's
 * `billing.refund.issue`, and whichever key a given route happened to check
 * would decide the answer. That is the exact bug @adminigloo/tenancy's
 * `billing.manage` caused: five keys for one capability, and a seeded owner
 * told they could do something the route then refused.
 *
 * `members.*` and `tenant.*` belong to @adminigloo/tenancy for the same reason.
 */
export const commercePermissions = {
  "orders.view": {
    label: "View orders",
    description: "See orders, their line items, totals and shipments.",
    category: "Commerce",
    // Not viewers. An order carries the customer's name, postal address and
    // phone number, which is the most sensitive data most storefronts hold; a
    // read-only seat granted to show someone a dashboard should not come with
    // the customer list attached.
    defaultFor: ["owner", "admin", "member"],
  },
  "orders.manage": {
    label: "Manage orders",
    description:
      "Change order status, record shipments and tracking, cancel an unpaid order.",
    category: "Commerce",
    defaultFor: ["owner", "admin"],
  },
  "orders.refund": {
    label: "Refund an order",
    description: "Send money back to a customer. Irreversible once it clears.",
    category: "Commerce",
    /**
     * SEALED, so a template's `deny` cannot be reopened by a per-user override.
     * Same reasoning as stripe's `billing.refund.issue`: the failure mode is
     * granting it to one person "just for today" during an incident and nobody
     * ever taking it away.
     *
     * A SEPARATE KEY from `billing.refund.issue` rather than a reuse of it,
     * because they are different money paths held by different people. This one
     * refunds a one-time purchase and is the storefront ops job; that one
     * refunds a subscription invoice and is finance's. Collapsing them means
     * the person who handles "my parcel arrived broken" can also credit a
     * year's subscription.
     */
    sealed: true,
    // No defaultFor. Sealed keeps an override from granting it; withholding it
    // from every template keeps a fresh tenant from starting with it.
  },
  "discounts.view": {
    label: "View discount codes",
    description: "See promo codes, their windows and how often they were used.",
    category: "Commerce",
    defaultFor: ["owner", "admin", "member"],
  },
  "discounts.manage": {
    label: "Manage discount codes",
    description: "Create, edit and switch off promo codes.",
    category: "Commerce",
    // Not sealed, deliberately. A discount is capped by `max_redemptions` and
    // `min_subtotal_minor` and is visible in the order totals afterwards, so
    // the blast radius is bounded and auditable — unlike a refund, which moves
    // money out of the account with nothing left to cap it.
    defaultFor: ["owner", "admin"],
  },
} as const satisfies PermissionMap;

export type CommercePermission = keyof typeof commercePermissions;

/**
 * commerce 0.5: THIS SITE'S OWN SHOP's orders, on the STAFF ladder.
 *
 * `commercePermissions` above is the tenant catalog's: a company's own orders,
 * held by its owner, admins and members. The shop a project sells from itself
 * (create-app's `--model one-time` or `both`) is worked by the site's staff,
 * and the staff ladder has no owner, member or viewer to give `orders.view`
 * to, so those keys reached nobody there. This is the shop's key in the staff
 * catalog, under its own name so the two can never be mistaken for each other.
 *
 * View only. A refund is made in Stripe's dashboard and comes back to the order
 * by the webhook; nothing in the app moves money back.
 */
export const shopOrderPermissions = {
  "shop.orders.view": {
    label: "View the shop's orders",
    description:
      "See every order placed in this site's own shop: who bought what, the " +
      "totals, refunds and disputes, what each order granted, and its trail.",
    category: "Shop",
    // Every staff role: support looks an order up first when someone writes in
    // about a purchase. An order names an email and what was bought, no card.
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
} as const satisfies PermissionMap;

export type ShopOrderPermission = keyof typeof shopOrderPermissions;

/**
 * commerce 0.2: A STORE OF ITS OWN — the products a business sells to its own
 * customers and the orders they place. Two keys, in two ladders:
 *
 *   storePermissions         one business, on the staff ladder (/admin/store)
 *   storeCompanyPermissions  a company's own roles (/app/store), in a
 *                            project where many companies share the app
 *
 * Refunds are not a key here: a company refunds in its own Stripe dashboard,
 * and the refund comes back to the order by the webhook.
 */
export const storePermissions = {
  "store.view": {
    label: "See the store",
    description: "The products for sale, their prices and stock, and the orders customers placed.",
    category: "Store",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "store.manage": {
    label: "Run the store",
    description: "Add and change products, prices, photos and stock, mark orders as sent, and clear what needs attention.",
    category: "Store",
    defaultFor: ["admin"],
  },
} as const satisfies PermissionMap;

export type StorePermission = keyof typeof storePermissions;

export const storeCompanyPermissions = {
  "store.view": {
    ...storePermissions["store.view"],
    description: "The company's products, their prices and stock, and the orders its customers placed.",
    defaultFor: ["owner", "admin", "member"],
  },
  "store.manage": {
    ...storePermissions["store.manage"],
    defaultFor: ["owner", "admin"],
  },
} as const satisfies PermissionMap;

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

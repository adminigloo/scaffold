import type { PermissionMap } from "@adminigloo/permissions";

/**
 * This package's contribution to the tenant catalog. The app spreads it into
 * its own `definePermissions("tenant", { ... })` call.
 *
 * NOTHING HERE IS NAMESPACED `billing.*`. @adminigloo/stripe owns that
 * namespace end to end, and `definePermissions` only rejects byte-identical
 * keys — a `billing.manage` declared here would coexist quite happily with
 * stripe's `billing.portal.open`, and whichever key a given route happened to
 * check would decide the answer. That has already happened in this repo, between
 * tenancy and stripe, and the visible symptom was a seeded owner being told they
 * could manage billing and then refused by the route.
 *
 * These keys are named after the tables this package owns instead: `plans` and
 * `subscriptions` are product objects that live here, and no other package can
 * plausibly claim them.
 */
export const billingPermissions = {
  "plans.view": {
    label: "View plans",
    description: "See the plan catalog and what each plan includes.",
    category: "Plans",
    // Everyone, viewers included. The upgrade prompt renders for whoever hit
    // the limit, and hiding the catalog from members turns "you have used all 5
    // seats" into a dead end with no next step on the screen.
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "plans.manage": {
    label: "Manage plans",
    description: "Create, edit, retire and reprice plans in the catalog.",
    category: "Plans",
    /**
     * Owner only. Editing the catalog sets what customers are charged and
     * rewrites the cached Stripe ids that checkout resolves against; an admin
     * who can reprice can set a plan to zero and move onto it.
     *
     * NOT sealed, unlike stripe's `billing.refund.issue`. Nothing here moves
     * money out of the account, and a bad price is visible on the next invoice
     * and reversible — sealing it would only stop a client delegating catalog
     * work to whoever actually runs their pricing.
     */
    defaultFor: ["owner"],
  },
  "subscriptions.view": {
    label: "View subscriptions",
    description: "See which plan this organisation is on and when it renews.",
    category: "Plans",
    // Not members or viewers: the plan and renewal date are what the
    // organisation pays, which is the same disclosure as an invoice.
    defaultFor: ["owner", "admin"],
  },
  "subscriptions.manage": {
    label: "Manage subscriptions",
    description: "Change plan, schedule a cancellation, or resume one.",
    category: "Plans",
    // Separate from `subscriptions.view` because this is the key that changes
    // the amount charged. Read access to the current plan is routine; a
    // downgrade that silently drops the tenant's entitlements is not.
    defaultFor: ["owner"],
  },
} as const satisfies PermissionMap;

export type BillingPermission = keyof typeof billingPermissions;

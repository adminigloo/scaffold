import type { PermissionMap } from "@adminigloo/permissions";

/**
 * This package's contribution to the tenant catalog. The app spreads it into
 * its own `definePermissions("tenant", { ... })` call.
 */
export const stripePermissions = {
  // defaultFor added when tenancy's overlapping billing.manage was removed:
  // without it a seeded owner held no billing key at all and the portal was
  // unreachable by anyone until someone hand-edited a template.
  "billing.portal.open": {
    label: "Open the billing portal",
    description:
      "Manage payment methods, cancel a subscription, download past invoices.",
    category: "Billing",
      defaultFor: ["owner"],
  },
  "billing.invoices.view": {
    label: "View invoices",
    description: "Read-only access to invoices and their line items.",
    category: "Billing",
      defaultFor: ["owner", "admin"],
  },
  "billing.refund.issue": {
    label: "Issue a refund",
    description:
      "Send money back to a customer. Irreversible once the refund clears.",
    category: "Billing",
    // Sealed, so a template's `deny` cannot be reopened by a per-user override.
    // Refunds move real money out of the account, and the failure mode is
    // someone granting it to one person "just for today" during an incident and
    // nobody ever taking it away. If a role should be able to refund, the role
    // says so; it is never handed out one person at a time.
    sealed: true,
  },
} as const satisfies PermissionMap;

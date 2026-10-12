/**
 * This package's permission keys, for the app to spread into its own
 * `definePermissions("tenant", { ... })` call beside the other packages'
 * fragments.
 *
 * TENANT, because the business that prices and quotes the work is the
 * customer of the product: each business (tenant) runs its own price book and
 * its own leads, and its owner decides which of its staff may send quotes or
 * see what the work costs. The defaults name the tenant role templates —
 * owner, admin, member, viewer.
 *
 * Five keys because there are five different jobs. Seeing leads and quotes is
 * everybody's in the office. Working an estimate and sending the quote is the
 * office's. SEEING COSTS is separate on purpose: a supply's price and the
 * margin on a job are the owner's business, and a member who quotes customers
 * should not need to see them — without `estimator.costs.view` every admin
 * response is stripped of costs and margins (prices only). Changing the price
 * book changes what every customer is quoted, and the business settings (tax,
 * lead alerts, the AI budget, embed keys) shape the whole estimator, so those
 * are the owner's or an admin's.
 *
 * Every key is under `estimator.*` and nothing else: two packages declaring
 * one key means whichever spread runs last silently wins.
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`, so
 * this package does not depend on the permissions package to describe five
 * strings; the shape is identical and `definePermissions` accepts it as is.
 */

export interface EstimatorPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const estimatorPermissions = {
  "estimator.view": {
    label: "View estimates and the price book",
    description: "See leads, estimates and quotes, the products and their customer prices, and the settings.",
    category: "Estimates",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "estimator.estimates.manage": {
    label: "Work estimates and send quotes",
    description:
      "Edit estimates, send, resend and revise quotes, mark a quote accepted or declined, archive, and turn an accepted quote into an invoice.",
    category: "Estimates",
    defaultFor: ["owner", "admin", "member"],
  },
  "estimator.costs.view": {
    label: "See costs and margins",
    description:
      "See supply costs, labor rates, the cost breakdown and the margin on every estimate. Without it, staff see prices only.",
    category: "Estimates",
    defaultFor: ["owner", "admin"],
  },
  "estimator.pricebook.manage": {
    label: "Manage the price book",
    description:
      "Add and change products, supplies, labor, markup and options, and load the sample catalog. This changes what customers are quoted.",
    category: "Estimates",
    defaultFor: ["owner", "admin"],
  },
  "estimator.settings.manage": {
    label: "Manage estimate settings",
    description:
      "Business details, tax, quote rules, lead alerts, photo reading and its budget, and website embed keys.",
    category: "Estimates",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, EstimatorPermissionDefinition>;

export type EstimatorPermission = keyof typeof estimatorPermissions;

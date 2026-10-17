/**
 * This package's permission keys (0.3), for the app to spread into its own
 * `definePermissions("tenant", { ... })` beside the other packages' fragments.
 *
 * TENANT keys, because each company has its own websites and its own
 * numbers. Two jobs:
 *
 *   analytics.view     see the company's website visits: where they came
 *                      from (search, AI assistants, other sites), the pages
 *                      read, the AI crawlers, and its websites' list.
 *   analytics.manage   add, rename and remove the company's websites (and so
 *                      see the snippet that counts them), and say "these are
 *                      my visits" on a device.
 *
 * `analytics.view` stays open while a company's plan is closed (it ends in
 * ".view", billing 0.3's rule): a company can always see its own numbers.
 *
 * A single-business site maps the same keys onto its STAFF catalog; the keys
 * are the contract, the defaults a starting point. Typed structurally so the
 * package installs without @adminigloo/permissions.
 */

export interface AnalyticsPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const analyticsPermissions = {
  "analytics.view": {
    label: "See website visits",
    description: "See how many people visit the company's websites, where they came from, which pages they read and which AI crawlers read them.",
    category: "Website",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "analytics.manage": {
    label: "Manage websites",
    description: "Add, rename and remove the company's websites, copy the snippet that counts their visits, and leave your own visits out of the numbers.",
    category: "Website",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, AnalyticsPermissionDefinition>;

export type AnalyticsPermission = keyof typeof analyticsPermissions;

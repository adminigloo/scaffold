/**
 * This package's permission keys (0.2), for the app to spread into its own
 * `definePermissions("tenant", { ... })` beside the other packages' fragments.
 *
 *   seo_reports.view   see the company's search checks: every report, its
 *                      worklist and its evidence.
 *   seo_reports.run    press "Check now" (each press uses one of the month's
 *                      checks).
 *
 * `seo_reports.view` stays open while a company's plan is closed (it ends in
 * ".view", billing 0.3's rule): a company can always read its old reports.
 * A single-business site maps the same keys onto its STAFF catalog. Typed
 * structurally so the package installs without @adminigloo/permissions.
 */

export interface SeoReportsPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const seoReportsPermissions = {
  "seo_reports.view": {
    label: "See search checks",
    description: "See how search engines and AI assistants read the company's website and pages, and the list of things to fix.",
    category: "Website",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "seo_reports.run": {
    label: "Run search checks",
    description: "Check the company's website and pages now. Each check uses one of the month's checks.",
    category: "Website",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, SeoReportsPermissionDefinition>;

export type SeoReportsPermission = keyof typeof seoReportsPermissions;

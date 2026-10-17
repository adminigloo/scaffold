/**
 * This package's permission keys (0.2), for the app to spread into its own
 * `definePermissions("tenant", { ... })` beside the other packages' fragments.
 *
 *   aeo.view     see the company's questions, what AI assistants answered
 *                (the quote, the sources, the competitors named) and the trend.
 *   aeo.manage   change the questions and who the business is, and press
 *                "Check now" (each answer uses the month's AI).
 *
 * `aeo.view` stays open while a company's plan is closed (".view", billing
 * 0.3's rule). A single-business site maps the same keys onto its STAFF
 * catalog. Typed structurally so the package installs without
 * @adminigloo/permissions.
 */

export interface AeoPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const aeoPermissions = {
  "aeo.view": {
    label: "See AI mentions",
    description: "See whether AI assistants name the company when customers ask them questions, what they said and which sources they used.",
    category: "Website",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "aeo.manage": {
    label: "Manage AI mentions",
    description: "Choose the questions to track and how the business is named, and check them now. Each check uses part of the month's AI.",
    category: "Website",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, AeoPermissionDefinition>;

export type AeoPermission = keyof typeof aeoPermissions;

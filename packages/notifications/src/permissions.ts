/**
 * This package's permission keys (Tenancy 2b-1, 4.6; D1), for the app to
 * spread into its own `definePermissions("tenant", { ... })` call beside the
 * other packages' fragments.
 *
 * The keys are the WORDS, not the package (2a's convention: `schedule.*` for
 * scheduling, `invoices.*` for invoicing): a business owner reads "alerts".
 * TENANT, because each company hears about its own work. Two keys because
 * there are two jobs: getting your own alerts (everyone, crew included) and
 * choosing who in the company hears about new work (the owner's or an
 * admin's).
 *
 * A single-business site spreads the same keys into its STAFF catalog
 * through its own map (`staff.alerts.view`, `staff.alerts.manage`).
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`
 * (D14: no permissions import); `definePermissions` accepts the shape as is.
 */

export interface NotificationsPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const notificationsPermissions = {
  "alerts.view": {
    label: "Get alerts",
    description: "See your own alerts in the bell, and choose which ones also come by email.",
    category: "Alerts",
    // Every role a project seeds, crew included: a crew member's bell holds
    // their own crew's visit changes (D4). A role a project never seeds grants
    // nothing (2a 6.1's comment).
    defaultFor: ["owner", "admin", "member", "viewer", "crew"],
  },
  "alerts.manage": {
    label: "Choose who hears about new work",
    description: "Pick who in the company gets alerts about new estimate requests, visit requests and invoices.",
    category: "Alerts",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, NotificationsPermissionDefinition>;

export type NotificationsPermission = keyof typeof notificationsPermissions;

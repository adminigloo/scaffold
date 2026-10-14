/**
 * This package's permission keys (Tenancy 2a, 9.4), for the app to spread
 * into its own `definePermissions("tenant", { ... })` call beside the other
 * packages' fragments.
 *
 * TENANT, because each company runs its own messages: its own wording, its
 * own delivery log. The defaults name the tenant role templates (owner,
 * admin, member, viewer). Two keys because there are two jobs: reading what
 * went out (anyone in the office answering "did they get the reminder?") and
 * changing what customers receive (the owner's or an admin's: a template
 * switched off by mistake is a week of reminders nobody gets).
 *
 * A single-business site spreads the same keys into its STAFF catalog
 * through its own map (`staff.comms.view`, `staff.comms.manage`); the keys
 * are the contract, the defaults a starting point.
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`, so
 * this package doesn't depend on the permissions package to describe two
 * strings; `definePermissions` accepts the shape as is.
 */

export interface CommsPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const commsPermissions = {
  "comms.view": {
    label: "See messages",
    description: "The emails and texts this company sends: their wording, and what went to whom and when.",
    category: "Messages",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "comms.manage": {
    label: "Edit messages",
    description: "Change the wording of the emails customers get, switch one off or on, and send what's due now.",
    category: "Messages",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, CommsPermissionDefinition>;

export type CommsPermission = keyof typeof commsPermissions;

/**
 * This package's permission key (0.2), for an app that runs
 * one audience per company (`createAudiences`) behind
 * `createAudienceAdminHandlers`.
 *
 *   audience.manage   see and change who is left out of the company's visit
 *                     counts: named people, email domains, office networks,
 *                     automation — and clean the history they polluted.
 *
 * Owners and admins by default: the rules name people by email, and each one
 * changes every number the company reads. Typed structurally so the package
 * installs without @adminigloo/permissions.
 */

export interface AudiencePermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const audiencePermissions = {
  "audience.manage": {
    label: "Leave people out of the visit counts",
    description: "Name the people, email addresses, networks and test tools whose visits don't count — your own team's included — and clean them out of past numbers.",
    category: "Website",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, AudiencePermissionDefinition>;

export type AudiencePermission = keyof typeof audiencePermissions;

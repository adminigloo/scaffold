/**
 * This package's permission keys (section 6.12), for the app to spread into
 * its own `definePermissions("tenant", { ... })` call beside the other
 * packages' fragments. The keys are the WORDS, not the package (D1):
 * `files.*`, as 2a named `schedule.*` for scheduling and `invoices.*` for
 * invoicing.
 *
 * TENANT, because each company keeps its own files. Two keys because there
 * are two jobs: seeing the company's own files and how much room is left
 * (anyone in the office), and adding to the company's files or deleting any
 * file (the owner's or an admin's: a deleted photo is deleted for good).
 *
 * A crew member holds neither: they reach their own visits' photos through
 * the visit's `assigned` rule (D12).
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`, so
 * this package doesn't depend on the permissions package to describe two
 * strings; `definePermissions` accepts the shape as is.
 */

export interface StoragePermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const storagePermissions = {
  "files.view": {
    label: "See files",
    description:
      "The company's own files and how much storage is used. Photos and files on visits, estimates and invoices also need permission to see those.",
    category: "Files",
    defaultFor: ["owner", "admin", "member", "viewer"],
    // Review G5: this opens the company's own files (the Files screen's
    // uploads). A file on a visit, an estimate or an invoice is that record's:
    // its own view permission decides, so removing "See invoices" from a role
    // hides invoice attachments too.
  },
  "files.manage": {
    label: "Manage files",
    description: "Add files to the company's files and delete any file, whatever it's attached to.",
    category: "Files",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, StoragePermissionDefinition>;

export type StoragePermission = keyof typeof storagePermissions;

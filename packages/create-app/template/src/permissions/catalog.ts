import { definePermissions, type PermissionKeyOf } from "__SCOPE__/permissions";
import { tenancyPermissions } from "__SCOPE__/tenancy";

/**
 * Permission keys for __PROJECT_NAME__.
 *
 * Packages contribute plain records; this file spreads them into one catalog
 * per scope. The `contributedBy` list is what catches two packages claiming the
 * same key — a spread would silently let the last one win, and the surviving
 * definition would be whichever import happened to come second.
 *
 * Adding a capability means adding a key here and granting it in a role
 * template. Nothing is implicit: a key in no template is denied for everyone.
 */

const appTenantPermissions = {
  // "reports.export": { label: "Export reports", category: "Reports" },
} as const;

export const tenantCatalog = definePermissions(
  "tenant",
  { ...tenancyPermissions, ...appTenantPermissions },
  { contributedBy: [tenancyPermissions, appTenantPermissions] },
);

const appStaffPermissions = {
  "staff.dashboard.view": {
    label: "View the admin dashboard",
    category: "Dashboard",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.tenants.view": {
    label: "View __TENANT_LABEL_PLURAL__",
    category: "__TENANT_LABEL_PLURAL__",
    defaultFor: ["admin", "cs_lead", "cs_agent"],
  },
  "staff.people.view": {
    label: "View people",
    category: "People",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.roles.view": {
    label: "View roles and permissions",
    category: "Access",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.roles.manage": {
    label: "Assign templates and set per-person overrides",
    description:
      "Grants and revokes individual capabilities on top of a role template.",
    category: "Access",
    defaultFor: ["admin"],
  },
  "staff.audit.view": {
    label: "View the audit log",
    category: "Access",
    defaultFor: ["admin", "cs_lead"],
  },
  "staff.tenants.impersonate": {
    label: "Open a customer's own screen",
    description: "Every entry is written to the audit log as sensitive access.",
    category: "__TENANT_LABEL_PLURAL__",
    // Sealed: an override must not be able to hand this to one person quietly.
    sealed: true,
  },
} as const;

export const staffCatalog = definePermissions("staff", appStaffPermissions);

export type TenantPermission = PermissionKeyOf<typeof tenantCatalog>;
export type StaffPermission = PermissionKeyOf<typeof staffCatalog>;

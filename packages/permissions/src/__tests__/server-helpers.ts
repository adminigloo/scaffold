import { definePermissions } from "../catalog.js";
import { STAFF_ROLE_TEMPLATES } from "../roles.js";
import { permissionsSchema } from "../schema.js";
import { createTestDb, type TestDb } from "./pglite.js";

/** Not a suite: shared fixtures for the ./server suites. */

export const TENANT_TEMPLATES = [
  { key: "owner", name: "Owner", rank: 40 },
  { key: "admin", name: "Admin", rank: 30 },
  { key: "member", name: "Member", rank: 20 },
  { key: "viewer", name: "Viewer", rank: 10 },
] as const;

export const tenantCatalog = definePermissions("tenant", {
  "members.view": { label: "View members", defaultFor: ["owner", "admin", "member", "viewer"] },
  "members.invite": { label: "Invite", defaultFor: ["owner", "admin"] },
  "members.remove": { label: "Remove", defaultFor: ["owner", "admin"] },
  "tenant.view": { label: "View", defaultFor: ["owner", "admin", "member", "viewer"] },
  "tenant.edit": { label: "Edit", defaultFor: ["owner", "admin"] },
  "tenant.transfer": { label: "Transfer", sealed: true, defaultFor: ["owner"] },
});

export const staffCatalog = definePermissions("staff", {
  "staff.tenants.view": { label: "See companies", defaultFor: ["admin", "cs_lead", "cs_agent"] },
  "staff.tenants.suspend": { label: "Suspend", defaultFor: ["admin"] },
  "staff.people.view": { label: "See people", defaultFor: ["admin", "cs_lead"] },
  "staff.roles.view": { label: "See roles", defaultFor: ["admin", "cs_lead"] },
  "staff.roles.manage": { label: "Manage roles", defaultFor: ["admin"] },
  "staff.tenants.impersonate": { label: "View as", sealed: true },
});

export async function freshDb(): Promise<TestDb> {
  return createTestDb(permissionsSchema);
}

export const SEED_BOTH = {
  staff: { catalog: staffCatalog, templates: STAFF_ROLE_TEMPLATES },
  tenant: { catalog: tenantCatalog, templates: TENANT_TEMPLATES },
};

/**
 * @adminigloo/permissions/server — the database half of the permission engine.
 *
 * The loaders, the catalog seed, the first-administrator bootstrap and role
 * assignment, moved here from the create-app template (PC-07) so a security
 * fix to any of them reaches every project by `npm update` instead of being
 * frozen into each generated copy.
 *
 * Server-only: it imports the tables from ./schema. The root entry stays the
 * pure resolver a browser can load.
 */
export type { PermissionsDb } from "./server/db.js";

export {
  createDrizzlePermissionLoaders,
  resolvePermissionsFor,
} from "./server/loaders.js";
export type {
  DrizzlePermissionLoaders,
  MembershipGate,
  MembershipVerdict,
} from "./server/loaders.js";

export { seedPermissionCatalog, SEED_LOCK_KEY } from "./server/seed.js";
export type { SeedPermissionCatalogInput, SeedReport, SeedScopeInput } from "./server/seed.js";

export { ensureBootstrapAdmin, BOOTSTRAP_ADMIN_LOCK_KEY } from "./server/bootstrap.js";
export type { BootstrapOutcome, EnsureBootstrapAdminInput } from "./server/bootstrap.js";

export {
  assignRoleTemplate,
  listRoleTemplates,
  roleOf,
  RoleAssignmentError,
} from "./server/assign.js";
export type {
  AssignRoleTemplateInput,
  RoleAssignment,
  RoleAssignmentErrorCode,
  RoleTemplateRow,
} from "./server/assign.js";

export { FIRM_WIDE } from "./constants.js";
export { STAFF_ROLE_TEMPLATES } from "./roles.js";
export type { BootstrapPolicy, RoleTemplateSpec, StaffRoleTemplateKey } from "./roles.js";

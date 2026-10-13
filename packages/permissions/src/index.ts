export {
  definePermissions,
  DuplicatePermissionError,
  UnknownPermissionError,
} from "./catalog.js";
export type {
  Catalog,
  Effect,
  PermissionDefinition,
  PermissionKeyOf,
  PermissionMap,
  Scope,
} from "./catalog.js";

export {
  resolvePermissionSet,
  resolveAgainstCatalog,
  explainPermission,
  createPermissionSet,
} from "./resolve.js";
export type {
  Decision,
  DenialReason,
  PermissionRule,
  PermissionSet,
  ResolveInput,
} from "./resolve.js";

export { PermissionDeniedError, requirePermission } from "./errors.js";

/**
 * From ./constants, NOT ./schema. Exporting it from the schema module made
 * this root import `drizzle-orm/pg-core` and `@adminigloo/db` (the Neon
 * driver) for one string, which every client component paid for.
 */
export { FIRM_WIDE } from "./constants.js";

export { STAFF_ROLE_TEMPLATES } from "./roles.js";
export type { BootstrapPolicy, RoleTemplateSpec, StaffRoleTemplateKey } from "./roles.js";

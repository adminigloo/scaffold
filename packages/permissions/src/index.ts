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

export { FIRM_WIDE } from "./schema.js";

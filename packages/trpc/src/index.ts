export type { ProcedureMeta, ProcedureScope } from "./scope.js";

export { createRequestCache } from "./cache.js";
export type { RequestCache } from "./cache.js";

export { createScaffoldContext } from "./context.js";
export type { ScaffoldContext, ScaffoldContextInput } from "./context.js";

export {
  isPermissionDenied,
  permissionDenied,
  permissionDeniedToTRPCError,
} from "./errors.js";
export type { PermissionDeniedLike } from "./errors.js";

export { createProcedures } from "./procedures.js";
export type {
  AuthenticatedOverrides,
  PermissionLoaders,
  Procedures,
  ProtectedProcedure,
  PublicProcedure,
  StaffOverrides,
  StaffProcedure,
  TenantInput,
  TenantOverrides,
  TenantProcedure,
  TRPCLike,
} from "./procedures.js";

export { auditProcedureScopes } from "./inventory.js";
export type { AuditResult, ProcedureEntry, ScopeViolation } from "./inventory.js";

export { scopeOfProcedure, auditBuiltProcedures } from "./inventory.js";
export type { BuiltProcedureLike, DerivedEntry } from "./inventory.js";
export { SCOPE_RANK, SCOPE_TAG, tagScope } from "./scope.js";

export {
  personalWorkspaceId,
  isPersonalWorkspaceId,
  personalWorkspaceSlug,
  EmptyUserIdError,
} from "./workspace.js";

export {
  generateInvitationToken,
  hashInvitationToken,
  verifyInvitationToken,
  invitationState,
  normaliseInviteEmail,
} from "./invitations.js";
export type { InvitationLifecycle, InvitationState, InvitationToken } from "./invitations.js";

export { tenancyPermissions } from "./permissions.js";
export type { TenancyPermission } from "./permissions.js";

export {
  TENANT_ROLE_TEMPLATES,
  templateRank,
  canManageTemplate,
  canManageTemplateKey,
} from "./templates.js";
export type { TenantRoleTemplate, TenantRoleTemplateKey } from "./templates.js";

/**
 * Tables are reachable ONLY from "@adminigloo/tenancy/schema", matching auth,
 * stripe and permissions.
 *
 * Re-exporting them here costs twice. The root entry becomes a static import of
 * drizzle-orm/pg-core, so a client component importing `canManageTemplateKey`
 * drags the whole query builder into the browser bundle — and with no
 * `sideEffects: false` anywhere in the repo, a bundler must assume the chunk
 * matters and cannot drop it. Worse, tsup does not code-split CJS: the same
 * `pgTable` call is emitted into BOTH dist/index.cjs and dist/schema.cjs, so a
 * CJS consumer holds two distinct objects for one physical table and reference
 * equality — which Drizzle relations and getTableConfig rely on — silently
 * fails.
 *
 * Types are safe to re-export: they erase at build time and pull in nothing.
 */
export type { TenantJson, TenantKind, TenantMemberStatus } from "./schema.js";

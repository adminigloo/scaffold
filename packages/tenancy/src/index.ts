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

export {
  createInvitationService,
  DEFAULT_INVITATION_EXPIRY_HOURS,
  UnknownRoleTemplateError,
  UnreadableDriverResultError,
} from "./service.js";
export type {
  AcceptResult,
  CreateInvitationServiceDeps,
  InvitationDb,
  InvitationService,
  InvitationSummary,
  SendInvitationInput,
  SentInvitation,
} from "./service.js";

export {
  grantTenantOwnerRole,
  backfillTenantOwnerRoles,
  TENANT_OWNER_TEMPLATE_KEY,
} from "./ownership.js";
export type { OwnerRoleDb } from "./ownership.js";

export { tenancyPermissions, TENANCY_STAFF_PERMISSION_KEYS } from "./permissions.js";
export type { TenancyPermission, TenancyStaffPermission } from "./permissions.js";

export {
  TENANT_ROLE_TEMPLATES,
  templateRank,
  canManageTemplate,
  canManageTemplateKey,
} from "./templates.js";
export type { TenantRoleTemplate, TenantRoleTemplateKey } from "./templates.js";

// Tenancy 1 (companies): the client-safe rules. Names and web addresses,
// brand-colour contrast, the settings registry, the checklist types and the
// audit vocabulary. Pure — `zod` is the only new import (settings.ts).
export {
  SLUG_MIN,
  SLUG_MAX,
  COMPANY_NAME_MAX,
  RESERVED_SLUGS,
  suggestSlug,
  validateSlug,
  slugProblemMessage,
  normaliseCompanyName,
  companyNameProblem,
  companyNameProblemMessage,
} from "./slug.js";
export type { SlugProblem, CompanyNameProblem } from "./slug.js";

export { normaliseHexColor, contrastRatio, brandColorReport, AA_TEXT_RATIO } from "./color.js";
export type { BrandColorReport } from "./color.js";

export {
  isTimeZone,
  defineSettingsFragment,
  defineTenantSettings,
  companySettings,
  DuplicateSettingsFragmentError,
  InvalidSettingsFragmentError,
} from "./settings.js";
export type {
  SettingsFieldKind,
  SettingsField,
  SettingsParseProblem,
  TenantSettingsFragment,
  TenantSettingsRegistry,
  SettingsValues,
} from "./settings.js";

export { defineSetupChecklist, DuplicateChecklistItemError, InvalidChecklistItemError } from "./checklist.js";
export type { SetupChecklistItem, SetupChecklist, ChecklistContext } from "./checklist.js";

export { tenancyAuditedActions, describeTenancyAuditEntry } from "./audit.js";
export type { TenancyAuditAction } from "./audit.js";

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
export type {
  TenantBranding,
  TenantJson,
  TenantKind,
  TenantMemberStatus,
  TenantSetupState,
} from "./schema.js";

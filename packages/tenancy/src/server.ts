/**
 * @adminigloo/tenancy/server — the server half of companies (Tenancy 1).
 *
 * The provisioning state machine, sessions and the company switcher, company
 * creation, profile and branding, the settings registry, the setup checklist,
 * the team lifecycle (roles, removal, leaving, ownership), invitations, the
 * operator console's functions, and the two HTTP handler factories the
 * `@adminigloo/tenancy-widget` screens talk to.
 *
 * A SEPARATE ENTRY FROM THE ROOT ON PURPOSE. The root (`@adminigloo/tenancy`)
 * is imported by client components for `TENANT_ROLE_TEMPLATES` and the slug
 * rules, so it must never import a table object or `drizzle-orm/pg-core`.
 * This entry is server-only.
 */
export { createTenancyService } from "./server/service.js";
export { tenancyMembershipGate } from "./server/gate.js";
export { tenancyChecklistItems } from "./server/checklist-service.js";
export { ensureBootstrapAdminForEmail } from "./server/provisioning.js";
export { RETIRED_SLUGS_KEPT, SLUG_CHANGES_PER_DAY, LOGO_MAX_BYTES } from "./server/profile.js";
export {
  INVITATION_EMAIL_COOLDOWN_MINUTES,
  INVITATION_EMAILS_PER_ADDRESS_PER_DAY,
  WRONG_ACCOUNT_NOTE_MINUTES,
} from "./server/invitations-lifecycle.js";

export { createTenancyHandlers } from "./server/handlers.js";
export type {
  CreateTenancyHandlersOptions,
  InvitationDelivery,
  RateLimiter,
  TenancyHandlers,
  TenancyPrincipal,
} from "./server/handlers.js";
export { createTenancyOperatorHandlers } from "./server/operator-handlers.js";
export type { CreateTenancyOperatorHandlersOptions } from "./server/operator-handlers.js";
export { TENANCY_ROUTES, TENANCY_OPERATOR_ROUTES, TENANCY_RATE_LIMITS } from "./server/routes.js";
export type { TenancyRoute, TenancyRouteKind, TenancyOperatorRouteKind, TenancyRateBucket } from "./server/routes.js";
export { isCrossOriginRequest } from "./server/http.js";

// Tenancy 2a: the seams the feature packages take (scheduling, the
// estimator, invoicing, comms), the cron walker, and the public face's wire.
export { createCompanyRouteSeams, createPublicCompanySeams } from "./server/company-seams.js";
export type { CompanyRouteSeams, PublicCompanySeams } from "./server/company-seams.js";
export { runForEachCompany } from "./server/company-runs.js";
export type { CompanyRunOptions, CompanyRunReport } from "./server/company-runs.js";

export { TenancyError, TENANCY_ERROR_STATUS } from "./server/errors.js";
export type { TenancyErrorCode, TenancyErrorDetails } from "./server/errors.js";

export {
  sessionToWire,
  companyToWire,
  companyChoiceToWire,
  pendingToWire,
  teamToWire,
  memberToWire,
  invitationToWire,
  issuedToWire,
  previewToWire,
  adminCompanyRowToWire,
  adminCompanyListToWire,
  adminCompanyDetailToWire,
  adminPersonToWire,
  adminPeopleToWire,
  publicCompanyToWire,
} from "./server/to-wire.js";

export type {
  AcceptOutcome,
  AdminCompanyDetail,
  AdminCompanyList,
  AdminCompanyRow,
  AdminMember,
  AdminPeople,
  AdminPerson,
  BootstrapForEmailOutcome,
  ChecklistView,
  CompanyChoice,
  CompanyProfile,
  CompanyView,
  CreateCompanyResult,
  CreateTenancyServiceOptions,
  DeprovisionResult,
  EmailHold,
  EmailReservation,
  InvitationPreview,
  InvitationView,
  IssuedInvitation,
  LogoStore,
  MemberPerson,
  MemberView,
  PendingForMe,
  PersonRef,
  ProvisionResult,
  PublicCompany,
  PublicCompanyLookup,
  RequestFacts,
  RoleKey,
  SeatLimitSource,
  SessionState,
  SettingsSectionView,
  SettingsView,
  SlugCheck,
  StaffRoleView,
  TeamView,
  TenancyAuditEvent,
  TenancyAuditSink,
  TenancyDb,
  TenancyEvent,
  TenancyEventListener,
  TenancyMode,
  TenancyNoun,
  TenancyService,
  UserFacts,
} from "./server/types.js";

export type * from "./wire.js";

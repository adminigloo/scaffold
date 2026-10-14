/**
 * @adminigloo/tenancy-widget — the company screens.
 *
 *   <Onboarding baseUrl="/api/tenancy" />                     "What's your company called?"
 *   <CompanySwitcher baseUrl="/api/tenancy" />                the header switcher
 *   <SetupChecklist baseUrl="/api/tenancy" tenantId={id} />   what's left to set up
 *   <TeamManager baseUrl="/api/tenancy" tenantId={id} />      invite, roles, remove, leave, transfer
 *   <CompanySettings baseUrl="/api/tenancy" tenantId={id} />  name, web address, logo, colour, details
 *   <CompanySuspended companyName="…" />                      the plain "suspended" screen
 *   <AcceptInvitation baseUrl="/api/tenancy" token={t} />     the invitation link's page
 *   <CompanyBrandBar company={publicCompany} />               a company's public face (Tenancy 2a)
 *   <CompanyUnavailable company={publicCompany} />            "isn't taking requests online right now"
 *
 * Talks to `@adminigloo/tenancy/server`'s `createTenancyHandlers` (or any
 * object implementing `TenancyTransport`) over the wire contract in
 * docs/tenancy-1-contract.md section 7. Declares the wire types itself and
 * never imports the server package at runtime. The operator console is a
 * separate entry, `@adminigloo/tenancy-widget/admin`, so a customer's bundle
 * never ships it.
 */

export { TENANCY_WIRE_VERSION } from "./version.js";

export { Onboarding, mintRequestKey, type OnboardingProps } from "./Onboarding.js";
export { CompanySwitcher, shortName, type CompanySwitcherProps } from "./CompanySwitcher.js";
export { SetupChecklist, type SetupChecklistProps } from "./SetupChecklist.js";
export { TeamManager, type TeamManagerProps } from "./TeamManager.js";
export { CompanySettings, formatRatio, sectionAnchor, wireValue, type CompanySettingsProps } from "./CompanySettings.js";
export { CompanySuspended, type CompanySuspendedProps } from "./CompanySuspended.js";
export { AcceptInvitation, ACCEPT_REDIRECT_MS, type AcceptInvitationProps } from "./AcceptInvitation.js";
export { CompanyBrandBar, type CompanyBrandBarProps } from "./CompanyBrandBar.js";
export { CompanyUnavailable, type CompanyUnavailableProps } from "./CompanyUnavailable.js";

export {
  createTenancyClient,
  parseAccept,
  parseChecklist,
  parseCompany,
  parseCompanyProfile,
  parseInvitations,
  parseIssued,
  parsePreview,
  parseSession,
  parseSettings,
  parseSlugCheck,
  parseTeam,
  ROLE_KEYS,
  humanizeRoleKey,
  roleKeyOrNull,
  type TenancyTransport,
} from "./client.js";
export { joinUrl, toClientError, WIRE_ERROR_CODES, type ClientError, type Result, type TransportOptions } from "./http.js";

export { injectTenancyStyles, tenancyWidgetCss, CONTRAST_PAIRS, DARK_TOKENS, LIGHT_TOKENS, type InjectStylesOptions } from "./styles.js";
export { resolveHostTheme, useHostTheme, type MatchMediaLike, type ResolvedTheme, type ThemeChoice } from "./theme.js";

export {
  COMPANY_NAME_MAX,
  companyNameProblem,
  companyNameProblemMessage,
  normaliseCompanyName,
  RESERVED_SLUGS,
  SLUG_MAX,
  SLUG_MIN,
  slugProblemMessage,
  suggestSlug,
  validateSlug,
  type CompanyNameProblem,
  type SlugProblem,
} from "./slug.js";
export { AA_TEXT_RATIO, brandColorReport, contrastRatio, normaliseHexColor, type BrandColorReport } from "./color.js";
export { allTimeZones, US_TIME_ZONES, zoneLabel, type ZoneChoice } from "./timezones.js";
export { acceptOutcomeText, codeFallback, DEFAULT_NOUN, errorText, nounTitle, SIGNED_OUT_MESSAGE, type Noun } from "./words.js";

export type {
  AcceptBody,
  AcceptWire,
  AdminCompanyDetailWire,
  AdminCompanyListWire,
  AdminCompanyRowWire,
  AdminMemberWire,
  AdminPeopleWire,
  AdminPersonWire,
  AssignOwnerBody,
  AuditLineWire,
  BrandColorReportWire,
  BrandingBody,
  BrandingWire,
  ChecklistItemWire,
  ChecklistWire,
  CompanyChoiceWire,
  CompanyKind,
  CompanyProfileWire,
  CompanyStatus,
  CompanyWire,
  CreateCompanyBody,
  CreateCompanyWire,
  Instant,
  InvitationPreviewWire,
  InvitationsWire,
  InvitationWire,
  InviteBody,
  IssuedWire,
  MemberWire,
  PendingForMeWire,
  PersonRefWire,
  ProfileBody,
  PublicCompanyWire,
  RoleBody,
  RoleKey,
  RoleOptionWire,
  SessionWire,
  SetActiveBody,
  SettingsBody,
  SettingsFieldKind,
  SettingsFieldWire,
  SettingsSectionWire,
  SettingsWire,
  SlugCheckWire,
  SlugProblemWire,
  StaffRoleBody,
  StaffRoleWire,
  SuspendBody,
  TeamWire,
  TenancyErrorCode,
  TransferBody,
  WireErrorBody,
  WireIssue,
} from "./types.js";

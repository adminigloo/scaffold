/**
 * @adminigloo/tenancy-widget/admin — the operator console, for the
 * platform's own staff.
 *
 *   <CompaniesConsole baseUrl="/api/admin/tenancy" detailHref={…} />   every company: search, filter, pages
 *   <CompanyDetail baseUrl="/api/admin/tenancy" tenantId={id} />        one company: members, activity, suspend
 *   <StaffPeople baseUrl="/api/admin/tenancy" />                        people, and who is staff at what level
 *
 * Talks to `@adminigloo/tenancy/server`'s `createTenancyOperatorHandlers`
 * (or any object implementing `TenancyAdminTransport`). A client entry,
 * separate from the company screens so a customer's page never ships the
 * console.
 */
export { TENANCY_WIRE_VERSION } from "../version.js";

export {
  CompaniesConsole,
  companyHref,
  type CompaniesConsoleProps,
  type CompanyKindFilter,
  type CompanyStatusFilter,
} from "./CompaniesConsole.js";
export { CompanyDetail, type CompanyDetailProps } from "./CompanyDetail.js";
export { StaffPeople, type StaffPeopleProps } from "./StaffPeople.js";

export {
  createTenancyAdminClient,
  parseAdminCompanyDetail,
  parseAdminCompanyList,
  parseAdminPeople,
  parseAdminPerson,
  parseStaffRole,
  type TenancyAdminTransport,
} from "./client.js";
export type { ClientError, Result, TransportOptions } from "../http.js";

export { injectTenancyAdminStyles, tenancyAdminCss } from "./styles.js";

export type {
  AdminCompanyDetailWire,
  AdminCompanyListWire,
  AdminCompanyRowWire,
  AdminMemberWire,
  AdminPeopleWire,
  AdminPersonWire,
  AssignOwnerBody,
  AuditLineWire,
  CompanyKind,
  CompanyStatus,
  Instant,
  PersonRefWire,
  RoleKey,
  StaffRoleBody,
  StaffRoleWire,
  SuspendBody,
  TenancyErrorCode,
  WireErrorBody,
  WireIssue,
} from "../types.js";

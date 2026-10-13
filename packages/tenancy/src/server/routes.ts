/**
 * The route tables (contract 7.1 and 7.2), as DATA: the handlers route by
 * them, the tests read them back (every route's documented 200 shape, the
 * two-company matrix), and create-app's generator test checks every
 * `permission` here is declared in the project's catalog.
 *
 * `permission` documents which key the SERVICE enforces — the handler never
 * pre-checks one (D7: the service re-resolves under the company lock). null =
 * sign-in only (signed-in routes) or plain membership (company routes);
 * "fragment" = the settings section's own view/edit permission.
 */

export type TenancyRateBucket =
  | "create-company"
  | "slug-check"
  | "switch"
  | "invite"
  | "invite-sender"
  | "invite-sender-day"
  | "accept"
  | "logo"
  | "write"
  | "operator-write";

export const TENANCY_RATE_LIMITS: Readonly<Record<TenancyRateBucket, { readonly limit: number; readonly windowMs: number }>> = {
  "create-company": { limit: 10, windowMs: 60 * 60_000 },
  "slug-check": { limit: 120, windowMs: 60_000 },
  switch: { limit: 60, windowMs: 60_000 },
  // Per COMPANY, charged only after the caller is shown to be a member of it
  // who may invite (review T1-06, R2 SEC-T1-D), so neither a stranger nor a
  // viewer can spend a company's budget and lock its owner out.
  invite: { limit: 50, windowMs: 60 * 60_000 },
  // Per SENDER, across every company they can invite into (review R2
  // SEC-T1-B). Without it one free account multiplied the per-company budget
  // by the companies it made, and sent from the site's own address.
  "invite-sender": { limit: 50, windowMs: 60 * 60_000 },
  "invite-sender-day": { limit: 200, windowMs: 24 * 60 * 60_000 },
  accept: { limit: 20, windowMs: 10 * 60_000 },
  logo: { limit: 20, windowMs: 60 * 60_000 },
  write: { limit: 120, windowMs: 60_000 },
  "operator-write": { limit: 60, windowMs: 60 * 60_000 },
};

export type TenancyRouteKind =
  | "session"
  | "slug-check"
  | "company-create"
  | "active-set"
  | "invite-accept"
  | "invite-preview"
  | "invite-join"
  | "company-get"
  | "profile-update"
  | "branding-update"
  | "logo-upload"
  | "logo-remove"
  | "settings-get"
  | "settings-update"
  | "checklist-get"
  | "checklist-dismiss"
  | "checklist-restore"
  | "checklist-hide"
  | "checklist-show"
  | "team-get"
  | "member-role"
  | "member-remove"
  | "leave"
  | "transfer"
  | "invitations-list"
  | "invitation-send"
  | "invitation-resend"
  | "invitation-revoke";

export type TenancyOperatorRouteKind =
  | "admin-companies"
  | "admin-company"
  | "admin-suspend"
  | "admin-reactivate"
  | "admin-assign-owner"
  | "admin-release-addresses"
  | "admin-people"
  | "admin-staff-roles"
  | "admin-staff-role-set";

export interface TenancyRoute<K extends string = TenancyRouteKind | TenancyOperatorRouteKind> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the mount, e.g. "v1/companies/:tenantId/members/:userId/remove". */
  readonly path: string;
  readonly scope: "signed-in" | "company" | "staff";
  readonly permission: string | null;
  readonly bucket: TenancyRateBucket | null;
}

export const TENANCY_ROUTES: readonly TenancyRoute<TenancyRouteKind>[] = [
  { kind: "session", method: "GET", path: "v1/session", scope: "signed-in", permission: null, bucket: null },
  { kind: "slug-check", method: "GET", path: "v1/slug", scope: "signed-in", permission: null, bucket: "slug-check" },
  { kind: "company-create", method: "POST", path: "v1/companies", scope: "signed-in", permission: null, bucket: "create-company" },
  { kind: "active-set", method: "POST", path: "v1/active", scope: "signed-in", permission: null, bucket: "switch" },
  { kind: "invite-accept", method: "POST", path: "v1/invitations/accept", scope: "signed-in", permission: null, bucket: "accept" },
  { kind: "invite-preview", method: "POST", path: "v1/invitations/preview", scope: "signed-in", permission: null, bucket: "accept" },
  { kind: "invite-join", method: "POST", path: "v1/invitations/:invitationId/join", scope: "signed-in", permission: null, bucket: "accept" },
  { kind: "company-get", method: "GET", path: "v1/companies/:tenantId", scope: "company", permission: "tenant.view", bucket: null },
  { kind: "profile-update", method: "POST", path: "v1/companies/:tenantId/profile", scope: "company", permission: "tenant.edit", bucket: "write" },
  { kind: "branding-update", method: "POST", path: "v1/companies/:tenantId/branding", scope: "company", permission: "tenant.edit", bucket: "write" },
  { kind: "logo-upload", method: "POST", path: "v1/companies/:tenantId/logo", scope: "company", permission: "tenant.edit", bucket: "logo" },
  { kind: "logo-remove", method: "POST", path: "v1/companies/:tenantId/logo/remove", scope: "company", permission: "tenant.edit", bucket: "write" },
  { kind: "settings-get", method: "GET", path: "v1/companies/:tenantId/settings", scope: "company", permission: "fragment", bucket: null },
  { kind: "settings-update", method: "POST", path: "v1/companies/:tenantId/settings/:section", scope: "company", permission: "fragment", bucket: "write" },
  { kind: "checklist-get", method: "GET", path: "v1/companies/:tenantId/checklist", scope: "company", permission: "tenant.view", bucket: null },
  { kind: "checklist-dismiss", method: "POST", path: "v1/companies/:tenantId/checklist/:itemKey/dismiss", scope: "company", permission: "tenant.edit", bucket: "write" },
  { kind: "checklist-restore", method: "POST", path: "v1/companies/:tenantId/checklist/:itemKey/restore", scope: "company", permission: "tenant.edit", bucket: "write" },
  { kind: "checklist-hide", method: "POST", path: "v1/companies/:tenantId/checklist/hide", scope: "company", permission: "tenant.edit", bucket: "write" },
  { kind: "checklist-show", method: "POST", path: "v1/companies/:tenantId/checklist/show", scope: "company", permission: "tenant.edit", bucket: "write" },
  { kind: "team-get", method: "GET", path: "v1/companies/:tenantId/members", scope: "company", permission: "members.view", bucket: null },
  { kind: "member-role", method: "POST", path: "v1/companies/:tenantId/members/:userId/role", scope: "company", permission: "members.role.change", bucket: "write" },
  { kind: "member-remove", method: "POST", path: "v1/companies/:tenantId/members/:userId/remove", scope: "company", permission: "members.remove", bucket: "write" },
  { kind: "leave", method: "POST", path: "v1/companies/:tenantId/leave", scope: "company", permission: null, bucket: "write" },
  { kind: "transfer", method: "POST", path: "v1/companies/:tenantId/transfer", scope: "company", permission: "tenant.transfer", bucket: "write" },
  { kind: "invitations-list", method: "GET", path: "v1/companies/:tenantId/invitations", scope: "company", permission: "members.invite", bucket: null },
  { kind: "invitation-send", method: "POST", path: "v1/companies/:tenantId/invitations", scope: "company", permission: "members.invite", bucket: "invite" },
  { kind: "invitation-resend", method: "POST", path: "v1/companies/:tenantId/invitations/:invitationId/resend", scope: "company", permission: "members.invite", bucket: "invite" },
  { kind: "invitation-revoke", method: "POST", path: "v1/companies/:tenantId/invitations/:invitationId/revoke", scope: "company", permission: "members.invite", bucket: "write" },
];

export const TENANCY_OPERATOR_ROUTES: readonly TenancyRoute<TenancyOperatorRouteKind>[] = [
  { kind: "admin-companies", method: "GET", path: "v1/admin/companies", scope: "staff", permission: "staff.tenants.view", bucket: null },
  { kind: "admin-company", method: "GET", path: "v1/admin/companies/:tenantId", scope: "staff", permission: "staff.tenants.view", bucket: null },
  { kind: "admin-suspend", method: "POST", path: "v1/admin/companies/:tenantId/suspend", scope: "staff", permission: "staff.tenants.suspend", bucket: "operator-write" },
  { kind: "admin-reactivate", method: "POST", path: "v1/admin/companies/:tenantId/reactivate", scope: "staff", permission: "staff.tenants.suspend", bucket: "operator-write" },
  { kind: "admin-assign-owner", method: "POST", path: "v1/admin/companies/:tenantId/owner", scope: "staff", permission: "staff.tenants.transfer", bucket: "operator-write" },
  { kind: "admin-release-addresses", method: "POST", path: "v1/admin/companies/:tenantId/release-addresses", scope: "staff", permission: "staff.tenants.suspend", bucket: "operator-write" },
  { kind: "admin-people", method: "GET", path: "v1/admin/people", scope: "staff", permission: "staff.people.view", bucket: null },
  { kind: "admin-staff-roles", method: "GET", path: "v1/admin/staff-roles", scope: "staff", permission: "staff.roles.view", bucket: null },
  { kind: "admin-staff-role-set", method: "POST", path: "v1/admin/people/:userId/staff-role", scope: "staff", permission: "staff.roles.manage", bucket: "operator-write" },
];

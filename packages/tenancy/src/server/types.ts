import type { BootstrapPolicy, Catalog } from "@adminigloo/permissions";
import type { BootstrapOutcome, MembershipVerdict } from "@adminigloo/permissions/server";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { TenancyAuditAction } from "../audit.js";
import type { BrandColorReport } from "../color.js";
import type { SetupChecklist } from "../checklist.js";
import type { TenantRoleSet } from "../roles.js";
import type { TenantSettingsRegistry } from "../settings.js";
import type {
  AuditLineWire,
  ChecklistWire,
  CompanyKind,
  CompanyStatus,
  RoleKey,
  RoleOptionWire,
  SettingsSectionWire,
  SettingsWire,
  SlugCheckWire,
  StaffRoleWire,
} from "../wire.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TenancyDb = PgDatabase<any, any, any>;
export type TenancyMode = "companies" | "personal";
export type { RoleKey };

/** Lowercase: { singular: "company", plural: "companies" }. Used in messages. */
export interface TenancyNoun {
  readonly singular: string;
  readonly plural: string;
}

/** Where logos are stored (create-app adapts its blob store). */
export interface LogoStore {
  put(input: {
    readonly pathname: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly url: string; readonly key: string }>;
  delete(key: string): Promise<void>;
}

/**
 * The seat limit (decision D16): billing only answers "how many"; tenancy
 * counts, under the company lock every joining path takes.
 */
export interface SeatLimitSource {
  /** null = unlimited. Called inside the company-locked transaction. */
  limitFor(tx: TenancyDb, tenantId: string): Promise<number | null>;
  /** Where "upgrade" goes, shown beside the seats-full message. Optional. */
  readonly upgradeHref?: string;
}

export interface RequestFacts {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface TenancyAuditEvent {
  readonly action: TenancyAuditAction;
  /** null = a system actor (webhook, seed, admin:grant). */
  readonly actorUserId: string | null;
  readonly scope: "tenant" | "staff";
  readonly tenantId: string | null;
  readonly resourceType: "tenant" | "tenant_member" | "tenant_invitation" | "staff_role";
  readonly resourceId: string;
  /** Never a token, never a URL carrying one. */
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly request: RequestFacts | null;
}

/** Called INSIDE the transaction (D17): the audit row commits with the change, or neither does. */
export type TenancyAuditSink = (tx: TenancyDb, event: TenancyAuditEvent) => Promise<void>;

export type TenancyEvent =
  | { readonly type: "company.created"; readonly tenantId: string; readonly userId: string }
  | { readonly type: "member.joined"; readonly tenantId: string; readonly userId: string; readonly via: "invitation" | "verified-email" }
  | { readonly type: "member.removed" | "member.left"; readonly tenantId: string; readonly userId: string; readonly by: string }
  | {
      readonly type: "member.role.changed";
      readonly tenantId: string;
      readonly userId: string;
      readonly from: RoleKey | null;
      readonly to: RoleKey;
      readonly by: string;
    }
  | { readonly type: "ownership.transferred"; readonly tenantId: string; readonly from: string; readonly to: string }
  | { readonly type: "company.suspended" | "company.reactivated"; readonly tenantId: string; readonly by: string }
  | { readonly type: "invitation.sent"; readonly tenantId: string; readonly invitationId: string; readonly by: string }
  /**
   * Tenancy 2a: a settings section saved (`changed`: the same field list as
   * its audit row). Scheduling's zone convergence listens for section
   * "company" with "timeZone" in `changed` (D5).
   */
  | {
      readonly type: "company.settings.updated";
      readonly tenantId: string;
      readonly section: string;
      readonly changed: readonly string[];
      readonly by: string;
    }
  | { readonly type: "company.profile.updated"; readonly tenantId: string; readonly changed: readonly ("name" | "slug")[]; readonly by: string }
  | { readonly type: "company.branding.updated"; readonly tenantId: string; readonly by: string };

export type TenancyEventListener = (event: TenancyEvent) => void | Promise<void>;

export interface CreateTenancyServiceOptions {
  readonly db: TenancyDb;
  readonly mode: TenancyMode;
  /** The project's tenant catalog. createCompany seeds the tenant templates from it when they're missing (D10). */
  readonly tenantCatalog: Catalog;
  readonly bootstrap: BootstrapPolicy;
  /** Default company/companies. */
  readonly noun?: TenancyNoun;
  /** Default defineTenantSettings([companySettings]). Must contain the `company` fragment. */
  readonly settings?: TenantSettingsRegistry;
  /** Default defineSetupChecklist(tenancyChecklistItems({})). */
  readonly checklist?: SetupChecklist;
  /**
   * The project's company roles (Tenancy 2a, D9): `defineTenantRoles([...])`,
   * e.g. with scheduling's Crew. Default `DEFAULT_TENANT_ROLES` (Tenancy 1's
   * four). Invitations, role changes, the team page's options and the
   * first-company seed (D10) all read it.
   */
  readonly roles?: TenantRoleSet;
  readonly seats?: SeatLimitSource;
  /** Absent → logo routes answer logo_storage_off. */
  readonly logos?: LogoStore;
  /** Added to RESERVED_SLUGS (create-app passes the project's own name). */
  readonly reservedSlugs?: Iterable<string>;
  readonly invitations?: { readonly expiresInHours?: number; readonly requireMatchingEmail?: boolean };
  /**
   * How many live companies one account may OWN (default 10; null = no limit).
   * Companies are free to make, and the invitation and web-address budgets
   * are per company, so without a limit one free account multiplied them
   * (review R2 SEC-T1-B/C). Past it, creating another answers `forbidden`
   * with a plain sentence. Staff can still hand more companies to a person.
   */
  readonly companiesPerAccount?: number | null;
  readonly audit?: TenancyAuditSink;
  readonly onEvent?: TenancyEventListener;
  readonly onEventError?: (error: unknown, event: TenancyEvent | { readonly type: string }) => void;
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// Server-side views (instants are Dates; the *ToWire helpers make the JSON)
// ---------------------------------------------------------------------------

export interface CompanyView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: CompanyKind;
  readonly status: CompanyStatus;
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly onBrandColor: "#ffffff" | "#111111" | null;
  readonly publicPath: string;
  readonly createdAt: Date;
  /** The caller's role here (null when read without a caller). */
  readonly role: RoleKey | null;
  readonly isOwner: boolean;
}

export interface CompanyChoice {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logoUrl: string | null;
  readonly role: RoleKey | null;
  readonly status: CompanyStatus;
  readonly active: boolean;
}

export interface PendingForMe {
  readonly id: string;
  readonly companyName: string;
  readonly roleKey: RoleKey | null;
  readonly roleName: string;
  readonly invitedBy: string | null;
  readonly expiresAt: Date | null;
}

export interface UserFacts {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
}

export type SessionState =
  | {
      readonly state: "needs-onboarding";
      readonly mode: TenancyMode;
      readonly user: UserFacts;
      readonly invitations: readonly PendingForMe[];
      /** The company they were removed from or left, when that's why they have none (review T1-09). */
      readonly formerCompany: string | null;
    }
  | {
      readonly state: "ready" | "suspended";
      readonly mode: TenancyMode;
      readonly user: UserFacts;
      readonly company: CompanyView;
      readonly companies: readonly CompanyChoice[];
    };

export type SlugCheck = SlugCheckWire;

export interface CreateCompanyResult {
  readonly status: "created" | "replayed" | "already-onboarded";
  readonly company: CompanyView;
}

export interface MemberView {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly roleKey: RoleKey | null;
  readonly roleName: string;
  readonly isOwner: boolean;
  readonly isYou: boolean;
  readonly status: "active" | "suspended";
  readonly joinedAt: Date;
  readonly actions: { readonly roles: readonly RoleKey[]; readonly remove: boolean; readonly transferTo: boolean };
}

export interface TeamView {
  readonly company: { readonly id: string; readonly name: string; readonly kind: CompanyKind };
  readonly you: {
    readonly userId: string;
    readonly roleKey: RoleKey | null;
    readonly isOwner: boolean;
    readonly canInvite: boolean;
    readonly canLeave: boolean;
    readonly leaveBlocked: string | null;
    readonly canTransfer: boolean;
  };
  readonly members: readonly MemberView[];
  readonly roles: readonly RoleOptionWire[];
  readonly invitableRoles: readonly RoleKey[];
  readonly seats: { readonly limit: number; readonly used: number; readonly pending: number } | null;
}

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly roleKey: RoleKey | null;
  readonly roleName: string;
  readonly state: "pending" | "expired";
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly canResend: boolean;
  readonly canRevoke: boolean;
  /**
   * The last time someone pressed Accept on its link signed in with a
   * different address, and that address masked ("j•••@gmail.com"); null if
   * nobody has (review R3 T1BO-07).
   */
  readonly wrongAccount: { readonly signedInAs: string | null; readonly at: Date } | null;
}

/**
 * Why an invitation was saved but NOT emailed (review R3 SEC-T1-B): the
 * address was emailed by this company within the cooldown ("cooldown"), or
 * has had the day's emails ("daily-limit"), or an email to it is still on its
 * way and we haven't heard back ("sending", review R4). `message` is the
 * inviter's sentence, and it only ever says "we emailed" about an email the
 * provider took; `until` is when the hold ends at the latest.
 */
export interface EmailHold {
  readonly reason: "cooldown" | "daily-limit" | "sending";
  readonly until: Date;
  readonly message: string;
}

/**
 * An invitation email reserved under the company lock, not yet sent (review
 * R4 SEC-T1-B). Whoever emails the link settles it with
 * `TenancyService.settleInvitationEmail`: `sent: true` only when the provider
 * took the message, `sent: false` for anything else (skipped, failed, threw).
 * Only a settled "sent" counts toward the limits as an email and can be
 * described as one; an unsettled reservation holds the address for at most
 * `INVITATION_EMAIL_COOLDOWN_MINUTES`, as "we haven't heard back".
 */
export interface EmailReservation {
  readonly invitationId: string;
  readonly reservedAt: Date;
}

export interface IssuedInvitation {
  readonly invitation: InvitationView;
  /** The plaintext token: exists only in this return value. */
  readonly token: string;
  readonly expiresAt: Date;
  /** An open invitation to this address existed and was re-sent. */
  readonly replaced: boolean;
  /** For the delivery email. */
  readonly companyName: string;
  readonly invitedBy: string | null;
  /** Set when the caller said it would email the link and the per-address limits say not yet: send nothing, show `message`. */
  readonly emailHold: EmailHold | null;
  /** Set when the caller said it would email the link and nothing held it: email it, then settle this. */
  readonly emailReservation: EmailReservation | null;
}

export type AcceptOutcome =
  | { readonly status: "accepted" | "already-a-member"; readonly company: { readonly id: string; readonly name: string } }
  | { readonly status: "expired" | "revoked" | "wrong-email" | "unknown" }
  | { readonly status: "company-unavailable" }
  | { readonly status: "seats-full"; readonly message: string };

export interface InvitationPreview {
  readonly found: boolean;
  readonly companyName: string | null;
  readonly roleName: string | null;
  readonly invitedBy: string | null;
  /** For one of the caller's verified addresses? null without a caller (review R2 T1BO-07). */
  readonly addressMatches: boolean | null;
  /** When it isn't: the invited address, masked. */
  readonly sentTo: string | null;
  /** When it isn't: the address the caller is signed in with. */
  readonly signedInAs: string | null;
}

export type SettingsView = SettingsWire;
export type SettingsSectionView = SettingsSectionWire;
export type ChecklistView = ChecklistWire;

export interface PersonRef {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
}

export interface AdminCompanyRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly kind: CompanyKind;
  readonly status: CompanyStatus;
  readonly createdAt: Date;
  readonly members: number;
  readonly owner: PersonRef | null;
}

export interface AdminCompanyList {
  readonly companies: readonly AdminCompanyRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface AdminMember {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly roleKey: RoleKey | null;
  readonly roleName: string;
  readonly isOwner: boolean;
  readonly status: "active" | "suspended";
  readonly joinedAt: Date;
}

export interface AdminCompanyDetail {
  readonly company: AdminCompanyRow & {
    readonly publicPath: string;
    readonly logoUrl: string | null;
    readonly brandColor: string | null;
    readonly createdBy: PersonRef | null;
    readonly ownerDeleted: boolean;
    readonly suspendedAt: Date | null;
    readonly suspendedReason: string | null;
    readonly suspendedBy: PersonRef | null;
    readonly timeZone: string | null;
    readonly contactEmail: string | null;
    readonly contactPhone: string | null;
  };
  readonly members: readonly AdminMember[];
  readonly pendingInvitations: number;
  /** The open (unexpired) invitations, newest first: who, as what, from whom (review R2 T1BO-09). */
  readonly invitations: readonly { readonly email: string; readonly roleName: string; readonly invitedBy: string | null; readonly expiresAt: Date | null }[];
  readonly retiredAddresses: readonly string[];
  /** Filled by the HANDLER from its `recentAudit` option; null = not connected. */
  readonly activity: readonly AuditLineWire[] | null;
  readonly can: { readonly suspend: boolean; readonly assignOwner: boolean; readonly releaseAddresses: boolean };
}

export type StaffRoleView = StaffRoleWire;

export interface AdminPerson {
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly createdAt: Date;
  readonly companies: number;
  readonly staffRole: { readonly key: string; readonly name: string; readonly rank: number } | null;
  readonly isYou: boolean;
  readonly canChange: boolean;
}

export interface AdminPeople {
  readonly people: readonly AdminPerson[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly roles: readonly StaffRoleView[];
  readonly you: { readonly userId: string; readonly roleKey: string | null };
}

export interface PublicCompany {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly onBrandColor: "#ffffff" | "#111111" | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  /** Tenancy 2a: the company's zone, for public pages that show times. null = not set yet. */
  readonly timeZone: string | null;
}

/** A company found by its web address, active or suspended (Tenancy 2a, D7). */
export interface PublicCompanyLookup {
  readonly company: PublicCompany;
  /** The address asked for, when it was an OLD one (a page redirects to the current). */
  readonly retiredSlug: string | null;
  readonly status: "active" | "suspended";
}

/**
 * The company as the feature packages need it (Tenancy 2a, 4.3): the basics
 * every feature reads (structurally a `SchedulingCompany`, an
 * `EstimatorCompany`, the base of an `InvoicingBusiness`), where its
 * customers' replies go, where its own notices go, and every settings
 * fragment's values.
 */
export interface CompanyProfile {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** "/t/" + slug. */
  readonly publicPath: string;
  readonly kind: "org" | "personal";
  readonly status: "active" | "suspended";
  readonly timeZone: string | null;
  readonly contactEmail: string | null;
  readonly contactPhone: string | null;
  readonly address: {
    readonly line1: string | null;
    readonly line2: string | null;
    readonly city: string | null;
    readonly region: string | null;
    readonly postalCode: string | null;
    readonly country: string | null;
  };
  readonly logoUrl: string | null;
  readonly brandColor: string | null;
  readonly onBrandColor: "#ffffff" | "#111111" | null;
  /** Where a customer's reply goes: the contact email, else the owner's sign-in address; null only when neither exists. */
  readonly replyTo: string | null;
  /** Where the company's own notices go when a feature has none saved: [contact email] or [owner's address] or []. */
  readonly inbox: readonly string[];
  /** Every registry fragment's parsed values (registry.parse), e.g. settings.invoicing.paymentInstructions. */
  readonly settings: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * When the company was made. A host can hold a NEW company to lower limits
   * than an established one — create-app's per-company sending allowance
   * does (Tenancy 2a review SEC-2A-03): a company made an hour ago that
   * starts mailing hundreds of strangers is the shape of abuse.
   */
  readonly createdAt: Date;
}

/** One active member, as a person (Tenancy 2a, 4.4): for "who opens this crew's route". */
export interface MemberPerson {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly roleKey: RoleKey | null;
  readonly roleName: string;
}

export interface ProvisionResult {
  /**
   * Personal mode only: `ws_<user>` while they own it. Null in companies mode,
   * and null once they've handed it to someone else (review R2 SEC-T1-A).
   */
  readonly personalWorkspaceId: string | null;
  readonly bootstrap: BootstrapOutcome;
  /** False when already provisioned (it still ran, idempotently). */
  readonly stamped: boolean;
}

export interface DeprovisionResult {
  readonly staffRolesRemoved: number;
  readonly membershipsSuspended: number;
  readonly invitationsRevoked: number;
  /** Companies where they are still the owner: the operator console offers "Change owner" (review T1-03). */
  readonly ownedCompanies: readonly string[];
}

export type BootstrapForEmailOutcome = BootstrapOutcome & {
  readonly userId: string | null;
  /** Set when more than one account carries the address: nobody is granted (review T1-02). */
  readonly ambiguous?: readonly string[];
};

type Actor = { readonly actorUserId: string; readonly tenantId: string };
type Req = { readonly request?: RequestFacts };

/** Everything the company lifecycle does. One instance per project (create-app's `src/server/tenancy.ts`). */
export interface TenancyService {
  readonly mode: TenancyMode;
  readonly noun: TenancyNoun;
  readonly settings: TenantSettingsRegistry;
  /** The project's company roles (Tenancy 2a): the core four plus its extras. */
  readonly roles: TenantRoleSet;

  // 6.2 provisioning
  provisionUser(input: { readonly userId: string; readonly email: string | null }): Promise<ProvisionResult>;
  deprovisionUser(input: { readonly userId: string }): Promise<DeprovisionResult>;
  ensureBootstrapAdmin(input: { readonly userId: string; readonly email: string | null }): Promise<BootstrapOutcome>;
  ensureBootstrapAdminFor(input: { readonly email: string }): Promise<BootstrapForEmailOutcome>;

  // 6.3 session
  resolveSession(input: { readonly userId: string; readonly verifiedEmails?: readonly string[] }): Promise<SessionState>;
  setActiveCompany(input: { readonly userId: string; readonly tenantId: string }): Promise<CompanyView>;
  /** The membership gate's verdict, for handlers that must not spend a company's rate budget on strangers. */
  membership(input: { readonly userId: string; readonly tenantId: string }): Promise<MembershipVerdict>;
  /** Does this member hold the permission now? A hint for rate budgets (review R2 SEC-T1-D); mutations decide under the lock. */
  hasPermission(input: { readonly userId: string; readonly tenantId: string; readonly permission: string }): Promise<boolean>;

  // 6.4 companies
  checkSlug(input: { readonly actorUserId: string; readonly slug?: string; readonly name?: string; readonly tenantId?: string }): Promise<SlugCheck>;
  createCompany(
    input: {
      readonly userId: string;
      readonly name: string;
      readonly slug?: string;
      readonly requestKey: string;
      readonly purpose: "onboarding" | "additional";
    } & Req,
  ): Promise<CreateCompanyResult>;

  // 6.5 profile and branding
  getCompany(input: Actor): Promise<{ readonly company: CompanyView; readonly can: readonly string[]; readonly logoUploads: boolean }>;
  updateCompanyProfile(input: Actor & { readonly name?: string; readonly slug?: string } & Req): Promise<CompanyView>;
  updateBranding(input: Actor & { readonly brandColor: string | null } & Req): Promise<{ readonly company: CompanyView; readonly brand: BrandColorReport | null }>;
  setLogo(
    input: Actor & { readonly file: { readonly bytes: Uint8Array; readonly contentType: string; readonly filename?: string } } & Req,
  ): Promise<CompanyView>;
  removeLogo(input: Actor & Req): Promise<CompanyView>;

  // 6.6 settings
  getSettings(input: Actor): Promise<SettingsView>;
  updateSettings(input: Actor & { readonly section: string; readonly values: unknown } & Req): Promise<SettingsSectionView>;
  /** Server-internal, NO permission check: for other packages' server code (Tenancy 2). */
  readSettings(tenantId: string): Promise<Readonly<Record<string, Readonly<Record<string, unknown>>>>>;

  // 6.7 checklist
  getChecklist(input: Actor): Promise<ChecklistView>;
  dismissChecklistItem(input: Actor & { readonly key: string }): Promise<ChecklistView>;
  restoreChecklistItem(input: Actor & { readonly key: string }): Promise<ChecklistView>;
  hideChecklist(input: Actor): Promise<ChecklistView>;
  showChecklist(input: Actor): Promise<ChecklistView>;

  // 6.8 team
  getTeam(input: Actor): Promise<TeamView>;
  changeMemberRole(input: Actor & { readonly targetUserId: string; readonly roleKey: RoleKey } & Req): Promise<MemberView>;
  removeMember(input: Actor & { readonly targetUserId: string } & Req): Promise<{ readonly removed: string }>;
  leaveCompany(input: { readonly userId: string; readonly tenantId: string } & Req): Promise<{ readonly left: string }>;
  transferOwnership(input: Actor & { readonly toUserId: string; readonly confirmName: string } & Req): Promise<TeamView>;

  // 6.9 invitations
  listInvitations(input: Actor): Promise<readonly InvitationView[]>;
  /**
   * `sendsEmail`: the caller will email the link (the HTTP handlers do when a
   * deliverer is wired). The per-address email limits apply only then, and
   * the answer's `emailHold` says when the email must wait (review R3 SEC-T1-B);
   * otherwise its `emailReservation` is the email, reserved: send it, then
   * `settleInvitationEmail` with what the provider said (review R4).
   */
  sendInvitation(input: Actor & { readonly email: string; readonly roleKey: RoleKey; readonly sendsEmail?: boolean } & Req): Promise<IssuedInvitation>;
  resendInvitation(input: Actor & { readonly invitationId: string; readonly sendsEmail?: boolean } & Req): Promise<IssuedInvitation>;
  /**
   * What became of a reserved invitation email (review R4 SEC-T1-B): `sent:
   * true` only when the provider took it — then, and only then, it counts as
   * emailed — and `sent: false` for skipped, failed or threw, which frees the
   * address at once. Exact and once: only the reservation named, in that
   * company; settling again changes nothing.
   */
  settleInvitationEmail(input: {
    readonly tenantId: string;
    readonly invitationId: string;
    readonly reservedAt: Date;
    readonly sent: boolean;
  }): Promise<void>;
  revokeInvitation(input: Actor & { readonly invitationId: string } & Req): Promise<{ readonly id: string }>;
  /** `verifiedEmails`: the caller's verified addresses, from the identity provider on the server (review R2 TB2-10). */
  acceptInvitation(input: { readonly token: string; readonly userId: string; readonly verifiedEmails?: readonly string[] } & Req): Promise<AcceptOutcome>;
  joinInvitation(
    input: { readonly invitationId: string; readonly userId: string; readonly verifiedEmails: readonly string[] } & Req,
  ): Promise<AcceptOutcome>;
  invitationsForMe(input: { readonly verifiedEmails: readonly string[] }): Promise<readonly PendingForMe[]>;
  previewInvitation(input: { readonly token: string; readonly userId?: string; readonly verifiedEmails?: readonly string[] }): Promise<InvitationPreview>;

  // 6.11 operator
  listCompanies(input: {
    readonly actorUserId: string;
    readonly q?: string;
    readonly kind?: "org" | "personal" | "all";
    readonly status?: "active" | "suspended" | "all";
    readonly page?: number;
    readonly pageSize?: number;
  }): Promise<AdminCompanyList>;
  getCompanyDetail(input: Actor): Promise<AdminCompanyDetail>;
  suspendCompany(input: Actor & { readonly reason: string } & Req): Promise<AdminCompanyDetail>;
  reactivateCompany(input: Actor & Req): Promise<AdminCompanyDetail>;
  assignOwner(input: Actor & { readonly toUserId: string } & Req): Promise<AdminCompanyDetail>;
  releaseRetiredAddresses(input: Actor & Req): Promise<AdminCompanyDetail>;
  listPeople(input: {
    readonly actorUserId: string;
    readonly q?: string;
    readonly staffOnly?: boolean;
    readonly page?: number;
    readonly pageSize?: number;
  }): Promise<AdminPeople>;
  listStaffRoles(input: { readonly actorUserId: string }): Promise<readonly StaffRoleView[]>;
  setStaffRole(input: { readonly actorUserId: string; readonly targetUserId: string; readonly templateKey: string | null } & Req): Promise<AdminPerson>;

  // 6.12 / 6.13
  /** An ACTIVE company by its web address (a suspended one is null): Tenancy 1's lookup, unchanged. */
  resolveCompanyBySlug(slug: string): Promise<{ readonly company: PublicCompany; readonly retiredSlug: string | null } | null>;
  /** No permission check: for server pages that already went through the gate (the header). */
  companyFor(tenantId: string): Promise<CompanyView | null>;

  // Tenancy 2a
  /**
   * A company by its web address (current or retired), WITH its status: a
   * suspended company is returned as "suspended" so its public pages can say
   * it isn't taking requests (D7). Unknown, deleted or personal → null.
   */
  resolvePublicCompany(slug: string): Promise<PublicCompanyLookup | null>;
  /**
   * The company's profile for server code that has already decided whom it
   * serves (a handler after `authorize`, a cron, comms' sender identity):
   * NO permission check, like `readSettings`. null for an unknown or deleted id.
   */
  companyProfile(tenantId: string): Promise<CompanyProfile | null>;
  /** The company's active members as people (no permission check): never the site's whole user table. */
  listMemberPeople(tenantId: string): Promise<readonly MemberPerson[]>;
  /**
   * Every company a cron should serve: companies mode → kind 'org', personal
   * mode → kind 'personal'; never suspended or deleted; ordered by id.
   */
  activeCompanyIds(): Promise<readonly string[]>;
}

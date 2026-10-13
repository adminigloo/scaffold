/**
 * The JSON wire contract between `@adminigloo/tenancy/server`'s handlers and
 * `@adminigloo/tenancy-widget` (docs/tenancy-1-contract.md, section 7.3).
 *
 * DECLARED TWICE, ON PURPOSE: here, and in the widget's `src/types.ts`. The
 * widget never imports this package at runtime (a host that renders only the
 * header switcher must not install drizzle and the tables to get a type), so
 * both sides carry the same block and the widget's wire-parity test reads both
 * files from disk and fails if the region between the WIRE markers differs by
 * a single byte. Change it in both places or in neither.
 *
 * Types only: nothing here exists at runtime.
 */

// WIRE:BEGIN
export type TenancyErrorCode =
  | "invalid" | "signed_out" | "forbidden" | "not_a_member" | "company_suspended" | "not_staff" | "cross_site"
  | "not_found" | "unavailable" | "name_invalid" | "slug_invalid" | "slug_reserved" | "slug_taken"
  | "rank" | "owner_protected" | "owner_must_transfer" | "self" | "last_owner" | "last_admin"
  | "already_member" | "personal_workspace" | "seats_full" | "confirmation_mismatch"
  | "logo_storage_off" | "logo_invalid" | "rate_limited" | "internal";

export type Instant = string;           // ISO 8601, UTC ("2026-10-12T15:04:05.000Z")
export type RoleKey = "owner" | "admin" | "member" | "viewer";
export type CompanyStatus = "active" | "suspended";
export type CompanyKind = "org" | "personal";

export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody {
  error: { code: TenancyErrorCode; message: string; issues?: WireIssue[]; suggestion?: string; upgradeHref?: string };
}

export interface CompanyWire {
  id: string;
  name: string;
  slug: string;
  kind: CompanyKind;
  status: CompanyStatus;
  logoUrl: string | null;
  brandColor: string | null;
  onBrandColor: "#ffffff" | "#111111" | null;
  publicPath: string;                 // "/t/" + slug (reserved now; Tenancy 2 serves pages under it)
  createdAt: Instant;
  role: RoleKey | null;               // the caller's
  isOwner: boolean;                   // the caller is the owner
}
export interface CompanyChoiceWire {
  id: string; name: string; slug: string; logoUrl: string | null;
  role: RoleKey | null; status: CompanyStatus; active: boolean;
}
export interface PendingForMeWire {
  id: string; companyName: string; roleKey: RoleKey | null; roleName: string;
  invitedBy: string | null; expiresAt: Instant | null;
}
export interface SessionWire {
  mode: "companies" | "personal";
  state: "needs-onboarding" | "ready" | "suspended";
  user: { userId: string; email: string | null; name: string | null };
  company: CompanyWire | null;        // null exactly when needs-onboarding
  companies: CompanyChoiceWire[];     // [] when needs-onboarding
  invitations: PendingForMeWire[];    // non-empty only when needs-onboarding
  formerCompany: string | null;       // needs-onboarding only: the name of the company they were removed from or left
}

export type SlugProblemWire = "too-short" | "too-long" | "invalid" | "reserved" | "taken";
export interface SlugCheckWire {
  slug: string;                       // what was checked (normalised); with only `name`, the suggestion
  available: boolean;
  problem: SlugProblemWire | null;
  message: string | null;             // plain sentence when not available
  suggestion: string;                 // always a free, valid slug
}
export interface CreateCompanyBody { name: string; slug?: string; requestKey: string; purpose?: "onboarding" | "additional" } // purpose default "onboarding"
export interface CreateCompanyWire { status: "created" | "replayed" | "already-onboarded"; company: CompanyWire }
export interface SetActiveBody { tenantId: string }

export interface AcceptBody { token: string }  // 1..512 chars
export interface AcceptWire {
  status: "accepted" | "already-a-member" | "expired" | "revoked" | "wrong-email" | "unknown" | "company-unavailable" | "seats-full";
  company: { id: string; name: string } | null;     // set for accepted / already-a-member only
  message: string | null;                            // set for seats-full only
}
export interface InvitationPreviewWire {
  found: boolean;                     // false for a used, withdrawn, expired or unknown link, or an unavailable company
  companyName: string | null;
  roleName: string | null;
  invitedBy: string | null;           // the inviter's name or email
  // Review R2 T1BO-07: is it for one of the signed-in person's verified
  // addresses? null when unknown (no caller, or the site doesn't match emails).
  addressMatches: boolean | null;
  sentTo: string | null;              // addressMatches === false only: the invited address, masked ("c•••@greenblade.test")
  signedInAs: string | null;          // addressMatches === false only: the caller's own address
}

export interface CompanyProfileWire { company: CompanyWire; can: string[]; logoUploads: boolean }
export interface ProfileBody { name?: string; slug?: string }
export interface BrandingBody { brandColor: string | null }
export interface BrandColorReportWire {
  color: string; textOnColor: "#ffffff" | "#111111";
  ratioWithWhiteText: number; ratioWithDarkText: number; ratioOnWhitePage: number;
  readable: boolean; warning: string | null;
}
export interface BrandingWire { company: CompanyWire; brand: BrandColorReportWire | null }

export type SettingsFieldKind = "text" | "textarea" | "email" | "tel" | "url" | "timezone" | "select" | "toggle" | "number";
export interface SettingsFieldWire {
  key: string; label: string; help: string | null; kind: SettingsFieldKind;
  options: { value: string; label: string }[] | null;
  placeholder: string | null; autoComplete: string | null;
  width: "full" | "half"; required: boolean;
  min: number | null; max: number | null; step: number | null;
}
export interface SettingsSectionWire {
  key: string; label: string; description: string | null;
  fields: SettingsFieldWire[];
  values: Record<string, string | number | boolean | null>;
  canEdit: boolean;
}
export interface SettingsWire { sections: SettingsSectionWire[] }
export interface SettingsBody { values: Record<string, string | number | boolean | null> }

export interface ChecklistItemWire { key: string; title: string; description: string; actionLabel: string; href: string; done: boolean; dismissed: boolean }
export interface ChecklistWire { items: ChecklistItemWire[]; done: number; total: number; complete: boolean; hidden: boolean }

export interface RoleOptionWire { key: RoleKey; name: string; description: string; rank: number }
export interface MemberWire {
  userId: string; name: string | null; email: string | null;
  roleKey: RoleKey | null; roleName: string;
  isOwner: boolean; isYou: boolean;
  status: "active" | "suspended";
  joinedAt: Instant;
  actions: { roles: RoleKey[]; remove: boolean; transferTo: boolean };
}
export interface TeamWire {
  company: { id: string; name: string; kind: CompanyKind };
  you: {
    userId: string; roleKey: RoleKey | null; isOwner: boolean;
    canInvite: boolean; canLeave: boolean; leaveBlocked: string | null; canTransfer: boolean;
  };
  members: MemberWire[];
  roles: RoleOptionWire[];            // owner, admin, member, viewer, highest first
  invitableRoles: RoleKey[];
  seats: { limit: number; used: number; pending: number } | null;
}
export interface RoleBody { roleKey: RoleKey }
export interface TransferBody { toUserId: string; confirmName: string }

export interface InvitationWire {
  id: string; email: string; roleKey: RoleKey | null; roleName: string;
  state: "pending" | "expired"; expiresAt: Instant | null; createdAt: Instant;
  canResend: boolean; canRevoke: boolean;
  // Review R3 T1BO-07: the last time someone pressed Accept on its link while
  // signed in with a different address (noted at most once per 10 minutes).
  wrongAccount: { signedInAs: string | null; at: Instant } | null;   // signedInAs masked: "j•••@gmail.com"
}
export interface InvitationsWire { invitations: InvitationWire[] }
export interface InviteBody { email: string; roleKey: RoleKey }   // email: trimmed, 3..254, an address
export interface IssuedWire {
  // "held" (review R3 SEC-T1-B): saved, but this company emailed that address
  // too recently or too often to email it again yet; `link` and `note` say what to do.
  invitation: InvitationWire; delivery: "sent" | "skipped" | "failed" | "held"; link: string | null;
  replaced: boolean;                  // an open invitation to that address was re-sent (its earlier link keeps working)
  note: string | null;                // "held" only: why it wasn't emailed and when it can be, in a sentence
}

// operator
export interface PersonRefWire { userId: string; email: string | null; name: string | null }
export interface AdminCompanyRowWire {
  id: string; name: string; slug: string; kind: CompanyKind; status: CompanyStatus;
  createdAt: Instant; members: number; owner: PersonRefWire | null;
}
export interface AdminCompanyListWire { companies: AdminCompanyRowWire[]; total: number; page: number; pageSize: number }
export interface AdminMemberWire {
  userId: string; name: string | null; email: string | null;
  roleKey: RoleKey | null; roleName: string; isOwner: boolean;
  status: "active" | "suspended"; joinedAt: Instant;
}
export interface AuditLineWire {
  at: Instant; action: string; label: string; actor: string | null; sensitive: boolean;
  detail: string | null;              // plain words from the row's metadata: "Jake: Member → Admin"
}
export interface AdminCompanyDetailWire {
  company: AdminCompanyRowWire & {
    publicPath: string; logoUrl: string | null; brandColor: string | null;
    createdBy: PersonRefWire | null;
    ownerDeleted: boolean;
    suspendedAt: Instant | null; suspendedReason: string | null; suspendedBy: PersonRefWire | null;
    timeZone: string | null; contactEmail: string | null; contactPhone: string | null;
  };
  members: AdminMemberWire[];
  pendingInvitations: number;
  // Review R2 T1BO-09: who is invited, so support can answer "I can't get in".
  invitations: { email: string; roleName: string; invitedBy: string | null; expiresAt: Instant | null }[];
  retiredAddresses: string[];         // old web addresses still pointing here
  activity: AuditLineWire[] | null;   // null = the host connected no activity source
  can: { suspend: boolean; assignOwner: boolean; releaseAddresses: boolean };
}
export interface SuspendBody { reason: string }   // 3..500 chars
export interface AssignOwnerBody { toUserId: string }
export interface StaffRoleWire { key: string; name: string; rank: number; assignable: boolean }
export interface AdminPersonWire {
  userId: string; email: string | null; name: string | null; createdAt: Instant;
  companies: number;
  staffRole: { key: string; name: string; rank: number } | null;
  isYou: boolean; canChange: boolean;
}
export interface AdminPeopleWire {
  people: AdminPersonWire[]; total: number; page: number; pageSize: number;
  roles: StaffRoleWire[];
  you: { userId: string; roleKey: string | null };
}
export interface StaffRoleBody { templateKey: string | null }
// WIRE:END

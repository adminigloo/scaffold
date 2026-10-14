import type {
  AdminCompanyDetailWire,
  AdminCompanyListWire,
  AdminCompanyRowWire,
  AdminPeopleWire,
  AdminPersonWire,
  AuditLineWire,
  CompanyChoiceWire,
  CompanyWire,
  InvitationPreviewWire,
  InvitationWire,
  IssuedWire,
  MemberWire,
  PendingForMeWire,
  PublicCompanyWire,
  SessionWire,
  TeamWire,
} from "../wire.js";
import { publicPathOf } from "./views.js";
import type {
  AdminCompanyDetail,
  AdminCompanyList,
  AdminCompanyRow,
  AdminPeople,
  AdminPerson,
  CompanyChoice,
  CompanyView,
  InvitationPreview,
  InvitationView,
  IssuedInvitation,
  MemberView,
  PendingForMe,
  PublicCompany,
  SessionState,
  TeamView,
} from "./types.js";

/**
 * The server views → the JSON wire (contract 7.3), in ONE place. The handlers
 * use these, and so do server-rendered pages that hand a component its first
 * data (`<CompanySwitcher session={sessionToWire(...)} />`), so a page and an
 * API answer can never disagree about a shape.
 */

/**
 * A company's public face for a page or a widget (Tenancy 2a, 4.9): the
 * brand bar and the "not taking requests" panel. The id is NOT on the wire:
 * a public page addresses a company by its web address, and an id there would
 * only be something to probe the private routes with.
 */
export function publicCompanyToWire(found: { readonly company: PublicCompany; readonly status: "active" | "suspended" }): PublicCompanyWire {
  const c = found.company;
  return {
    name: c.name,
    slug: c.slug,
    publicPath: publicPathOf(c.slug),
    logoUrl: c.logoUrl,
    brandColor: c.brandColor,
    onBrandColor: c.onBrandColor,
    contactEmail: c.contactEmail,
    contactPhone: c.contactPhone,
    status: found.status,
  };
}

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function companyToWire(c: CompanyView): CompanyWire {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    kind: c.kind,
    status: c.status,
    logoUrl: c.logoUrl,
    brandColor: c.brandColor,
    onBrandColor: c.onBrandColor,
    publicPath: c.publicPath,
    createdAt: iso(c.createdAt),
    role: c.role,
    isOwner: c.isOwner,
  };
}

export function companyChoiceToWire(c: CompanyChoice): CompanyChoiceWire {
  return { id: c.id, name: c.name, slug: c.slug, logoUrl: c.logoUrl, role: c.role, status: c.status, active: c.active };
}

export function pendingToWire(p: PendingForMe): PendingForMeWire {
  return {
    id: p.id,
    companyName: p.companyName,
    roleKey: p.roleKey,
    roleName: p.roleName,
    invitedBy: p.invitedBy,
    expiresAt: isoOrNull(p.expiresAt),
  };
}

export function sessionToWire(s: SessionState): SessionWire {
  if (s.state === "needs-onboarding") {
    return {
      mode: s.mode,
      state: s.state,
      user: { userId: s.user.userId, email: s.user.email, name: s.user.name },
      company: null,
      companies: [],
      invitations: s.invitations.map(pendingToWire),
      formerCompany: s.formerCompany,
    };
  }
  return {
    mode: s.mode,
    state: s.state,
    user: { userId: s.user.userId, email: s.user.email, name: s.user.name },
    company: companyToWire(s.company),
    companies: s.companies.map(companyChoiceToWire),
    invitations: [],
    formerCompany: null,
  };
}

export function memberToWire(m: MemberView): MemberWire {
  return {
    userId: m.userId,
    name: m.name,
    email: m.email,
    roleKey: m.roleKey,
    roleName: m.roleName,
    isOwner: m.isOwner,
    isYou: m.isYou,
    status: m.status,
    joinedAt: iso(m.joinedAt),
    actions: { roles: [...m.actions.roles], remove: m.actions.remove, transferTo: m.actions.transferTo },
  };
}

export function teamToWire(t: TeamView): TeamWire {
  return {
    company: { ...t.company },
    you: { ...t.you },
    members: t.members.map(memberToWire),
    roles: t.roles.map((r) => ({ ...r })),
    invitableRoles: [...t.invitableRoles],
    seats: t.seats ? { ...t.seats } : null,
  };
}

export function invitationToWire(i: InvitationView): InvitationWire {
  return {
    id: i.id,
    email: i.email,
    roleKey: i.roleKey,
    roleName: i.roleName,
    state: i.state,
    expiresAt: isoOrNull(i.expiresAt),
    createdAt: iso(i.createdAt),
    canResend: i.canResend,
    canRevoke: i.canRevoke,
    wrongAccount: i.wrongAccount ? { signedInAs: i.wrongAccount.signedInAs, at: iso(i.wrongAccount.at) } : null,
  };
}

/**
 * The issued invitation as the inviter's browser sees it. `link` is null when
 * the email went out: the token is a bearer credential for somebody else's
 * seat, and returning it routinely would put it in the inviter's browser,
 * history and any log that records a response body, for no benefit — the
 * invitee already has it. When the email did NOT go out (no deliverer, it
 * failed, or the per-address limits held it) the link is the only way the
 * feature works, so it is returned — with, when held, the sentence saying why.
 */
export function issuedToWire(issued: IssuedInvitation, delivery: IssuedWire["delivery"], url: string): IssuedWire {
  return {
    invitation: invitationToWire(issued.invitation),
    delivery,
    link: delivery === "sent" ? null : url,
    replaced: issued.replaced,
    note: delivery === "held" ? (issued.emailHold?.message ?? null) : null,
  };
}

export function previewToWire(p: InvitationPreview): InvitationPreviewWire {
  return {
    found: p.found,
    companyName: p.companyName,
    roleName: p.roleName,
    invitedBy: p.invitedBy,
    addressMatches: p.addressMatches,
    sentTo: p.sentTo,
    signedInAs: p.signedInAs,
  };
}

export function adminCompanyRowToWire(r: AdminCompanyRow): AdminCompanyRowWire {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    kind: r.kind,
    status: r.status,
    createdAt: iso(r.createdAt),
    members: r.members,
    owner: r.owner ? { ...r.owner } : null,
  };
}

export function adminCompanyListToWire(l: AdminCompanyList): AdminCompanyListWire {
  return { companies: l.companies.map(adminCompanyRowToWire), total: l.total, page: l.page, pageSize: l.pageSize };
}

export function adminCompanyDetailToWire(d: AdminCompanyDetail, activity: readonly AuditLineWire[] | null = d.activity): AdminCompanyDetailWire {
  const c = d.company;
  return {
    company: {
      ...adminCompanyRowToWire(c),
      publicPath: c.publicPath,
      logoUrl: c.logoUrl,
      brandColor: c.brandColor,
      createdBy: c.createdBy ? { ...c.createdBy } : null,
      ownerDeleted: c.ownerDeleted,
      suspendedAt: isoOrNull(c.suspendedAt),
      suspendedReason: c.suspendedReason,
      suspendedBy: c.suspendedBy ? { ...c.suspendedBy } : null,
      timeZone: c.timeZone,
      contactEmail: c.contactEmail,
      contactPhone: c.contactPhone,
    },
    members: d.members.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      roleKey: m.roleKey,
      roleName: m.roleName,
      isOwner: m.isOwner,
      status: m.status,
      joinedAt: iso(m.joinedAt),
    })),
    pendingInvitations: d.pendingInvitations,
    invitations: d.invitations.map((i) => ({ email: i.email, roleName: i.roleName, invitedBy: i.invitedBy, expiresAt: isoOrNull(i.expiresAt) })),
    retiredAddresses: [...d.retiredAddresses],
    activity: activity ? activity.map((a) => ({ ...a })) : null,
    can: { ...d.can },
  };
}

export function adminPersonToWire(p: AdminPerson): AdminPersonWire {
  return {
    userId: p.userId,
    email: p.email,
    name: p.name,
    createdAt: iso(p.createdAt),
    companies: p.companies,
    staffRole: p.staffRole ? { ...p.staffRole } : null,
    isYou: p.isYou,
    canChange: p.canChange,
  };
}

export function adminPeopleToWire(p: AdminPeople): AdminPeopleWire {
  return {
    people: p.people.map(adminPersonToWire),
    total: p.total,
    page: p.page,
    pageSize: p.pageSize,
    roles: p.roles.map((r) => ({ ...r })),
    you: { ...p.you },
  };
}

import {
  createRequester,
  isId,
  isObject,
  isString,
  isTrue,
  listOf,
  num,
  numOrNull,
  oneOf,
  queryString,
  seg,
  str,
  stringList,
  strOrNull,
  type Result,
  type TransportOptions,
} from "./http.js";
import type {
  AcceptWire,
  BrandColorReportWire,
  BrandingBody,
  BrandingWire,
  ChecklistItemWire,
  ChecklistWire,
  CompanyChoiceWire,
  CompanyProfileWire,
  CompanyWire,
  CreateCompanyBody,
  CreateCompanyWire,
  InvitationPreviewWire,
  InvitationsWire,
  InvitationWire,
  InviteBody,
  IssuedWire,
  MemberWire,
  PendingForMeWire,
  ProfileBody,
  RoleBody,
  RoleKey,
  RoleOptionWire,
  SessionWire,
  SettingsBody,
  SettingsFieldKind,
  SettingsFieldWire,
  SettingsSectionWire,
  SettingsWire,
  SlugCheckWire,
  SlugProblemWire,
  TeamWire,
  TransferBody,
} from "./types.js";

/**
 * The company transport: `createTenancyHandlers`' routes (contract 7.1), each
 * answer checked narrowly. Components take this INTERFACE, not the client, so
 * a host can back the screens with anything that answers in these shapes (a
 * test fake, server actions, tRPC; the README has a sketch).
 *
 * D3 IN THE URL. Every company route names its company in the path
 * (`v1/companies/{tenantId}/…`), never "whichever company is active". A team
 * page left open in one tab keeps acting on the company it shows after the
 * owner switches company in another tab.
 */

export interface TenancyTransport {
  session(): Promise<Result<SessionWire>>;
  checkSlug(q: { name?: string; slug?: string; tenantId?: string }): Promise<Result<SlugCheckWire>>;
  createCompany(body: CreateCompanyBody): Promise<Result<CreateCompanyWire>>;
  setActive(tenantId: string): Promise<Result<{ company: CompanyWire }>>;
  acceptInvitation(token: string): Promise<Result<AcceptWire>>;
  /** Which company and role a link is for, before anyone presses Accept (review T1-07). */
  previewInvitation(token: string): Promise<Result<InvitationPreviewWire>>;
  joinInvitation(invitationId: string): Promise<Result<AcceptWire>>;
  company(tenantId: string): Promise<Result<CompanyProfileWire>>;
  updateProfile(tenantId: string, body: ProfileBody): Promise<Result<{ company: CompanyWire }>>;
  updateBranding(tenantId: string, body: BrandingBody): Promise<Result<BrandingWire>>;
  /** Multipart, field "file"; no content-type header set by hand (the FormData sets its boundary). */
  uploadLogo(tenantId: string, file: Blob): Promise<Result<{ company: CompanyWire }>>;
  removeLogo(tenantId: string): Promise<Result<{ company: CompanyWire }>>;
  settings(tenantId: string): Promise<Result<SettingsWire>>;
  updateSettings(tenantId: string, section: string, body: SettingsBody): Promise<Result<{ section: SettingsSectionWire }>>;
  checklist(tenantId: string): Promise<Result<ChecklistWire>>;
  dismissChecklistItem(tenantId: string, itemKey: string): Promise<Result<ChecklistWire>>;
  /** Undo "Not needed" (review T1-13). */
  restoreChecklistItem(tenantId: string, itemKey: string): Promise<Result<ChecklistWire>>;
  hideChecklist(tenantId: string): Promise<Result<ChecklistWire>>;
  /** Bring a hidden list back (review T1-13). */
  showChecklist(tenantId: string): Promise<Result<ChecklistWire>>;
  team(tenantId: string): Promise<Result<TeamWire>>;
  changeRole(tenantId: string, userId: string, body: RoleBody): Promise<Result<{ member: MemberWire }>>;
  removeMember(tenantId: string, userId: string): Promise<Result<{ removed: string }>>;
  leave(tenantId: string): Promise<Result<{ left: string }>>;
  transfer(tenantId: string, body: TransferBody): Promise<Result<TeamWire>>;
  invitations(tenantId: string): Promise<Result<InvitationsWire>>;
  invite(tenantId: string, body: InviteBody): Promise<Result<IssuedWire>>;
  resendInvitation(tenantId: string, invitationId: string): Promise<Result<IssuedWire>>;
  revokeInvitation(tenantId: string, invitationId: string): Promise<Result<{ id: string }>>;
}

// ---------------------------------------------------------------------------
// Shape checks: only what the widget reads, with safe defaults for the rest
// ---------------------------------------------------------------------------

export const ROLE_KEYS: readonly RoleKey[] = ["owner", "admin", "member", "viewer"];
const STATUSES = ["active", "suspended"] as const;
const KINDS = ["org", "personal"] as const;
const TEXT_ON = ["#ffffff", "#111111"] as const;

export function roleKeyOrNull(value: unknown): RoleKey | null {
  return oneOf(value, ROLE_KEYS);
}

export function parseCompany(raw: unknown): CompanyWire | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.name) || !isString(raw.slug)) return null;
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    kind: oneOf(raw.kind, KINDS) ?? "org",
    status: oneOf(raw.status, STATUSES) ?? "active",
    logoUrl: strOrNull(raw.logoUrl),
    brandColor: strOrNull(raw.brandColor),
    onBrandColor: oneOf(raw.onBrandColor, TEXT_ON),
    publicPath: str(raw.publicPath) || `/t/${raw.slug}`,
    createdAt: str(raw.createdAt),
    role: roleKeyOrNull(raw.role),
    isOwner: isTrue(raw.isOwner),
  };
}

export function parseCompanyChoice(raw: unknown): CompanyChoiceWire | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.name)) return null;
  return {
    id: raw.id,
    name: raw.name,
    slug: str(raw.slug),
    logoUrl: strOrNull(raw.logoUrl),
    role: roleKeyOrNull(raw.role),
    status: oneOf(raw.status, STATUSES) ?? "active",
    active: isTrue(raw.active),
  };
}

export function parsePendingForMe(raw: unknown): PendingForMeWire | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.companyName)) return null;
  return {
    id: raw.id,
    companyName: raw.companyName,
    roleKey: roleKeyOrNull(raw.roleKey),
    roleName: str(raw.roleName, "Member") || "Member",
    invitedBy: strOrNull(raw.invitedBy),
    expiresAt: strOrNull(raw.expiresAt),
  };
}

export function parseSession(body: unknown): SessionWire | null {
  if (!isObject(body) || !isObject(body.user)) return null;
  const mode = oneOf(body.mode, ["companies", "personal"] as const);
  const state = oneOf(body.state, ["needs-onboarding", "ready", "suspended"] as const);
  if (!mode || !state || !isId(body.user.userId)) return null;
  const company = body.company === null || body.company === undefined ? null : parseCompany(body.company);
  // "ready" and "suspended" always name the company the page is about; a
  // session that says ready with no company is a broken answer, not an empty one.
  if (state !== "needs-onboarding" && !company) return null;
  return {
    mode,
    state,
    user: { userId: body.user.userId, email: strOrNull(body.user.email), name: strOrNull(body.user.name) },
    company: state === "needs-onboarding" ? null : company,
    companies: state === "needs-onboarding" ? [] : listOf(body.companies, parseCompanyChoice),
    invitations: state === "needs-onboarding" ? listOf(body.invitations, parsePendingForMe) : [],
    formerCompany: state === "needs-onboarding" ? strOrNull(body.formerCompany) : null,
  };
}

const SLUG_PROBLEMS: readonly SlugProblemWire[] = ["too-short", "too-long", "invalid", "reserved", "taken"];

export function parseSlugCheck(body: unknown): SlugCheckWire | null {
  if (!isObject(body) || !isString(body.slug) || typeof body.available !== "boolean") return null;
  return {
    slug: body.slug,
    available: body.available,
    problem: oneOf(body.problem, SLUG_PROBLEMS),
    message: strOrNull(body.message),
    suggestion: str(body.suggestion),
  };
}

export function parseCreateCompany(body: unknown): CreateCompanyWire | null {
  if (!isObject(body)) return null;
  const status = oneOf(body.status, ["created", "replayed", "already-onboarded"] as const);
  const company = parseCompany(body.company);
  return status && company ? { status, company } : null;
}

export function parseCompanyEnvelope(body: unknown): { company: CompanyWire } | null {
  const company = isObject(body) ? parseCompany(body.company) : null;
  return company ? { company } : null;
}

const ACCEPT_STATUSES = [
  "accepted",
  "already-a-member",
  "expired",
  "revoked",
  "wrong-email",
  "unknown",
  "company-unavailable",
  "seats-full",
] as const;

export function parseAccept(body: unknown): AcceptWire | null {
  if (!isObject(body)) return null;
  const status = oneOf(body.status, ACCEPT_STATUSES);
  if (!status) return null;
  const company =
    isObject(body.company) && isId(body.company.id) && isString(body.company.name)
      ? { id: body.company.id, name: body.company.name }
      : null;
  // Joined means joined SOMEWHERE: an "accepted" without the company would
  // send the person to a page that can't say where they are.
  if ((status === "accepted" || status === "already-a-member") && !company) return null;
  return { status, company, message: strOrNull(body.message) };
}

export function parseCompanyProfile(body: unknown): CompanyProfileWire | null {
  if (!isObject(body)) return null;
  const company = parseCompany(body.company);
  // `logoUploads` absent (an older server) reads as "switched on": the upload
  // then explains itself the old way, after a file is picked.
  return company ? { company, can: stringList(body.can), logoUploads: body.logoUploads !== false } : null;
}

export function parseBrandReport(raw: unknown): BrandColorReportWire | null {
  if (!isObject(raw) || !isString(raw.color)) return null;
  return {
    color: raw.color,
    textOnColor: oneOf(raw.textOnColor, TEXT_ON) ?? "#ffffff",
    ratioWithWhiteText: num(raw.ratioWithWhiteText, 1),
    ratioWithDarkText: num(raw.ratioWithDarkText, 1),
    ratioOnWhitePage: num(raw.ratioOnWhitePage, num(raw.ratioWithWhiteText, 1)),
    readable: isTrue(raw.readable),
    warning: strOrNull(raw.warning),
  };
}

export function parseBranding(body: unknown): BrandingWire | null {
  if (!isObject(body)) return null;
  const company = parseCompany(body.company);
  return company ? { company, brand: parseBrandReport(body.brand) } : null;
}

const FIELD_KINDS: readonly SettingsFieldKind[] = ["text", "textarea", "email", "tel", "url", "timezone", "select", "toggle", "number"];

function parseField(raw: unknown): SettingsFieldWire | null {
  if (!isObject(raw) || !isId(raw.key) || !isString(raw.label)) return null;
  const kind = oneOf(raw.kind, FIELD_KINDS);
  // A kind this version doesn't know is skipped, not guessed: a newer server
  // may add one, and rendering it as a text box could save the wrong type.
  if (!kind) return null;
  const options = Array.isArray(raw.options)
    ? listOf(raw.options, (o) => (isObject(o) && isString(o.value) && isString(o.label) ? { value: o.value, label: o.label } : null))
    : null;
  return {
    key: raw.key,
    label: raw.label,
    help: strOrNull(raw.help),
    kind,
    options,
    placeholder: strOrNull(raw.placeholder),
    autoComplete: strOrNull(raw.autoComplete),
    width: raw.width === "half" ? "half" : "full",
    required: isTrue(raw.required),
    min: numOrNull(raw.min),
    max: numOrNull(raw.max),
    step: numOrNull(raw.step),
  };
}

function parseValues(raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!isObject(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      out[key] = value;
    }
  }
  return out;
}

export function parseSettingsSection(raw: unknown): SettingsSectionWire | null {
  if (!isObject(raw) || !isId(raw.key) || !isString(raw.label) || !Array.isArray(raw.fields)) return null;
  return {
    key: raw.key,
    label: raw.label,
    description: strOrNull(raw.description),
    fields: listOf(raw.fields, parseField),
    values: parseValues(raw.values),
    canEdit: isTrue(raw.canEdit),
  };
}

export function parseSettings(body: unknown): SettingsWire | null {
  if (!isObject(body) || !Array.isArray(body.sections)) return null;
  return { sections: listOf(body.sections, parseSettingsSection) };
}

export function parseSectionEnvelope(body: unknown): { section: SettingsSectionWire } | null {
  const section = isObject(body) ? parseSettingsSection(body.section) : null;
  return section ? { section } : null;
}

function parseChecklistItem(raw: unknown): ChecklistItemWire | null {
  if (!isObject(raw) || !isId(raw.key) || !isString(raw.title)) return null;
  return {
    key: raw.key,
    title: raw.title,
    description: str(raw.description),
    actionLabel: str(raw.actionLabel),
    href: str(raw.href),
    done: isTrue(raw.done),
    dismissed: isTrue(raw.dismissed),
  };
}

export function parseChecklist(body: unknown): ChecklistWire | null {
  if (!isObject(body) || !Array.isArray(body.items)) return null;
  const items = listOf(body.items, parseChecklistItem);
  return {
    items,
    done: num(body.done, items.filter((i) => i.done).length),
    total: num(body.total, items.length),
    complete: isTrue(body.complete),
    hidden: isTrue(body.hidden),
  };
}

function parseRoleOption(raw: unknown): RoleOptionWire | null {
  if (!isObject(raw)) return null;
  const key = roleKeyOrNull(raw.key);
  if (!key) return null;
  return { key, name: str(raw.name, key) || key, description: str(raw.description), rank: num(raw.rank, 0) };
}

function roleList(raw: unknown): RoleKey[] {
  return listOf(raw, roleKeyOrNull);
}

export function parseMember(raw: unknown): MemberWire | null {
  if (!isObject(raw) || !isId(raw.userId)) return null;
  const actions = isObject(raw.actions) ? raw.actions : {};
  return {
    userId: raw.userId,
    name: strOrNull(raw.name),
    email: strOrNull(raw.email),
    roleKey: roleKeyOrNull(raw.roleKey),
    roleName: str(raw.roleName, "No role") || "No role",
    isOwner: isTrue(raw.isOwner),
    isYou: isTrue(raw.isYou),
    status: raw.status === "suspended" ? "suspended" : "active",
    joinedAt: str(raw.joinedAt),
    // What the caller may do to this row comes only from the server: a
    // missing or malformed `actions` grants nothing.
    actions: { roles: roleList(actions.roles), remove: isTrue(actions.remove), transferTo: isTrue(actions.transferTo) },
  };
}

export function parseTeam(body: unknown): TeamWire | null {
  if (!isObject(body) || !isObject(body.company) || !isObject(body.you) || !Array.isArray(body.members)) return null;
  if (!isId(body.company.id) || !isId(body.you.userId)) return null;
  const you = body.you;
  const seats =
    isObject(body.seats) && typeof body.seats.limit === "number"
      ? { limit: num(body.seats.limit), used: num(body.seats.used), pending: num(body.seats.pending) }
      : null;
  return {
    company: { id: body.company.id, name: str(body.company.name), kind: oneOf(body.company.kind, KINDS) ?? "org" },
    you: {
      userId: you.userId as string,
      roleKey: roleKeyOrNull(you.roleKey),
      isOwner: isTrue(you.isOwner),
      canInvite: isTrue(you.canInvite),
      canLeave: isTrue(you.canLeave),
      leaveBlocked: strOrNull(you.leaveBlocked),
      canTransfer: isTrue(you.canTransfer),
    },
    members: listOf(body.members, parseMember),
    roles: listOf(body.roles, parseRoleOption),
    invitableRoles: roleList(body.invitableRoles),
    seats,
  };
}

export function parseInvitation(raw: unknown): InvitationWire | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.email)) return null;
  return {
    id: raw.id,
    email: raw.email,
    roleKey: roleKeyOrNull(raw.roleKey),
    roleName: str(raw.roleName, "Member") || "Member",
    state: raw.state === "expired" ? "expired" : "pending",
    expiresAt: strOrNull(raw.expiresAt),
    createdAt: str(raw.createdAt),
    canResend: isTrue(raw.canResend),
    canRevoke: isTrue(raw.canRevoke),
    // An older server sends none: no note, never a made-up one.
    wrongAccount:
      isObject(raw.wrongAccount) && isString(raw.wrongAccount.at)
        ? { signedInAs: strOrNull(raw.wrongAccount.signedInAs), at: raw.wrongAccount.at }
        : null,
  };
}

export function parseInvitations(body: unknown): InvitationsWire | null {
  if (!isObject(body) || !Array.isArray(body.invitations)) return null;
  return { invitations: listOf(body.invitations, parseInvitation) };
}

export function parseIssued(body: unknown): IssuedWire | null {
  if (!isObject(body)) return null;
  const invitation = parseInvitation(body.invitation);
  const delivery = oneOf(body.delivery, ["sent", "skipped", "failed", "held"] as const);
  if (!invitation || !delivery) return null;
  return { invitation, delivery, link: strOrNull(body.link), replaced: isTrue(body.replaced), note: strOrNull(body.note) };
}

export function parsePreview(body: unknown): InvitationPreviewWire | null {
  if (!isObject(body) || typeof body.found !== "boolean") return null;
  return {
    found: body.found,
    companyName: strOrNull(body.companyName),
    roleName: strOrNull(body.roleName),
    invitedBy: strOrNull(body.invitedBy),
    // An older server sends none of these: null = "we don't know", never "it doesn't match".
    addressMatches: typeof body.addressMatches === "boolean" ? body.addressMatches : null,
    sentTo: strOrNull(body.sentTo),
    signedInAs: strOrNull(body.signedInAs),
  };
}

function stringField<K extends string>(key: K) {
  return (body: unknown): Record<K, string> | null =>
    isObject(body) && isId(body[key]) ? ({ [key]: body[key] } as Record<K, string>) : null;
}

const parseRemoved = stringField("removed");
const parseLeft = stringField("left");
const parseRevoked = stringField("id");

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

/** `v1/companies/{tenantId}{suffix}`, the id encoded. */
function companyPath(tenantId: string, suffix = ""): string {
  return `/v1/companies/${seg(tenantId)}${suffix}`;
}

export function createTenancyClient(options: TransportOptions): TenancyTransport {
  const http = createRequester(options);
  return {
    session: () => http.get("/v1/session", parseSession),
    checkSlug: (q) => http.get(`/v1/slug${queryString({ name: q.name, slug: q.slug, tenantId: q.tenantId })}`, parseSlugCheck),
    createCompany: (body) => http.post("/v1/companies", body, parseCreateCompany),
    setActive: (tenantId) => http.post("/v1/active", { tenantId }, parseCompanyEnvelope),
    acceptInvitation: (token) => http.post("/v1/invitations/accept", { token }, parseAccept),
    // A POST, not a GET with ?token=: the token is a bearer credential and a
    // query string ends up in access logs.
    previewInvitation: (token) => http.post("/v1/invitations/preview", { token }, parsePreview),
    joinInvitation: (invitationId) => http.post(`/v1/invitations/${seg(invitationId)}/join`, {}, parseAccept),
    company: (tenantId) => http.get(companyPath(tenantId), parseCompanyProfile),
    updateProfile: (tenantId, body) => http.post(companyPath(tenantId, "/profile"), body, parseCompanyEnvelope),
    updateBranding: (tenantId, body) => http.post(companyPath(tenantId, "/branding"), body, parseBranding),
    uploadLogo: (tenantId, file) => {
      const form = new FormData();
      form.append("file", file);
      return http.postForm(companyPath(tenantId, "/logo"), form, parseCompanyEnvelope);
    },
    removeLogo: (tenantId) => http.post(companyPath(tenantId, "/logo/remove"), {}, parseCompanyEnvelope),
    settings: (tenantId) => http.get(companyPath(tenantId, "/settings"), parseSettings),
    updateSettings: (tenantId, section, body) => http.post(companyPath(tenantId, `/settings/${seg(section)}`), body, parseSectionEnvelope),
    checklist: (tenantId) => http.get(companyPath(tenantId, "/checklist"), parseChecklist),
    dismissChecklistItem: (tenantId, itemKey) => http.post(companyPath(tenantId, `/checklist/${seg(itemKey)}/dismiss`), {}, parseChecklist),
    restoreChecklistItem: (tenantId, itemKey) => http.post(companyPath(tenantId, `/checklist/${seg(itemKey)}/restore`), {}, parseChecklist),
    hideChecklist: (tenantId) => http.post(companyPath(tenantId, "/checklist/hide"), {}, parseChecklist),
    showChecklist: (tenantId) => http.post(companyPath(tenantId, "/checklist/show"), {}, parseChecklist),
    team: (tenantId) => http.get(companyPath(tenantId, "/members"), parseTeam),
    changeRole: (tenantId, userId, body) =>
      http.post(companyPath(tenantId, `/members/${seg(userId)}/role`), body, (raw) => {
        const member = isObject(raw) ? parseMember(raw.member) : null;
        return member ? { member } : null;
      }),
    removeMember: (tenantId, userId) => http.post(companyPath(tenantId, `/members/${seg(userId)}/remove`), {}, parseRemoved),
    leave: (tenantId) => http.post(companyPath(tenantId, "/leave"), {}, parseLeft),
    transfer: (tenantId, body) => http.post(companyPath(tenantId, "/transfer"), body, parseTeam),
    invitations: (tenantId) => http.get(companyPath(tenantId, "/invitations"), parseInvitations),
    invite: (tenantId, body) => http.post(companyPath(tenantId, "/invitations"), body, parseIssued),
    resendInvitation: (tenantId, invitationId) => http.post(companyPath(tenantId, `/invitations/${seg(invitationId)}/resend`), {}, parseIssued),
    revokeInvitation: (tenantId, invitationId) => http.post(companyPath(tenantId, `/invitations/${seg(invitationId)}/revoke`), {}, parseRevoked),
  };
}

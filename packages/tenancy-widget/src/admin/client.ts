import { roleKeyOrNull } from "../client.js";
import {
  createRequester,
  isId,
  isObject,
  isString,
  isTrue,
  listOf,
  num,
  oneOf,
  queryString,
  seg,
  str,
  strOrNull,
  type Result,
  type TransportOptions,
} from "../http.js";
import type {
  AdminCompanyDetailWire,
  AdminCompanyListWire,
  AdminCompanyRowWire,
  AdminMemberWire,
  AdminPeopleWire,
  AdminPersonWire,
  AssignOwnerBody,
  AuditLineWire,
  PersonRefWire,
  StaffRoleBody,
  StaffRoleWire,
  SuspendBody,
} from "../types.js";

/**
 * The operator transport: `createTenancyOperatorHandlers`' routes (contract
 * 7.2), every answer checked narrowly. Its own module under ./admin, so a
 * customer's bundle never carries the console's routes or parsers.
 */

export interface TenancyAdminTransport {
  companies(q: {
    q?: string;
    kind?: "org" | "personal" | "all";
    status?: "active" | "suspended" | "all";
    page?: number;
    pageSize?: number;
  }): Promise<Result<AdminCompanyListWire>>;
  company(tenantId: string): Promise<Result<AdminCompanyDetailWire>>;
  suspend(tenantId: string, body: SuspendBody): Promise<Result<AdminCompanyDetailWire>>;
  reactivate(tenantId: string): Promise<Result<AdminCompanyDetailWire>>;
  /** Hand the company to an active member (the owner's account is gone; review T1-03). */
  assignOwner(tenantId: string, body: AssignOwnerBody): Promise<Result<AdminCompanyDetailWire>>;
  /** Free the company's old web addresses (review T1-07). */
  releaseAddresses(tenantId: string): Promise<Result<AdminCompanyDetailWire>>;
  people(q: { q?: string; staffOnly?: boolean; page?: number; pageSize?: number }): Promise<Result<AdminPeopleWire>>;
  staffRoles(): Promise<Result<{ roles: StaffRoleWire[] }>>;
  setStaffRole(userId: string, body: StaffRoleBody): Promise<Result<{ person: AdminPersonWire }>>;
}

const KINDS = ["org", "personal"] as const;
const STATUSES = ["active", "suspended"] as const;

export function parsePersonRef(raw: unknown): PersonRefWire | null {
  if (!isObject(raw) || !isId(raw.userId)) return null;
  return { userId: raw.userId, email: strOrNull(raw.email), name: strOrNull(raw.name) };
}

export function parseAdminCompanyRow(raw: unknown): AdminCompanyRowWire | null {
  if (!isObject(raw) || !isId(raw.id) || !isString(raw.name)) return null;
  return {
    id: raw.id,
    name: raw.name,
    slug: str(raw.slug),
    kind: oneOf(raw.kind, KINDS) ?? "org",
    status: oneOf(raw.status, STATUSES) ?? "active",
    createdAt: str(raw.createdAt),
    members: num(raw.members, 0),
    owner: parsePersonRef(raw.owner),
  };
}

function page(body: Record<string, unknown>) {
  return { total: num(body.total, 0), page: Math.max(1, num(body.page, 1)), pageSize: Math.max(1, num(body.pageSize, 25)) };
}

export function parseAdminCompanyList(body: unknown): AdminCompanyListWire | null {
  if (!isObject(body) || !Array.isArray(body.companies)) return null;
  return { companies: listOf(body.companies, parseAdminCompanyRow), ...page(body) };
}

function parseAdminMember(raw: unknown): AdminMemberWire | null {
  if (!isObject(raw) || !isId(raw.userId)) return null;
  return {
    userId: raw.userId,
    name: strOrNull(raw.name),
    email: strOrNull(raw.email),
    roleKey: roleKeyOrNull(raw.roleKey),
    roleName: str(raw.roleName, "No role") || "No role",
    isOwner: isTrue(raw.isOwner),
    status: raw.status === "suspended" ? "suspended" : "active",
    joinedAt: str(raw.joinedAt),
  };
}

function parseAuditLine(raw: unknown): AuditLineWire | null {
  if (!isObject(raw) || !isString(raw.at) || !isString(raw.action)) return null;
  return {
    at: raw.at,
    action: raw.action,
    label: str(raw.label, raw.action) || raw.action,
    actor: strOrNull(raw.actor),
    sensitive: isTrue(raw.sensitive),
    detail: strOrNull(raw.detail),
  };
}

export function parseAdminCompanyDetail(body: unknown): AdminCompanyDetailWire | null {
  if (!isObject(body) || !isObject(body.company)) return null;
  const row = parseAdminCompanyRow(body.company);
  if (!row) return null;
  const c = body.company;
  return {
    company: {
      ...row,
      publicPath: str(c.publicPath) || `/t/${row.slug}`,
      logoUrl: strOrNull(c.logoUrl),
      brandColor: strOrNull(c.brandColor),
      createdBy: parsePersonRef(c.createdBy),
      ownerDeleted: isTrue(c.ownerDeleted),
      suspendedAt: strOrNull(c.suspendedAt),
      suspendedReason: strOrNull(c.suspendedReason),
      suspendedBy: parsePersonRef(c.suspendedBy),
      timeZone: strOrNull(c.timeZone),
      contactEmail: strOrNull(c.contactEmail),
      contactPhone: strOrNull(c.contactPhone),
    },
    members: listOf(body.members, parseAdminMember),
    pendingInvitations: num(body.pendingInvitations, 0),
    invitations: Array.isArray(body.invitations)
      ? listOf(body.invitations, (raw) =>
          isObject(raw) && isString(raw.email)
            ? { email: raw.email, roleName: str(raw.roleName), invitedBy: strOrNull(raw.invitedBy), expiresAt: strOrNull(raw.expiresAt) }
            : null,
        )
      : [],
    retiredAddresses: Array.isArray(body.retiredAddresses) ? body.retiredAddresses.filter(isString) : [],
    // null means "the host connected no activity source", which the page says
    // in words; an array (even empty) means it's connected.
    activity: Array.isArray(body.activity) ? listOf(body.activity, parseAuditLine) : null,
    // What the console may offer comes only from the server; missing = no.
    can: {
      suspend: isObject(body.can) && isTrue(body.can.suspend),
      assignOwner: isObject(body.can) && isTrue(body.can.assignOwner),
      releaseAddresses: isObject(body.can) && isTrue(body.can.releaseAddresses),
    },
  };
}

export function parseStaffRole(raw: unknown): StaffRoleWire | null {
  if (!isObject(raw) || !isId(raw.key) || !isString(raw.name)) return null;
  return { key: raw.key, name: raw.name, rank: num(raw.rank, 0), assignable: isTrue(raw.assignable) };
}

export function parseAdminPerson(raw: unknown): AdminPersonWire | null {
  if (!isObject(raw) || !isId(raw.userId)) return null;
  const role = isObject(raw.staffRole) && isId(raw.staffRole.key) ? raw.staffRole : null;
  return {
    userId: raw.userId,
    email: strOrNull(raw.email),
    name: strOrNull(raw.name),
    createdAt: str(raw.createdAt),
    companies: num(raw.companies, 0),
    staffRole: role ? { key: role.key as string, name: str(role.name, role.key as string), rank: num(role.rank, 0) } : null,
    isYou: isTrue(raw.isYou),
    canChange: isTrue(raw.canChange),
  };
}

export function parseAdminPeople(body: unknown): AdminPeopleWire | null {
  if (!isObject(body) || !Array.isArray(body.people)) return null;
  const you = isObject(body.you) && isId(body.you.userId) ? { userId: body.you.userId, roleKey: strOrNull(body.you.roleKey) } : null;
  if (!you) return null;
  return {
    people: listOf(body.people, parseAdminPerson),
    ...page(body),
    roles: listOf(body.roles, parseStaffRole).sort((a, b) => b.rank - a.rank),
    you,
  };
}

function companyPath(tenantId: string, suffix = ""): string {
  return `/v1/admin/companies/${seg(tenantId)}${suffix}`;
}

export function createTenancyAdminClient(options: TransportOptions): TenancyAdminTransport {
  const http = createRequester(options);
  return {
    companies: (q) =>
      http.get(
        `/v1/admin/companies${queryString({ q: q.q, kind: q.kind, status: q.status, page: q.page, pageSize: q.pageSize })}`,
        parseAdminCompanyList,
      ),
    company: (tenantId) => http.get(companyPath(tenantId), parseAdminCompanyDetail),
    suspend: (tenantId, body) => http.post(companyPath(tenantId, "/suspend"), body, parseAdminCompanyDetail),
    reactivate: (tenantId) => http.post(companyPath(tenantId, "/reactivate"), {}, parseAdminCompanyDetail),
    assignOwner: (tenantId, body) => http.post(companyPath(tenantId, "/owner"), body, parseAdminCompanyDetail),
    releaseAddresses: (tenantId) => http.post(companyPath(tenantId, "/release-addresses"), {}, parseAdminCompanyDetail),
    people: (q) =>
      http.get(
        `/v1/admin/people${queryString({ q: q.q, staffOnly: q.staffOnly ? "true" : undefined, page: q.page, pageSize: q.pageSize })}`,
        parseAdminPeople,
      ),
    staffRoles: () =>
      http.get("/v1/admin/staff-roles", (body) =>
        isObject(body) && Array.isArray(body.roles) ? { roles: listOf(body.roles, parseStaffRole).sort((a, b) => b.rank - a.rank) } : null,
      ),
    setStaffRole: (userId, body) =>
      http.post(`/v1/admin/people/${seg(userId)}/staff-role`, body, (raw) => {
        const person = isObject(raw) ? parseAdminPerson(raw.person) : null;
        return person ? { person } : null;
      }),
  };
}

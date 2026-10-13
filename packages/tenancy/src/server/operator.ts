import {
  assignRoleTemplate,
  listRoleTemplates,
  RoleAssignmentError,
  roleOf,
} from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { parseFragment } from "../settings.js";
import { roleNameOf, roleOptions, type Ctx } from "./context.js";
import {
  asRoleKey,
  COMPANY_COLUMNS,
  companyRow,
  date,
  dateOrNull,
  likePattern,
  lockCompany,
  num,
  q,
  readCompany,
  readUser,
  statusOf,
  str,
  strOrNull,
  type CompanyRow,
} from "./db.js";
import { firstFreeSlug } from "./slugs.js";
import { handOver } from "./team.js";
import { publicPathOf } from "./views.js";
import type {
  AdminCompanyDetail,
  AdminCompanyList,
  AdminCompanyRow,
  AdminMember,
  AdminPeople,
  AdminPerson,
  PersonRef,
  RequestFacts,
  StaffRoleView,
  TenancyDb,
} from "./types.js";

/**
 * The operator (platform staff) functions (contract 6.11). Staff are NOT
 * company members (D15), so the membership gate is not in their path: every
 * function checks the caller's STAFF permissions first — none at all is
 * `not_staff`, the wrong key is `forbidden`.
 */
async function requireStaff(ctx: Ctx, db: TenancyDb, actorUserId: string, key: string): Promise<ReadonlySet<string>> {
  const set = await ctx.loaders(db).loadStaffPermissions({ principal: { userId: actorUserId } });
  if (set === null) throw ctx.fail("not_staff");
  const can = new Set(set.toArray());
  if (!can.has(key)) throw ctx.fail("forbidden");
  return can;
}

function pageOf(page: number | undefined, pageSize: number | undefined): { page: number; pageSize: number; offset: number } {
  const p = Number.isInteger(page) && (page as number) > 0 ? (page as number) : 1;
  const s = Number.isInteger(pageSize) && (pageSize as number) > 0 ? Math.min(pageSize as number, 100) : 25;
  return { page: p, pageSize: s, offset: (p - 1) * s };
}

function personRef(id: unknown, email: unknown, name: unknown): PersonRef | null {
  return typeof id === "string" ? { userId: id, email: strOrNull(email), name: strOrNull(name) } : null;
}

/**
 * Every company, searchable by name, web address, the owner's email, a
 * MEMBER's email (review R2 T1BO-09: "I'm Carl Crew and I can't get in" must
 * find the company Carl is in, not only the ones he owns) or the exact id;
 * filtered by kind (personal workspaces hidden by default) and status; newest
 * first; paged.
 */
export async function listCompanies(
  ctx: Ctx,
  input: {
    readonly actorUserId: string;
    readonly q?: string;
    readonly kind?: "org" | "personal" | "all";
    readonly status?: "active" | "suspended" | "all";
    readonly page?: number;
    readonly pageSize?: number;
  },
): Promise<AdminCompanyList> {
  await requireStaff(ctx, ctx.db, input.actorUserId, "staff.tenants.view");
  const { page, pageSize, offset } = pageOf(input.page, input.pageSize);
  const term = (input.q ?? "").trim().slice(0, 100);
  const kind = input.kind ?? "org";
  const status = input.status ?? "all";
  const where = sql.join(
    [
      sql`t.deleted_at is null`,
      ...(kind === "all" ? [] : [sql`t.kind = ${kind}`]),
      ...(status === "active" ? [sql`t.suspended_at is null`] : status === "suspended" ? [sql`t.suspended_at is not null`] : []),
      ...(term
        ? [
            sql`(t.name ilike ${likePattern(term)} escape '\\' or t.slug ilike ${likePattern(term)} escape '\\'
                 or o.email ilike ${likePattern(term)} escape '\\' or t.id = ${term}
                 or exists (select 1 from tenant_members sm join users su on su.id = sm.user_id
                            where sm.tenant_id = t.id and su.email ilike ${likePattern(term)} escape '\\'))`,
          ]
        : []),
    ],
    sql` and `,
  );
  const totalRows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/admin-companies-count */
      select count(*) as n from tenants t left join users o on o.id = t.owner_user_id where ${where}`,
  );
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/admin-companies */
      select t.id, t.name, t.slug, t.kind, t.suspended_at, t.created_at, t.owner_user_id,
             o.email as owner_email, o.display_name as owner_name,
             (select count(*) from tenant_members m where m.tenant_id = t.id and m.status = 'active') as members
      from tenants t left join users o on o.id = t.owner_user_id
      where ${where}
      order by t.created_at desc, t.id desc
      limit ${pageSize} offset ${offset}`,
  );
  return {
    companies: rows.map((r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      slug: str(r["slug"]),
      kind: r["kind"] === "personal" ? "personal" : "org",
      status: dateOrNull(r["suspended_at"]) === null ? "active" : "suspended",
      createdAt: date(r["created_at"]),
      members: num(r["members"]),
      owner: personRef(r["owner_user_id"], r["owner_email"], r["owner_name"]),
    })),
    total: num(totalRows[0]?.["n"]),
    page,
    pageSize,
  };
}

async function detailOf(ctx: Ctx, db: TenancyDb, company: CompanyRow, can: ReadonlySet<string>): Promise<AdminCompanyDetail> {
  const options = await roleOptions(db, company.id);
  const people = await q(
    db,
    sql`/* adminigloo:tenancy/admin-people-refs */
      select id, email, display_name, deleted_at from users
      where id in (${sql.join(
        [company.ownerUserId, company.createdBy, company.suspendedBy].filter((v): v is string => v !== null).map((v) => sql`${v}`).concat(sql`''`),
        sql`, `,
      )})`,
  );
  const ref = (id: string | null): PersonRef | null => {
    if (!id) return null;
    const row = people.find((p) => p["id"] === id);
    return row ? personRef(row["id"], row["email"], row["display_name"]) : { userId: id, email: null, name: null };
  };
  const ownerRow = people.find((p) => p["id"] === company.ownerUserId);
  const memberRows = await q(
    db,
    sql`/* adminigloo:tenancy/admin-members */
      select m.user_id, m.status, m.created_at, u.email, u.display_name, rt.key as role_key
      from tenant_members m
      left join users u on u.id = m.user_id
      left join principal_role pr on pr.principal_id = m.user_id and pr.scope = 'tenant' and pr.tenant_id = m.tenant_id
      left join role_template rt on rt.id = pr.template_id
      where m.tenant_id = ${company.id}
      order by (m.user_id = ${company.ownerUserId ?? ""}) desc, coalesce(rt.rank, 0) desc, m.created_at`,
  );
  const members: AdminMember[] = memberRows.map((r) => {
    const key = strOrNull(r["role_key"]);
    return {
      userId: str(r["user_id"]),
      name: strOrNull(r["display_name"]),
      email: strOrNull(r["email"]),
      roleKey: asRoleKey(key),
      roleName: roleNameOf(options, key),
      isOwner: r["user_id"] === company.ownerUserId,
      status: r["status"] === "active" ? "active" : "suspended",
      joinedAt: date(r["created_at"]),
    };
  });
  const pending = await q(
    db,
    sql`/* adminigloo:tenancy/admin-pending */
      select i.email, i.expires_at, rt.key as role_key, u.display_name as inviter_name, u.email as inviter_email
      from tenant_invitations i
      left join role_template rt on rt.id = i.template_id
      left join users u on u.id = i.invited_by
      where i.tenant_id = ${company.id} and i.accepted_at is null and i.revoked_at is null
        and (i.expires_at is null or i.expires_at > ${ctx.now()})
      order by i.created_at desc, i.id desc`,
  );
  const retired = await q(
    db,
    sql`/* adminigloo:tenancy/admin-retired */ select slug from tenant_retired_slugs where tenant_id = ${company.id} order by retired_at desc, slug`,
  );
  const fragment = ctx.settings.get("company");
  const details = fragment
    ? parseFragment(fragment, (company.settings as Record<string, unknown> | null)?.["company"]).value
    : {};
  const row: AdminCompanyRow = {
    id: company.id,
    name: company.name,
    slug: company.slug,
    kind: company.kind,
    status: statusOf(company),
    createdAt: company.createdAt,
    members: members.filter((m) => m.status === "active").length,
    owner: ref(company.ownerUserId),
  };
  return {
    company: {
      ...row,
      publicPath: publicPathOf(company.slug),
      logoUrl: company.branding.logoUrl ?? null,
      brandColor: company.branding.brandColor ?? null,
      createdBy: ref(company.createdBy),
      ownerDeleted: company.ownerUserId !== null && (!ownerRow || dateOrNull(ownerRow["deleted_at"]) !== null),
      suspendedAt: company.suspendedAt,
      suspendedReason: company.suspendedReason,
      suspendedBy: ref(company.suspendedBy),
      timeZone: strOrNull(details["timeZone"]),
      contactEmail: strOrNull(details["contactEmail"]),
      contactPhone: strOrNull(details["contactPhone"]),
    },
    members,
    pendingInvitations: pending.length,
    invitations: pending.map((r) => ({
      email: str(r["email"]),
      roleName: roleNameOf(options, strOrNull(r["role_key"])),
      invitedBy: strOrNull(r["inviter_name"]) ?? strOrNull(r["inviter_email"]),
      expiresAt: dateOrNull(r["expires_at"]),
    })),
    retiredAddresses: retired.map((r) => str(r["slug"])),
    activity: null,
    can: {
      suspend: can.has("staff.tenants.suspend"),
      assignOwner: can.has("staff.tenants.transfer"),
      releaseAddresses: can.has("staff.tenants.suspend"),
    },
  };
}

async function liveCompany(ctx: Ctx, db: TenancyDb, tenantId: string, lock: boolean): Promise<CompanyRow> {
  const company = lock ? await lockCompany(db, tenantId) : await readCompany(db, tenantId);
  if (!company || company.deletedAt !== null) throw ctx.fail("not_found");
  return company;
}

export async function getCompanyDetail(ctx: Ctx, input: { readonly actorUserId: string; readonly tenantId: string }): Promise<AdminCompanyDetail> {
  const can = await requireStaff(ctx, ctx.db, input.actorUserId, "staff.tenants.view");
  return detailOf(ctx, ctx.db, await liveCompany(ctx, ctx.db, input.tenantId, false), can);
}

type OperatorMutation = { readonly actorUserId: string; readonly tenantId: string; readonly request?: RequestFacts };

/**
 * Suspend a company (staff.tenants.suspend). Everyone in it loses access on
 * their next request (the gate answers company-suspended) until it is
 * reactivated; its web address stops resolving. Idempotent: suspending a
 * suspended company keeps the first time and reason. The reason is shown to
 * staff only.
 */
export async function suspendCompany(ctx: Ctx, input: OperatorMutation & { readonly reason: string }): Promise<AdminCompanyDetail> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw ctx.fail("invalid", { issues: [{ path: ["reason"], message: "Write a short reason (3 to 500 characters). Only staff see it." }] });
  }
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const can = await requireStaff(ctx, tx, input.actorUserId, "staff.tenants.suspend");
    const company = await liveCompany(ctx, tx, input.tenantId, true);
    if (company.suspendedAt !== null) return { detail: await detailOf(ctx, tx, company, can), changed: false };
    const at = ctx.now();
    await tx.execute(sql`/* adminigloo:tenancy/suspend */
      update tenants set suspended_at = ${at}, suspended_reason = ${reason}, suspended_by = ${input.actorUserId}, updated_at = now()
      where id = ${company.id}`);
    await ctx.audit(tx, {
      action: "company.suspended",
      actorUserId: input.actorUserId,
      scope: "staff",
      tenantId: company.id,
      resourceType: "tenant",
      resourceId: company.id,
      metadata: { reason },
      request: input.request ?? null,
    });
    const next = { ...company, suspendedAt: at, suspendedReason: reason, suspendedBy: input.actorUserId };
    return { detail: await detailOf(ctx, tx, next, can), changed: true };
  });
  if (out.changed) ctx.emit({ type: "company.suspended", tenantId: input.tenantId, by: input.actorUserId });
  return out.detail;
}

export async function reactivateCompany(ctx: Ctx, input: OperatorMutation): Promise<AdminCompanyDetail> {
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const can = await requireStaff(ctx, tx, input.actorUserId, "staff.tenants.suspend");
    const company = await liveCompany(ctx, tx, input.tenantId, true);
    if (company.suspendedAt === null) return { detail: await detailOf(ctx, tx, company, can), changed: false };
    await tx.execute(sql`/* adminigloo:tenancy/reactivate */
      update tenants set suspended_at = null, suspended_reason = null, suspended_by = null, updated_at = now() where id = ${company.id}`);
    await ctx.audit(tx, {
      action: "company.reactivated",
      actorUserId: input.actorUserId,
      scope: "staff",
      tenantId: company.id,
      resourceType: "tenant",
      resourceId: company.id,
      metadata: { suspendedReason: company.suspendedReason },
      request: input.request ?? null,
    });
    const next = { ...company, suspendedAt: null, suspendedReason: null, suspendedBy: null };
    return { detail: await detailOf(ctx, tx, next, can), changed: true };
  });
  if (out.changed) ctx.emit({ type: "company.reactivated", tenantId: input.tenantId, by: input.actorUserId });
  return out.detail;
}

/**
 * Give a company a new owner from the console (staff.tenants.transfer;
 * review T1-03). The way out of the dead end where the owner closed their
 * account: nobody inside can transfer (only the owner can), nobody can remove
 * the owner, and every owner-only act would be blocked for good — short of
 * someone running SQL against production. Limited to ACTIVE members; the
 * previous owner (if still listed) becomes an Admin, exactly as in a
 * transfer, so D4 holds. Audited at staff scope with the staff actor.
 */
export async function assignOwner(ctx: Ctx, input: OperatorMutation & { readonly toUserId: string }): Promise<AdminCompanyDetail> {
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const can = await requireStaff(ctx, tx, input.actorUserId, "staff.tenants.transfer");
    const company = await liveCompany(ctx, tx, input.tenantId, true);
    const target = await q(
      tx,
      sql`/* adminigloo:tenancy/admin-owner-target */
        select m.user_id from tenant_members m join users u on u.id = m.user_id
        where m.tenant_id = ${company.id} and m.user_id = ${input.toUserId} and m.status = 'active' and u.deleted_at is null`,
    );
    if (target.length === 0) throw ctx.fail("not_found", undefined, "Choose someone who is an active member of this company.");
    const from = company.ownerUserId;
    if (from === input.toUserId) return { detail: await detailOf(ctx, tx, company, can), from };
    await handOver(ctx, tx, company, from, input.toUserId, "operator:assignOwner");
    await ctx.audit(tx, {
      action: "company.ownership.transferred",
      actorUserId: input.actorUserId,
      scope: "staff",
      tenantId: company.id,
      resourceType: "tenant",
      resourceId: company.id,
      metadata: { from, to: input.toUserId, via: "operator" },
      request: input.request ?? null,
    });
    return { detail: await detailOf(ctx, tx, { ...company, ownerUserId: input.toUserId }, can), from };
  });
  if (out.from !== input.toUserId) {
    ctx.emit({ type: "ownership.transferred", tenantId: input.tenantId, from: out.from ?? "", to: input.toUserId });
  }
  return out.detail;
}

/**
 * Release a company's old web addresses (staff.tenants.suspend; review T1-07):
 * they stop redirecting here and anyone can claim them. For a squatter, or a
 * business whose old name another business now needs.
 *
 * FOR A SUSPENDED COMPANY, ITS CURRENT ADDRESS TOO (review R2 SEC-T1-C). A
 * squatter's company is suspended first; then its current address moves to a
 * neutral `co-<id>` one and the name is free. Without this, a real business
 * finding "acme-plumbing" squatted needed someone to run SQL. An ACTIVE
 * company's current address is never taken away here (suspend it first, so a
 * paying customer can't lose its address to a mis-click). Suspension alone
 * doesn't free it either: a suspension for an unpaid bill is usually lifted,
 * and the business should come back to its own address.
 */
export async function releaseRetiredAddresses(ctx: Ctx, input: OperatorMutation): Promise<AdminCompanyDetail> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const can = await requireStaff(ctx, tx, input.actorUserId, "staff.tenants.suspend");
    let company = await liveCompany(ctx, tx, input.tenantId, true);
    const released = await q(
      tx,
      sql`/* adminigloo:tenancy/release-retired */ delete from tenant_retired_slugs where tenant_id = ${company.id} returning slug`,
    );
    let current: { from: string; to: string } | null = null;
    if (company.suspendedAt !== null && company.kind === "org") {
      const neutral = await firstFreeSlug(ctx, tx, `co-${company.id.replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase()}`, company.id);
      if (neutral !== company.slug) {
        await tx.execute(sql`/* adminigloo:tenancy/release-current */
          update tenants set slug = ${neutral}, updated_at = now() where id = ${company.id}`);
        await tx.execute(sql`/* adminigloo:tenancy/log-slug-change */
          insert into tenant_slug_changes (id, tenant_id, from_slug, to_slug, changed_by, changed_at)
          values (${uuidv7()}, ${company.id}, ${company.slug}, ${neutral}, null, ${ctx.now()})`);
        current = { from: company.slug, to: neutral };
        company = { ...company, slug: neutral };
      }
    }
    if (released.length > 0 || current) {
      await ctx.audit(tx, {
        action: "company.addresses.released",
        actorUserId: input.actorUserId,
        scope: "staff",
        tenantId: company.id,
        resourceType: "tenant",
        resourceId: company.id,
        metadata: { slugs: released.map((r) => str(r["slug"])), ...(current ? { current } : {}) },
        request: input.request ?? null,
      });
    }
    return detailOf(ctx, tx, company, can);
  });
}

async function staffRoleViews(db: TenancyDb, actorRank: number, topRank: number): Promise<StaffRoleView[]> {
  const templates = await listRoleTemplates(db, { scope: "staff" });
  return templates.map((t) => ({
    key: t.key,
    name: t.name,
    rank: t.rank,
    // Strictly below you — or, at the very top, your own rank (review T1-09:
    // administrators can make another administrator).
    assignable: actorRank > t.rank || (actorRank === topRank && t.rank === topRank),
  }));
}

async function personFacts(
  ctx: Ctx,
  db: TenancyDb,
  actorUserId: string,
): Promise<{ can: ReadonlySet<string>; rank: number; key: string | null; topRank: number }> {
  const set = await ctx.loaders(db).loadStaffPermissions({ principal: { userId: actorUserId } });
  if (set === null) throw ctx.fail("not_staff");
  const role = await roleOf(db, { principalId: actorUserId, scope: "staff" });
  const templates = await listRoleTemplates(db, { scope: "staff" });
  return { can: new Set(set.toArray()), rank: role?.rank ?? 0, key: role?.key ?? null, topRank: templates[0]?.rank ?? 0 };
}

function canChange(actor: { userId: string; rank: number; topRank: number; can: ReadonlySet<string> }, targetId: string, targetRank: number): boolean {
  if (!actor.can.has("staff.roles.manage") || actor.userId === targetId) return false;
  return actor.rank > targetRank || (actor.rank === actor.topRank && targetRank <= actor.rank);
}

export async function listPeople(
  ctx: Ctx,
  input: { readonly actorUserId: string; readonly q?: string; readonly staffOnly?: boolean; readonly page?: number; readonly pageSize?: number },
): Promise<AdminPeople> {
  const actor = await personFacts(ctx, ctx.db, input.actorUserId);
  if (!actor.can.has("staff.people.view")) throw ctx.fail("forbidden");
  const { page, pageSize, offset } = pageOf(input.page, input.pageSize);
  const term = (input.q ?? "").trim().slice(0, 100);
  const where = sql.join(
    [
      sql`u.deleted_at is null`,
      ...(term ? [sql`(u.email ilike ${likePattern(term)} escape '\\' or u.display_name ilike ${likePattern(term)} escape '\\')`] : []),
      ...(input.staffOnly ? [sql`sr.principal_id is not null`] : []),
    ],
    sql` and `,
  );
  const from = sql`users u
    left join principal_role sr on sr.principal_id = u.id and sr.scope = 'staff' and sr.tenant_id = '*'
    left join role_template st on st.id = sr.template_id`;
  const total = await q(ctx.db, sql`/* adminigloo:tenancy/admin-people-count */ select count(*) as n from ${from} where ${where}`);
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/admin-people */
      select u.id, u.email, u.display_name, u.created_at, st.key as staff_key, st.name as staff_name, st.rank as staff_rank,
             (select count(*) from tenant_members m where m.user_id = u.id and m.status = 'active') as companies
      from ${from}
      where ${where}
      order by u.created_at desc, u.id desc
      limit ${pageSize} offset ${offset}`,
  );
  const actorRef = { userId: input.actorUserId, rank: actor.rank, topRank: actor.topRank, can: actor.can };
  return {
    people: rows.map((r) => personOf(r, actorRef)),
    total: num(total[0]?.["n"]),
    page,
    pageSize,
    roles: await staffRoleViews(ctx.db, actor.rank, actor.topRank),
    you: { userId: input.actorUserId, roleKey: actor.key },
  };
}

function personOf(r: Record<string, unknown>, actor: { userId: string; rank: number; topRank: number; can: ReadonlySet<string> }): AdminPerson {
  const key = strOrNull(r["staff_key"]);
  const rank = key ? num(r["staff_rank"]) : 0;
  return {
    userId: str(r["id"]),
    email: strOrNull(r["email"]),
    name: strOrNull(r["display_name"]),
    createdAt: date(r["created_at"]),
    companies: num(r["companies"]),
    staffRole: key ? { key, name: str(r["staff_name"]), rank } : null,
    isYou: r["id"] === actor.userId,
    canChange: canChange(actor, str(r["id"]), rank),
  };
}

export async function listStaffRoles(ctx: Ctx, input: { readonly actorUserId: string }): Promise<StaffRoleView[]> {
  const actor = await personFacts(ctx, ctx.db, input.actorUserId);
  if (!actor.can.has("staff.roles.view")) throw ctx.fail("forbidden");
  return staffRoleViews(ctx.db, actor.rank, actor.topRank);
}

/**
 * Give, change or take away someone's staff role (staff.roles.manage), the
 * People screen's picker (PC-04/TB-09). Through `assignRoleTemplate`: the rank
 * guard, never yourself, and the last administrator can't be removed.
 * `topRankPeers` lets an administrator make (or unmake) another administrator
 * (review T1-09) — without it nobody outranks an admin and a second one needed
 * shell access.
 */
export async function setStaffRole(
  ctx: Ctx,
  input: { readonly actorUserId: string; readonly targetUserId: string; readonly templateKey: string | null; readonly request?: RequestFacts },
): Promise<AdminPerson> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const actor = await personFacts(ctx, tx, input.actorUserId);
    if (!actor.can.has("staff.roles.manage")) throw ctx.fail("forbidden");
    const target = await readUser(tx, input.targetUserId);
    if (!target) throw ctx.fail("not_found");
    let assignment;
    try {
      assignment = await assignRoleTemplate(tx, {
        scope: "staff",
        principalId: target.id,
        templateKey: input.templateKey,
        actor: { principalId: input.actorUserId },
        protectLastKey: "admin",
        clearOverrides: "on-removal",
        topRankPeers: true,
      });
    } catch (error) {
      if (error instanceof RoleAssignmentError) {
        if (error.code === "last-holder") throw ctx.fail("last_admin");
        if (error.code === "rank") throw ctx.fail("rank", undefined, "Only someone above them can change this.");
        if (error.code === "self") throw ctx.fail("self");
        throw ctx.fail("invalid", { issues: [{ path: ["templateKey"], message: "Choose one of the staff roles listed." }] });
      }
      throw error;
    }
    if (assignment.changed) {
      await ctx.audit(tx, {
        action: assignment.next ? "staff.role.assigned" : "staff.role.removed",
        actorUserId: input.actorUserId,
        scope: "staff",
        tenantId: null,
        resourceType: "staff_role",
        resourceId: target.id,
        metadata: {
          person: target.name ?? target.email,
          from: assignment.previous?.key ?? null,
          to: assignment.next?.key ?? null,
          clearedOverrides: assignment.clearedOverrides,
        },
        request: input.request ?? null,
      });
    }
    const rows = await q(
      tx,
      sql`/* adminigloo:tenancy/admin-person */
        select u.id, u.email, u.display_name, u.created_at, st.key as staff_key, st.name as staff_name, st.rank as staff_rank,
               (select count(*) from tenant_members m where m.user_id = u.id and m.status = 'active') as companies
        from users u
        left join principal_role sr on sr.principal_id = u.id and sr.scope = 'staff' and sr.tenant_id = '*'
        left join role_template st on st.id = sr.template_id
        where u.id = ${target.id}`,
    );
    return personOf(rows[0]!, { userId: input.actorUserId, rank: actor.rank, topRank: actor.topRank, can: actor.can });
  });
}

/** `/t/{slug}`: the public face (no permission). Suspended and deleted companies don't resolve; a retired address follows to its company. */
export async function resolveCompanyBySlug(
  ctx: Ctx,
  slug: string,
): Promise<{ company: import("./types.js").PublicCompany; retiredSlug: string | null } | null> {
  const wanted = slug.trim().toLowerCase();
  if (!wanted || wanted.length > 64) return null;
  let rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/slug-current */
      select ${COMPANY_COLUMNS} from tenants t where t.slug = ${wanted} and t.kind = 'org'`,
  );
  let retiredSlug: string | null = null;
  if (rows.length === 0) {
    rows = await q(
      ctx.db,
      sql`/* adminigloo:tenancy/slug-retired */
        select ${COMPANY_COLUMNS} from tenant_retired_slugs r join tenants t on t.id = r.tenant_id
        where r.slug = ${wanted} and t.kind = 'org'`,
    );
    retiredSlug = rows.length > 0 ? wanted : null;
  }
  if (!rows[0]) return null;
  const company = companyRow(rows[0]);
  if (company.deletedAt !== null || company.suspendedAt !== null) return null;
  const fragment = ctx.settings.get("company");
  const details = fragment ? parseFragment(fragment, (company.settings as Record<string, unknown> | null)?.["company"]).value : {};
  return {
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      logoUrl: company.branding.logoUrl ?? null,
      brandColor: company.branding.brandColor ?? null,
      onBrandColor: company.branding.onBrandColor ?? null,
      contactEmail: strOrNull(details["contactEmail"]),
      contactPhone: strOrNull(details["contactPhone"]),
    },
    retiredSlug,
  };
}

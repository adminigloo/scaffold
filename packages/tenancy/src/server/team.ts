import { assignRoleTemplate, resolvePermissionsFor, RoleAssignmentError } from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { normaliseCompanyName } from "../slug.js";
import type { RoleKey, RoleOptionWire } from "../wire.js";
import {
  rankOf,
  requireActor,
  requireLive,
  roleKeyOf,
  roleNameOf,
  roleOptions,
  type ActorFacts,
  type Ctx,
} from "./context.js";
import { asRoleKey, date, lockCompany, num, q, readCompany, str, strOrNull, type CompanyRow } from "./db.js";
import { revokeOpenInvitationsBy } from "./invitation-rules.js";
import type { MemberView, RequestFacts, TeamView, TenancyDb } from "./types.js";

const ASSIGNABLE: readonly RoleKey[] = ["admin", "member", "viewer"];

interface MemberRow {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly status: "active" | "suspended";
  readonly joinedAt: Date;
  readonly roleKey: string | null;
  readonly rank: number;
}

async function memberRows(db: TenancyDb, tenantId: string): Promise<MemberRow[]> {
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/team-members */
      select m.user_id, m.status, m.created_at, u.display_name, u.email, rt.key as role_key, coalesce(rt.rank, 0) as rank
      from tenant_members m
      left join users u on u.id = m.user_id
      left join principal_role pr on pr.principal_id = m.user_id and pr.scope = 'tenant' and pr.tenant_id = m.tenant_id
      left join role_template rt on rt.id = pr.template_id
      where m.tenant_id = ${tenantId}`,
  );
  return rows.map((r) => ({
    userId: str(r["user_id"]),
    name: strOrNull(r["display_name"]),
    email: strOrNull(r["email"]),
    status: r["status"] === "active" ? "active" : "suspended",
    joinedAt: date(r["created_at"]),
    roleKey: strOrNull(r["role_key"]),
    rank: num(r["rank"]),
  }));
}

/**
 * What the caller may do to one row: computed on the SERVER from the caller's
 * own role and permissions, so the widget never works a rank out itself and
 * never offers a button the server would refuse (the property test in
 * team.test.ts holds these to what the mutations accept).
 */
function actionsFor(
  caller: { userId: string; can: ReadonlySet<string>; rank: number; isOwner: boolean },
  target: MemberRow,
  company: CompanyRow,
  options: readonly RoleOptionWire[],
): MemberView["actions"] {
  const isTargetOwner = company.ownerUserId === target.userId;
  const self = caller.userId === target.userId;
  const outranks = caller.rank > target.rank;
  const roles =
    caller.can.has("members.role.change") && !self && !isTargetOwner && outranks && target.status === "active"
      ? ASSIGNABLE.filter((k) => k !== target.roleKey && caller.rank > rankOf(options, k))
      : [];
  return {
    roles,
    remove: caller.can.has("members.remove") && !self && !isTargetOwner && outranks,
    transferTo: caller.isOwner && caller.can.has("tenant.transfer") && target.status === "active" && !self,
  };
}

function memberView(
  row: MemberRow,
  company: CompanyRow,
  callerUserId: string,
  options: readonly RoleOptionWire[],
  actions: MemberView["actions"],
): MemberView {
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    roleKey: asRoleKey(row.roleKey),
    roleName: roleNameOf(options, row.roleKey),
    isOwner: company.ownerUserId === row.userId,
    isYou: row.userId === callerUserId,
    status: row.status,
    joinedAt: row.joinedAt,
    actions,
  };
}

/** Build the team page's view on `db` for a caller whose facts are already resolved. */
export async function buildTeam(ctx: Ctx, db: TenancyDb, company: CompanyRow, callerUserId: string, facts: ActorFacts): Promise<TeamView> {
  const options = await roleOptions(db, company.id);
  const rows = await memberRows(db, company.id);
  const isOwner = company.ownerUserId === callerUserId;
  const caller = { userId: callerUserId, can: facts.can, rank: facts.role?.rank ?? 0, isOwner };
  const members = rows
    .map((row) => memberView(row, company, callerUserId, options, actionsFor(caller, row, company, options)))
    .sort((a, b) => {
      if (a.isOwner !== b.isOwner) return a.isOwner ? -1 : 1;
      const r = rankOf(options, b.roleKey) - rankOf(options, a.roleKey);
      if (r !== 0) return r;
      return (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "");
    });
  const personalInCompanies = ctx.mode === "companies" && company.kind === "personal";
  const invitableRoles =
    facts.can.has("members.invite") && !personalInCompanies ? ASSIGNABLE.filter((k) => caller.rank > rankOf(options, k)) : [];

  let seats: TeamView["seats"] = null;
  if (ctx.seats) {
    const limit = await ctx.seats.limitFor(db, company.id);
    if (typeof limit === "number") {
      const counts = await seatCounts(db, company.id, ctx.now(), null);
      seats = { limit, used: counts.active, pending: counts.pending };
    }
  }

  return {
    company: { id: company.id, name: company.name, kind: company.kind },
    you: {
      userId: callerUserId,
      roleKey: roleKeyOf(facts.role?.key),
      isOwner,
      canInvite: invitableRoles.length > 0,
      canLeave: !isOwner,
      leaveBlocked: isOwner ? ctx.fail("last_owner").message : null,
      canTransfer: isOwner && facts.can.has("tenant.transfer"),
    },
    members,
    roles: options,
    invitableRoles,
    seats,
  };
}

/** Active members and open (pending, unexpired) invitations, optionally leaving one address out. */
export async function seatCounts(
  db: TenancyDb,
  tenantId: string,
  now: Date,
  exceptEmail: string | null,
): Promise<{ active: number; pending: number }> {
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/seat-counts */
      select
        (select count(*) from tenant_members where tenant_id = ${tenantId} and status = 'active') as active,
        (select count(*) from tenant_invitations
          where tenant_id = ${tenantId} and accepted_at is null and revoked_at is null
            and (expires_at is null or expires_at > ${now})
            and email <> ${exceptEmail ?? ""}) as pending`,
  );
  return { active: num(rows[0]?.["active"]), pending: num(rows[0]?.["pending"]) };
}

/** The team page (members.view). */
export async function getTeam(ctx: Ctx, input: { readonly actorUserId: string; readonly tenantId: string }): Promise<TeamView> {
  const facts = await requireActor(ctx, ctx.db, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "members.view" });
  const company = requireLive(ctx, await readCompany(ctx.db, input.tenantId));
  return buildTeam(ctx, ctx.db, company, input.actorUserId, facts);
}

function mapRoleError(ctx: Ctx, error: unknown): never {
  if (error instanceof RoleAssignmentError) {
    if (error.code === "self") throw ctx.fail("self");
    if (error.code === "rank") throw ctx.fail("rank");
    if (error.code === "unknown-template") throw ctx.fail("invalid", { issues: [{ path: ["roleKey"], message: "Choose one of the roles listed." }] });
    if (error.code === "last-holder") throw ctx.fail("last_admin");
  }
  throw error;
}

type Mutation = { readonly actorUserId: string; readonly tenantId: string; readonly request?: RequestFacts };

/**
 * Change a member's role (members.role.change), under the company lock (D7).
 * Owner is never a role you give (D5: use Transfer); the owner can't be
 * changed; nobody changes themselves; the rank guard is strictly greater.
 *
 * D12: their per-person overrides in this company are cleared — they were set
 * relative to the old role, and a demotion that kept an `allow tenant.edit`
 * override would be a demotion that did nothing. The cleared keys are audited.
 *
 * A DEMOTION ALSO WITHDRAWS the open invitations they can no longer send
 * (review T1-03): all of them when the new role can't invite at all, else
 * the ones carrying a role at or above their new rank (review R2 SEC-T1-F).
 */
export async function changeMemberRole(
  ctx: Ctx,
  input: Mutation & { readonly targetUserId: string; readonly roleKey: RoleKey },
): Promise<MemberView> {
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "members.role.change" });
    if (input.roleKey === "owner") throw ctx.fail("owner_must_transfer");
    const rows = await memberRows(tx, company.id);
    const target = rows.find((r) => r.userId === input.targetUserId && r.status === "active");
    if (!target) throw ctx.fail("not_found");
    if (target.userId === input.actorUserId) throw ctx.fail("self");
    if (company.ownerUserId === target.userId) throw ctx.fail("owner_protected");

    let assignment;
    try {
      assignment = await assignRoleTemplate(tx, {
        scope: "tenant",
        tenantId: company.id,
        principalId: target.userId,
        templateKey: input.roleKey,
        actor: { principalId: input.actorUserId },
        clearOverrides: "on-change",
      });
    } catch (error) {
      mapRoleError(ctx, error);
    }

    if (assignment.changed) {
      const newRank = assignment.next?.rank ?? 0;
      // BY AUTHORITY, NOT ONLY BY RANK (review R2 SEC-T1-F, F4). An admin
      // demoted to Member can't invite anyone, yet a Viewer invitation they
      // sent (rank 10, below Member's 20) used to survive and let an alternate
      // account of theirs in. So: a new role without members.invite withdraws
      // ALL their open invitations here; otherwise those at or above the new
      // rank. (Accepting re-checks the sender's authority too.)
      const canStillInvite = (await resolvePermissionsFor(tx, { principalId: target.userId, scope: "tenant", tenantId: company.id }))
        .toArray()
        .includes("members.invite");
      if (!canStillInvite || newRank < (assignment.previous?.rank ?? 0)) {
        await revokeOpenInvitationsBy(ctx, tx, {
          tenantId: company.id,
          inviterUserId: target.userId,
          minRank: canStillInvite ? newRank : 0,
          via: "member.role.changed",
          actorUserId: input.actorUserId,
          ...(input.request ? { request: input.request } : {}),
        });
      }
      await ctx.audit(tx, {
        action: "member.role.changed",
        actorUserId: input.actorUserId,
        scope: "tenant",
        tenantId: company.id,
        resourceType: "tenant_member",
        resourceId: target.userId,
        metadata: {
          member: target.name ?? target.email,
          from: assignment.previous?.key ?? null,
          to: assignment.next?.key ?? null,
          clearedOverrides: assignment.clearedOverrides,
        },
        request: input.request ?? null,
      });
    }
    const options = await roleOptions(tx, company.id);
    const fresh = (await memberRows(tx, company.id)).find((r) => r.userId === target.userId)!;
    const caller = { userId: input.actorUserId, can: facts.can, rank: facts.role?.rank ?? 0, isOwner: company.ownerUserId === input.actorUserId };
    return {
      view: memberView(fresh, company, input.actorUserId, options, actionsFor(caller, fresh, company, options)),
      from: asRoleKey(assignment.previous?.key ?? null),
      changed: assignment.changed,
    };
  });
  if (out.changed) {
    ctx.emit({
      type: "member.role.changed",
      tenantId: input.tenantId,
      userId: input.targetUserId,
      from: out.from,
      to: input.roleKey,
      by: input.actorUserId,
    });
  }
  return out.view;
}

/**
 * The deletes removal and leaving share (D11): the membership, their company
 * role and their per-person overrides there — and the open invitations they
 * sent (review T1-03). Re-inviting them later starts clean; the audit row is
 * the history.
 *
 * THE POINTER IS LEFT AS IT IS (review T1-09). It's a preference, never an
 * authority: the gate never reads it, and `resolveSession` treats a pointer at
 * a company you're no longer in as stale. Leaving it lets the next session say
 * "You're no longer part of Green Acres" instead of dropping the person on an
 * unexplained "What's your company called?".
 */
async function removeFrom(ctx: Ctx, tx: TenancyDb, tenantId: string, userId: string, by: string, via: string, request?: RequestFacts): Promise<void> {
  await tx.execute(sql`/* adminigloo:tenancy/remove-member */
    delete from tenant_members where tenant_id = ${tenantId} and user_id = ${userId}`);
  await tx.execute(sql`/* adminigloo:tenancy/remove-role */
    delete from principal_role where principal_id = ${userId} and scope = 'tenant' and tenant_id = ${tenantId}`);
  await tx.execute(sql`/* adminigloo:tenancy/remove-overrides */
    delete from principal_override where principal_id = ${userId} and scope = 'tenant' and tenant_id = ${tenantId}`);
  await revokeOpenInvitationsBy(ctx, tx, {
    tenantId,
    inviterUserId: userId,
    minRank: 0,
    via,
    actorUserId: by,
    ...(request ? { request } : {}),
  });
}

/**
 * Remove a member (members.remove). Not yourself (use Leave), not the owner,
 * and only someone you outrank (no role counts as 0). They lose access on
 * their VERY NEXT request: there is no session to invalidate, because the
 * loaders, the handlers, the page gate and the header all read the database
 * every time.
 */
export async function removeMember(ctx: Ctx, input: Mutation & { readonly targetUserId: string }): Promise<{ removed: string }> {
  await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "members.remove" });
    if (input.targetUserId === input.actorUserId) throw ctx.fail("self", undefined, "To remove yourself, use Leave.");
    const target = (await memberRows(tx, company.id)).find((r) => r.userId === input.targetUserId);
    if (!target) throw ctx.fail("not_found");
    if (company.ownerUserId === target.userId) throw ctx.fail("owner_protected");
    if ((facts.role?.rank ?? 0) <= target.rank) throw ctx.fail("rank");
    await removeFrom(ctx, tx, company.id, target.userId, input.actorUserId, "member.removed", input.request);
    await ctx.audit(tx, {
      action: "member.removed",
      actorUserId: input.actorUserId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant_member",
      resourceId: target.userId,
      metadata: { member: target.name ?? target.email, role: target.roleKey },
      request: input.request ?? null,
    });
  });
  ctx.emit({ type: "member.removed", tenantId: input.tenantId, userId: input.targetUserId, by: input.actorUserId });
  return { removed: input.targetUserId };
}

/**
 * Leave a company. Needs no permission — being a member is enough, including
 * a member of a suspended company. The owner can't leave (hand it over first).
 */
export async function leaveCompany(
  ctx: Ctx,
  input: { readonly userId: string; readonly tenantId: string; readonly request?: RequestFacts },
): Promise<{ left: string }> {
  await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    // CONTRACT: 6.8 says a non-member leaving answers `not_found`, but the
    // two-company matrix (12.8, 13.2) requires every company route to answer
    // `not_a_member` for a company that isn't yours. One answer for "not
    // yours", "doesn't exist" and "deleted" on every route, so this follows
    // the matrix.
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const me = (await memberRows(tx, company.id)).find((r) => r.userId === input.userId && r.status === "active");
    if (!me) throw ctx.fail("not_a_member");
    if (company.ownerUserId === input.userId) throw ctx.fail("last_owner");
    await removeFrom(ctx, tx, company.id, input.userId, input.userId, "member.left", input.request);
    await ctx.audit(tx, {
      action: "member.left",
      actorUserId: input.userId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant_member",
      resourceId: input.userId,
      metadata: { member: me.name ?? me.email, role: me.roleKey },
      request: input.request ?? null,
    });
  });
  ctx.emit({ type: "member.left", tenantId: input.tenantId, userId: input.userId, by: input.userId });
  return { left: input.tenantId };
}

/**
 * Hand the company to another member (tenant.transfer, a SEALED key), after
 * typing the company's name (case and spacing ignored; the server checks again).
 * The new owner gets the owner role and the previous owner becomes an Admin,
 * both written with the owner pointer in one transaction, so D4 (one owner,
 * the only holder of the owner role) holds at every commit.
 *
 * Races (D7), both orders: transfer to B vs. removing B (whoever commits
 * second sees the first's result: not_found or owner_protected); transfer by
 * someone who just lost ownership or the key (re-read under the lock:
 * forbidden).
 */
export async function transferOwnership(
  ctx: Ctx,
  input: Mutation & { readonly toUserId: string; readonly confirmName: string },
): Promise<TeamView> {
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId });
    if (company.ownerUserId !== input.actorUserId || !facts.can.has("tenant.transfer")) throw ctx.fail("forbidden");
    if (normaliseCompanyName(input.confirmName).toLowerCase() !== normaliseCompanyName(company.name).toLowerCase()) {
      throw ctx.fail("confirmation_mismatch", { issues: [{ path: ["confirmName"], message: ctx.fail("confirmation_mismatch").message }] });
    }
    if (input.toUserId === input.actorUserId) throw ctx.fail("self", undefined, "You already own it. Choose someone else.");
    const target = (await memberRows(tx, company.id)).find((r) => r.userId === input.toUserId && r.status === "active");
    if (!target) throw ctx.fail("not_found");

    await handOver(ctx, tx, company, input.actorUserId, target.userId, "transferOwnership");
    await ctx.audit(tx, {
      action: "company.ownership.transferred",
      actorUserId: input.actorUserId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant",
      resourceId: company.id,
      metadata: { from: input.actorUserId, to: target.userId, toName: target.name ?? target.email },
      request: input.request ?? null,
    });
    const after = requireLive(ctx, await lockCompany(tx, company.id));
    const myFacts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: company.id });
    return buildTeam(ctx, tx, after, input.actorUserId, myFacts);
  });
  ctx.emit({ type: "ownership.transferred", tenantId: input.tenantId, from: input.actorUserId, to: input.toUserId });
  return out;
}

/**
 * The hand-over itself, shared by the owner's transfer and the operator's
 * "Change owner": the pointer moves, the new owner gets the owner role, the
 * previous holder of the owner role becomes an Admin. System actor: the caller
 * already decided who may do this.
 */
export async function handOver(ctx: Ctx, tx: TenancyDb, company: CompanyRow, fromUserId: string | null, toUserId: string, system: string): Promise<void> {
  await tx.execute(sql`/* adminigloo:tenancy/transfer-owner */
    update tenants set owner_user_id = ${toUserId}, updated_at = now() where id = ${company.id}`);
  await assignRoleTemplate(tx, {
    scope: "tenant",
    tenantId: company.id,
    principalId: toUserId,
    templateKey: "owner",
    actor: { system },
    clearOverrides: "on-change",
  });
  // Every other holder of the owner role (normally exactly the previous owner)
  // steps down to Admin, so the owner template has one holder (D4).
  const holders = await q(
    tx,
    sql`/* adminigloo:tenancy/owner-holders */
      select pr.principal_id from principal_role pr join role_template rt on rt.id = pr.template_id
      where pr.scope = 'tenant' and pr.tenant_id = ${company.id} and rt.key = 'owner' and pr.principal_id <> ${toUserId}`,
  );
  const previous = new Set(holders.map((h) => str(h["principal_id"])));
  if (fromUserId) previous.add(fromUserId);
  for (const userId of previous) {
    const stillMember = await q(tx, sql`/* adminigloo:tenancy/member-exists */ select 1 from tenant_members where tenant_id = ${company.id} and user_id = ${userId}`);
    await assignRoleTemplate(tx, {
      scope: "tenant",
      tenantId: company.id,
      principalId: userId,
      templateKey: stillMember.length > 0 ? "admin" : null,
      actor: { system },
      clearOverrides: "on-change",
    });
  }
}

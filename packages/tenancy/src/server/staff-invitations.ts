import { assignRoleTemplate, listRoleTemplates, RoleAssignmentError, roleOf } from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { normaliseInviteEmail } from "../invitations.js";
import type { Ctx } from "./context.js";
import { date, dateOrNull, q, str, strOrNull } from "./db.js";
import { personFacts, readAdminPerson, setStaffRole, staffRoleViews } from "./operator.js";
import { ensureBootstrapAdmin } from "./provisioning.js";
import type {
  AdminPerson,
  RequestFacts,
  StaffAccessOutcome,
  StaffInvitationView,
  StaffInviteResult,
  TenancyAuditSink,
  TenancyDb,
} from "./types.js";

/**
 * STAFF INVITATIONS (tenancy 0.9): a staff role for someone who hasn't signed
 * up yet, from People's Invite.
 *
 * A staff role is a `principal_role` row, and that needs a user id, which
 * exists only after the first sign-in. So an invitation holds the address and
 * the role until then, and the first account whose VERIFIED address matches
 * takes it up (`claimStaffInvitation`). It's claimed in both places a person
 * is first met, because either can come first: provisioning (the identity
 * webhook, or the first request) and the /admin gate (`ensureStaffAccess`),
 * where an invitee is sent. No token: the identity provider verified the
 * address before we ever see it, so a link would only be a second copy of
 * that proof. One open invitation per address.
 *
 * AN INVITATION IS ITS INVITER'S AUTHORITY (review T1-03's rule, applied to
 * staff): the role is given through `assignRoleTemplate` with the inviter as
 * the actor, so an inviter who has since lost their rank can't hand it out
 * by proxy.
 */

/** How long an invitation waits for its first sign-in. */
export const STAFF_INVITATION_DAYS = 14;
/** One address is emailed at most once in this many minutes, however often Invite is pressed. */
export const STAFF_INVITATION_EMAIL_COOLDOWN_MINUTES = 10;

const DAY_MS = 86_400_000;

function viewOf(r: Record<string, unknown>, now: Date, canRevoke: boolean): StaffInvitationView {
  const expiresAt = date(r["expires_at"]);
  return {
    id: str(r["id"]),
    email: str(r["email"]),
    role: { key: str(r["template_key"]), name: strOrNull(r["role_name"]) ?? str(r["template_key"]) },
    invitedBy: strOrNull(r["inviter_name"]),
    createdAt: date(r["created_at"]),
    expiresAt,
    emailedAt: dateOrNull(r["emailed_at"]),
    expired: expiresAt.getTime() <= now.getTime(),
    canRevoke,
  };
}

const INVITATION_COLUMNS = sql`i.id, i.email, i.template_key, i.created_at, i.expires_at, i.emailed_at,
  coalesce(inviter.display_name, inviter.email) as inviter_name,
  (select t.name from role_template t where t.scope = 'staff' and t.tenant_id = '*' and t.key = i.template_key and t.deleted_at is null limit 1) as role_name`;

/**
 * Invite someone to a staff role (staff.roles.manage). An address that
 * already has exactly one account gets the role now, under `setStaffRole`'s
 * rules; two accounts on one address are refused (review T1-02: picking one
 * would make the grant depend on row order). Any other address gets an open
 * invitation; inviting it again replaces the role and restarts the clock.
 * `sendEmail` says whether the caller should email it now (the cooldown).
 */
export async function inviteStaff(
  ctx: Ctx,
  input: { readonly actorUserId: string; readonly email: string; readonly templateKey: string; readonly request?: RequestFacts },
): Promise<StaffInviteResult> {
  const email = normaliseInviteEmail(input.email);
  if (!email || !email.includes("@")) {
    throw ctx.fail("invalid", { issues: [{ path: ["email"], message: "Type an email address." }] });
  }
  const actor = await personFacts(ctx, ctx.db, input.actorUserId);
  if (!actor.can.has("staff.roles.manage")) throw ctx.fail("forbidden");
  const roles = await staffRoleViews(ctx.db, actor.rank, actor.topRank);
  const role = roles.find((r) => r.key === input.templateKey);
  if (!role) throw ctx.fail("invalid", { issues: [{ path: ["templateKey"], message: "Choose one of the staff roles listed." }] });
  if (!role.assignable) throw ctx.fail("rank", undefined, "You can't give someone a role above your own.");

  const accounts = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/staff-invite-account */
      select id from users where lower(email) = ${email} and deleted_at is null order by created_at, id`,
  );
  if (accounts.length > 1) {
    throw ctx.fail("invalid", {
      issues: [{ path: ["email"], message: "More than one account uses this address. Give the role from the list instead." }],
    });
  }
  if (accounts.length === 1) {
    const person = await setStaffRole(ctx, {
      actorUserId: input.actorUserId,
      targetUserId: str(accounts[0]?.["id"]),
      templateKey: role.key,
      ...(input.request ? { request: input.request } : {}),
    });
    return { kind: "granted", person };
  }

  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const now = ctx.now();
    const expiresAt = new Date(now.getTime() + STAFF_INVITATION_DAYS * DAY_MS);
    const open = await q(
      tx,
      sql`/* adminigloo:tenancy/staff-invite-open */
        select id, emailed_at from staff_invitations
        where email = ${email} and claimed_at is null and revoked_at is null
        for update`,
    );
    const lastEmailed = dateOrNull(open[0]?.["emailed_at"]);
    const sendEmail = !lastEmailed || now.getTime() - lastEmailed.getTime() >= STAFF_INVITATION_EMAIL_COOLDOWN_MINUTES * 60_000;
    let id: string;
    if (open[0]) {
      id = str(open[0]["id"]);
      await tx.execute(sql`/* adminigloo:tenancy/staff-invite-renew */
        update staff_invitations
        set template_key = ${role.key}, invited_by = ${input.actorUserId}, expires_at = ${expiresAt},
            emailed_at = ${sendEmail ? now : lastEmailed}
        where id = ${id}`);
    } else {
      id = uuidv7();
      await tx.execute(sql`/* adminigloo:tenancy/staff-invite-new */
        insert into staff_invitations (id, email, template_key, invited_by, created_at, expires_at, emailed_at)
        values (${id}, ${email}, ${role.key}, ${input.actorUserId}, ${now}, ${expiresAt}, ${now})`);
    }
    await ctx.audit(tx, {
      action: "staff.invitation.sent",
      actorUserId: input.actorUserId,
      scope: "staff",
      tenantId: null,
      resourceType: "staff_invitation",
      resourceId: id,
      metadata: { email, to: role.key, renewed: Boolean(open[0]) },
      request: input.request ?? null,
    });
    const rows = await q(
      tx,
      sql`/* adminigloo:tenancy/staff-invite-read */
        select ${INVITATION_COLUMNS} from staff_invitations i left join users inviter on inviter.id = i.invited_by where i.id = ${id}`,
    );
    return { kind: "invited", invitation: viewOf(rows[0]!, now, true), sendEmail };
  });
}

/** The invitations nobody has taken up yet, newest first (staff.people.view). */
export async function listStaffInvitations(ctx: Ctx, input: { readonly actorUserId: string }): Promise<StaffInvitationView[]> {
  const actor = await personFacts(ctx, ctx.db, input.actorUserId);
  if (!actor.can.has("staff.people.view")) throw ctx.fail("forbidden");
  const now = ctx.now();
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/staff-invites */
      select ${INVITATION_COLUMNS} from staff_invitations i left join users inviter on inviter.id = i.invited_by
      where i.claimed_at is null and i.revoked_at is null
      order by i.created_at desc, i.id desc
      limit 200`,
  );
  return rows.map((r) => viewOf(r, now, actor.can.has("staff.roles.manage")));
}

/** Withdraw an invitation nobody has taken up (staff.roles.manage). Idempotent. */
export async function revokeStaffInvitation(
  ctx: Ctx,
  input: { readonly actorUserId: string; readonly invitationId: string; readonly request?: RequestFacts },
): Promise<void> {
  const actor = await personFacts(ctx, ctx.db, input.actorUserId);
  if (!actor.can.has("staff.roles.manage")) throw ctx.fail("forbidden");
  await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const rows = await q(
      tx,
      sql`/* adminigloo:tenancy/staff-invite-revoke */
        update staff_invitations set revoked_at = ${ctx.now()}, revoked_by = ${input.actorUserId}
        where id = ${input.invitationId} and claimed_at is null and revoked_at is null
        returning id, email, template_key`,
    );
    if (!rows[0]) return;
    await ctx.audit(tx, {
      action: "staff.invitation.revoked",
      actorUserId: input.actorUserId,
      scope: "staff",
      tenantId: null,
      resourceType: "staff_invitation",
      resourceId: str(rows[0]["id"]),
      metadata: { email: str(rows[0]["email"]), role: str(rows[0]["template_key"]) },
      request: input.request ?? null,
    });
  });
}

/**
 * Take up the open invitation for this person's verified address, if one is
 * waiting. True when a role was given. Never throws for a refusal: an inviter
 * who has since lost their rank (or a role that no longer exists) leaves the
 * invitation open for an administrator to look at.
 */
export async function claimStaffInvitation(
  db: TenancyDb,
  input: { readonly userId: string; readonly email: string | null; readonly now: Date; readonly audit?: TenancyAuditSink },
): Promise<boolean> {
  if (!input.email) return false;
  const email = normaliseInviteEmail(input.email);
  return db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const rows = await q(
      tx,
      sql`/* adminigloo:tenancy/staff-invite-claimable */
        select id, template_key, invited_by from staff_invitations
        where email = ${email} and claimed_at is null and revoked_at is null and expires_at > ${input.now}
        for update`,
    );
    const invitation = rows[0];
    if (!invitation || !strOrNull(invitation["invited_by"])) return false;
    const key = str(invitation["template_key"]);
    const template = (await listRoleTemplates(tx, { scope: "staff" })).find((t) => t.key === key);
    if (!template) return false;
    // A role they already hold at this rank or higher is kept: an invitation never demotes.
    const current = await roleOf(tx, { principalId: input.userId, scope: "staff" });
    if (!current || current.rank < template.rank) {
      try {
        await assignRoleTemplate(tx, {
          scope: "staff",
          principalId: input.userId,
          templateKey: key,
          actor: { principalId: str(invitation["invited_by"]) },
          protectLastKey: "admin",
          topRankPeers: true,
        });
      } catch (error) {
        if (error instanceof RoleAssignmentError) return false;
        throw error;
      }
    }
    await tx.execute(sql`/* adminigloo:tenancy/staff-invite-claim */
      update staff_invitations set claimed_at = ${input.now}, claimed_by = ${input.userId} where id = ${str(invitation["id"])}`);
    if (input.audit) {
      await input.audit(tx, {
        action: "staff.invitation.claimed",
        actorUserId: input.userId,
        scope: "staff",
        tenantId: null,
        resourceType: "staff_role",
        resourceId: input.userId,
        metadata: { invitationId: str(invitation["id"]), to: key, kept: current && current.rank >= template.rank ? current.key : null, invitedBy: str(invitation["invited_by"]) },
        request: null,
      });
    }
    return true;
  });
}

/**
 * The /admin gate's self-heal for a signed-in person with no staff role: the
 * first administrator (`ensureBootstrapAdmin`), or the role an invitation is
 * holding for their address. Retried on every such visit, so an invitee whose
 * account was made before the invitation (or by a webhook that came first)
 * still gets in.
 */
export async function ensureStaffAccess(ctx: Ctx, input: { readonly userId: string; readonly email: string | null }): Promise<StaffAccessOutcome> {
  const bootstrap = await ensureBootstrapAdmin(ctx, input);
  if (bootstrap.granted) return { granted: true, via: "bootstrap" };
  const claimed = await claimStaffInvitation(ctx.db, {
    userId: input.userId,
    email: input.email,
    now: ctx.now(),
    audit: (tx, event) => ctx.audit(tx, event),
  });
  return claimed ? { granted: true, via: "invitation" } : bootstrap;
}

/**
 * A person's name, from People: your own (any staff role), or anyone's with
 * staff.roles.manage. Written to the identity provider first when the app
 * gave one (`identity.updateName`), because who someone is lives there and its
 * webhook would put the old name back over an edit made only here; then to
 * `users.display_name`, so the screen shows it at once.
 */
export async function setPersonName(
  ctx: Ctx,
  input: {
    readonly actorUserId: string;
    readonly targetUserId: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly request?: RequestFacts;
  },
): Promise<AdminPerson> {
  const firstName = input.firstName.trim().slice(0, 80);
  const lastName = input.lastName.trim().slice(0, 80);
  if (!firstName && !lastName) throw ctx.fail("invalid", { issues: [{ path: ["firstName"], message: "Type a first or last name." }] });
  const actor = await personFacts(ctx, ctx.db, input.actorUserId);
  const self = input.actorUserId === input.targetUserId;
  if (!self && !actor.can.has("staff.roles.manage")) throw ctx.fail("forbidden");
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/person-for-name */
      select id, external_id from users where id = ${input.targetUserId} and deleted_at is null`,
  );
  const target = rows[0];
  if (!target) throw ctx.fail("not_found");
  if (ctx.identity) {
    await ctx.identity.updateName({ userId: str(target["id"]), externalId: str(target["external_id"]), firstName, lastName });
  }
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  const actorRef = { userId: input.actorUserId, rank: actor.rank, topRank: actor.topRank, can: actor.can };
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    await tx.execute(sql`/* adminigloo:tenancy/person-name */
      update users set display_name = ${displayName}, updated_at = ${ctx.now()} where id = ${input.targetUserId}`);
    await ctx.audit(tx, {
      action: "person.renamed",
      actorUserId: input.actorUserId,
      scope: "staff",
      tenantId: null,
      resourceType: "user",
      resourceId: input.targetUserId,
      metadata: { self },
      request: input.request ?? null,
    });
    const person = await readAdminPerson(tx, actorRef, input.targetUserId);
    if (!person) throw ctx.fail("not_found");
    return person;
  });
}

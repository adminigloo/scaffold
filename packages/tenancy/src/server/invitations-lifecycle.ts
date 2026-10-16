import { sql } from "drizzle-orm";
import { hashInvitationToken, invitationState, normaliseInviteEmail } from "../invitations.js";
import { createInvitationService, type AcceptResult, type InvitationDb } from "../service.js";
import type { RoleKey } from "../wire.js";
import { holdsPermission, rankOf, requireActor, requireLive, roleNameOf, roleOptions, type Ctx } from "./context.js";
import { asRoleKey, date, dateOrNull, lockCompany, num, q, readCompany, str, strOrNull, type CompanyRow } from "./db.js";
import { openInvitationFor } from "./invitation-rules.js";
import { seatCounts } from "./team.js";
import type {
  AcceptOutcome,
  EmailHold,
  EmailReservation,
  InvitationPreview,
  InvitationView,
  IssuedInvitation,
  RequestFacts,
  TenancyDb,
} from "./types.js";

/**
 * The invitation lifecycle (contract 6.9; decisions D16, D18, D19).
 *
 * D18: THE 0.3 SERVICE IS KEPT. The hash-only token, the upsert on the partial
 * index, `FOR UPDATE` on accept, the union result and `requireMatchingEmail`
 * are unchanged; this layer wraps them with the company lock first, the rank
 * guard, `already_member`, the personal-workspace refusal, seats, the pointer
 * write and the audit. It replaces the template's tRPC invitations router, so
 * there is exactly one invite path and a fix to it reaches every project by npm.
 */

type Mutation = {
  readonly actorUserId: string;
  readonly tenantId: string;
  readonly request?: RequestFacts;
  /** The caller will email the link: the per-address email limits apply (review R3 SEC-T1-B). */
  readonly sendsEmail?: boolean;
};

/**
 * One company emails one address about an OPEN invitation at most once per
 * this many minutes (review R3 SEC-T1-B). A Resend inside it is still saved —
 * a fresh link, a changed role — and the inviter is handed the link instead.
 */
export const INVITATION_EMAIL_COOLDOWN_MINUTES = 10;

/**
 * …and one company sends one address at most this many invitation emails in
 * any 24 hours, every invitation to it counted — so withdrawing and inviting
 * again isn't a way round the cooldown. Per company, never per address alone:
 * a cap any inviter could spend would let them block a real employer's
 * invitation to that address for a day.
 */
export const INVITATION_EMAILS_PER_ADDRESS_PER_DAY = 5;

/** A wrong-account note on an invitation is written at most once per this many minutes (review R3 T1BO-07). */
export const WRONG_ACCOUNT_NOTE_MINUTES = 10;

const DAY_MS = 24 * 60 * 60_000;

function service(ctx: Ctx, tx: TenancyDb, beforeConsume?: Parameters<typeof createInvitationService>[0]["beforeConsume"]) {
  return createInvitationService({
    db: tx as unknown as InvitationDb,
    now: ctx.now,
    requireMatchingEmail: ctx.requireMatchingEmail,
    ...(ctx.invitationExpiryHours !== undefined ? { defaultExpiryHours: ctx.invitationExpiryHours } : {}),
    ...(beforeConsume ? { beforeConsume } : {}),
  });
}

interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly roleKey: string | null;
  readonly rank: number;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly wrongAccountAt: Date | null;
  readonly wrongAccountEmail: string | null;
}

async function invitationRows(db: TenancyDb, tenantId: string, id?: string): Promise<InvitationRow[]> {
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/invitations */
      select i.id, i.email, i.expires_at, i.created_at, i.accepted_at, i.revoked_at, i.wrong_account_at, i.wrong_account_email,
             rt.key as role_key, coalesce(rt.rank, 0) as rank
      from tenant_invitations i left join role_template rt on rt.id = i.template_id
      where i.tenant_id = ${tenantId} ${id ? sql`and i.id = ${id}` : sql``}
      order by i.created_at desc, i.id desc`,
  );
  return rows.map((r) => ({
    id: str(r["id"]),
    email: str(r["email"]),
    roleKey: strOrNull(r["role_key"]),
    rank: Number(r["rank"]),
    expiresAt: dateOrNull(r["expires_at"]),
    createdAt: date(r["created_at"]),
    acceptedAt: dateOrNull(r["accepted_at"]),
    revokedAt: dateOrNull(r["revoked_at"]),
    wrongAccountAt: dateOrNull(r["wrong_account_at"]),
    wrongAccountEmail: strOrNull(r["wrong_account_email"]),
  }));
}

function stateOf(ctx: Ctx, row: InvitationRow) {
  return invitationState({ expiresAt: row.expiresAt, revokedAt: row.revokedAt, acceptedAt: row.acceptedAt }, ctx.now());
}

function view(
  row: InvitationRow,
  state: "pending" | "expired",
  options: Awaited<ReturnType<typeof roleOptions>>,
  actorRank: number,
): InvitationView {
  return {
    id: row.id,
    email: row.email,
    roleKey: asRoleKey(row.roleKey),
    roleName: roleNameOf(options, row.roleKey),
    state,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    // Resend re-issues the SAME role, so it needs a role you could give.
    canResend: row.roleKey !== null && actorRank > row.rank,
    canRevoke: actorRank > row.rank,
    wrongAccount: row.wrongAccountAt ? { signedInAs: row.wrongAccountEmail, at: row.wrongAccountAt } : null,
  };
}

/**
 * Invitations still worth acting on: pending and expired, newest first
 * (members.invite — an invitation is the address of someone NOT in the
 * company, so viewers don't see it). Each row says whether THIS caller may
 * resend or withdraw it.
 */
export async function listInvitations(ctx: Ctx, input: { readonly actorUserId: string; readonly tenantId: string }): Promise<InvitationView[]> {
  const facts = await requireActor(ctx, ctx.db, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "members.invite" });
  const options = await roleOptions(ctx.db, input.tenantId, ctx.roles);
  const out: InvitationView[] = [];
  for (const row of await invitationRows(ctx.db, input.tenantId)) {
    const state = stateOf(ctx, row);
    if (state === "pending" || state === "expired") out.push(view(row, state, options, facts.role?.rank ?? 0));
  }
  return out;
}

async function inviterLabel(db: TenancyDb, userId: string): Promise<string | null> {
  const rows = await q(db, sql`/* adminigloo:tenancy/inviter */ select display_name, email from users where id = ${userId}`);
  return strOrNull(rows[0]?.["display_name"]) ?? strOrNull(rows[0]?.["email"]);
}

async function checkSeats(ctx: Ctx, tx: TenancyDb, company: CompanyRow, exceptEmail: string | null): Promise<void> {
  if (!ctx.seats) return;
  const limit = await ctx.seats.limitFor(tx, company.id);
  if (typeof limit !== "number") return;
  const counts = await seatCounts(tx, company.id, ctx.now(), exceptEmail);
  const used = counts.active + counts.pending;
  if (used + 1 > limit) {
    throw ctx.fail(
      "seats_full",
      ctx.seats.upgradeHref ? { upgradeHref: ctx.seats.upgradeHref } : undefined,
      `Your plan includes ${limit} ${limit === 1 ? "person" : "people"} and ${used} ${used === 1 ? "is" : "are"} on the team or invited. Remove someone or upgrade to add more.`,
    );
  }
}

/** "a minute", "7 minutes", "about 3 hours": how long until something, for the inviter's sentence (never early). */
function spanOf(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? "a minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours <= 1 ? "about an hour" : `about ${hours} hours`;
}

/** A boolean column read through a raw `execute`: true, or Postgres text "t". */
function isTrue(value: unknown): boolean {
  return value === true || value === "t" || value === "true";
}

/** "less than a minute", "a minute", "3 minutes": how long AGO, never more than it was. */
function agoOf(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  return minutes < 60 ? (minutes === 1 ? "a minute" : `${minutes} minutes`) : spanOf(ms);
}

/**
 * May this company email this address about an invitation NOW (review R3
 * SEC-T1-B)? Read under the company lock, so two Resends at once can't both
 * pass. Null → email it; otherwise the hold, with the inviter's sentence:
 *
 *   - the open invitation's link was emailed less than the cooldown ago, or
 *   - the address has had the day's emails from this company, every
 *     invitation to it counted (withdrawn and accepted ones too), or
 *   - an email to it is on its way and we haven't heard back (review R4).
 *
 * "WE EMAILED" ONLY ABOUT AN EMAIL THAT WENT (review R4 SEC-T1-B). The first
 * two are read from `emailed_at`, which holds only emails the provider took;
 * one still on its way (`email_sending_at`) is said as exactly that, and one
 * that never came back stops holding after the cooldown without ever being
 * counted. So a skipped, failed or thrown delivery is never "We emailed".
 */
async function emailHoldFor(
  ctx: Ctx,
  tx: TenancyDb,
  company: CompanyRow,
  email: string,
  change: { readonly reopened: boolean; readonly newRoleName: string | null },
): Promise<EmailHold | null> {
  const now = ctx.now();
  const cooldownMs = INVITATION_EMAIL_COOLDOWN_MINUTES * 60_000;
  const rows = await q(
    tx,
    sql`/* adminigloo:tenancy/invite-email-history */
      select coalesce(sum(s.sends), 0) as sends, min(s.oldest) as oldest,
             max(s.last) filter (where i.accepted_at is null and i.revoked_at is null) as open_last,
             coalesce(bool_or(cardinality(i.emailed_at) > 0) filter (where i.accepted_at is null and i.revoked_at is null), false) as open_emailed,
             max(i.email_sending_at) filter (where i.email_sending_at > ${new Date(now.getTime() - cooldownMs)}) as sending_since,
             coalesce(bool_or(i.email_sending_at > ${new Date(now.getTime() - cooldownMs)})
               filter (where i.accepted_at is null and i.revoked_at is null), false) as open_sending
      from tenant_invitations i
      left join lateral (
        select count(*) as sends, min(e.at) as oldest, max(e.at) as last
        from unnest(i.emailed_at) as e(at) where e.at > ${new Date(now.getTime() - DAY_MS)}
      ) s on true
      where i.tenant_id = ${company.id} and i.email = ${email}`,
  );
  const sends = num(rows[0]?.["sends"]);
  const oldest = dateOrNull(rows[0]?.["oldest"]);
  const openLast = dateOrNull(rows[0]?.["open_last"]);
  const openEmailed = isTrue(rows[0]?.["open_emailed"]);
  const sendingSince = dateOrNull(rows[0]?.["sending_since"]);
  const openSending = isTrue(rows[0]?.["open_sending"]);
  // The earlier email's link still works (earlier_token_hashes): say so, and
  // what it now gives when the role changed, so nobody re-sends in a panic —
  // but only when an email of THIS invitation went.
  const gives = change.newRoleName ? ` and now gives the ${change.newRoleName} role` : "";
  const earlier = change.reopened && openEmailed ? ` The link in the email we already sent still works${gives}.` : "";
  if (openLast && now.getTime() - openLast.getTime() < cooldownMs) {
    const until = new Date(openLast.getTime() + cooldownMs);
    return {
      reason: "cooldown",
      until,
      message:
        `We emailed ${email} ${agoOf(now.getTime() - openLast.getTime())} ago, so we didn't email them again yet. Emails can take a few minutes to arrive.` +
        `${earlier} You can email it again in ${spanOf(until.getTime() - now.getTime())}, or copy the link below and send it yourself.`,
    };
  }
  if (sends >= INVITATION_EMAILS_PER_ADDRESS_PER_DAY && oldest) {
    const until = new Date(oldest.getTime() + DAY_MS);
    return {
      reason: "daily-limit",
      until,
      message:
        `${email} has had ${INVITATION_EMAILS_PER_ADDRESS_PER_DAY} invitation emails from ${company.name} in the last day, so we didn't email them again.` +
        `${earlier} You can email it again in ${spanOf(until.getTime() - now.getTime())}, or copy the link below and send it yourself.`,
    };
  }
  if (sendingSince) {
    // On its way, or lost mid-send: we don't know it arrived, so we don't say it did.
    return {
      reason: "sending",
      until: new Date(sendingSince.getTime() + cooldownMs),
      message:
        `We started emailing ${email} ${agoOf(now.getTime() - sendingSince.getTime())} ago and haven't heard back yet, so we didn't start another.` +
        `${change.reopened && openSending ? ` If that email arrives, its link works too${gives}.` : ""} Copy the link below if you'd like to send it yourself.`,
    };
  }
  return null;
}

/** Reserve the email under the company lock: nothing counts it as sent until the mailer says so. */
async function reserveEmail(ctx: Ctx, tx: TenancyDb, invitationId: string): Promise<EmailReservation> {
  const reservedAt = ctx.now();
  await tx.execute(sql`/* adminigloo:tenancy/invite-email-reserved */
    update tenant_invitations set email_sending_at = ${reservedAt} where id = ${invitationId}`);
  return { invitationId, reservedAt };
}

/**
 * What became of a reserved invitation email (review R4 SEC-T1-B). "sent":
 * stamped into `emailed_at` (keeping only the last day's, the history the
 * limits read) at the time the provider took it. Anything else: the
 * reservation is dropped and nothing is counted, so the next Resend emails
 * and nobody is told "We emailed". Under the company lock, like the check
 * that reserved it; only the reservation named, in that company, once.
 */
export async function settleInvitationEmail(
  ctx: Ctx,
  input: { readonly tenantId: string; readonly invitationId: string; readonly reservedAt: Date; readonly sent: boolean },
): Promise<void> {
  await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    await lockCompany(tx, input.tenantId);
    const now = ctx.now();
    if (input.sent) {
      await tx.execute(sql`/* adminigloo:tenancy/invite-emailed */
        update tenant_invitations
        set emailed_at = array(
              select e.at from unnest(emailed_at) as e(at) where e.at > ${new Date(now.getTime() - DAY_MS)} order by e.at
            ) || array[${now}::timestamptz],
            email_sending_at = null
        where id = ${input.invitationId} and tenant_id = ${input.tenantId} and email_sending_at = ${input.reservedAt}`);
    } else {
      await tx.execute(sql`/* adminigloo:tenancy/invite-email-released */
        update tenant_invitations set email_sending_at = null
        where id = ${input.invitationId} and tenant_id = ${input.tenantId} and email_sending_at = ${input.reservedAt}`);
    }
  });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite someone, or re-send to an address with an open invitation.
 *
 * Lock order (D7): the company row, then the invitation row (through the
 * service's upsert). Refusals, in order: a suspended company; a personal
 * workspace in companies mode; no `members.invite`; `owner` (never a role you
 * give: transfer instead); a role not below yours (strictly greater); an
 * address that's already on the team; an OPEN invitation to that address
 * carrying a role you couldn't give (review T1-04 — re-sending replaces the
 * row and its link, so without this an admin could quietly lower or kill an
 * invitation the owner sent, the same act `revoke` refuses them); seats.
 */
export async function sendInvitation(
  ctx: Ctx,
  input: Mutation & { readonly email: string; readonly roleKey: RoleKey },
): Promise<IssuedInvitation> {
  const email = normaliseInviteEmail(input.email);
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) {
    throw ctx.fail("invalid", { issues: [{ path: ["email"], message: "Enter an email address, like you@example.com." }] });
  }
  return issue(ctx, input, email, input.roleKey, null);
}

/** Re-send an open invitation (a fresh link; the earlier ones keep working). Same rank and seat rules. */
export async function resendInvitation(ctx: Ctx, input: Mutation & { readonly invitationId: string }): Promise<IssuedInvitation> {
  return issue(ctx, input, null, null, input.invitationId);
}

async function issue(
  ctx: Ctx,
  input: Mutation,
  emailIn: string | null,
  roleIn: RoleKey | null,
  resendId: string | null,
): Promise<IssuedInvitation> {
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    if (company.suspendedAt !== null) {
      // Members get the suspension message; strangers get "not yours".
      await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId });
    }
    if (ctx.mode === "companies" && company.kind === "personal") throw ctx.fail("personal_workspace");
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "members.invite" });
    const options = await roleOptions(tx, company.id, ctx.roles);
    const actorRank = facts.role?.rank ?? 0;

    let email: string;
    let roleKey: RoleKey;
    if (resendId !== null) {
      const row = (await invitationRows(tx, company.id, resendId))[0];
      const state = row ? stateOf(ctx, row) : null;
      if (!row || (state !== "pending" && state !== "expired")) throw ctx.fail("not_found");
      const key = asRoleKey(row.roleKey);
      if (key === null) throw ctx.fail("not_found");
      if (actorRank <= row.rank) throw ctx.fail("rank");
      email = row.email;
      roleKey = key;
    } else {
      email = emailIn!;
      roleKey = roleIn!;
      if (roleKey === "owner") throw ctx.fail("owner_must_transfer");
      // Tenancy 2a: a key the PROJECT offers (a host calling the service
      // directly gets the handlers' rule). Without this an unknown key would
      // rank 0, pass, and fail only at acceptance, in front of the invitee.
      if (!ctx.roles.has(roleKey)) throw ctx.fail("invalid", { issues: [{ path: ["roleKey"], message: "Pick one of the roles listed." }] });
      if (!facts.role) throw ctx.fail("forbidden");
      if (actorRank <= rankOf(options, roleKey)) throw ctx.fail("rank");
    }

    const member = await q(
      tx,
      sql`/* adminigloo:tenancy/invite-already-member */
        select 1 from tenant_members m join users u on u.id = m.user_id
        where m.tenant_id = ${company.id} and m.status = 'active' and lower(u.email) = ${email} limit 1`,
    );
    if (member.length > 0) throw ctx.fail("already_member");

    const open = await openInvitationFor(tx, company.id, email);
    if (open && resendId === null && actorRank <= open.rank) {
      throw ctx.fail(
        "rank",
        undefined,
        "There's already an invitation to that address from someone above you. Ask them to resend or withdraw it.",
      );
    }

    await checkSeats(ctx, tx, company, open ? email : null);

    // Saved whatever the email limits say; only the email waits (review R3
    // SEC-T1-B). A first invitation to an address is never held: nothing has
    // been sent to it.
    const emailHold = input.sendsEmail
      ? await emailHoldFor(ctx, tx, company, email, {
          reopened: open !== null,
          newRoleName: open !== null && open.roleKey !== roleKey ? roleNameOf(options, roleKey) : null,
        })
      : null;

    const sent = await service(ctx, tx).send({
      tenantId: company.id,
      email,
      roleTemplateKey: roleKey,
      invitedByUserId: input.actorUserId,
      ...(ctx.invitationExpiryHours !== undefined ? { expiresInHours: ctx.invitationExpiryHours } : {}),
    });
    await ctx.audit(tx, {
      action: "invitation.sent",
      actorUserId: input.actorUserId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant_invitation",
      resourceId: sent.id,
      // The address and the role, never the token or the URL: metadata lives in
      // the table kept longest of all, and a credential written there outlives
      // the credential.
      metadata: {
        email,
        roleKey,
        resend: open !== null,
        ...(open && open.roleKey !== roleKey ? { previousRoleKey: open.roleKey } : {}),
        ...(emailHold ? { emailHeld: emailHold.reason } : {}),
      },
      request: input.request ?? null,
    });
    // Reserved, not recorded (review R4 SEC-T1-B): it counts as emailed only
    // once the caller settles it as sent, so a skipped, failed or thrown
    // delivery is never later described as "We emailed".
    const emailReservation = input.sendsEmail && emailHold === null ? await reserveEmail(ctx, tx, sent.id) : null;
    const row = (await invitationRows(tx, company.id, sent.id))[0]!;
    return {
      invitation: view(row, "pending", options, actorRank),
      token: sent.token,
      expiresAt: sent.expiresAt,
      replaced: open !== null,
      companyName: company.name,
      invitedBy: await inviterLabel(tx, input.actorUserId),
      emailHold,
      emailReservation,
    };
  });
  ctx.emit({ type: "invitation.sent", tenantId: input.tenantId, invitationId: out.invitation.id, by: input.actorUserId });
  return out;
}

/**
 * Withdraw an open invitation. The id must be one of THIS company's (the IDOR
 * guard from the 0.3 router: the service's revoke takes no tenant), and the
 * caller must outrank the role it carries.
 */
export async function revokeInvitation(ctx: Ctx, input: Mutation & { readonly invitationId: string }): Promise<{ id: string }> {
  return ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "members.invite" });
    const row = (await invitationRows(tx, company.id, input.invitationId))[0];
    const state = row ? stateOf(ctx, row) : null;
    if (!row || (state !== "pending" && state !== "expired")) throw ctx.fail("not_found");
    if ((facts.role?.rank ?? 0) <= row.rank) throw ctx.fail("rank");
    await service(ctx, tx).revoke(row.id, input.actorUserId);
    await ctx.audit(tx, {
      action: "invitation.revoked",
      actorUserId: input.actorUserId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant_invitation",
      resourceId: row.id,
      metadata: { email: row.email, roleKey: row.roleKey, previousState: state },
      request: input.request ?? null,
    });
    return { id: row.id };
  });
}

/**
 * The host's last word before an invitation is consumed, under the company
 * lock (D16): the company must still be usable, and there must be a seat.
 *
 * THE COMPANY'S STATE IS CHECKED HERE, AFTER THE IDENTITY GATE (review T1-11),
 * not before it: someone holding a forwarded link learns "this was not for
 * you", never whether the company is suspended.
 */
function beforeConsumeFor(ctx: Ctx, company: CompanyRow) {
  return async (
    tx: InvitationDb,
    input: { readonly tenantId: string; readonly userId: string; readonly invitationId: string; readonly invitedBy: string | null },
  ) => {
    if (company.deletedAt !== null || company.suspendedAt !== null) {
      return { refuse: "company-unavailable", message: `This ${ctx.noun.singular} isn't available right now.` };
    }
    // AN INVITATION IS ITS SENDER'S AUTHORITY, checked when it is USED (review
    // R2 SEC-T1-F, F4). Removal, leaving and demotion withdraw what the person
    // could no longer send (T1-03), but authority can also end in ways no
    // lifecycle function sees: a staff `deny members.invite` override, a role
    // template edited to drop the key. So, under the company lock: the sender
    // must still be an active member who may invite. If not, the invitation is
    // withdrawn now (audited) and the invitee hears "withdrawn" — never "you're
    // in" on the say-so of someone who can't let anyone in any more. A
    // hand-over keeps working: the previous owner stays an Admin who may invite.
    if (input.invitedBy !== null) {
      const db = tx as unknown as TenancyDb;
      const allowed = await holdsPermission(db, { userId: input.invitedBy, tenantId: input.tenantId, permission: "members.invite" });
      if (!allowed) {
        const revoked = await q(
          db,
          sql`/* adminigloo:tenancy/revoke-lapsed */
            update tenant_invitations set revoked_at = ${ctx.now()}, revoked_by = null
            where id = ${input.invitationId} and revoked_at is null and accepted_at is null
            returning email`,
        );
        if (revoked[0]) {
          await ctx.audit(db, {
            action: "invitation.revoked",
            actorUserId: null,
            scope: "tenant",
            tenantId: input.tenantId,
            resourceType: "tenant_invitation",
            resourceId: input.invitationId,
            metadata: { email: str(revoked[0]["email"]), via: "inviter.can-no-longer-invite", inviter: input.invitedBy },
          });
        }
        return { refuse: "inviter-lapsed", message: "This invitation was withdrawn." };
      }
    }
    if (ctx.seats) {
      const limit = await ctx.seats.limitFor(tx as unknown as TenancyDb, input.tenantId);
      if (typeof limit === "number") {
        const { active } = await seatCounts(tx as unknown as TenancyDb, input.tenantId, ctx.now(), null);
        if (active + 1 > limit) {
          return {
            refuse: "seats-full",
            message: `${company.name} is full right now. Ask whoever invited you to make room, then try the link again.`,
          };
        }
      }
    }
    return null;
  };
}

async function finishAccept(
  ctx: Ctx,
  tx: TenancyDb,
  company: CompanyRow,
  result: AcceptResult,
  userId: string,
  via: "invitation" | "verified-email",
  request?: RequestFacts,
): Promise<{ outcome: AcceptOutcome; joined: boolean }> {
  switch (result.status) {
    case "accepted":
    case "already-a-member": {
      // The invitee lands IN the inviting company: the next page renders it.
      await tx.execute(sql`/* adminigloo:tenancy/accept-pointer */
        update users set active_tenant_id = ${company.id} where id = ${userId}`);
      if (result.status === "accepted") {
        // What joining replaced, when it replaced anything (review R2
        // SEC-T1-E): a leftover role or per-person overrides from before.
        const replaced = result.status === "accepted" && (result.replacedRole != null || (result.clearedOverrides?.length ?? 0) > 0);
        await ctx.audit(tx, {
          action: "invitation.accepted",
          actorUserId: userId,
          scope: "tenant",
          tenantId: company.id,
          resourceType: "tenant_member",
          resourceId: userId,
          metadata: {
            via,
            ...(replaced && result.status === "accepted"
              ? { replacedRole: result.replacedRole ?? null, clearedOverrides: [...(result.clearedOverrides ?? [])] }
              : {}),
          },
          request: request ?? null,
        });
      }
      return { outcome: { status: result.status, company: { id: company.id, name: company.name } }, joined: result.status === "accepted" };
    }
    case "wrong-email":
      return { outcome: { status: "wrong-email" }, joined: false };
    case "unknown-token":
      return { outcome: { status: "unknown" }, joined: false };
    case "expired":
    case "revoked":
      return { outcome: { status: result.status }, joined: false };
    case "refused":
      if (result.reason === "seats-full") return { outcome: { status: "seats-full", message: result.message }, joined: false };
      if (result.reason === "inviter-lapsed") return { outcome: { status: "revoked" }, joined: false };
      return { outcome: { status: "company-unavailable" }, joined: false };
  }
}

/**
 * Accept by the mailed link. Lock order (D7): find the company by hash with NO
 * lock, take the company lock, then the service takes the invitation lock —
 * the opposite order would deadlock against `sendInvitation`'s upsert.
 *
 * "Accept while removed": X accepted, was removed, then presses accept again.
 * The row is spent and X isn't a member, so the service answers unknown and
 * the removal sticks.
 */
export async function acceptInvitation(
  ctx: Ctx,
  input: {
    readonly token: string;
    readonly userId: string;
    /** The caller's VERIFIED addresses from the identity provider (review R2 TB2-10). */
    readonly verifiedEmails?: readonly string[];
    readonly request?: RequestFacts;
  },
): Promise<AcceptOutcome> {
  const hash = hashInvitationToken(input.token);
  const found = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/accept-find */
      select tenant_id from tenant_invitations
      where token_hash = ${hash} or earlier_token_hashes @> array[${hash}]::text[] limit 1`,
  );
  const tenantId = strOrNull(found[0]?.["tenant_id"]);
  if (!tenantId) return { status: "unknown" };
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = await lockCompany(tx, tenantId);
    if (!company) return { outcome: { status: "unknown" } as AcceptOutcome, joined: false };
    const result = await service(ctx, tx, beforeConsumeFor(ctx, company)).accept(input.token, input.userId, {
      verifiedEmails: input.verifiedEmails ?? [],
    });
    if (result.status === "wrong-email") await noteWrongAccount(ctx, tx, hash, input.userId);
    return finishAccept(ctx, tx, company, result, input.userId, "invitation", input.request);
  });
  if (out.joined) {
    // Tenancy 2b-1 (8.1): who joined, and as what, in words (one query).
    const { person, roleName } = await ctx.memberFacts(tenantId, input.userId);
    ctx.emit({ type: "member.joined", tenantId, userId: input.userId, via: "invitation", person, roleName });
  }
  return out.outcome;
}

/**
 * Someone pressed Accept on this link signed in with a different address
 * (review R3 T1BO-07). Note it on the invitation — when, and the address they
 * were signed in with, masked — so the team page can tell the owner "they
 * used their Gmail" instead of the owner hearing "the link doesn't work".
 * No email, and nothing new for the person pressing to learn. At most once
 * per WRONG_ACCOUNT_NOTE_MINUTES per invitation, so a link pressed in a loop
 * can't churn the row; only an open invitation carries the note.
 */
async function noteWrongAccount(ctx: Ctx, tx: TenancyDb, tokenHash: string, userId: string): Promise<void> {
  const me = await q(tx, sql`/* adminigloo:tenancy/wrong-account-caller */ select email from users where id = ${userId}`);
  const address = strOrNull(me[0]?.["email"]);
  const masked = address ? maskEmail(normaliseInviteEmail(address)) : null;
  const now = ctx.now();
  await tx.execute(sql`/* adminigloo:tenancy/wrong-account-note */
    update tenant_invitations
    set wrong_account_at = ${now}, wrong_account_email = ${masked}
    where (token_hash = ${tokenHash} or earlier_token_hashes @> array[${tokenHash}]::text[])
      and accepted_at is null and revoked_at is null
      and (wrong_account_at is null or wrong_account_at <= ${new Date(now.getTime() - WRONG_ACCOUNT_NOTE_MINUTES * 60_000)})`);
}

/** Join from onboarding by a VERIFIED address (D19); otherwise the same as accepting. */
export async function joinInvitation(
  ctx: Ctx,
  input: { readonly invitationId: string; readonly userId: string; readonly verifiedEmails: readonly string[]; readonly request?: RequestFacts },
): Promise<AcceptOutcome> {
  if (ctx.mode === "personal") throw ctx.fail("unavailable");
  const found = await q(ctx.db, sql`/* adminigloo:tenancy/join-find */ select tenant_id from tenant_invitations where id = ${input.invitationId}`);
  const tenantId = strOrNull(found[0]?.["tenant_id"]);
  if (!tenantId) return { status: "unknown" };
  const out = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = await lockCompany(tx, tenantId);
    if (!company) return { outcome: { status: "unknown" } as AcceptOutcome, joined: false };
    const result = await service(ctx, tx, beforeConsumeFor(ctx, company)).acceptForVerifiedEmail(
      input.invitationId,
      input.userId,
      input.verifiedEmails,
    );
    return finishAccept(ctx, tx, company, result, input.userId, "verified-email", input.request);
  });
  if (out.joined) {
    const { person, roleName } = await ctx.memberFacts(tenantId, input.userId);
    ctx.emit({ type: "member.joined", tenantId, userId: input.userId, via: "verified-email", person, roleName });
  }
  return out.outcome;
}

/** "carl.crew@greenblade.test" → "c•••@greenblade.test": enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

/**
 * What a link is for, before anyone presses Accept (review T1-07): the company,
 * the role and who sent it. Only for an open invitation to a usable company;
 * anything else answers `found: false` and the Accept button gives the real
 * outcome after the identity check.
 *
 * Given the caller (review R2 T1BO-07), it also says whether the invitation is
 * for one of their VERIFIED addresses — so a crew lead signed in with his own
 * Gmail learns BEFORE pressing Accept that it was sent to another address,
 * which one (masked: "c•••@greenblade.test"), and which address he is signed
 * in with, instead of being refused after a button that looked like it would
 * work. Never the invited address in full.
 */
export async function previewInvitation(
  ctx: Ctx,
  input: { readonly token: string; readonly userId?: string; readonly verifiedEmails?: readonly string[] },
): Promise<InvitationPreview> {
  const none: InvitationPreview = {
    found: false,
    companyName: null,
    roleName: null,
    invitedBy: null,
    addressMatches: null,
    sentTo: null,
    signedInAs: null,
  };
  if (!input.token || input.token.length > 512) return none;
  const hash = hashInvitationToken(input.token);
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/invitation-preview */
      select i.tenant_id, i.email, i.expires_at, i.accepted_at, i.revoked_at, rt.key as role_key,
             u.display_name as inviter_name, u.email as inviter_email
      from tenant_invitations i
      left join role_template rt on rt.id = i.template_id
      left join users u on u.id = i.invited_by
      where i.token_hash = ${hash} or i.earlier_token_hashes @> array[${hash}]::text[]
      limit 1`,
  );
  const row = rows[0];
  if (!row) return none;
  const state = invitationState(
    { expiresAt: dateOrNull(row["expires_at"]), acceptedAt: dateOrNull(row["accepted_at"]), revokedAt: dateOrNull(row["revoked_at"]) },
    ctx.now(),
  );
  if (state !== "pending") return none;
  const company = await readCompany(ctx.db, str(row["tenant_id"]));
  if (!company || company.deletedAt !== null || company.suspendedAt !== null) return none;
  const options = await roleOptions(ctx.db, company.id, ctx.roles);
  const roleKey = strOrNull(row["role_key"]);
  let addressMatches: boolean | null = null;
  let signedInAs: string | null = null;
  if (input.userId && ctx.requireMatchingEmail) {
    const me = await q(ctx.db, sql`/* adminigloo:tenancy/preview-caller */ select email from users where id = ${input.userId} and deleted_at is null`);
    signedInAs = strOrNull(me[0]?.["email"]);
    const mine = new Set([...(input.verifiedEmails ?? []), ...(signedInAs ? [signedInAs] : [])].map(normaliseInviteEmail).filter((e) => e));
    addressMatches = mine.has(normaliseInviteEmail(str(row["email"])));
  }
  return {
    found: true,
    companyName: company.name,
    roleName: roleKey ? roleNameOf(options, roleKey) : null,
    invitedBy: strOrNull(row["inviter_name"]) ?? strOrNull(row["inviter_email"]),
    addressMatches,
    sentTo: addressMatches === false ? maskEmail(normaliseInviteEmail(str(row["email"]))) : null,
    signedInAs: addressMatches === false ? signedInAs : null,
  };
}

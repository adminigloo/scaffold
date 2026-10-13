import { sql } from "drizzle-orm";
import { normaliseInviteEmail } from "../invitations.js";
import { roleNameOf, roleOptions, type Ctx } from "./context.js";
import { asRoleKey, companyRow, COMPANY_COLUMNS, dateOrNull, q, readUser, str, strOrNull, type CompanyRow } from "./db.js";
import { ensureFreshPersonalWorkspace, provisionUser } from "./provisioning.js";
import { companyView } from "./views.js";
import type { CompanyChoice, CompanyView, PendingForMe, SessionState, TenancyDb } from "./types.js";

interface LiveMembership {
  readonly company: CompanyRow;
  readonly joinedAt: Date;
  readonly roleKey: string | null;
}

/** Active memberships in live (not deleted) tenants of the mode's kind, in the deterministic order. */
async function liveMemberships(ctx: Ctx, db: TenancyDb, userId: string): Promise<LiveMembership[]> {
  const kind = ctx.mode === "companies" ? "org" : "personal";
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/session-memberships */
      select ${COMPANY_COLUMNS}, m.created_at as joined_at, rt.key as role_key
      from tenant_members m
      join tenants t on t.id = m.tenant_id
      left join principal_role pr on pr.principal_id = m.user_id and pr.scope = 'tenant' and pr.tenant_id = m.tenant_id
      left join role_template rt on rt.id = pr.template_id
      where m.user_id = ${userId} and m.status = 'active' and t.deleted_at is null and t.kind = ${kind}`,
  );
  const list = rows.map((row) => ({
    company: companyRow(row),
    joinedAt: dateOrNull(row["joined_at"]) ?? new Date(0),
    roleKey: strOrNull(row["role_key"]),
  }));
  // DETERMINISTIC ORDER, never the database's emission order (Riddler Go's
  // ordering bug: two requests could land the same person in different
  // companies). Usable before suspended; in personal mode the workspace you
  // OWN before one you were invited into (by owner, not by id: `ws_<you>` may
  // have been handed to someone else, review R2 SEC-T1-A); then the oldest
  // membership; then the id.
  list.sort((a, b) => {
    const sa = a.company.suspendedAt === null ? 0 : 1;
    const sb = b.company.suspendedAt === null ? 0 : 1;
    if (sa !== sb) return sa - sb;
    if (ctx.mode === "personal") {
      const oa = a.company.ownerUserId === userId ? 0 : 1;
      const ob = b.company.ownerUserId === userId ? 0 : 1;
      if (oa !== ob) return oa - ob;
    }
    const t = a.joinedAt.getTime() - b.joinedAt.getTime();
    if (t !== 0) return t;
    return a.company.id < b.company.id ? -1 : a.company.id > b.company.id ? 1 : 0;
  });
  return list;
}

/**
 * Which company is this person in? (decisions D3, D6, D15; contract 6.3)
 *
 * The POINTER (`users.active_tenant_id`) is a preference, never an authority:
 * it is honoured only while it names a live membership. A stale one (removed,
 * left, company deleted) falls back to the first live membership in the
 * deterministic order and is rewritten. With none at all:
 *
 *   companies mode  → needs-onboarding, with the invitations waiting for the
 *                     person's VERIFIED addresses, and — when the stale
 *                     pointer names a company they were removed from or left
 *                     — that company's name, so onboarding can say "You're no
 *                     longer part of Green Acres" instead of silently asking
 *                     them to create a company (review T1-09). The pointer is
 *                     left as it is until they join or create one, so every
 *                     onboarding render can say it.
 *   personal mode   → provision once to heal, and retry.
 *
 * Runs on every signed-in page view (the header switcher) and is the reason a
 * removed member is refused on their very next request: nothing is cached.
 */
export async function resolveSession(
  ctx: Ctx,
  input: { readonly userId: string; readonly verifiedEmails?: readonly string[] },
  healed = false,
): Promise<SessionState> {
  const user = await readUser(ctx.db, input.userId);
  if (!user) throw ctx.fail("signed_out");
  const facts = { userId: user.id, email: user.email, name: user.name };
  const memberships = await liveMemberships(ctx, ctx.db, user.id);

  if (memberships.length === 0) {
    if (ctx.mode === "personal") {
      if (healed) throw ctx.fail("internal");
      // Heal: their own workspace (a 0.3 user, a provisioning crash) — and if
      // that one was handed to someone else, a new one of their own, never a
      // way back into the one they gave away (review R2 SEC-T1-A).
      const out = await provisionUser(ctx, { userId: user.id, email: user.email });
      if (out.personalWorkspaceId === null) await ensureFreshPersonalWorkspace(ctx, { userId: user.id, email: user.email });
      return resolveSession(ctx, input, true);
    }
    return {
      state: "needs-onboarding",
      mode: ctx.mode,
      user: facts,
      invitations: await invitationsForMe(ctx, { verifiedEmails: input.verifiedEmails ?? [] }),
      formerCompany: await formerCompanyName(ctx, user.id, user.activeTenantId),
    };
  }

  const pointed = memberships.find((m) => m.company.id === user.activeTenantId);
  const chosen = pointed ?? memberships[0]!;
  if (!pointed) {
    await ctx.db.execute(sql`/* adminigloo:tenancy/session-pointer */
      update users set active_tenant_id = ${chosen.company.id}
      where id = ${user.id} and active_tenant_id is distinct from ${chosen.company.id}`);
  }

  const companies: CompanyChoice[] = memberships.map((m) => ({
    id: m.company.id,
    name: m.company.name,
    slug: m.company.slug,
    logoUrl: m.company.branding.logoUrl ?? null,
    role: asRoleKey(m.roleKey),
    status: m.company.suspendedAt === null ? "active" : "suspended",
    active: m.company.id === chosen.company.id,
  }));
  const company = companyView(chosen.company, { userId: user.id, role: asRoleKey(chosen.roleKey) });
  return {
    state: chosen.company.suspendedAt === null ? "ready" : "suspended",
    mode: ctx.mode,
    user: facts,
    company,
    companies,
  };
}

/** The org company a stale pointer names, if the person is no longer a live member of it. */
async function formerCompanyName(ctx: Ctx, userId: string, pointer: string | null): Promise<string | null> {
  if (!pointer) return null;
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/former-company */
      select t.name from tenants t
      where t.id = ${pointer} and t.kind = 'org'
        and not exists (select 1 from tenant_members m where m.tenant_id = t.id and m.user_id = ${userId} and m.status = 'active')`,
  );
  return strOrNull(rows[0]?.["name"]);
}

/**
 * Choose the company the next page renders. The caller must be an active
 * member of a live company of the mode's kind; anything else is `not_found`,
 * the same answer for a foreign id and a missing one. A suspended company may
 * be chosen: the page then explains.
 */
export async function setActiveCompany(ctx: Ctx, input: { readonly userId: string; readonly tenantId: string }): Promise<CompanyView> {
  const memberships = await liveMemberships(ctx, ctx.db, input.userId);
  const found = memberships.find((m) => m.company.id === input.tenantId);
  if (!found) throw ctx.fail("not_found");
  await ctx.db.execute(sql`/* adminigloo:tenancy/set-active */
    update users set active_tenant_id = ${input.tenantId} where id = ${input.userId}`);
  return companyView(found.company, { userId: input.userId, role: asRoleKey(found.roleKey) });
}

/**
 * Open invitations addressed to any of these VERIFIED addresses (D19), in
 * companies that aren't suspended or deleted. Empty input → []. The host takes
 * the addresses from the identity provider on the server; an unverified one
 * never qualifies.
 */
export async function invitationsForMe(ctx: Ctx, input: { readonly verifiedEmails: readonly string[] }): Promise<PendingForMe[]> {
  const emails = [...new Set(input.verifiedEmails.map(normaliseInviteEmail).filter((e) => e.length > 0))];
  if (emails.length === 0) return [];
  const kind = ctx.mode === "companies" ? "org" : "personal";
  const now = ctx.now();
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/invitations-for-me */
      select i.id, i.tenant_id, i.expires_at, t.name as company_name, rt.key as role_key,
             u.display_name as inviter_name, u.email as inviter_email
      from tenant_invitations i
      join tenants t on t.id = i.tenant_id
      left join role_template rt on rt.id = i.template_id
      left join users u on u.id = i.invited_by
      where i.email in (${sql.join(emails.map((e) => sql`${e}`), sql`, `)})
        and i.accepted_at is null and i.revoked_at is null
        and (i.expires_at is null or i.expires_at > ${now})
        and t.deleted_at is null and t.suspended_at is null and t.kind = ${kind}
      order by i.created_at desc, i.id desc`,
  );
  const options = rows.length > 0 ? await roleOptions(ctx.db, "*") : [];
  return rows.map((row) => {
    const roleKey = asRoleKey(row["role_key"]);
    return {
      id: str(row["id"]),
      companyName: str(row["company_name"]),
      roleKey,
      roleName: roleKey ? roleNameOf(options, roleKey) : "Member",
      invitedBy: strOrNull(row["inviter_name"]) ?? strOrNull(row["inviter_email"]),
      expiresAt: dateOrNull(row["expires_at"]),
    };
  });
}

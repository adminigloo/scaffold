import { resolvePermissionSet } from "@adminigloo/permissions";
import { sql } from "drizzle-orm";
import type { Ctx } from "./context.js";
import { asRoleKey, COMPANY_COLUMNS, companyRow, q, str, strOrNull } from "./db.js";
import { publicPathOf } from "./views.js";
import type { CompanyProfile, MemberPerson } from "./types.js";

/**
 * The reads the FEATURE packages need (Tenancy 2a, 4.3–4.5): the company as
 * its customers know it, its people, and the list a cron walks.
 *
 * NO PERMISSION CHECK, on purpose, like `readSettings`: these are for server
 * code that has ALREADY decided whom it serves — a handler after `authorize`,
 * a public page after `resolveTenant`, a cron, comms' sender identity. They
 * never take a caller's word for a company id; the caller's seam did that.
 * Nothing here is reachable from a request without one of those in front.
 */

/** A saved text value, or null for missing or blank (a cleared field is stored as ""). */
function textOrNull(value: unknown): string | null {
  const s = strOrNull(value);
  return s !== null && s.trim() !== "" ? s.trim() : null;
}

/**
 * The company's profile, or null for an unknown or deleted id.
 *
 * ONE query: `tenants` left-joined to `users` on the owner, for the owner's
 * sign-in address (a deleted owner contributes null). Settings that don't
 * parse are reported through `onEventError` and fall back to defaults; never
 * thrown (T1 6.6): a bad stored value must not stop a booking email.
 */
export async function companyProfile(ctx: Ctx, tenantId: string): Promise<CompanyProfile | null> {
  if (typeof tenantId !== "string" || tenantId === "") return null;
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/company-profile */
      select ${COMPANY_COLUMNS}, u.email as owner_email
      from tenants t left join users u on u.id = t.owner_user_id and u.deleted_at is null
      where t.id = ${tenantId}`,
  );
  const row = rows[0];
  if (!row) return null;
  const company = companyRow(row);
  if (company.deletedAt !== null) return null;

  const { values, problems } = ctx.settings.parse(company.settings ?? {});
  for (const p of problems) ctx.report(new Error(p.message), "settings.parse");
  const settings = values as Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  const details = settings["company"] ?? {};

  const contactEmail = textOrNull(details["contactEmail"]);
  const ownerEmail = textOrNull(row["owner_email"]);
  // Where a customer's reply lands: the address the business chose to be
  // reached at, else the owner's own (someone reads it); never a no-reply.
  const replyTo = contactEmail ?? ownerEmail;
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    publicPath: publicPathOf(company.slug),
    kind: company.kind,
    status: company.suspendedAt === null ? "active" : "suspended",
    timeZone: textOrNull(details["timeZone"]),
    contactEmail,
    contactPhone: textOrNull(details["contactPhone"]),
    address: {
      line1: textOrNull(details["addressLine1"]),
      line2: textOrNull(details["addressLine2"]),
      city: textOrNull(details["city"]),
      region: textOrNull(details["region"]),
      postalCode: textOrNull(details["postalCode"]),
      country: textOrNull(details["country"]),
    },
    logoUrl: company.branding.logoUrl ?? null,
    brandColor: company.branding.brandColor ?? null,
    onBrandColor: company.branding.onBrandColor ?? null,
    replyTo,
    inbox: replyTo ? [replyTo] : [],
    settings,
    createdAt: company.createdAt,
  };
}

/**
 * The company's ACTIVE members as people, ordered by name then email: for
 * scheduling's "who opens this crew's route" picker. The company's own
 * people, never the site's whole user table (in companies mode that would
 * show Summit's people to Green Acres). One query; the role's name is the one
 * the database holds (a renamed template reads as renamed).
 *
 * TENANCY 2b-1 (8.2): `holding` narrows it to the members whose resolved
 * permission set in this company includes that key. Resolved EXACTLY as a
 * request resolves it — `resolvePermissionSet` over their role's grants and
 * their own overrides here (an allow override adds it, a deny override takes
 * it away, a template's deny seals it) — so "who gets this alert" and "who
 * may open what it links to" can never disagree. THREE QUERIES whatever the
 * team size: the members (with each one's role template), the grants of
 * those templates for this one key, and this company's overrides of it for
 * those members. A per-person resolve was 3 queries a person: 90 for a team
 * of 30, on every alert. Grants and overrides are read for the ONE key
 * asked: resolution is per key, so the answer for it is the same as the
 * whole set's, without reading the whole set.
 */
export async function listMemberPeople(
  ctx: Ctx,
  tenantId: string,
  options: { readonly holding?: string } = {},
): Promise<readonly MemberPerson[]> {
  if (typeof tenantId !== "string" || tenantId === "") return [];
  const holding = typeof options.holding === "string" ? options.holding : undefined;
  // An empty key is held by nobody; a host that forgot to fill it gets [] and
  // not everyone (never widen).
  if (holding !== undefined && holding.trim() === "") return [];
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/member-people */
      select m.user_id, u.display_name, u.email, rt.key as role_key, rt.name as role_name, pr.template_id
      from tenant_members m
      join tenants t on t.id = m.tenant_id and t.deleted_at is null
      left join users u on u.id = m.user_id and u.deleted_at is null
      left join principal_role pr on pr.principal_id = m.user_id and pr.scope = 'tenant' and pr.tenant_id = m.tenant_id
      left join role_template rt on rt.id = pr.template_id
      where m.tenant_id = ${tenantId} and m.status = 'active'
      order by lower(u.display_name) nulls last, lower(u.email) nulls last, m.user_id`,
  );
  const holders = holding === undefined ? null : await holdersOf(ctx, tenantId, holding, rows);
  return rows.filter((r) => holders === null || holders.has(str(r["user_id"]))).map((r) => {
    const roleKey = asRoleKey(r["role_key"]);
    return {
      userId: str(r["user_id"]),
      name: textOrNull(r["display_name"]),
      email: textOrNull(r["email"]),
      roleKey,
      roleName: textOrNull(r["role_name"]) ?? (roleKey ? ctx.roles.templates.find((t) => t.key === roleKey)?.name ?? roleKey : "No role"),
    };
  });
}

/**
 * Which of these member rows hold `permission` in this company: the second
 * and third of `listMemberPeople`'s three queries, then
 * `resolvePermissionSet` per person in memory (8.2).
 */
async function holdersOf(
  ctx: Ctx,
  tenantId: string,
  permission: string,
  members: readonly Readonly<Record<string, unknown>>[],
): Promise<ReadonlySet<string>> {
  const holders = new Set<string>();
  if (members.length === 0) return holders;
  const userIds = [...new Set(members.map((r) => str(r["user_id"])))];
  const templateIds = [...new Set(members.map((r) => strOrNull(r["template_id"])).filter((id): id is string => id !== null))];
  const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

  // 2. The grants of the templates these members hold, for this key (a team
  // where nobody holds a role has none to read: at most three queries).
  const grants =
    templateIds.length === 0
      ? []
      : await q(
          ctx.db,
          sql`/* adminigloo:tenancy/member-people-grants */
            select template_id, permission, effect from role_template_grant
            where permission = ${permission} and template_id in (${list(templateIds)})`,
        );
  // 3. This company's overrides of this key for these members.
  const overrides = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/member-people-overrides */
      select principal_id, permission, effect from principal_override
      where scope = 'tenant' and tenant_id = ${tenantId} and permission = ${permission}
        and principal_id in (${list(userIds)})`,
  );

  const grantsByTemplate = new Map<string, { permission: string; effect: "allow" | "deny" }[]>();
  for (const g of grants) {
    const id = str(g["template_id"]);
    const rules = grantsByTemplate.get(id) ?? [];
    rules.push({ permission: str(g["permission"]), effect: g["effect"] === "deny" ? "deny" : "allow" });
    grantsByTemplate.set(id, rules);
  }
  const overridesByPerson = new Map<string, { permission: string; effect: "allow" | "deny" }[]>();
  for (const o of overrides) {
    const id = str(o["principal_id"]);
    const rules = overridesByPerson.get(id) ?? [];
    rules.push({ permission: str(o["permission"]), effect: o["effect"] === "deny" ? "deny" : "allow" });
    overridesByPerson.set(id, rules);
  }
  for (const member of members) {
    const userId = str(member["user_id"]);
    const templateId = strOrNull(member["template_id"]);
    const set = resolvePermissionSet({
      templateGrants: templateId ? grantsByTemplate.get(templateId) ?? [] : [],
      overrides: overridesByPerson.get(userId) ?? [],
    });
    if (set.has(permission)) holders.add(userId);
  }
  return holders;
}

/**
 * Every company a cron should serve, ordered by id (a stable order to rotate,
 * D10): companies mode → kind 'org'; personal mode → kind 'personal'. Never a
 * suspended or deleted one: a suspended company's reminders stop with it.
 */
export async function activeCompanyIds(ctx: Ctx): Promise<readonly string[]> {
  const kind = ctx.mode === "personal" ? "personal" : "org";
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/active-companies */
      select id from tenants where kind = ${kind} and suspended_at is null and deleted_at is null order by id`,
  );
  return rows.map((r) => str(r["id"]));
}

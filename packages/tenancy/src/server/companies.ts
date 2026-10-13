import { assignRoleTemplate } from "@adminigloo/permissions/server";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  companyNameProblem,
  normaliseCompanyName,
  slugProblemMessage,
  suggestSlug,
  validateSlug,
} from "../slug.js";
import { requireActor, type Ctx } from "./context.js";
import { companyRow, COMPANY_COLUMNS, num, q } from "./db.js";
import { isUniqueViolation, nameError, slugError } from "./errors.js";
import { tenancyMembershipGate } from "./gate.js";
import { ensureTenantTemplates } from "./provisioning.js";
import { resolveSession } from "./session.js";
import { firstFreeSlug, slugCandidates, takenSlugs } from "./slugs.js";
import { companyView } from "./views.js";
import type { CreateCompanyResult, RequestFacts, SlugCheck, TenancyDb } from "./types.js";

/**
 * Is this web address free? (contract 6.4)
 *
 * Given only a NAME, it answers with the first free address derived from it
 * (so the onboarding form shows an address that will work, not one that
 * collides). Given a SLUG, it checks that exact address and, when it can't be
 * used, says why in a sentence and offers a free one. Given a `tenantId`, the
 * caller must be able to see that company, and its own current and retired
 * addresses count as available (renaming back is fine).
 */
export async function checkSlug(
  ctx: Ctx,
  input: { readonly actorUserId: string; readonly slug?: string; readonly name?: string; readonly tenantId?: string },
): Promise<SlugCheck> {
  const own = input.tenantId ?? null;
  if (own !== null) {
    try {
      await requireActor(ctx, ctx.db, { userId: input.actorUserId, tenantId: own }, { permission: "tenant.view", allowSuspended: true });
    } catch {
      throw ctx.fail("not_found");
    }
  }

  if (input.slug === undefined) {
    const free = await firstFreeSlug(ctx, ctx.db, input.name ?? "", own);
    return { slug: free, available: true, problem: null, message: null, suggestion: free };
  }

  const slug = input.slug.trim().toLowerCase();
  const problem = validateSlug(slug, { reserved: ctx.reserved });
  if (problem) {
    return {
      slug,
      available: false,
      problem,
      message: slugProblemMessage(problem, ctx.noun.singular),
      suggestion: await firstFreeSlug(ctx, ctx.db, slug || input.name || "company", own),
    };
  }
  const taken = await takenSlugs(ctx.db, [slug], own);
  if (taken.has(slug)) {
    return {
      slug,
      available: false,
      problem: "taken",
      message: (await yoursMessage(ctx, input.actorUserId, slug)) ?? slugProblemMessage("taken", ctx.noun.singular),
      suggestion: await firstFreeSlug(ctx, ctx.db, slug, own),
    };
  }
  return { slug, available: true, problem: null, message: null, suggestion: slug };
}

/**
 * "That's the web address of Cal's Snow Removal, which you already have." —
 * when the address is held (now or as an old one) by a company the caller is
 * a member of (review R2 T1BO-01). The plain "already used by another
 * company" was false there, and after a lost answer it pushed people to take
 * the "-2" it offered and make a twin of the company they had just made.
 */
async function yoursMessage(ctx: Ctx, userId: string, slug: string): Promise<string | null> {
  const rows = await q(
    ctx.db,
    sql`/* adminigloo:tenancy/slug-yours */
      select t.name from tenants t
      join tenant_members m on m.tenant_id = t.id and m.user_id = ${userId} and m.status = 'active'
      where t.deleted_at is null
        and (t.slug = ${slug} or exists (select 1 from tenant_retired_slugs r where r.tenant_id = t.id and r.slug = ${slug}))
      limit 1`,
  );
  const name = rows[0]?.["name"];
  return typeof name === "string" ? `That's the web address of ${name}, which you already have. Open it from the menu, or pick a different address.` : null;
}

/** How long a "Create another" with the same name opens the company it already made (review R2 T1BO-01). */
export const DUPLICATE_CREATE_WINDOW_MINUTES = 10;

const REQUEST_KEY = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Create a company with the caller as its owner, in ONE transaction
 * (scenario step 1; decisions D6, D10; contract 6.4).
 *
 *   1. Per-user advisory lock: every create for one person waits its turn,
 *      so two tabs (or a double click) can't both pass the checks below.
 *   2. Replay: the same form's key again (a refresh, a double submit, a lost
 *      response) returns the company it already made. READ-ONLY, and only
 *      while the caller is still a member of it (review T1-01): the key lives
 *      in the creator's own browser, so a creator who was later removed could
 *      otherwise re-send the original request and have their membership and
 *      owner role re-created behind the real owner's back. A former creator
 *      gets `not_found`.
 *   3. Onboarding guard: a person who already has a company and submits the
 *      onboarding form again (another tab, another key) lands in that company
 *      instead of making a second one. "Create another" gets its own guard
 *      (review R2 T1BO-01): the same person creating a company with the same
 *      name (case and spacing ignored) within DUPLICATE_CREATE_WINDOW_MINUTES
 *      of the last one gets THAT company back, whatever address or key the
 *      retry carries — a lost answer followed by "Use calsnow-2", or a reload
 *      and a retype, used to make a twin nobody could delete. And one account
 *      owns at most `companiesPerAccount` live companies (review R2
 *      SEC-T1-B/C): companies were free and unlimited, which multiplied the
 *      invitation and web-address budgets by however many one account made.
 *   4. The owner template is seeded if missing (D10).
 *   5–9. Insert the company, its owner membership and owner role, and point
 *      the person at it. A suggested address that collides moves to `-2`,
 *      `-3`…; an explicit one that collides is refused with a free suggestion.
 *  10. Audit `company.created`.
 */
export async function createCompany(
  ctx: Ctx,
  input: {
    readonly userId: string;
    readonly name: string;
    readonly slug?: string;
    readonly requestKey: string;
    readonly purpose: "onboarding" | "additional";
    readonly request?: RequestFacts;
  },
): Promise<CreateCompanyResult> {
  if (ctx.mode === "personal") throw ctx.fail("unavailable");
  if (!REQUEST_KEY.test(input.requestKey)) {
    throw ctx.fail("invalid", { issues: [{ path: ["requestKey"], message: "Reload the page and try again." }] });
  }

  const name = normaliseCompanyName(input.name);
  const nameProblem = companyNameProblem(name);
  if (nameProblem) throw nameError(nameProblem, ctx.noun);

  let explicit: string | null = null;
  if (input.slug !== undefined && input.slug.trim() !== "") {
    explicit = input.slug.trim().toLowerCase();
    const problem = validateSlug(explicit, { reserved: ctx.reserved });
    if (problem) throw slugError(problem, ctx.noun, await firstFreeSlug(ctx, ctx.db, explicit, null));
  }

  const result = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    await tx.execute(sql`/* adminigloo:tenancy/create-lock */
      select pg_advisory_xact_lock(hashtextextended(${`adminigloo:tenancy:create:${input.userId}`}, 0))`);

    // 2. Replay — read-only.
    const prior = await q(
      tx,
      sql`/* adminigloo:tenancy/create-replay */
        select ${COMPANY_COLUMNS} from tenants t where t.created_by = ${input.userId} and t.creation_key = ${input.requestKey}`,
    );
    if (prior[0]) {
      const company = companyRow(prior[0]);
      const verdict = await tenancyMembershipGate(tx, { userId: input.userId, tenantId: company.id });
      if (company.deletedAt !== null || verdict === "not-a-member") throw ctx.fail("not_found");
      const role = await q(
        tx,
        sql`/* adminigloo:tenancy/role-of */
          select rt.key from principal_role pr join role_template rt on rt.id = pr.template_id
          where pr.principal_id = ${input.userId} and pr.scope = 'tenant' and pr.tenant_id = ${company.id}`,
      );
      const key = role[0]?.["key"];
      return {
        status: "replayed" as const,
        company: companyView(company, {
          userId: input.userId,
          role: key === "owner" || key === "admin" || key === "member" || key === "viewer" ? key : null,
        }),
        created: false,
      };
    }

    // 3. Onboarding guard.
    if (input.purpose === "additional") {
      const twin = await q(
        tx,
        sql`/* adminigloo:tenancy/create-twin */
          select ${COMPANY_COLUMNS} from tenants t
          join tenant_members m on m.tenant_id = t.id and m.user_id = ${input.userId} and m.status = 'active'
          where t.created_by = ${input.userId} and t.kind = 'org' and t.deleted_at is null
            and lower(t.name) = lower(${name})
            and t.created_at > now() - make_interval(mins => ${DUPLICATE_CREATE_WINDOW_MINUTES})
          order by t.created_at desc limit 1`,
      );
      if (twin[0]) {
        const company = companyRow(twin[0]);
        const role = await q(
          tx,
          sql`/* adminigloo:tenancy/role-of */
            select rt.key from principal_role pr join role_template rt on rt.id = pr.template_id
            where pr.principal_id = ${input.userId} and pr.scope = 'tenant' and pr.tenant_id = ${company.id}`,
        );
        const key = role[0]?.["key"];
        await tx.execute(sql`/* adminigloo:tenancy/create-pointer */
          update users set active_tenant_id = ${company.id} where id = ${input.userId}`);
        return {
          status: "replayed" as const,
          company: companyView(company, {
            userId: input.userId,
            role: key === "owner" || key === "admin" || key === "member" || key === "viewer" ? key : null,
          }),
          created: false,
        };
      }
    }
    if (input.purpose === "onboarding") {
      const live = await q(
        tx,
        sql`/* adminigloo:tenancy/create-has-company */
          select 1 from tenant_members m join tenants t on t.id = m.tenant_id
          where m.user_id = ${input.userId} and m.status = 'active' and t.kind = 'org' and t.deleted_at is null limit 1`,
      );
      if (live.length > 0) return { status: "already-onboarded" as const, company: null, created: false };
    }
    if (ctx.companiesPerAccount !== null) {
      const owned = await q(
        tx,
        sql`/* adminigloo:tenancy/create-owned-count */
          select count(*) as n from tenants where owner_user_id = ${input.userId} and kind = 'org' and deleted_at is null`,
      );
      if (num(owned[0]?.["n"]) >= ctx.companiesPerAccount) {
        throw ctx.fail(
          "forbidden",
          undefined,
          `One account can own up to ${ctx.companiesPerAccount} ${ctx.companiesPerAccount === 1 ? ctx.noun.singular : ctx.noun.plural}. Contact support if you need more.`,
        );
      }
    }

    // 4. D10.
    await ensureTenantTemplates(ctx, tx);

    // 5–6. The company, on the first free address.
    const id = uuidv7();
    const candidates = explicit ? [explicit] : slugCandidates(suggestSlug(name), ctx.reserved);
    const taken = await takenSlugs(tx, candidates, null);
    let slug: string | null = null;
    for (const candidate of candidates) {
      if (taken.has(candidate)) continue;
      try {
        // A savepoint, so a unique violation from a racing create (on another
        // connection) rolls back this one insert, not the transaction.
        await tx.transaction(async (sp) => {
          await (sp as unknown as TenancyDb).execute(sql`/* adminigloo:tenancy/create-insert */
            insert into tenants (id, kind, slug, name, owner_user_id, created_by, creation_key)
            values (${id}, 'org', ${candidate}, ${name}, ${input.userId}, ${input.userId}, ${input.requestKey})`);
        });
        slug = candidate;
        break;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    if (slug === null) {
      if (explicit) throw slugError("taken", ctx.noun, await firstFreeSlug(ctx, tx, explicit, null));
      throw ctx.fail("internal");
    }

    // 7. The owner's membership.
    await tx.execute(sql`/* adminigloo:tenancy/create-member */
      insert into tenant_members (tenant_id, user_id, status) values (${id}, ${input.userId}, 'active')
      on conflict (tenant_id, user_id) do nothing`);

    // 8. The owner role. After step 4 it can't write zero rows; if it ever
    // does, NOTHING commits: an owner who holds nothing in their own company is
    // the PC-01 failure, and it must never be saved.
    const granted = await assignRoleTemplate(tx, {
      scope: "tenant",
      tenantId: id,
      principalId: input.userId,
      templateKey: "owner",
      actor: { system: "createCompany" },
    });
    if (granted.next?.key !== "owner") throw ctx.fail("internal");

    // 9. Point the person at it: the next page renders this company.
    await tx.execute(sql`/* adminigloo:tenancy/create-pointer */
      update users set active_tenant_id = ${id} where id = ${input.userId}`);

    // 10. Audit.
    await ctx.audit(tx, {
      action: "company.created",
      actorUserId: input.userId,
      scope: "tenant",
      tenantId: id,
      resourceType: "tenant",
      resourceId: id,
      metadata: { name, slug, purpose: input.purpose },
      request: input.request ?? null,
    });

    const created = await q(tx, sql`/* adminigloo:tenancy/read-company */ select ${COMPANY_COLUMNS} from tenants t where t.id = ${id}`);
    return {
      status: "created" as const,
      company: companyView(companyRow(created[0]!), { userId: input.userId, role: "owner" }),
      created: true,
    };
  });

  if (result.status === "already-onboarded") {
    const session = await resolveSession(ctx, { userId: input.userId });
    if (session.state === "needs-onboarding") throw ctx.fail("internal");
    return { status: "already-onboarded", company: session.company };
  }
  if (result.created) ctx.emit({ type: "company.created", tenantId: result.company!.id, userId: input.userId });
  return { status: result.status, company: result.company! };
}

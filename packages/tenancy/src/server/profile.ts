import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { brandColorReport, normaliseHexColor, type BrandColorReport } from "../color.js";
import { companyNameProblem, normaliseCompanyName, validateSlug } from "../slug.js";
import type { TenantBranding } from "../schema.js";
import { requireActor, requireLive, roleKeyOf, type Ctx } from "./context.js";
import { lockCompany, num, q, readCompany } from "./db.js";
import { isUniqueViolation, nameError, slugError } from "./errors.js";
import { firstFreeSlug, takenSlugs } from "./slugs.js";
import { companyView } from "./views.js";
import type { CompanyView, RequestFacts, TenancyDb } from "./types.js";

/** How many of its old web addresses a company keeps pointing at itself (review T1-07). */
export const RETIRED_SLUGS_KEPT = 3;
/** How many address changes a company may make in a rolling day (review T1-07). */
export const SLUG_CHANGES_PER_DAY = 3;
/**
 * How many address changes one PERSON may make in a rolling day, across every
 * company they can edit (review R2 SEC-T1-C): the per-company limit alone was
 * multiplied by the companies one account could make.
 */
export const SLUG_CHANGES_PER_PERSON_PER_DAY = 5;
/** The largest logo accepted, in bytes. */
export const LOGO_MAX_BYTES = 1_048_576;

type Actor = { readonly actorUserId: string; readonly tenantId: string; readonly request?: RequestFacts };

/** The company's profile and what the caller may do there (`can`), so the widget hides what they can't do. */
export async function getCompany(
  ctx: Ctx,
  input: { readonly actorUserId: string; readonly tenantId: string },
): Promise<{ company: CompanyView; can: readonly string[]; logoUploads: boolean }> {
  const facts = await requireActor(ctx, ctx.db, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.view" });
  const row = requireLive(ctx, await readCompany(ctx.db, input.tenantId));
  return {
    company: companyView(row, { userId: input.actorUserId, role: roleKeyOf(facts.role?.key) }),
    can: [...facts.can].sort(),
    // Whether a logo can be uploaded at all, so the page explains before
    // anyone picks a file (review T1-11) instead of after.
    logoUploads: ctx.logos !== undefined,
  };
}

/**
 * Rename, or change the web address (tenant.edit).
 *
 * A NEW ADDRESS RETIRES THE OLD ONE (D14): it keeps pointing here, so links in
 * old emails and on old receipts still work, and nobody else can claim it.
 * Getting your own old address back is fine. Bounded (review T1-07): the last
 * RETIRED_SLUGS_KEPT old addresses are kept and older ones are released, and a
 * company changes its address at most SLUG_CHANGES_PER_DAY times a day, one
 * person at most SLUG_CHANGES_PER_PERSON_PER_DAY times across all their
 * companies — counted from `tenant_slug_changes`, which switching back to an
 * old address doesn't erase (review R2 F6, SEC-T1-C). With the per-account
 * company limit, one free account can't lock up hundreds of business names.
 *
 * A RACE FOR THE SAME ADDRESS (review R2 F5): two companies can both see an
 * address free; the unique index makes the second writer wait and then fail.
 * That failure is caught (a savepoint) and answered as `slug_taken` with a
 * free suggestion, like createCompany, never as a 500.
 */
export async function updateCompanyProfile(
  ctx: Ctx,
  input: Actor & { readonly name?: string; readonly slug?: string },
): Promise<CompanyView> {
  let changed: ("name" | "slug")[] = [];
  const view = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.edit" });

    let name = company.name;
    if (input.name !== undefined) {
      name = normaliseCompanyName(input.name);
      const problem = companyNameProblem(name);
      if (problem) throw nameError(problem, ctx.noun);
    }

    let slug = company.slug;
    if (input.slug !== undefined && input.slug.trim().toLowerCase() !== company.slug) {
      if (company.kind === "personal") {
        throw ctx.fail("invalid", {
          issues: [{ path: ["slug"], message: "A personal workspace's web address can't be changed." }],
        });
      }
      slug = input.slug.trim().toLowerCase();
      const problem = validateSlug(slug, { reserved: ctx.reserved });
      if (problem) throw slugError(problem, ctx.noun, await firstFreeSlug(ctx, tx, slug, company.id));
      if ((await takenSlugs(tx, [slug], company.id)).has(slug)) {
        throw slugError("taken", ctx.noun, await firstFreeSlug(ctx, tx, slug, company.id));
      }
      const since = new Date(ctx.now().getTime() - 24 * 3_600_000);
      const recent = await q(
        tx,
        sql`/* adminigloo:tenancy/slug-changes-today */
          select
            (select count(*) from tenant_slug_changes where tenant_id = ${company.id} and changed_at > ${since}) as company_n,
            (select count(*) from tenant_slug_changes where changed_by = ${input.actorUserId} and changed_at > ${since}) as person_n`,
      );
      if (num(recent[0]?.["company_n"]) >= SLUG_CHANGES_PER_DAY) {
        throw ctx.fail(
          "rate_limited",
          undefined,
          `You've changed the web address ${SLUG_CHANGES_PER_DAY} times today. Try again tomorrow.`,
        );
      }
      if (num(recent[0]?.["person_n"]) >= SLUG_CHANGES_PER_PERSON_PER_DAY) {
        throw ctx.fail(
          "rate_limited",
          undefined,
          `You've changed web addresses ${SLUG_CHANGES_PER_PERSON_PER_DAY} times today. Try again tomorrow.`,
        );
      }
      await tx.execute(sql`/* adminigloo:tenancy/log-slug-change */
        insert into tenant_slug_changes (id, tenant_id, from_slug, to_slug, changed_by, changed_at)
        values (${uuidv7()}, ${company.id}, ${company.slug}, ${slug}, ${input.actorUserId}, ${ctx.now()})`);
      await tx.execute(sql`/* adminigloo:tenancy/retire-slug */
        insert into tenant_retired_slugs (slug, tenant_id, retired_at) values (${company.slug}, ${company.id}, ${ctx.now()})
        on conflict (slug) do nothing`);
      await tx.execute(sql`/* adminigloo:tenancy/unretire-slug */
        delete from tenant_retired_slugs where slug = ${slug} and tenant_id = ${company.id}`);
      await tx.execute(sql`/* adminigloo:tenancy/retired-slug-cap */
        delete from tenant_retired_slugs where tenant_id = ${company.id} and slug not in (
          select slug from tenant_retired_slugs where tenant_id = ${company.id}
          order by retired_at desc, slug limit ${RETIRED_SLUGS_KEPT})`);
    }

    if (name === company.name && slug === company.slug) {
      return companyView(company, { userId: input.actorUserId, role: roleKeyOf(facts.role?.key) });
    }
    try {
      await tx.transaction(async (sp) => {
        await (sp as unknown as TenancyDb).execute(sql`/* adminigloo:tenancy/update-profile */
          update tenants set name = ${name}, slug = ${slug}, updated_at = now() where id = ${company.id}`);
      });
    } catch (error) {
      if (slug !== company.slug && isUniqueViolation(error)) {
        throw slugError("taken", ctx.noun, await firstFreeSlug(ctx, tx, slug, company.id));
      }
      throw error;
    }
    await ctx.audit(tx, {
      action: "company.profile.updated",
      actorUserId: input.actorUserId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant",
      resourceId: company.id,
      metadata: { from: { name: company.name, slug: company.slug }, to: { name, slug } },
      request: input.request ?? null,
    });
    changed = [...(name !== company.name ? (["name"] as const) : []), ...(slug !== company.slug ? (["slug"] as const) : [])];
    return companyView({ ...company, name, slug }, { userId: input.actorUserId, role: roleKeyOf(facts.role?.key) });
  });
  // Tenancy 2a: after commit, only when something changed (links built from
  // the web address, emails signed with the name, read it fresh next time).
  if (changed.length > 0) ctx.emit({ type: "company.profile.updated", tenantId: view.id, changed, by: input.actorUserId });
  return view;
}

async function writeBranding(tx: TenancyDb, tenantId: string, branding: TenantBranding): Promise<void> {
  await tx.execute(sql`/* adminigloo:tenancy/update-branding */
    update tenants set branding = ${JSON.stringify(branding)}::jsonb, updated_at = now() where id = ${tenantId}`);
}

/**
 * The brand colour (tenant.edit). WARN, NEVER BLOCK: a colour is never refused
 * for contrast; the report says how it reads. Stores the colour and the text
 * colour that reads on it, beside the logo keys.
 */
export async function updateBranding(
  ctx: Ctx,
  input: Actor & { readonly brandColor: string | null },
): Promise<{ company: CompanyView; brand: BrandColorReport | null }> {
  let report: BrandColorReport | null = null;
  if (input.brandColor !== null) {
    report = brandColorReport(input.brandColor);
    if (!report || normaliseHexColor(input.brandColor) === null) {
      throw ctx.fail("invalid", { issues: [{ path: ["brandColor"], message: "Enter a colour like #0f766e." }] });
    }
  }
  const result = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.edit" });
    const { brandColor: _c, onBrandColor: _o, ...rest } = company.branding;
    const branding: TenantBranding = report ? { ...rest, brandColor: report.color, onBrandColor: report.textOnColor } : rest;
    await writeBranding(tx, company.id, branding);
    await ctx.audit(tx, {
      action: "company.branding.updated",
      actorUserId: input.actorUserId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant",
      resourceId: company.id,
      metadata: { brandColor: report?.color ?? null, from: company.branding.brandColor ?? null },
      request: input.request ?? null,
    });
    return {
      company: companyView({ ...company, branding }, { userId: input.actorUserId, role: roleKeyOf(facts.role?.key) }),
      brand: report,
    };
  });
  ctx.emit({ type: "company.branding.updated", tenantId: result.company.id, by: input.actorUserId });
  return result;
}

const LOGO_TYPES: Readonly<Record<string, { ext: string; magic: (b: Uint8Array) => boolean }>> = {
  "image/png": { ext: "png", magic: (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v) },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": {
    ext: "webp",
    magic: (b) =>
      String.fromCharCode(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 0) === "RIFF" &&
      String.fromCharCode(b[8] ?? 0, b[9] ?? 0, b[10] ?? 0, b[11] ?? 0) === "WEBP",
  },
};

/**
 * Upload a logo (tenant.edit). PNG, JPEG or WebP, 1 MB at most, and the bytes
 * must BE that type (the magic number is checked, not just the declared type).
 * SVG is refused: it can carry script.
 *
 * THE ORDER MATTERS:
 *
 *   0. Check the caller BEFORE storing anything (review T1-06): otherwise any
 *      signed-in stranger who knows a company's id could write a megabyte into
 *      its storage folder per request before being refused.
 *   1. `put` the new file OUTSIDE the transaction (storage isn't
 *      transactional), at tenancy/logos/{tenantId}/{uuid}.{ext}.
 *   2. Lock, re-check the caller (the authority, D7), point the company at it,
 *      audit.
 *   3. After commit, best-effort delete of the previous file.
 *   4. If the transaction fails, best-effort delete of the new one.
 *
 * So a failed write never leaves the company without its old logo.
 */
export async function setLogo(
  ctx: Ctx,
  input: Actor & { readonly file: { readonly bytes: Uint8Array; readonly contentType: string; readonly filename?: string } },
): Promise<CompanyView> {
  const store = ctx.logos;
  if (!store) throw ctx.fail("logo_storage_off");
  const type = LOGO_TYPES[input.file.contentType.toLowerCase().split(";")[0]?.trim() ?? ""];
  if (!type || input.file.bytes.byteLength === 0 || input.file.bytes.byteLength > LOGO_MAX_BYTES || !type.magic(input.file.bytes)) {
    throw ctx.fail("logo_invalid");
  }
  // 0. Not a hint here but a gate: nothing is stored for a stranger.
  requireLive(ctx, await readCompany(ctx.db, input.tenantId));
  await requireActor(ctx, ctx.db, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.edit" });

  // Tenancy 2b-1 (8.3): the store is told the company, so a store that
  // keeps files per company (storage 0.2) files it, and counts it, there.
  const stored = await store.put({
    pathname: `tenancy/logos/${input.tenantId}/${uuidv7()}.${type.ext}`,
    bytes: input.file.bytes,
    contentType: input.file.contentType,
    tenantId: input.tenantId,
  });
  let previousKey: string | undefined;
  let view: CompanyView;
  try {
    view = await ctx.db.transaction(async (raw) => {
      const tx = raw as unknown as TenancyDb;
      const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
      const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.edit" });
      previousKey = company.branding.logoKey;
      const branding: TenantBranding = { ...company.branding, logoUrl: stored.url, logoKey: stored.key };
      await writeBranding(tx, company.id, branding);
      await ctx.audit(tx, {
        action: "company.branding.updated",
        actorUserId: input.actorUserId,
        scope: "tenant",
        tenantId: company.id,
        resourceType: "tenant",
        resourceId: company.id,
        metadata: { logo: "uploaded", contentType: input.file.contentType, bytes: input.file.bytes.byteLength },
        request: input.request ?? null,
      });
      return companyView({ ...company, branding }, { userId: input.actorUserId, role: roleKeyOf(facts.role?.key) });
    });
  } catch (error) {
    await store.delete(stored.key, { tenantId: input.tenantId }).catch((e: unknown) => ctx.report(e, "logo.cleanup"));
    throw error;
  }
  ctx.emit({ type: "company.branding.updated", tenantId: view.id, by: input.actorUserId });
  if (previousKey && previousKey !== stored.key) {
    await store.delete(previousKey, { tenantId: input.tenantId }).catch((e: unknown) => ctx.report(e, "logo.delete-previous"));
  }
  return view;
}

/** Remove the logo (tenant.edit): clear both fields, then best-effort delete the stored file. */
export async function removeLogo(ctx: Ctx, input: Actor): Promise<CompanyView> {
  let previousKey: string | undefined;
  const view = await ctx.db.transaction(async (raw) => {
    const tx = raw as unknown as TenancyDb;
    const company = requireLive(ctx, await lockCompany(tx, input.tenantId));
    const facts = await requireActor(ctx, tx, { userId: input.actorUserId, tenantId: input.tenantId }, { permission: "tenant.edit" });
    previousKey = company.branding.logoKey;
    const { logoUrl: _u, logoKey: _k, ...branding } = company.branding;
    await writeBranding(tx, company.id, branding);
    await ctx.audit(tx, {
      action: "company.branding.updated",
      actorUserId: input.actorUserId,
      scope: "tenant",
      tenantId: company.id,
      resourceType: "tenant",
      resourceId: company.id,
      metadata: { logo: "removed" },
      request: input.request ?? null,
    });
    return companyView({ ...company, branding }, { userId: input.actorUserId, role: roleKeyOf(facts.role?.key) });
  });
  ctx.emit({ type: "company.branding.updated", tenantId: view.id, by: input.actorUserId });
  if (previousKey && ctx.logos) {
    await ctx.logos.delete(previousKey, { tenantId: input.tenantId }).catch((e: unknown) => ctx.report(e, "logo.delete"));
  }
  return view;
}

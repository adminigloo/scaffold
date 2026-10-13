import { sql } from "drizzle-orm";
import { SLUG_MAX, suggestSlug, validateSlug } from "../slug.js";
import type { Ctx } from "./context.js";
import { q, str } from "./db.js";
import type { TenancyDb } from "./types.js";

/**
 * Availability of web addresses (decision D14). An address is TAKEN when a
 * company holds it now, or retired it (a company's old addresses keep pointing
 * at it). A company's own current and retired addresses count as free FOR IT:
 * getting your old address back is fine.
 */
export async function takenSlugs(
  db: TenancyDb,
  candidates: readonly string[],
  ownTenantId: string | null,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const list = sql.join(candidates.map((c) => sql`${c}`), sql`, `);
  const own = ownTenantId ?? "";
  const rows = await q(
    db,
    sql`/* adminigloo:tenancy/slugs-taken */
      select slug from tenants where slug in (${list}) and id <> ${own}
      union
      select slug from tenant_retired_slugs where slug in (${list}) and tenant_id <> ${own}`,
  );
  return new Set(rows.map((r) => str(r["slug"])));
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 4; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/** `base`, `base-2` … `base-20`, then `base-` plus 4 random characters: each cut to fit SLUG_MAX and still valid. */
export function slugCandidates(base: string, reserved: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const push = (suffix: string) => {
    const room = SLUG_MAX - suffix.length;
    const head = base.slice(0, room).replace(/-+$/, "");
    const candidate = `${head}${suffix}`;
    if (validateSlug(candidate, { reserved }) === null && !out.includes(candidate)) out.push(candidate);
  };
  push("");
  for (let n = 2; n <= 20; n += 1) push(`-${n}`);
  for (let i = 0; i < 6; i += 1) push(`-${randomSuffix()}`);
  return out;
}

/** The first free, valid address derived from `seed` (a name or a refused slug). */
export async function firstFreeSlug(ctx: Ctx, db: TenancyDb, seed: string, ownTenantId: string | null): Promise<string> {
  let base = suggestSlug(seed);
  if (validateSlug(base, { reserved: ctx.reserved }) === "reserved") base = `${base}-co`;
  const candidates = slugCandidates(base, ctx.reserved);
  const taken = await takenSlugs(db, candidates, ownTenantId);
  const free = candidates.find((c) => !taken.has(c));
  // Twenty numbered tries and six random ones all taken is not a real state;
  // a longer random tail is still a valid, free answer.
  return free ?? `${base.slice(0, SLUG_MAX - 9).replace(/-+$/, "")}-${randomSuffix()}${randomSuffix()}`;
}

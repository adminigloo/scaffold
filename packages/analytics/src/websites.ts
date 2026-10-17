import { and, arrayOverlaps, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { AnalyticsError, type AnalyticsContext } from "./context.js";

/**
 * THE SITE REGISTER (0.3): a tenant's websites — a company's own site,
 * greenacres.com — each with the web addresses its beacon may come from and
 * a public site key the snippet carries. One deployment serves every
 * tenant's websites: the beacon names its website by the key
 * (`resolveSite`), and a beacon is counted only when the page it came from
 * is on one of that website's addresses.
 *
 * WHAT THE KEY IS AND IS NOT. It is in the page source of the website, so it
 * is public: it decides WHICH website a visit belongs to, never who may read
 * a report. Someone who copies the key into their own site gains nothing —
 * their pages are not on the website's addresses, so their beacons are
 * dropped.
 *
 * EVERY FUNCTION HERE IS SCOPED TO ONE TENANT, except the key lookup the
 * beacon makes (a key names its tenant). Another tenant's website id is
 * "not found", exactly like an id that never existed.
 */

export interface Website {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  /** Host names, lower-cased, without "www." — both forms count. */
  readonly domains: readonly string[];
  readonly siteKey: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly removedAt: Date | null;
}

/** What a beacon resolves to: whose visit it is, which website, and the addresses it may come from. */
export interface ResolvedSite {
  readonly tenantId: string;
  /** The website's id, or null for the tenant's own pages on this deployment. */
  readonly siteId: string | null;
  readonly allowedHosts: readonly string[];
  /**
   * Only pages under this path count (`/t/green-acres`: that page and
   * anything below it). For a site that is one part of this app's pages —
   * one company's — so a page of another company's posting here counts
   * nothing. Left out: every page on the allowed hosts.
   */
  readonly pathPrefix?: string;
}

/** At most this many web addresses per website: a site and its www, a shop subdomain, a staging copy. */
export const MAX_WEBSITE_DOMAINS = 10;
/** How long a site key's answer is reused per instance. */
export const SITE_CACHE_MS = 60_000;
const SITE_CACHE_MAX = 2_000;
const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** "aws_" + 24 characters of [A-Za-z0-9]. */
export const SITE_KEY_SHAPE = /^aws_[A-Za-z0-9]{24}$/;

/** A new public site key: "aws_" and 24 random letters and digits (about 143 bits). */
export function newSiteKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = "aws_";
  // 256 is not a multiple of 62; the bias of a modulo here is 4/256 on the
  // first few letters, which costs a public, non-secret key nothing.
  for (const byte of bytes) out += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  return out;
}

/**
 * A web address as the register stores it: the host name, lower-cased, with
 * "www." taken off (both forms count) and a port kept (a laptop's
 * localhost:3000). Accepts what an owner types: "https://www.GreenAcres.com/contact",
 * "greenacres.com", "shop.greenacres.com". Null for anything that is not a
 * host: a path alone, a wildcard, spaces, an email address.
 */
export function normalizeDomain(input: string): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().toLowerCase();
  if (raw === "" || raw.length > 253 || /[\s*@\\]/.test(raw)) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `https://${raw}`).host;
  } catch {
    return null;
  }
  if (!host || host.startsWith(".") || host.endsWith(".")) return null;
  const bare = host.replace(/^www\./, "");
  const [name] = bare.split(":");
  // A dotted name (greenacres.com) or localhost — never a bare word, which
  // is what a typo of a whole address usually becomes.
  if (!name || (!name.includes(".") && name !== "localhost")) return null;
  return bare;
}

/** The bare host a request's page came from (Origin, then Referer), lower-cased, without "www.". */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function toWebsite(row: {
  id: string;
  tenantId: string;
  name: string;
  domains: string[] | null;
  siteKey: string;
  createdBy: string | null;
  createdAt: Date;
  removedAt: Date | null;
}): Website {
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    domains: [...(row.domains ?? [])],
    siteKey: row.siteKey,
    createdBy: row.createdBy,
    createdAt: new Date(row.createdAt),
    removedAt: row.removedAt ? new Date(row.removedAt) : null,
  };
}

/** A website's name, trimmed: 1 to 80 characters. */
function cleanName(name: unknown): string {
  const text = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (text.length < 1 || text.length > 80) {
    throw new AnalyticsError("invalid_input", "Give the website a name of up to 80 characters, like “Our website”.");
  }
  return text;
}

/** The web addresses, normalised and de-duplicated: 1 to MAX_WEBSITE_DOMAINS, each a real host. */
function cleanDomains(domains: unknown): string[] {
  const list = Array.isArray(domains) ? domains : typeof domains === "string" ? domains.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const host = normalizeDomain(entry);
    if (!host) throw new AnalyticsError("invalid_input", `“${entry.trim().slice(0, 80)}” isn't a web address. Type it like greenacres.com.`);
    if (!out.includes(host)) out.push(host);
  }
  if (out.length === 0) throw new AnalyticsError("invalid_input", "Add the website's address, like greenacres.com.");
  if (out.length > MAX_WEBSITE_DOMAINS) {
    throw new AnalyticsError("invalid_input", `A website can have up to ${MAX_WEBSITE_DOMAINS} addresses.`);
  }
  return out;
}

const COLUMNS = (ctx: AnalyticsContext) => {
  const w = ctx.t.websites;
  return {
    id: w.id,
    tenantId: w.tenantId,
    name: w.name,
    domains: w.domains,
    siteKey: w.siteKey,
    createdBy: w.createdBy,
    createdAt: w.createdAt,
    removedAt: w.removedAt,
  };
};

/** The tenant's websites, oldest first. Removed ones only with `includeRemoved`. */
export async function listWebsitesIn(ctx: AnalyticsContext, tenantId: string, options: { includeRemoved?: boolean } = {}): Promise<Website[]> {
  const w = ctx.t.websites;
  const rows = await ctx.db
    .select(COLUMNS(ctx))
    .from(w)
    .where(and(eq(w.tenantId, tenantId), options.includeRemoved ? undefined : isNull(w.removedAt)))
    .orderBy(asc(w.createdAt), asc(w.id));
  return rows.map(toWebsite);
}

/** One of the tenant's websites, or null — another tenant's id is null too. */
export async function getWebsiteIn(ctx: AnalyticsContext, tenantId: string, id: string): Promise<Website | null> {
  const w = ctx.t.websites;
  const [row] = await ctx.db
    .select(COLUMNS(ctx))
    .from(w)
    .where(and(eq(w.tenantId, tenantId), eq(w.id, id), isNull(w.removedAt)))
    .limit(1);
  return row ? toWebsite(row) : null;
}

/**
 * Addresses a website may not have. `hosts`: never these (a deployed app's own
 * address: its pages here are already counted, under the company's own
 * pages). `local`: refuse a laptop's addresses (localhost, 127.0.0.1, *.local)
 * — on a deployed app nobody's website lives there.
 */
export interface WebsiteAddressRules {
  readonly hosts?: readonly string[];
  readonly local?: boolean;
}

/** A laptop's own address: localhost and its subdomains, the loopback and unspecified addresses, mDNS names. */
export function isLocalHost(host: string): boolean {
  const name = (host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0] ?? "").toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || /^127\./.test(name) || name === "0.0.0.0" || name === "::1";
}

function checkAddresses(domains: readonly string[], rules: WebsiteAddressRules | undefined): void {
  if (!rules) return;
  const own = new Set((rules.hosts ?? []).map((host) => normalizeDomain(host)).filter((host): host is string => host !== null));
  for (const domain of domains) {
    if (own.has(domain)) {
      throw new AnalyticsError("invalid_input", `${domain} is this app's own address, and your pages on it are already counted. Add your own website's address instead.`);
    }
    if (rules.local && isLocalHost(domain)) {
      throw new AnalyticsError("invalid_input", `${domain} is an address on someone's own computer, not a website. Add your website's address, like greenacres.com.`);
    }
  }
}

/** One of these addresses already belongs to another of the tenant's websites: the sentence that says which. */
async function refuseDuplicates(
  ctx: AnalyticsContext,
  db: AnalyticsContext["db"],
  tenantId: string,
  domains: readonly string[],
  exceptId: string | null,
): Promise<void> {
  const w = ctx.t.websites;
  const [taken] = await db
    .select({ name: w.name, domains: w.domains })
    .from(w)
    .where(and(eq(w.tenantId, tenantId), isNull(w.removedAt), arrayOverlaps(w.domains, [...domains]), exceptId ? ne(w.id, exceptId) : undefined))
    .limit(1);
  if (taken) {
    const domain = domains.find((d) => (taken.domains ?? []).includes(d)) ?? domains[0];
    throw new AnalyticsError("invalid_input", `${domain} is already one of your websites (${taken.name}).`);
  }
}

/** The sentence an owner reads when the plan's websites are all used: the one the add refuses with, and the list shows. */
export function websiteLimitSentence(limit: number): string {
  return limit <= 0
    ? "Your plan doesn't include websites of your own. Choose a plan that does to add one."
    : `Your plan includes ${limit === 1 ? "1 website" : `${limit} websites`}. Stop counting one or choose a bigger plan to add another.`;
}

/** The lock every add for one tenant takes, so the count and the insert can't be raced. */
function addLockKey(ctx: AnalyticsContext, tenantId: string): string {
  return `adminigloo:analytics:websites:${ctx.t.prefix}:${tenantId}`;
}

export interface AddWebsiteInput {
  tenantId: string;
  name: string;
  /** What the owner typed: one address, or several. */
  domains: readonly string[] | string;
  /** Who added it (a user id), for the record. */
  by?: string | null;
  /**
   * The most websites this tenant may have (its plan's), or null/undefined
   * for no limit. Counted and inserted under one per-tenant lock, so adds
   * sent at once can't all slip under it.
   */
  limit?: number | null;
  /** Addresses refused here (the app's own, a laptop's). */
  refuse?: WebsiteAddressRules;
}

/**
 * Add a website: a new public site key, the addresses normalised. Throws
 * `invalid_input` with a sentence for the form (a bad address, the app's own,
 * one another of the tenant's websites already has) and `limit_reached` past
 * the plan's websites. The check and the insert run in one transaction under
 * a per-tenant advisory lock.
 */
export async function addWebsiteIn(ctx: AnalyticsContext, input: AddWebsiteInput): Promise<Website> {
  const name = cleanName(input.name);
  const domains = cleanDomains(input.domains);
  checkAddresses(domains, input.refuse);
  const w = ctx.t.websites;
  const row = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${addLockKey(ctx, input.tenantId)}, 0))`);
    if (typeof input.limit === "number") {
      const [counted] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(w)
        .where(and(eq(w.tenantId, input.tenantId), isNull(w.removedAt)));
      if (Number(counted?.n ?? 0) >= input.limit) throw new AnalyticsError("limit_reached", websiteLimitSentence(input.limit));
    }
    await refuseDuplicates(ctx, tx as unknown as AnalyticsContext["db"], input.tenantId, domains, null);
    const [inserted] = await tx
      .insert(w)
      .values({ tenantId: input.tenantId, name, domains, siteKey: newSiteKey(), createdBy: input.by ?? null })
      .returning(COLUMNS(ctx));
    return inserted;
  });
  if (!row) throw new AnalyticsError("invalid_config", "The website could not be saved.");
  return toWebsite(row);
}

export interface UpdateWebsiteInput {
  tenantId: string;
  id: string;
  name?: string;
  domains?: readonly string[] | string;
  /** Addresses refused here (the app's own, a laptop's). */
  refuse?: WebsiteAddressRules;
}

/** Rename a website or change its addresses. Null: no such website in this tenant. The key never changes. */
export async function updateWebsiteIn(ctx: AnalyticsContext, input: UpdateWebsiteInput): Promise<Website | null> {
  const set: { name?: string; domains?: string[] } = {};
  if (input.name !== undefined) set.name = cleanName(input.name);
  if (input.domains !== undefined) {
    set.domains = cleanDomains(input.domains);
    checkAddresses(set.domains, input.refuse);
  }
  const w = ctx.t.websites;
  if (Object.keys(set).length === 0) return getWebsiteIn(ctx, input.tenantId, input.id);
  const row = await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${addLockKey(ctx, input.tenantId)}, 0))`);
    if (set.domains) await refuseDuplicates(ctx, tx as unknown as AnalyticsContext["db"], input.tenantId, set.domains, input.id);
    const [updated] = await tx
      .update(w)
      .set(set)
      .where(and(eq(w.tenantId, input.tenantId), eq(w.id, input.id), isNull(w.removedAt)))
      .returning(COLUMNS(ctx));
    return updated;
  });
  if (!row) return null;
  dropCachedKey(ctx, row.siteKey);
  return toWebsite(row);
}

/**
 * Remove a website: its key stops counting at once (in this instance; within
 * a minute in every other), and its visits stay in the reports. Null: no
 * such website in this tenant.
 */
export async function removeWebsiteIn(ctx: AnalyticsContext, input: { tenantId: string; id: string; at?: Date }): Promise<Website | null> {
  const w = ctx.t.websites;
  const [row] = await ctx.db
    .update(w)
    .set({ removedAt: input.at ?? new Date() })
    .where(and(eq(w.tenantId, input.tenantId), eq(w.id, input.id), isNull(w.removedAt)))
    .returning(COLUMNS(ctx));
  if (!row) return null;
  dropCachedKey(ctx, row.siteKey);
  return toWebsite(row);
}

function dropCachedKey(ctx: AnalyticsContext, key: string): void {
  ctx.siteCache.delete(key);
}

/**
 * The ACTIVE website a site key names, whichever tenant it belongs to — the
 * beacon's one cross-tenant read, because the key is how a beacon says whose
 * it is. Cached per instance for a minute, misses included, so a flood of
 * made-up keys costs one query per key per minute (and the cache is capped).
 */
export async function websiteByKeyIn(ctx: AnalyticsContext, key: string, now: number = Date.now()): Promise<Website | null> {
  if (typeof key !== "string" || !SITE_KEY_SHAPE.test(key)) return null;
  const cached = ctx.siteCache.get(key);
  if (cached && now - cached.at < SITE_CACHE_MS) return cached.site;
  const w = ctx.t.websites;
  const [row] = await ctx.db
    .select(COLUMNS(ctx))
    .from(w)
    .where(and(eq(w.siteKey, key), isNull(w.removedAt)))
    .limit(1);
  const site = row ? toWebsite(row) : null;
  ctx.siteCache.set(key, { at: now, site });
  if (ctx.siteCache.size > SITE_CACHE_MAX) ctx.siteCache.delete(ctx.siteCache.keys().next().value as string);
  return site;
}

/** Where a beacon carries its site key: `?site=` on the endpoint's address (sendBeacon can't set a header), or this header. */
export const SITE_KEY_PARAM = "site";
export const SITE_KEY_HEADER = "x-aig-site";

/** The site key a beacon request carries, or null. */
export function siteKeyOf(req: Request): string | null {
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(req.url).searchParams.get(SITE_KEY_PARAM);
  } catch {
    fromUrl = null;
  }
  const key = (fromUrl ?? req.headers.get(SITE_KEY_HEADER) ?? "").trim();
  return key === "" ? null : key;
}

export interface SiteResolverOptions {
  /**
   * Is this tenant taking visits right now? The host's own gate — in a
   * companies project, a suspended company or one whose plan ended is not.
   * Asked once per beacon, after the key named the tenant. Default: open.
   */
  admit?: (tenantId: string, req: Request) => boolean | Promise<boolean>;
}

/**
 * `resolveSite` for the keyed beacon endpoint: the key on the request names
 * the website; its addresses are the hosts the page may be on. Null (the
 * beacon is dropped, still 204): no key, a key that names nothing or a
 * removed website, or a tenant `admit` says is closed.
 */
export function createSiteResolverIn(ctx: AnalyticsContext, options: SiteResolverOptions = {}) {
  return async (req: Request): Promise<ResolvedSite | null> => {
    const key = siteKeyOf(req);
    if (!key) return null;
    const site = await websiteByKeyIn(ctx, key);
    if (!site) return null;
    if (options.admit && !(await options.admit(site.tenantId, req))) return null;
    return { tenantId: site.tenantId, siteId: site.id, allowedHosts: site.domains };
  };
}

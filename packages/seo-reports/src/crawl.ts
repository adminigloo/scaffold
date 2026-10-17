import { auditPage, check, linksOf, scoreOf, titleOf, metaContent, type CheckKind, type PageAudit, type SeoCheck } from "./audit.js";
import { bareHostName, createSafeFetcher, DEFAULT_MAX_BYTES, DEFAULT_USER_AGENT, type FetchedPage, type ResolveHost, type Transport } from "./net.js";
import { parseRobots, robotsVerdict, type ParsedRobots } from "./robots.js";

/**
 * THE SEARCH CHECK ITSELF (0.2): read a company's own addresses the way a
 * search engine and an AI assistant would, and score what they'd find.
 *
 * WHAT IS READ: only the addresses it is handed (`targets`) — in a companies
 * app, the company's own websites from the analytics register and its own
 * pages on the app (/t/{web address}). Every request goes through the safe
 * fetcher (./net.ts): those hosts only, no private addresses, redirects
 * re-checked, bytes and time capped.
 *
 * HOW: each address's robots.txt, llms.txt and sitemap, then its pages — the
 * home page, the sitemap's pages, and the pages they link to — a few at a
 * time, until the page cap or the time cap. A cap reached is said in the
 * report ("checked the first 50 pages"), never silent.
 */

/** The crawlers that feed answer engines. A site invisible to these is described from other people's words. */
export const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot"] as const;
/** The search engines' own crawlers. */
export const SEARCH_CRAWLERS = ["Googlebot", "Bingbot"] as const;

/** Each crawler in words an owner knows, with the name robots.txt uses in brackets. */
export const CRAWLER_WORDS: Readonly<Record<string, string>> = {
  GPTBot: "ChatGPT's reader (GPTBot)",
  "OAI-SearchBot": "ChatGPT search (OAI-SearchBot)",
  ClaudeBot: "Claude's reader (ClaudeBot)",
  PerplexityBot: "Perplexity's reader (PerplexityBot)",
  "Google-Extended": "Google's AI (Google-Extended)",
  CCBot: "Common Crawl, which many AI models learn from (CCBot)",
  Googlebot: "Google (Googlebot)",
  Bingbot: "Bing (Bingbot)",
};
const crawlerWords = (agent: string) => CRAWLER_WORDS[agent] ?? agent;

export interface CheckTarget {
  /** What to call it on screen: "Our website", "Your pages on Snowplow". */
  readonly label: string;
  /** Where it starts: "https://greenacres.com" or the app's address. */
  readonly baseUrl: string;
  /**
   * Only pages under this path ("/t/green-acres") — for a company's pages on
   * a site it shares. Its robots.txt and sitemap are still read (for the
   * rules and the page list), but the site's own files are not the company's
   * to fix, so they aren't scored for it.
   */
  readonly pathPrefix?: string | null;
  /**
   * Not checked yet, and why, in a sentence for the screen ("We'll check this
   * site once your visits line is working."). A pending address is never read.
   */
  readonly pending?: string | null;
}

export interface CrawlLimits {
  /** Pages per check, across every address. Default 50. */
  readonly maxPages: number;
  /** Bytes read per page; the rest is cut. Default 2 MB. */
  readonly maxBytesPerPage: number;
  /** Per request. Default 8 seconds. */
  readonly pageTimeoutMs: number;
  /** The whole check. Default 45 seconds (inside a 60-second server function). */
  readonly totalTimeMs: number;
  /** Requests at once. Default 3. */
  readonly concurrency: number;
}

export const DEFAULT_CRAWL_LIMITS: CrawlLimits = {
  maxPages: 50,
  maxBytesPerPage: DEFAULT_MAX_BYTES,
  pageTimeoutMs: 8_000,
  totalTimeMs: 45_000,
  concurrency: 3,
};

export interface RunSiteCheckOptions {
  readonly targets: readonly CheckTarget[];
  /** Name lookup, for tests and for hosts with their own (default: the system's). */
  readonly resolve?: ResolveHost;
  /** The HTTP exchange, for tests (default: node's own, pinned to the checked address). */
  readonly transport?: Transport;
  readonly limits?: Partial<CrawlLimits>;
  readonly userAgent?: string;
  readonly now?: () => Date;
}

export interface CheckCounts {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
}

export interface SeoReportResult {
  /** The first address checked (0.1's one address). */
  baseUrl: string;
  startedAt: Date;
  finishedAt: Date;
  score: number;
  seoScore: number;
  aeoScore: number;
  pageCount: number;
  siteChecks: SeoCheck[];
  pages: PageAudit[];
}

export interface SiteCheckResult extends SeoReportResult {
  /** Every address checked, as "label — address". */
  addresses: string[];
  /** Why the check stopped early: the page cap, the time cap, or null (it read everything it found). */
  stopped: "pages" | "time" | null;
  counts: CheckCounts;
}

export class SeoReportsError extends Error {
  readonly name = "SeoReportsError";
  constructor(
    readonly code: "no_addresses" | "invalid_input" | "not_found" | "limit_reached" | "running" | "closed" | "rate_limited",
    message: string,
  ) {
    super(message);
  }
}

const NOT_PAGES = /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|zip|gz|mp4|mov|mp3|wav|css|js|mjs|json|xml|txt|woff2?|ttf|eot|csv|docx?|xlsx?|pptx?)$/i;

interface Normalised {
  readonly label: string;
  readonly origin: URL;
  /** "" for a whole site, "/t/green-acres" for part of one. */
  readonly prefix: string;
}

function normaliseTargets(targets: readonly CheckTarget[]): Normalised[] {
  const out: Normalised[] = [];
  for (const target of targets) {
    if (target.pending) continue;
    let url: URL;
    try {
      url = new URL(target.baseUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const raw = (target.pathPrefix ?? "").trim();
    const prefix = raw === "" || raw === "/" ? "" : `/${raw.replace(/^\/+|\/+$/g, "")}`;
    if (out.some((t) => t.origin.origin === url.origin && t.prefix === prefix)) continue;
    out.push({ label: target.label.trim() || url.host, origin: new URL(url.origin), prefix });
  }
  return out;
}

function underPrefix(url: URL, target: Normalised): boolean {
  if (bareHostName(url.hostname) !== bareHostName(target.origin.hostname)) return false;
  if (target.prefix === "") return true;
  return url.pathname === target.prefix || url.pathname.startsWith(`${target.prefix}/`);
}

/** A host's own files every target on it reads (the rules and the page list), never its pages. */
const SITE_FILES = /^\/(robots\.txt|llms\.txt|sitemap[\w-]*\.xml)$/i;

/**
 * May this address be read for these targets? A whole site's: anything on
 * its host. A company's part of a shared host (/t/green-acres): only paths
 * under that part — and the host's robots.txt and sitemap — so a redirect to
 * /admin, or to another company's /t/ pages, is refused.
 */
function mayRead(url: URL, targets: readonly Normalised[]): boolean {
  const host = bareHostName(url.hostname);
  const onHost = targets.filter((t) => bareHostName(t.origin.hostname) === host);
  if (onHost.length === 0) return false;
  if (onHost.some((t) => t.prefix === "")) return true;
  if (SITE_FILES.test(url.pathname)) return true;
  return onHost.some((t) => underPrefix(url, t));
}

function keyOf(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${bareHostName(u.hostname)}${path}${u.search}`;
  } catch {
    return url;
  }
}

function isHtml(page: FetchedPage): boolean {
  const type = page.headers["content-type"]?.toLowerCase() ?? "";
  if (type) return type.includes("html");
  return /^\s*(<!doctype html|<html|<head|<body)/i.test(page.text);
}

function ok(page: FetchedPage): boolean {
  return page.refused === null && page.error === null && page.status >= 200 && page.status < 300;
}

function list(items: readonly string[], max = 5): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

function locsOf(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"));
}

/** Check a company's own addresses. Never throws for a site's problems: they are the report. */
export async function runSiteCheck(options: RunSiteCheckOptions): Promise<SiteCheckResult> {
  const now = options.now ?? (() => new Date());
  const limits: CrawlLimits = { ...DEFAULT_CRAWL_LIMITS, ...options.limits };
  const targets = normaliseTargets(options.targets);
  if (targets.length === 0) {
    throw new SeoReportsError("no_addresses", "There's no web address to check yet. Add your website first.");
  }
  const startedAt = now();
  const total = new AbortController();
  const totalTimer = setTimeout(() => total.abort(), limits.totalTimeMs);
  const fetcher = createSafeFetcher({
    allowedHosts: targets.map((t) => t.origin.hostname),
    allowUrl: (url) => mayRead(url, targets),
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    maxBytes: limits.maxBytesPerPage,
    timeoutMs: limits.pageTimeoutMs,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    signal: total.signal,
  });

  const siteChecks: SeoCheck[] = [];
  const pages: PageAudit[] = [];
  const titles = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();
  const broken: string[] = [];
  const movedAway: string[] = [];
  let pagesLeft = limits.maxPages;
  let stopped: SiteCheckResult["stopped"] = null;
  const outOfTime = () => total.signal.aborted;

  try {
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!;
      if (outOfTime()) {
        stopped = "time";
        break;
      }
      const origin = target.origin.origin;
      const owns = target.prefix === "";
      const named = (label: string) => (targets.length > 1 ? `${label} (${target.label})` : label);
      const homePath = target.prefix || "/";

      // --- robots.txt: served, and who it lets in --------------------------
      const robots = await fetcher.fetch(`${origin}/robots.txt`);
      const robotsServed = ok(robots) && !isHtml(robots);
      let parsed: ParsedRobots = { groups: [], sitemaps: [] };
      if (robotsServed) parsed = parseRobots(robots.text);
      if (owns) {
        siteChecks.push(
          robotsServed
            ? check("site.robots", named("robots.txt"), "seo", "pass", "Served.")
            : check("site.robots", named("robots.txt"), "seo", "warn", `Not served (${robots.status ? `the address answered ${robots.status}` : "no answer"}). Search engines then read everything, but it's also where they look for your sitemap.`),
        );
      }
      const blockedAi = AI_CRAWLERS.map((agent) => ({ agent, verdict: robotsVerdict(parsed, agent, homePath) })).filter((v) => !v.verdict.allowed);
      siteChecks.push(
        blockedAi.length === 0
          ? check("site.ai-crawlers", named("AI assistants let in"), "aeo", "pass", `ChatGPT, Claude, Perplexity and Google's AI may all read ${homePath === "/" ? "the site" : homePath}.`)
          : check("site.ai-crawlers", named("AI assistants let in"), "aeo", "warn", `Your robots.txt file keeps out ${blockedAi.map((b) => `${crawlerWords(b.agent)} (the line “${b.verdict.rule}”)`).join(", ")}.`),
      );
      const blockedSearch = SEARCH_CRAWLERS.map((agent) => ({ agent, verdict: robotsVerdict(parsed, agent, homePath) })).filter((v) => !v.verdict.allowed);
      siteChecks.push(
        blockedSearch.length === 0
          ? check("site.search-crawlers", named("Search engines let in"), "seo", "pass", `Google and Bing may read ${homePath === "/" ? "the site" : homePath}.`)
          : check("site.search-crawlers", named("Search engines let in"), "seo", "fail", `Your robots.txt file keeps out ${blockedSearch.map((b) => `${crawlerWords(b.agent)} (the line “${b.verdict.rule}”)`).join(", ")} — those pages can't be in search.`),
      );

      // --- llms.txt: the site's own file, so only a whole site is scored on it
      if (owns) {
        const llms = await fetcher.fetch(`${origin}/llms.txt`);
        const served = ok(llms) && !isHtml(llms) && llms.text.trim() !== "";
        siteChecks.push(
          served
            ? check("site.llms-txt", named("llms.txt"), "aeo", "pass", `Served (${llms.bytes} bytes) — the list of important pages AI assistants read first.`)
            : check("site.llms-txt", named("llms.txt"), "aeo", "fail", "Not served. An llms.txt tells AI assistants where the important pages are."),
        );
      }

      // --- the sitemap: its own, or the one robots.txt names ---------------
      const sitemapUrls = [...parsed.sitemaps.filter((s) => fetcher.mayFetch(s)), `${origin}/sitemap.xml`].filter((s, i, all) => all.indexOf(s) === i).slice(0, 2);
      let locs: string[] = [];
      let sitemapServed = false;
      for (const sitemapUrl of sitemapUrls) {
        if (outOfTime()) break;
        const sitemap = await fetcher.fetch(sitemapUrl);
        if (!ok(sitemap)) continue;
        sitemapServed = true;
        if (/<sitemapindex\b/i.test(sitemap.text)) {
          // An index of sitemaps: its first few, from the same site.
          for (const child of locsOf(sitemap.text).filter((s) => fetcher.mayFetch(s)).slice(0, 3)) {
            if (outOfTime()) break;
            const part = await fetcher.fetch(child);
            if (ok(part)) locs.push(...locsOf(part.text));
          }
        } else {
          locs.push(...locsOf(sitemap.text));
        }
        if (locs.length > 0) break;
      }
      const ours = locs
        .map((loc) => {
          try {
            return new URL(loc);
          } catch {
            return null;
          }
        })
        .filter((u): u is URL => u !== null && underPrefix(u, target));
      siteChecks.push(
        ours.length > 0
          ? check("site.sitemap", named("Sitemap"), "seo", "pass", `${ours.length} page${ours.length === 1 ? "" : "s"} listed.`)
          : owns
            ? check("site.sitemap", named("Sitemap"), "seo", "fail", sitemapServed ? "There's a sitemap, but it lists no pages." : "No sitemap (sitemap.xml) was found.")
            : check("site.sitemap", named("Sitemap"), "seo", "warn", `The site's sitemap doesn't list your pages under ${target.prefix}.`),
      );
      locs = [];

      // --- the pages: home, the sitemap's, and what they link to ------------
      // A fair share of the page cap per address, so one big site can't
      // leave nothing for the rest.
      const share = Math.max(1, Math.floor(pagesLeft / (targets.length - index)));
      let budget = Math.min(share, pagesLeft);
      const seen = new Set<string>();
      const queue: string[] = [];
      for (const url of [`${origin}${homePath}`, ...ours.map((u) => u.toString())]) {
        if (seen.has(keyOf(url))) continue;
        seen.add(keyOf(url));
        queue.push(url);
      }
      const linkedFrom = new Map<string, string>();
      const listed = new Set(ours.map((u) => keyOf(u.toString())));

      while (queue.length > 0) {
        if (outOfTime()) {
          stopped = "time";
          break;
        }
        if (budget <= 0) {
          stopped = stopped ?? "pages";
          break;
        }
        const wave = queue.splice(0, Math.min(limits.concurrency, budget));
        budget -= wave.length;
        pagesLeft -= wave.length;
        const fetched = await Promise.all(wave.map((url) => fetcher.fetch(url)));
        for (let i = 0; i < wave.length; i += 1) {
          const url = wave[i]!;
          const page = fetched[i]!;
          const where = new URL(url);
          const path = `${where.pathname}${where.search}`;
          const from = linkedFrom.get(keyOf(url));
          if (page.error !== null && outOfTime()) continue; // cut off by the time cap, not the page's fault
          if (page.refused === "foreign_host" || page.refused === "outside_pages") {
            movedAway.push(`${path} → ${page.refusedUrl ?? "another site"}`);
            continue;
          }
          if (page.refused !== null || page.error !== null || page.status === 0) {
            const why =
              page.refused === "private_address"
                ? "it leads to a private network address, so it wasn't read (for safety)"
                : page.refused === "no_address"
                  ? "the address doesn't exist (no such site name)"
                  : page.refused === "too_many_redirects"
                    ? "it moves too many times"
                    : page.refused
                      ? "it can't be read safely"
                      : `it didn't answer (${page.error ?? "no answer"})`;
            pages.push({ path, url, checks: [check("page.fetch", "Page opens", "seo", "fail", `Couldn't open: ${why}.`)] });
            continue;
          }
          if (page.status >= 400) {
            pages.push({
              path,
              url,
              checks: [check("page.fetch", "Page opens", "seo", "fail", `Answers with an error (${page.status})${listed.has(keyOf(url)) ? " though the sitemap lists it" : ""}.`)],
            });
            if (from) broken.push(`${from} links to ${path} (${page.status})`);
            continue;
          }
          if (!isHtml(page)) continue;
          const audit = auditPage(path, page.text, { url: page.finalUrl, headers: page.headers });
          if (page.truncated) {
            audit.checks.unshift(check("page.fetch", "Page opens", "seo", "warn", `Over ${Math.round(limits.maxBytesPerPage / 1024 / 1024)} MB, so only the start of it was read. Big pages are slow to open.`));
          }
          pages.push(audit);
          const title = titleOf(page.text);
          if (title) titles.set(title, [...(titles.get(title) ?? []), path]);
          const description = metaContent(page.text, "description")?.trim();
          if (description) descriptions.set(description, [...(descriptions.get(description) ?? []), path]);
          for (const link of linksOf(page.text, page.finalUrl)) {
            let target2: URL;
            try {
              target2 = new URL(link);
            } catch {
              continue;
            }
            if (!underPrefix(target2, target) || NOT_PAGES.test(target2.pathname)) continue;
            const key = keyOf(link);
            if (seen.has(key)) continue;
            seen.add(key);
            linkedFrom.set(key, path);
            queue.push(link);
          }
        }
      }
    }
  } finally {
    clearTimeout(totalTimer);
  }

  if (stopped !== null) {
    siteChecks.push(
      check(
        "site.crawl-cap",
        "How much was checked",
        "seo",
        "warn",
        stopped === "pages"
          ? `Checked the first ${limits.maxPages - pagesLeft} pages, the most one check reads. The rest are checked as you fix these.`
          : `Ran out of time after ${pages.length} pages (one check takes at most ${Math.round(limits.totalTimeMs / 1000)} seconds). Slow pages use the time up.`,
      ),
    );
  }
  const repeated = (map: Map<string, string[]>) => [...map.entries()].filter(([, paths]) => paths.length > 1);
  const dupTitles = repeated(titles);
  siteChecks.push(
    dupTitles.length === 0
      ? check("site.duplicate-titles", "Different page titles", "seo", "pass", pages.length > 1 ? "Every page checked has its own title." : "Only one page to compare.")
      : check("site.duplicate-titles", "Different page titles", "seo", "warn", dupTitles.slice(0, 4).map(([title, paths]) => `“${title.slice(0, 60)}” on ${list(paths, 4)}`).join("; ")),
  );
  const dupDescriptions = repeated(descriptions);
  siteChecks.push(
    dupDescriptions.length === 0
      ? check("site.duplicate-descriptions", "Different page summaries", "seo", "pass", pages.length > 1 ? "Every page checked has its own summary." : "Only one page to compare.")
      : check("site.duplicate-descriptions", "Different page summaries", "seo", "warn", `${dupDescriptions.length} summar${dupDescriptions.length === 1 ? "y is" : "ies are"} on more than one page: ${dupDescriptions.slice(0, 3).map(([, paths]) => list(paths, 3)).join("; ")}.`),
  );
  siteChecks.push(
    broken.length === 0
      ? check("site.broken-links", "Links that work", "seo", "pass", "No link between the pages checked leads to an error.")
      : check("site.broken-links", "Links that work", "seo", "fail", list(broken, 8) + "."),
  );
  if (movedAway.length > 0) {
    siteChecks.push(check("site.moved-away", "Pages that move elsewhere", "seo", "warn", `These move to a website that isn't on your list, so they weren't read: ${list(movedAway, 5)}.`));
  }

  const all = [...siteChecks, ...pages.flatMap((page) => page.checks)];
  const seoScore = scoreOf(all, "seo");
  const aeoScore = scoreOf(all, "aeo");
  const count = (status: SeoCheck["status"]) => all.filter((c) => c.status === status).length;
  return {
    baseUrl: `${targets[0]!.origin.origin}${targets[0]!.prefix}`,
    addresses: targets.map((t) => `${t.label} — ${t.origin.host}${t.prefix}`),
    startedAt,
    finishedAt: now(),
    seoScore,
    aeoScore,
    score: Math.round((seoScore + aeoScore) / 2),
    pageCount: pages.length,
    siteChecks,
    pages,
    stopped,
    counts: { pass: count("pass"), warn: count("warn"), fail: count("fail") },
  };
}

export interface RunSeoReportOptions extends Omit<RunSiteCheckOptions, "targets"> {
  baseUrl: string;
  /** 0.1's crawl ceiling; `limits.maxPages` wins. */
  maxPages?: number;
  /** 0.1's per-request timeout; `limits.pageTimeoutMs` wins. */
  timeoutMs?: number;
}

/** 0.1's one-address audit, on the 0.2 crawler (the same safety rules). */
export function runSeoReport(options: RunSeoReportOptions): Promise<SiteCheckResult> {
  const { baseUrl, maxPages, timeoutMs, limits, ...rest } = options;
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // runSiteCheck refuses it in words
  }
  return runSiteCheck({
    ...rest,
    targets: [{ label: host, baseUrl }],
    limits: { ...(maxPages !== undefined ? { maxPages } : {}), ...(timeoutMs !== undefined ? { pageTimeoutMs: timeoutMs } : {}), ...limits },
  });
}

export type { CheckKind };

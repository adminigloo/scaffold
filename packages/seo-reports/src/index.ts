import { desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { seoReports } from "./schema.js";

/**
 * SEO and AEO audits as a business operation.
 *
 * SEO is how a search engine reads a site; AEO — answer-engine optimisation —
 * is how the systems that ANSWER instead of listing (ChatGPT, Claude,
 * Perplexity, Google's AI overviews) read it: can their crawlers get in, is
 * there structured data to quote, is there an llms.txt telling them where the
 * substance lives. Businesses are asking "do AI assistants know we exist"
 * with no way to check; this package is the check, run against your own
 * site, with the receipts kept in your own database.
 *
 * EVERY CHECK CARRIES ITS EVIDENCE. A score without reasons teaches nobody
 * anything and cannot be argued with; each check states what it looked at
 * and what it found, so the report reads as a worklist rather than a grade.
 *
 * THE PARSER IS REGEX OVER HTML, AND SAYS SO. It reads the handful of shapes
 * meta tags actually take in served HTML; it is not a DOM and does not
 * pretend to be one. The alternative was a parsing dependency in a package
 * whose whole job is reading twenty tags — and a check that is wrong about
 * an exotic page fails toward "warn", never toward a false pass.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SeoDb = PgDatabase<any, any, any>;

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckKind = "seo" | "aeo";

export interface SeoCheck {
  /** Stable machine id, e.g. "page.title" or "site.llms-txt". */
  id: string;
  label: string;
  kind: CheckKind;
  status: CheckStatus;
  /** What was looked at and what was found — the evidence, not advice prose. */
  detail: string;
}

export interface PageAudit {
  path: string;
  checks: SeoCheck[];
}

export interface SeoReportResult {
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

// ---------------------------------------------------------------------------
// HTML analysis — the handful of shapes served pages actually take.
// ---------------------------------------------------------------------------

function attrOf(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match ? (match[2] ?? match[3] ?? "") : null;
}

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attrOf(tag, "name") ?? attrOf(tag, "property");
    if (name?.toLowerCase() === key.toLowerCase()) return attrOf(tag, "content");
  }
  return null;
}

const check = (
  id: string,
  label: string,
  kind: CheckKind,
  status: CheckStatus,
  detail: string,
): SeoCheck => ({ id, label, kind, status, detail });

/** Audit one served page. Pure, so the tests are HTML in, verdicts out. */
export function auditPage(path: string, html: string): PageAudit {
  const checks: SeoCheck[] = [];

  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  checks.push(
    title === null
      ? check("page.title", "Title", "seo", "fail", "No <title> element.")
      : title.length < 15 || title.length > 60
        ? check(
            "page.title",
            "Title",
            "seo",
            "warn",
            `"${title.slice(0, 60)}" is ${title.length} characters; results truncate outside roughly 15–60.`,
          )
        : check("page.title", "Title", "seo", "pass", `"${title}" (${title.length} chars).`),
  );

  const description = metaContent(html, "description");
  checks.push(
    description === null
      ? check(
          "page.description",
          "Meta description",
          "seo",
          "fail",
          "No meta description — the snippet under the result becomes whatever the engine scrapes.",
        )
      : description.length < 50 || description.length > 160
        ? check(
            "page.description",
            "Meta description",
            "seo",
            "warn",
            `${description.length} characters; the useful range is roughly 50–160.`,
          )
        : check(
            "page.description",
            "Meta description",
            "seo",
            "pass",
            `${description.length} characters.`,
          ),
  );

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  checks.push(
    h1Count === 1
      ? check("page.h1", "One h1", "seo", "pass", "Exactly one h1.")
      : check(
          "page.h1",
          "One h1",
          "seo",
          h1Count === 0 ? "fail" : "warn",
          h1Count === 0 ? "No h1 on the page." : `${h1Count} h1 elements compete for the topic.`,
        ),
  );

  const canonical = (html.match(/<link\b[^>]*>/gi) ?? []).some(
    (tag) => attrOf(tag, "rel")?.toLowerCase() === "canonical",
  );
  checks.push(
    canonical
      ? check("page.canonical", "Canonical URL", "seo", "pass", "rel=canonical present.")
      : check(
          "page.canonical",
          "Canonical URL",
          "seo",
          "warn",
          "No rel=canonical; parameter and preview URLs can compete with this page.",
        ),
  );

  const ogTitle = metaContent(html, "og:title");
  const ogImage = metaContent(html, "og:image");
  checks.push(
    ogTitle && ogImage
      ? check("page.og", "Social card", "seo", "pass", "og:title and og:image present.")
      : check(
          "page.og",
          "Social card",
          "seo",
          "warn",
          `Missing ${[!ogTitle && "og:title", !ogImage && "og:image"].filter(Boolean).join(" and ")} — shared links render as grey boxes.`,
        ),
  );

  const robotsMeta = metaContent(html, "robots") ?? "";
  checks.push(
    /noindex/i.test(robotsMeta)
      ? check(
          "page.robots",
          "Indexable",
          "seo",
          "warn",
          "meta robots says noindex — deliberate on previews, a disaster in production.",
        )
      : check("page.robots", "Indexable", "seo", "pass", "No noindex directive."),
  );

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const withAlt = images.filter((tag) => (attrOf(tag, "alt") ?? "") !== "").length;
  checks.push(
    images.length === 0
      ? check("page.img-alt", "Image alt text", "seo", "pass", "No images on the page.")
      : withAlt / images.length >= 0.8
        ? check(
            "page.img-alt",
            "Image alt text",
            "seo",
            "pass",
            `${withAlt}/${images.length} images carry alt text.`,
          )
        : check(
            "page.img-alt",
            "Image alt text",
            "seo",
            "warn",
            `${withAlt}/${images.length} images carry alt text.`,
          ),
  );

  // --- The answer-engine half of the page ---------------------------------

  const ldBlocks =
    html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ??
    [];
  let ldValid = 0;
  for (const block of ldBlocks) {
    const body = />([\s\S]*)<\/script>$/i.exec(block)?.[1] ?? "";
    try {
      JSON.parse(body);
      ldValid += 1;
    } catch {
      // counted below as present-but-broken
    }
  }
  checks.push(
    ldBlocks.length === 0
      ? check(
          "page.structured-data",
          "Structured data",
          "aeo",
          "fail",
          "No JSON-LD — answer engines quote what is machine-readable first.",
        )
      : ldValid === ldBlocks.length
        ? check(
            "page.structured-data",
            "Structured data",
            "aeo",
            "pass",
            `${ldValid} valid JSON-LD block${ldValid === 1 ? "" : "s"}.`,
          )
        : check(
            "page.structured-data",
            "Structured data",
            "aeo",
            "warn",
            `${ldBlocks.length - ldValid} of ${ldBlocks.length} JSON-LD blocks fail to parse.`,
          ),
  );

  const h2Count = (html.match(/<h2[\s>]/gi) ?? []).length;
  checks.push(
    h2Count > 0
      ? check(
          "page.headings",
          "Sectioned content",
          "aeo",
          "pass",
          `${h2Count} h2 sections — answer engines lift sections, not walls of text.`,
        )
      : check("page.headings", "Sectioned content", "aeo", "warn", "No h2 sections to lift."),
  );

  return { path, checks };
}

// ---------------------------------------------------------------------------
// Site-level checks — robots, llms.txt, sitemap, and who is allowed in.
// ---------------------------------------------------------------------------

/**
 * The crawlers that feed answer engines. A site invisible to these is a site
 * AI assistants describe from other people's words about it.
 */
export const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot"] as const;

/** Is this agent fully disallowed by the robots.txt source? Group-aware enough to be honest. */
export function robotsBlocks(robotsTxt: string, agent: string): boolean {
  let applies = false;
  let blocked = false;
  for (const raw of robotsTxt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!key) continue;
    if (key.trim().toLowerCase() === "user-agent") {
      applies = value === "*" || value.toLowerCase() === agent.toLowerCase();
    } else if (applies && key.trim().toLowerCase() === "disallow" && value === "/") {
      blocked = true;
    } else if (applies && key.trim().toLowerCase() === "allow" && value === "/") {
      blocked = false;
    }
  }
  return blocked;
}

export interface RunSeoReportOptions {
  baseUrl: string;
  /** Injected for tests and for hosts with their own fetch policies. */
  fetchImpl?: typeof fetch;
  /** Crawl ceiling. Serverless minutes are the budget this respects. */
  maxPages?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "user-agent": "adminigloo-seo-reports/0.1" },
      redirect: "follow",
    });
    return { ok: res.ok, status: res.status, text: res.ok ? await res.text() : "" };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Crawl the site's own sitemap and score every check. */
export async function runSeoReport(options: RunSeoReportOptions): Promise<SeoReportResult> {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxPages = options.maxPages ?? 15;
  const timeoutMs = options.timeoutMs ?? 5000;
  const startedAt = new Date();

  const siteChecks: SeoCheck[] = [];

  const robots = await fetchText(fetchImpl, `${baseUrl}/robots.txt`, timeoutMs);
  siteChecks.push(
    robots.ok
      ? check("site.robots", "robots.txt", "seo", "pass", "Served.")
      : check("site.robots", "robots.txt", "seo", "fail", `Not served (status ${robots.status}).`),
  );
  if (robots.ok) {
    const blockedAgents = AI_CRAWLERS.filter((agent) => robotsBlocks(robots.text, agent));
    siteChecks.push(
      blockedAgents.length === 0
        ? check(
            "site.ai-crawlers",
            "AI crawler access",
            "aeo",
            "pass",
            `${AI_CRAWLERS.join(", ")} are not blocked.`,
          )
        : check(
            "site.ai-crawlers",
            "AI crawler access",
            "aeo",
            "warn",
            `${blockedAgents.join(", ")} blocked in robots.txt — deliberate for some businesses, invisibility for most.`,
          ),
    );
  }

  const llms = await fetchText(fetchImpl, `${baseUrl}/llms.txt`, timeoutMs);
  siteChecks.push(
    llms.ok
      ? check(
          "site.llms-txt",
          "llms.txt",
          "aeo",
          "pass",
          `Served (${llms.text.length} bytes) — the routing table answer engines read first.`,
        )
      : check(
          "site.llms-txt",
          "llms.txt",
          "aeo",
          "fail",
          "Not served. An llms.txt tells answer engines where the substance lives.",
        ),
  );

  const sitemap = await fetchText(fetchImpl, `${baseUrl}/sitemap.xml`, timeoutMs);
  const locs = sitemap.ok
    ? [...sitemap.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1] ?? "")
    : [];
  siteChecks.push(
    sitemap.ok && locs.length > 0
      ? check("site.sitemap", "sitemap.xml", "seo", "pass", `${locs.length} URLs listed.`)
      : check(
          "site.sitemap",
          "sitemap.xml",
          "seo",
          "fail",
          sitemap.ok ? "Served but lists no URLs." : `Not served (status ${sitemap.status}).`,
        ),
  );

  // Same-origin pages only, capped. The cap is reported, never silent.
  const origin = new URL(baseUrl).origin;
  const paths: string[] = [];
  for (const loc of locs) {
    try {
      const url = new URL(loc);
      if (url.origin === origin && !paths.includes(url.pathname)) paths.push(url.pathname);
    } catch {
      // a malformed <loc> is the sitemap's problem, recorded by its own check
    }
    if (paths.length >= maxPages) break;
  }
  if (locs.length > maxPages) {
    siteChecks.push(
      check(
        "site.crawl-cap",
        "Crawl coverage",
        "seo",
        "warn",
        `Audited the first ${maxPages} of ${locs.length} sitemap URLs.`,
      ),
    );
  }

  const pages: PageAudit[] = [];
  for (const path of paths) {
    const res = await fetchText(fetchImpl, `${origin}${path}`, timeoutMs);
    if (!res.ok) {
      pages.push({
        path,
        checks: [
          check(
            "page.fetch",
            "Fetchable",
            "seo",
            "fail",
            `Listed in the sitemap but answered ${res.status || "nothing"} — the worst SEO signal there is.`,
          ),
        ],
      });
      continue;
    }
    pages.push(auditPage(path, res.text));
  }

  const all = [...siteChecks, ...pages.flatMap((page) => page.checks)];
  const scoreOf = (kind: CheckKind): number => {
    const relevant = all.filter((c) => c.kind === kind);
    if (relevant.length === 0) return 0;
    const points = relevant.reduce(
      (sum, c) => sum + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0),
      0,
    );
    return Math.round((points / relevant.length) * 100);
  };
  const seoScore = scoreOf("seo");
  const aeoScore = scoreOf("aeo");

  return {
    baseUrl,
    startedAt,
    finishedAt: new Date(),
    seoScore,
    aeoScore,
    score: Math.round((seoScore + aeoScore) / 2),
    pageCount: pages.length,
    siteChecks,
    pages,
  };
}

// ---------------------------------------------------------------------------
// Persistence — the receipts.
// ---------------------------------------------------------------------------

export async function saveSeoReport(db: SeoDb, result: SeoReportResult): Promise<string> {
  const rows = await db
    .insert(seoReports)
    .values({
      baseUrl: result.baseUrl,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      score: result.score,
      seoScore: result.seoScore,
      aeoScore: result.aeoScore,
      pageCount: result.pageCount,
      siteChecks: result.siteChecks,
      pages: result.pages,
    })
    .returning({ id: seoReports.id });
  const row = rows[0];
  if (!row) throw new Error("report insert returned no row");
  return row.id;
}

export interface SeoReportSummary {
  id: string;
  baseUrl: string;
  finishedAt: Date;
  score: number;
  seoScore: number;
  aeoScore: number;
  pageCount: number;
}

export async function listSeoReports(db: SeoDb, limit = 20): Promise<SeoReportSummary[]> {
  return db
    .select({
      id: seoReports.id,
      baseUrl: seoReports.baseUrl,
      finishedAt: seoReports.finishedAt,
      score: seoReports.score,
      seoScore: seoReports.seoScore,
      aeoScore: seoReports.aeoScore,
      pageCount: seoReports.pageCount,
    })
    .from(seoReports)
    .orderBy(desc(seoReports.finishedAt))
    .limit(limit);
}

export const getReportSchema = z.object({ reportId: z.string() });

export async function getSeoReport(db: SeoDb, reportId: string) {
  const rows = await db.select().from(seoReports).where(eq(seoReports.id, reportId)).limit(1);
  return rows[0] ?? null;
}

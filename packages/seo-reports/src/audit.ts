/**
 * WHAT ONE PAGE SAYS TO A SEARCH ENGINE, AND TO AN AI ASSISTANT (0.2) — pure:
 * HTML and headers in, verdicts with their evidence out.
 *
 * EVERY CHECK CARRIES ITS EVIDENCE. A score without reasons teaches nobody
 * anything and cannot be argued with; each check says what it looked at and
 * what it found, so the report reads as a worklist rather than a grade.
 *
 * THE PARSER IS REGEX OVER HTML, AND SAYS SO. It reads the handful of shapes
 * meta tags take in served HTML; it is not a DOM. A check that is wrong about
 * an exotic page fails toward "warn", never toward a false pass.
 */

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckKind = "seo" | "aeo";

export interface SeoCheck {
  /** Stable machine id, e.g. "page.title" or "site.llms-txt". */
  id: string;
  label: string;
  kind: CheckKind;
  status: CheckStatus;
  /** What was looked at and what was found — the evidence, in plain words. */
  detail: string;
}

export interface PageAudit {
  /** The page's address on its site (path and query), e.g. "/prices". */
  path: string;
  /** The full address, when known (0.2). */
  url?: string;
  checks: SeoCheck[];
}

/** "1 character", "2 characters". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const check = (id: string, label: string, kind: CheckKind, status: CheckStatus, detail: string): SeoCheck => ({
  id,
  label,
  kind,
  status,
  detail,
});

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** The few entities titles and descriptions actually carry. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+[0-9]*);/gi, (whole, name: string) => {
    const lower = name.toLowerCase();
    if (lower in ENTITIES) return ENTITIES[lower]!;
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16) || 32);
    if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)) || 32);
    return whole;
  });
}

export function attrOf(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? "") : null;
}

export function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = attrOf(tag, "name") ?? attrOf(tag, "property");
    if (name?.toLowerCase() === key.toLowerCase()) return attrOf(tag, "content");
  }
  return null;
}

/** The page's <title>, trimmed and with its entities read; null when it has none. */
export function titleOf(html: string): string | null {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return raw === undefined ? null : decodeEntities(raw.replace(/\s+/g, " ").trim());
}

/** The canonical link's href, as written; null when there is none. */
export function canonicalOf(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attrOf(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (rel.includes("canonical")) return attrOf(tag, "href") ?? "";
  }
  return null;
}

/** Every <a href> on the page, resolved against its address (fragments dropped, http(s) only). */
export function linksOf(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = attrOf(tag, "href");
    if (!href || /^(mailto|tel|javascript|data|sms):/i.test(href.trim()) || href.trim().startsWith("#")) continue;
    const rel = attrOf(tag, "rel")?.toLowerCase() ?? "";
    if (/\bnofollow\b/.test(rel)) continue;
    try {
      const url = new URL(href.trim(), pageUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      out.add(url.toString());
    } catch {
      // a broken href is the page's problem; nothing to follow
    }
  }
  return [...out];
}

/** Two addresses that name the same page: same host, path (a trailing slash aside) and query. */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname);
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() && path(x) === path(y) && x.search === y.search;
  } catch {
    return false;
  }
}

function noindexIn(directives: string): boolean {
  return /(^|[\s,:])(noindex|none)([\s,]|$)/i.test(directives);
}

/** JSON-LD types on the page: "Organization", "LocalBusiness"… (nested @graph included). */
function ldTypes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) ldTypes(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string") out.add(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === "string") out.add(t);
  if (record["@graph"]) ldTypes(record["@graph"], out);
}

export interface AuditPageContext {
  /** The page's full address (after redirects), for the canonical check. */
  url?: string;
  /** The response headers, lower-cased names, for X-Robots-Tag. */
  headers?: Readonly<Record<string, string>>;
}

/** Audit one served page. Pure, so the tests are HTML in, verdicts out. */
export function auditPage(path: string, html: string, context: AuditPageContext = {}): PageAudit {
  const checks: SeoCheck[] = [];

  const title = titleOf(html);
  checks.push(
    title === null || title === ""
      ? check("page.title", "Page title", "seo", "fail", "The page has no title. Search results show the title as the blue link.")
      : title.length < 15 || title.length > 60
        ? check("page.title", "Page title", "seo", "warn", `“${title.slice(0, 70)}” is ${plural(title.length, "character")}; search results cut titles off outside roughly 15–60.`)
        : check("page.title", "Page title", "seo", "pass", `“${title}” (${plural(title.length, "character")}).`),
  );

  const description = metaContent(html, "description");
  checks.push(
    description === null || description.trim() === ""
      ? check("page.description", "Page summary", "seo", "fail", "No short summary for Google to show under the link, so it shows whatever it picks from the page.")
      : description.length < 50 || description.length > 160
        ? check("page.description", "Page summary", "seo", "warn", `The short summary Google shows is ${plural(description.length, "character")}; the useful range is about 50–160.`)
        : check("page.description", "Page summary", "seo", "pass", `The short summary Google shows is ${plural(description.length, "character")}.`),
  );

  const h1Count = (html.match(/<h1[\s>]/gi) ?? []).length;
  checks.push(
    h1Count === 1
      ? check("page.h1", "One main heading", "seo", "pass", "One main heading.")
      : check("page.h1", "One main heading", "seo", h1Count === 0 ? "fail" : "warn", h1Count === 0 ? "No main heading on the page." : `${h1Count} main headings compete to say what the page is about.`),
  );

  const canonical = canonicalOf(html);
  if (canonical === null || canonical.trim() === "") {
    checks.push(check("page.canonical", "Main address", "seo", "warn", "The page doesn't say what the page's main address is, so copies of it with extra bits in the address can compete with it."));
  } else if (context.url) {
    let resolved: string | null = null;
    try {
      resolved = new URL(canonical.trim(), context.url).toString();
    } catch {
      resolved = null;
    }
    checks.push(
      resolved === null
        ? check("page.canonical", "Main address", "seo", "fail", `The page's main address it gives, “${canonical.slice(0, 120)}”, isn't a web address.`)
        : samePage(resolved, context.url)
          ? check("page.canonical", "Main address", "seo", "pass", "Gives itself as the page's main address.")
          : check("page.canonical", "Main address", "seo", "warn", `Gives another page as the page's main address (${resolved.slice(0, 160)}), so search engines may show that page instead of this one.`),
    );
  } else {
    checks.push(check("page.canonical", "Main address", "seo", "pass", "Gives the page's main address."));
  }

  const ogTitle = metaContent(html, "og:title");
  const ogImage = metaContent(html, "og:image");
  checks.push(
    ogTitle && ogImage
      ? check("page.og", "Link preview", "seo", "pass", "Has a title and a picture for link previews.")
      : check("page.og", "Link preview", "seo", "warn", `Missing ${[!ogTitle && "a preview title", !ogImage && "a preview picture"].filter(Boolean).join(" and ")} — shared links show as a plain grey box.`),
  );

  const robotsMeta = [metaContent(html, "robots"), metaContent(html, "googlebot")].filter((v): v is string => v !== null).join(", ");
  checks.push(
    noindexIn(robotsMeta)
      ? check("page.noindex", "Allowed in search", "seo", "fail", `The page asks search engines to leave it out of search (it says “${robotsMeta.slice(0, 80)}”).`)
      : check("page.noindex", "Allowed in search", "seo", "pass", "The page doesn't ask to be left out of search."),
  );

  const header = context.headers?.["x-robots-tag"];
  checks.push(
    header !== undefined && noindexIn(header)
      ? check("page.x-robots-tag", "Allowed in search (server)", "seo", "fail", `The server tells search engines to leave this page out of search (its X-Robots-Tag says “${header.slice(0, 80)}”).`)
      : check("page.x-robots-tag", "Allowed in search (server)", "seo", "pass", header !== undefined ? `The server's instructions for search engines (“${header.slice(0, 80)}”) don't leave the page out.` : "The server doesn't ask to leave the page out."),
  );

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const withAlt = images.filter((tag) => (attrOf(tag, "alt") ?? "").trim() !== "").length;
  checks.push(
    images.length === 0
      ? check("page.img-alt", "Picture descriptions", "seo", "pass", "No pictures on the page.")
      : withAlt / images.length >= 0.8
        ? check("page.img-alt", "Picture descriptions", "seo", "pass", `${withAlt} of ${plural(images.length, "picture")} have image descriptions.`)
        : check("page.img-alt", "Picture descriptions", "seo", "warn", `Only ${withAlt} of ${plural(images.length, "picture")} have image descriptions.`),
  );

  // --- The answer-engine half of the page ---------------------------------

  const ldBlocks = html.match(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  let ldValid = 0;
  const types = new Set<string>();
  for (const block of ldBlocks) {
    const body = /^<script\b[^>]*>([\s\S]*)<\/script>$/i.exec(block)?.[1] ?? "";
    try {
      ldTypes(JSON.parse(body), types);
      ldValid += 1;
    } catch {
      // counted below as present-but-broken
    }
  }
  const typeList = [...types].slice(0, 6).join(", ");
  checks.push(
    ldBlocks.length === 0
      ? check("page.structured-data", "Business details for machines", "aeo", "fail", "No business details written for machines (structured data). AI assistants quote what they can read as facts first.")
      : ldValid === ldBlocks.length
        ? types.size > 0
          ? check("page.structured-data", "Business details for machines", "aeo", "pass", `${plural(ldValid, "set")} of business details for machines: ${typeList}.`)
          : check("page.structured-data", "Business details for machines", "aeo", "warn", "Business details for machines are there but don't say what they describe (a business, a product…).")
        : check("page.structured-data", "Business details for machines", "aeo", "warn", `${ldBlocks.length - ldValid} of ${plural(ldBlocks.length, "set")} of business details for machines are broken and can't be read.`),
  );

  const h2Count = (html.match(/<h2[\s>]/gi) ?? []).length;
  checks.push(
    h2Count > 0
      ? check("page.headings", "Sections", "aeo", "pass", `${plural(h2Count, "section heading")} — AI assistants quote sections, not walls of text.`)
      : check("page.headings", "Sections", "aeo", "warn", "No section headings to quote from."),
  );

  return { path, ...(context.url ? { url: context.url } : {}), checks };
}

/** 0–100 for one kind: a pass is a point, a warn half of one. */
export function scoreOf(checks: readonly SeoCheck[], kind: CheckKind): number {
  const relevant = checks.filter((c) => c.kind === kind);
  if (relevant.length === 0) return 0;
  const points = relevant.reduce((sum, c) => sum + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  return Math.round((points / relevant.length) * 100);
}

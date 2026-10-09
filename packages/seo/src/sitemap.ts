import { Issues, SeoError } from "./errors.js";
import { CHANGE_FREQUENCIES, pathRule, type ChangeFrequency, type PathList } from "./paths.js";
import { absoluteUrl, pageUrl, type Site } from "./site.js";
import { checkDate, dateMillis, utf8Bytes, type DateInput } from "./util.js";

/**
 * Sitemaps with REAL dates. `lastModified` is a required key on every entry:
 * pass the date the content last changed (a row's `updatedAt`, a content
 * file's date), or `null` when you do not know it, and the entry is written
 * without a `<lastmod>`. Nothing here ever substitutes "now": trailcards and
 * Riddler Go stamped every page with the build time, which teaches search
 * engines that the dates mean nothing.
 *
 * The path list is the same one robots.txt and the noindex header read: a
 * URL under a `private` or `noindex` path is never listed (Search Console
 * reports exactly that as "Submitted URL marked noindex" or "blocked by
 * robots.txt"). Rows from a database go through the same check.
 *
 * Over 50,000 URLs or 50 MB (the protocol's limits) the entries split into
 * several files under a sitemap index, each file's index `<lastmod>` being
 * its newest entry's. The files are served from the site root
 * (`/sitemap-0.xml`), because a sitemap may only list URLs at or below its
 * own folder.
 */

export interface SitemapEntryInput {
  /** A path or a URL on the site's own origin. */
  url: string;
  /** When the content last changed, from your data; null when unknown. Never "now". */
  lastModified: DateInput | null | undefined;
  changeFrequency?: ChangeFrequency;
  priority?: number;
  /** Image URLs on the page (paths or absolute; a CDN host is fine). */
  images?: readonly string[];
  /** hreflang → path or URL. */
  alternates?: { languages: Readonly<Record<string, string>> };
}

export interface SitemapEntry {
  url: string;
  lastModified?: string;
  changeFrequency?: ChangeFrequency;
  priority?: number;
  images?: string[];
  alternates?: { languages: Record<string, string> };
}

export interface SitemapEntriesOptions {
  /** For the future-date check. Default: the current time. */
  now?: Date;
  /**
   * Skip an invalid entry and report it here, instead of throwing. For
   * sitemaps built from database rows, where one bad row should not take
   * the whole file down.
   */
  onInvalid?: (issue: { url: string; issues: readonly string[] }) => void;
}

/** A day of clock skew, no more: a `lastModified` later than that is a bug in the data. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Normalise, check and de-duplicate entries. Off production it returns
 * nothing: a staging sitemap is an invitation to index staging.
 * A URL listed twice keeps its newest `lastModified`.
 */
export function sitemapEntries(site: Site, inputs: readonly SitemapEntryInput[], options: SitemapEntriesOptions = {}): SitemapEntry[] {
  if (!site.indexable) return [];
  const now = (options.now ?? new Date()).getTime();
  const byUrl = new Map<string, SitemapEntry>();
  for (const input of inputs) {
    const issues = new Issues("sitemapEntries");
    let url = "";
    try {
      url = pageUrl(site, input.url);
    } catch (error) {
      issues.add((error as Error).message.replace(/^@adminigloo\/seo pageUrl: /, ""));
    }
    if (url) {
      const rule = pathRule(site.paths, url);
      if (rule === "private" || rule === "noindex") issues.add(`is under a ${rule} path in the site's path list, so it cannot be in the sitemap`);
    }
    if (!("lastModified" in input)) issues.add("lastModified is required (null when unknown): it is never filled in with the current time");
    let lastModified: string | undefined;
    if (input.lastModified !== null && input.lastModified !== undefined) {
      const check = checkDate(input.lastModified);
      if ("problem" in check) issues.add(`lastModified ${check.problem}`);
      else if (dateMillis(check.iso) > now + FUTURE_TOLERANCE_MS) issues.add(`lastModified ${check.iso} is in the future`);
      else lastModified = check.iso;
    }
    if (input.priority !== undefined) issues.check(input.priority >= 0 && input.priority <= 1, "priority must be between 0 and 1");
    if (input.changeFrequency !== undefined) issues.check(CHANGE_FREQUENCIES.includes(input.changeFrequency), "changeFrequency is not a sitemap value");
    const images: string[] = [];
    for (const image of input.images ?? []) {
      try {
        const resolved = absoluteUrl(site, image);
        if (!images.includes(resolved)) images.push(resolved);
      } catch {
        issues.add(`image "${image}" is neither an absolute URL nor a path`);
      }
    }
    let languages: Record<string, string> | undefined;
    if (input.alternates) {
      languages = {};
      for (const [lang, target] of Object.entries(input.alternates.languages)) {
        try {
          languages[lang] = absoluteUrl(site, target);
        } catch {
          issues.add(`alternate "${lang}" is neither an absolute URL nor a path`);
        }
      }
    }
    if (issues.list.length > 0) {
      if (options.onInvalid) {
        options.onInvalid({ url: input.url, issues: [...issues.list] });
        continue;
      }
      throw new SeoError("invalid_input", "sitemapEntries", issues.list.map((issue) => `${input.url}: ${issue}`));
    }
    const entry: SitemapEntry = {
      url,
      ...(lastModified ? { lastModified } : {}),
      ...(input.changeFrequency ? { changeFrequency: input.changeFrequency } : {}),
      ...(input.priority !== undefined ? { priority: Math.round(input.priority * 100) / 100 } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(languages && Object.keys(languages).length > 0 ? { alternates: { languages } } : {}),
    };
    const previous = byUrl.get(url);
    if (!previous || newer(entry.lastModified, previous.lastModified)) byUrl.set(url, entry);
  }
  return [...byUrl.values()];
}

function newer(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined) return false;
  if (b === undefined) return true;
  return dateMillis(a) > dateMillis(b);
}

/** Sitemap inputs for the path list's public pages, with the dates the list carries. */
export function pathEntries(site: Site, paths: PathList = site.paths): SitemapEntryInput[] {
  return paths.public.map((entry) => ({
    url: entry.path,
    lastModified: entry.lastModified ?? null,
    ...(entry.changeFrequency ? { changeFrequency: entry.changeFrequency } : {}),
    ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
    ...(entry.images ? { images: entry.images } : {}),
  }));
}

/** The array Next's `app/sitemap.ts` returns (`MetadataRoute.Sitemap`). */
export function toNextSitemap(entries: readonly SitemapEntry[]): Array<{
  url: string;
  lastModified?: string;
  changeFrequency?: ChangeFrequency;
  priority?: number;
  images?: string[];
  alternates?: { languages: Record<string, string> };
}> {
  return entries.map((entry) => ({ ...entry }));
}

// ---------------------------------------------------------------------------
// Raw XML
// ---------------------------------------------------------------------------

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const URLSET_OPEN =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
const URLSET_CLOSE = "</urlset>\n";

/** 0.7 → "0.7", 1 → "1.0", 0.85 → "0.85", 1e-7 → "0.0": never exponent notation. */
function formatPriority(priority: number): string {
  return priority.toFixed(2).replace(/0$/, "");
}

function urlXml(entry: SitemapEntry): string {
  const parts = [`<url>\n<loc>${xml(entry.url)}</loc>\n`];
  for (const [lang, href] of Object.entries(entry.alternates?.languages ?? {})) {
    parts.push(`<xhtml:link rel="alternate" hreflang="${xml(lang)}" href="${xml(href)}"/>\n`);
  }
  if (entry.lastModified) parts.push(`<lastmod>${xml(entry.lastModified)}</lastmod>\n`);
  if (entry.changeFrequency) parts.push(`<changefreq>${entry.changeFrequency}</changefreq>\n`);
  if (entry.priority !== undefined) parts.push(`<priority>${formatPriority(entry.priority)}</priority>\n`);
  for (const image of entry.images ?? []) parts.push(`<image:image>\n<image:loc>${xml(image)}</image:loc>\n</image:image>\n`);
  parts.push("</url>\n");
  return parts.join("");
}

/** One `<urlset>` document. Does not split: use `buildSitemaps` for that. */
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  return URLSET_OPEN + entries.map(urlXml).join("") + URLSET_CLOSE;
}

/** A `<sitemapindex>` document. */
export function sitemapIndexXml(sitemaps: ReadonlyArray<{ url: string; lastModified?: string }>): string {
  const items = sitemaps.map(
    (s) => `<sitemap>\n<loc>${xml(s.url)}</loc>\n${s.lastModified ? `<lastmod>${xml(s.lastModified)}</lastmod>\n` : ""}</sitemap>\n`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.join("")}</sitemapindex>\n`;
}

export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

export interface SplitOptions {
  /** Default 50,000 (the protocol's limit). */
  maxUrls?: number;
  /** Uncompressed bytes per file. Default 50 MB (the protocol's limit). */
  maxBytes?: number;
}

/** Entries in file-sized chunks, in order: no chunk over `maxUrls` URLs or `maxBytes` of XML. */
export function splitSitemap(entries: readonly SitemapEntry[], options: SplitOptions = {}): SitemapEntry[][] {
  const maxUrls = Math.min(options.maxUrls ?? SITEMAP_MAX_URLS, SITEMAP_MAX_URLS);
  const maxBytes = Math.min(options.maxBytes ?? SITEMAP_MAX_BYTES, SITEMAP_MAX_BYTES);
  const overhead = utf8Bytes(URLSET_OPEN) + utf8Bytes(URLSET_CLOSE);
  const chunks: SitemapEntry[][] = [];
  let current: SitemapEntry[] = [];
  let bytes = overhead;
  for (const entry of entries) {
    const size = utf8Bytes(urlXml(entry));
    if (overhead + size > maxBytes) {
      throw new SeoError("invalid_input", "splitSitemap", [`${entry.url} alone is larger than ${maxBytes} bytes of sitemap`]);
    }
    if (current.length > 0 && (current.length >= maxUrls || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = overhead;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

export interface SitemapFile {
  /** 0, 1, 2… */
  id: number;
  /** Where it is served, e.g. "/sitemap-0.xml". */
  path: string;
  url: string;
  xml: string;
  /** The newest entry's lastModified. */
  lastModified?: string;
}

export interface SitemapSet {
  /** The `<sitemapindex>` to serve at /sitemap.xml, or null when one file holds everything. */
  index: string | null;
  /** Serve at /sitemap.xml when there is no index; otherwise each at its `path`. */
  files: SitemapFile[];
  /** What /sitemap.xml should answer: the index, or the only file. */
  root: string;
}

/**
 * The whole sitemap as XML: one file, or an index plus files when the
 * entries pass the limits. `filePath(id)` is where you serve file `id`
 * (default "/sitemap-{id}.xml", at the root: under the sitemaps protocol a
 * file in /sitemaps/ may only list URLs under /sitemaps/).
 */
export function buildSitemaps(
  site: Site,
  entries: readonly SitemapEntry[],
  options: SplitOptions & { filePath?: (id: number) => string } = {},
): SitemapSet {
  const filePath = options.filePath ?? ((id: number) => `/sitemap-${id}.xml`);
  const chunks = splitSitemap(entries, options);
  const files = chunks.map((chunk, id) => {
    const path = filePath(id);
    const newest = chunk.reduce<string | undefined>((max, entry) => (newer(entry.lastModified, max) ? entry.lastModified : max), undefined);
    return { id, path, url: absoluteUrl(site, path), xml: sitemapXml(chunk), ...(newest ? { lastModified: newest } : {}) };
  });
  const index = files.length > 1 ? sitemapIndexXml(files) : null;
  return { index, files, root: index ?? files[0]!.xml };
}

/** An XML Response for a route handler. */
export function sitemapResponse(body: string, options: { cacheSeconds?: number } = {}): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": `public, max-age=${options.cacheSeconds ?? 3600}`,
    },
  });
}

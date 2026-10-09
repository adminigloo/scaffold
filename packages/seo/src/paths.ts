import { Issues } from "./errors.js";
import type { DateInput } from "./util.js";

/**
 * ONE path list drives robots.txt, the noindex header and meta tag, and the
 * sitemap (Riddler Go's `marketing-paths.ts` idea), so adding a page lands in
 * all three and a private area can never be listed in one and forgotten in
 * another.
 *
 *   - `public`: the pages you want found. They go in the sitemap (with their
 *     real last-modified date, when you give one) and are always crawlable.
 *   - `private`: areas no crawler should fetch or index: admin, account, API.
 *     Disallowed in robots.txt, so a crawler that obeys robots.txt never
 *     fetches them. They are ALSO sent `noindex, nofollow` (header and meta)
 *     for everything that does fetch them anyway: a crawler that ignores
 *     robots.txt or could not load it, a link previewer, a person's assistant.
 *     The header cannot stop the one thing a disallow allows: a disallowed URL
 *     that is linked from elsewhere may still be listed by URL alone, because
 *     the crawler never sees the header. A page that must drop out of the index
 *     belongs in `noindex`, not here.
 *   - `noindex`: pages a crawler may fetch but should not list: sign-in, cart,
 *     thin pages. NOT disallowed in robots.txt, on purpose: a crawler that may
 *     not fetch a page never sees its noindex, so disallowing it would keep the
 *     page in the index.
 *
 * Matching is by path segment: `/admin` covers `/admin`, `/admin/` and
 * `/admin/users`, never `/admin-guide`, and robots.txt says the same (it
 * writes `/admin$`, `/admin/` and `/admin?`, never the bare prefix `/admin`).
 * A trailing slash is ignored, so `/checkout/` and `/checkout` are the same
 * entry (trailcards' `/checkout/` rule did not block `/checkout` itself), and
 * a list that names both (Riddler Go's `NOINDEX_PREFIXES` does) is fine.
 */

export const CHANGE_FREQUENCIES = ["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"] as const;
export type ChangeFrequency = (typeof CHANGE_FREQUENCIES)[number];

export interface PublicPathInput {
  path: string;
  /**
   * When the page's content last changed, from your data or your content
   * registry. Leave it out rather than guess: a sitemap that says every page
   * changed today teaches search engines to ignore its dates.
   */
  lastModified?: DateInput | null;
  changeFrequency?: ChangeFrequency;
  /** 0.0 to 1.0. Google ignores it; Bing and others may read it. */
  priority?: number;
  /** Absolute or site-relative image URLs on the page, for the image sitemap. */
  images?: readonly string[];
}

export interface PathListInput {
  public?: ReadonlyArray<string | PublicPathInput>;
  private?: readonly string[];
  noindex?: readonly string[];
}

export interface PublicPath {
  readonly path: string;
  readonly lastModified?: DateInput | null;
  readonly changeFrequency?: ChangeFrequency;
  readonly priority?: number;
  readonly images?: readonly string[];
}

export interface PathList {
  readonly public: readonly PublicPath[];
  readonly private: readonly string[];
  readonly noindex: readonly string[];
}

export type PathRule = "private" | "noindex" | "public" | "unlisted";

const FORBIDDEN_CHARS = /[*$?#\s]/;

/** "/checkout/" → "/checkout"; "/" stays "/". Returns null for a path that is not one. */
export function normalizePath(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || FORBIDDEN_CHARS.test(path)) return null;
  if (path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Does `prefix` cover `pathname`, by whole segments? `/admin` covers `/admin/x`, not `/admin-guide`. */
export function pathCovers(prefix: string, pathname: string): boolean {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The path of a request or a URL, without query or fragment. */
export function pathnameOf(value: string): string {
  let path = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      return value;
    }
  }
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

const DEFINED = new WeakSet<object>();

/** Whether a value came from definePaths (and so has been normalised and checked). */
export function isPathList(value: unknown): value is PathList {
  return typeof value === "object" && value !== null && DEFINED.has(value);
}

export function definePaths(input: PathListInput): PathList {
  const issues = new Issues("definePaths", "invalid_config");
  const seen = new Map<string, string>();
  /** True for a path seen for the first time. The same path twice in ONE list is a harmless repeat; in two lists it is a contradiction. */
  const claim = (path: string, list: string): boolean => {
    const previous = seen.get(path);
    if (previous === undefined) {
      seen.set(path, list);
      return true;
    }
    if (previous !== list || list === "public") issues.add(previous === list ? `"${path}" is listed twice in public` : `"${path}" is listed as both ${previous} and ${list}`);
    return false;
  };

  const privatePaths: string[] = [];
  for (const raw of input.private ?? []) {
    const path = normalizePath(raw);
    if (path === null) {
      issues.add(`private path "${raw}" must start with "/" and contain no *, $, ?, # or spaces`);
      continue;
    }
    if (path === "/") {
      issues.add('"/" cannot be private: an off-production site is closed with defineSite({ indexable: false }), never by the path list');
      continue;
    }
    if (pathCovers("/_next", path)) {
      issues.add(`"${path}" cannot be private: /_next/ serves the CSS, JavaScript and optimised images a search engine needs to render the site`);
      continue;
    }
    if (claim(path, "private")) privatePaths.push(path);
  }

  const noindexPaths: string[] = [];
  for (const raw of input.noindex ?? []) {
    const path = normalizePath(raw);
    if (path === null || path === "/") {
      issues.add(
        path === "/"
          ? '"/" cannot be noindex: an off-production site is closed with defineSite({ indexable: false })'
          : `noindex path "${raw}" must start with "/" and contain no *, $, ?, # or spaces`,
      );
      continue;
    }
    if (claim(path, "noindex")) noindexPaths.push(path);
  }

  const publicPaths: PublicPath[] = [];
  for (const raw of input.public ?? []) {
    const entry: PublicPathInput = typeof raw === "string" ? { path: raw } : raw;
    const path = normalizePath(entry.path);
    if (path === null) {
      issues.add(`public path "${entry.path}" must start with "/" and contain no *, $, ?, # or spaces`);
      continue;
    }
    const hidden = [...privatePaths, ...noindexPaths].find((prefix) => pathCovers(prefix, path));
    if (hidden) issues.add(`public path "${path}" is inside "${hidden}", which is ${privatePaths.includes(hidden) ? "private" : "noindex"}`);
    if (entry.priority !== undefined && !(entry.priority >= 0 && entry.priority <= 1)) {
      issues.add(`public path "${path}": priority must be between 0 and 1`);
    }
    if (entry.changeFrequency !== undefined && !CHANGE_FREQUENCIES.includes(entry.changeFrequency)) {
      issues.add(`public path "${path}": changeFrequency must be one of ${CHANGE_FREQUENCIES.join(", ")}`);
    }
    if (claim(path, "public")) publicPaths.push(Object.freeze({ ...entry, path }));
  }

  issues.throwIfAny();
  const list: PathList = Object.freeze({
    public: Object.freeze(publicPaths),
    private: Object.freeze(privatePaths),
    noindex: Object.freeze(noindexPaths),
  });
  DEFINED.add(list);
  return list;
}

export const EMPTY_PATHS: PathList = /* @__PURE__ */ (() => definePaths({}))();

/**
 * What the path list says about one request path. The most specific private
 * or noindex entry wins (a noindex `/account` with a private `/account/billing`
 * makes `/account/billing/x` private); `public` means listed exactly;
 * `unlisted` is everything else (indexable, just not in the list).
 */
export function pathRule(paths: PathList, pathnameOrUrl: string): PathRule {
  const pathname = normalizePath(pathnameOf(pathnameOrUrl)) ?? pathnameOf(pathnameOrUrl);
  let best: { length: number; rule: PathRule } | null = null;
  for (const prefix of paths.private) {
    if (pathCovers(prefix, pathname) && (!best || prefix.length > best.length)) best = { length: prefix.length, rule: "private" };
  }
  for (const prefix of paths.noindex) {
    if (pathCovers(prefix, pathname) && (!best || prefix.length > best.length)) best = { length: prefix.length, rule: "noindex" };
  }
  if (best) return best.rule;
  return paths.public.some((entry) => entry.path === pathname) ? "public" : "unlisted";
}

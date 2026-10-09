import { Issues, SeoError } from "./errors.js";
import { definePaths, EMPTY_PATHS, isPathList, pathRule, type PathList, type PathListInput } from "./paths.js";
import { isHttpUrl, oneLine } from "./util.js";

/**
 * The site, defined once and passed to every builder: its address, its name,
 * the share image every page falls back to, its path list, and whether this
 * deployment may be indexed at all. One `indexable` value feeds the robots
 * meta tag, the X-Robots-Tag header, robots.txt, the sitemap and IndexNow, so
 * the page and the file can never say different things (the AdminIgloo site's
 * `INDEXABLE` rule).
 */

/** A share image as the site and page metadata carry it (named apart from `./og`'s `ShareImage` component). */
export interface ShareImageMeta {
  /** Absolute after defineSite / pageMetadata resolve it. */
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
  readonly type?: string;
}

/** A path ("/opengraph-image") or URL, or the full descriptor. */
export type ShareImageInput = string | { url: string; width?: number; height?: number; alt?: string; type?: string };

export interface SiteInput {
  /** The production origin, e.g. "https://riddlergo.com". No path: base paths are not supported. */
  url: string;
  /** The brand, as it should appear once at the end of a title. */
  name: string;
  /**
   * May this deployment be indexed? Required, so the decision is always made
   * on purpose: pass `isIndexable({ env, host })`. When false, every page is
   * noindex, robots.txt refuses everything, the sitemap is empty and IndexNow
   * sends nothing.
   */
  indexable: boolean;
  /** The default meta description, for pages that do not set their own. */
  description?: string;
  /** Open Graph locale. Default "en_US". */
  locale?: string;
  /** BCP 47 language for JSON-LD `inLanguage`. Default derived from `locale` ("en-US"). */
  language?: string;
  /** Between a page title and the brand. Default " | ". */
  titleSeparator?: string;
  /**
   * The share image a page uses when it has none of its own: a static file
   * ("/og.png") or the route a root `opengraph-image.tsx` is served at
   * ("/opengraph-image"). Give width and height (1200×630) so previews draw
   * before the image loads.
   */
  image?: ShareImageInput;
  /** Twitter/X handles, with or without the "@". */
  twitter?: { site?: string; creator?: string };
  /** Match `trailingSlash` in next.config. Default false. */
  trailingSlash?: boolean;
  /** The one path list for robots.txt, noindex and the sitemap. */
  paths?: PathList | PathListInput;
}

export interface Site {
  /** The origin, no trailing slash: "https://riddlergo.com". */
  readonly url: string;
  readonly host: string;
  readonly name: string;
  readonly indexable: boolean;
  readonly description?: string;
  readonly locale: string;
  readonly language: string;
  readonly titleSeparator: string;
  readonly image?: ShareImageMeta;
  readonly twitter?: { readonly site?: string; readonly creator?: string };
  readonly trailingSlash: boolean;
  readonly paths: PathList;
}

export function defineSite(input: SiteInput): Site {
  const issues = new Issues("defineSite", "invalid_config");
  let origin = "";
  let host = "";
  if (typeof input.url !== "string" || !isHttpUrl(input.url)) {
    issues.add(
      input.url === undefined || input.url === ""
        ? 'url is missing: a build without NEXT_PUBLIC_APP_URL (CI) should pass url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", which isIndexable() already refuses'
        : `url must be an absolute http(s) URL, got ${JSON.stringify(input.url)}`,
    );
  } else {
    const parsed = new URL(input.url);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
      issues.add(`url must be an origin with no path, query or fragment (got "${input.url}"); base paths are not supported`);
    }
    origin = parsed.origin;
    host = parsed.host;
  }
  const name = typeof input.name === "string" ? oneLine(input.name) : "";
  issues.check(name !== "", "name is required");
  issues.check(typeof input.indexable === "boolean", "indexable is required: pass isIndexable({ env, host })");
  const separator = input.titleSeparator ?? " | ";
  issues.check(separator.trim() !== "", 'titleSeparator must contain a visible character, e.g. " | " or " · "');
  issues.throwIfAny();

  const locale = input.locale ?? "en_US";
  const paths = !input.paths ? EMPTY_PATHS : isPathList(input.paths) ? input.paths : definePaths(input.paths);
  const base = { url: origin, host };
  const image = input.image === undefined ? undefined : resolveShareImage(base, input.image, "image");

  const site: Site = {
    url: origin,
    host,
    name,
    indexable: input.indexable,
    ...(input.description ? { description: oneLine(input.description) } : {}),
    locale,
    language: input.language ?? locale.replace("_", "-"),
    titleSeparator: separator,
    ...(image ? { image } : {}),
    ...(input.twitter ? { twitter: normalizeTwitter(input.twitter) } : {}),
    trailingSlash: input.trailingSlash ?? false,
    paths,
  };

  if (image && image.url.startsWith(`${origin}/`)) {
    const rule = pathRule(paths, image.url);
    if (rule === "private") {
      throw new SeoError("invalid_config", "defineSite", [
        `the default share image ${image.url} is under a private path, so link previewers that obey robots.txt (Twitterbot) cannot fetch it`,
      ]);
    }
  }
  return Object.freeze(site);
}

function normalizeTwitter(twitter: { site?: string; creator?: string }): { site?: string; creator?: string } {
  const handle = (value: string | undefined): string | undefined => {
    if (!value || value.trim() === "") return undefined;
    const trimmed = value.trim();
    return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  };
  const site = handle(twitter.site);
  const creator = handle(twitter.creator);
  return { ...(site ? { site } : {}), ...(creator ? { creator } : {}) };
}

/**
 * An absolute URL for a path or URL. A path resolves against the site; an
 * absolute URL on another host (a CDN image, a social profile) is kept.
 */
export function absoluteUrl(site: Pick<Site, "url">, pathOrUrl: string): string {
  if (isHttpUrl(pathOrUrl)) return new URL(pathOrUrl).href;
  if (!pathOrUrl.startsWith("/")) {
    throw new SeoError("invalid_input", "absoluteUrl", [`"${pathOrUrl}" is neither an absolute URL nor a path starting with "/"`]);
  }
  return new URL(pathOrUrl, `${site.url}/`).href;
}

const TRACKING_PARAMS = /^(utm_[a-z_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|twclid|ttclid|li_fat_id|mc_cid|mc_eid|_ga|_gl|igshid)$/i;

/**
 * The canonical URL of a page on this site: absolute, on the site's own
 * origin, fragment dropped, campaign parameters (utm_*, gclid, fbclid, …)
 * dropped, trailing slash per `site.trailingSlash`. Throws for another host:
 * a canonical pointing off-site is a decision, never a fallback.
 */
export function pageUrl(site: Pick<Site, "url" | "trailingSlash">, path: string): string {
  if (typeof path !== "string" || path.trim() === "") {
    throw new SeoError("invalid_input", "pageUrl", ["path is required: a canonical is the page itself, never a fallback to the homepage"]);
  }
  const url = new URL(absoluteUrl(site, path));
  if (url.origin !== site.url) {
    throw new SeoError("invalid_input", "pageUrl", [`${url.href} is not on ${site.url}; a page's canonical is on its own site`]);
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  if (url.pathname !== "/") {
    const last = url.pathname.split("/").pop() ?? "";
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(last);
    if (site.trailingSlash && !url.pathname.endsWith("/") && !looksLikeFile) url.pathname = `${url.pathname}/`;
    if (!site.trailingSlash) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  }
  return url.href;
}

export function resolveShareImage(site: Pick<Site, "url">, input: ShareImageInput, field: string): ShareImageMeta {
  const descriptor = typeof input === "string" ? { url: input } : input;
  const issues = new Issues("shareImage");
  issues.check(typeof descriptor.url === "string" && descriptor.url !== "", `${field}.url is required`);
  for (const key of ["width", "height"] as const) {
    const value = descriptor[key];
    if (value !== undefined) issues.check(Number.isInteger(value) && value > 0, `${field}.${key} must be a positive integer`);
  }
  issues.throwIfAny();
  return Object.freeze({
    url: absoluteUrl(site, descriptor.url),
    ...(descriptor.width !== undefined ? { width: descriptor.width } : {}),
    ...(descriptor.height !== undefined ? { height: descriptor.height } : {}),
    ...(descriptor.alt ? { alt: oneLine(descriptor.alt) } : {}),
    ...(descriptor.type ? { type: descriptor.type } : {}),
  });
}

/** Directives `robotsHeader` may add to a noindex answer. */
export const EXTRA_ROBOTS_DIRECTIVES = ["noarchive", "nosnippet", "noimageindex", "notranslate"] as const;
export type ExtraRobotsDirective = (typeof EXTRA_ROBOTS_DIRECTIVES)[number];

/**
 * The `X-Robots-Tag` value for a request path, or null to send none. For a
 * proxy/middleware, so crawlers that never parse the page's HTML (and every
 * non-HTML response) still get the answer:
 *
 *   - off production: `noindex, nofollow` on everything;
 *   - a private path: `noindex, nofollow`;
 *   - a noindex path: `noindex` (links on it may still be followed);
 *   - anything else: null.
 *
 * `extra` is appended to every header it sends, e.g. Riddler Go's
 * `["noarchive", "nosnippet"]` (`noindex, nofollow, noarchive, nosnippet`).
 */
export function robotsHeader(
  site: Pick<Site, "indexable" | "paths">,
  pathnameOrUrl: string,
  options: { extra?: readonly ExtraRobotsDirective[] } = {},
): string | null {
  const extra = options.extra ?? [];
  const unknown = extra.filter((directive) => !EXTRA_ROBOTS_DIRECTIVES.includes(directive));
  if (unknown.length > 0) {
    throw new SeoError("invalid_config", "robotsHeader", [`extra may only hold ${EXTRA_ROBOTS_DIRECTIVES.join(", ")} (got ${unknown.join(", ")})`]);
  }
  const rule = site.indexable ? pathRule(site.paths, pathnameOrUrl) : "private";
  const base = rule === "private" ? ["noindex", "nofollow"] : rule === "noindex" ? ["noindex"] : null;
  return base ? [...base, ...extra.filter((directive, i) => extra.indexOf(directive) === i)].join(", ") : null;
}

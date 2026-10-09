import { Issues } from "./errors.js";
import { pathRule } from "./paths.js";
import { absoluteUrl, pageUrl, resolveShareImage, type ShareImageInput, type ShareImageMeta, type Site } from "./site.js";
import { checkDate, escapeRegExp, oneLine, type DateInput } from "./util.js";

/**
 * Page metadata as a plain object that Next's `Metadata` type accepts (a type
 * test pins that), with no runtime dependency on Next. The rules it exists to
 * enforce, each one a defect found in trailcards, Riddler Go or this site:
 *
 *   1. The canonical is ALWAYS the page itself. `path` is required; there is no
 *      fallback to the homepage (trailcards' /subscribe told Google it was a
 *      copy of the homepage).
 *   2. The brand is in the title ONCE. The title is emitted as
 *      `{ absolute: "Pricing | Brand" }`, so a layout's `%s | Brand` template
 *      can never add it again, and a title that already names the brand gets
 *      no suffix ("All Trail Decks | Traildek | Traildek" was live).
 *   3. Open Graph and Twitter are always complete: Next replaces a layout's
 *      `openGraph` wholesale when a page sets its own, so the page's block
 *      re-states the site name, locale and URL and always carries a share image
 *      (the page's, else the site default). /pricing on Riddler Go lost its
 *      image exactly this way.
 *   4. noindex is one switch, and the path list and the deployment decide it
 *      too: a private or noindex path, or an off-production deployment, is
 *      noindex whatever the page asked for.
 */

export type OpenGraphPageType = "website" | "article" | "profile";

export interface PageInput {
  /** This page's own path (or same-site URL). Required: it becomes the canonical. */
  path: string;
  /** The page's title, without the brand (a title that names the brand gets no suffix). */
  title: string;
  /** Falls back to the site description. */
  description?: string;
  /** The page's share image; falls back to the site default. */
  image?: ShareImageInput | readonly ShareImageInput[];
  /** Open Graph type. Default "website". */
  type?: OpenGraphPageType;
  /** For `type: "article"`. */
  article?: {
    publishedTime?: DateInput;
    modifiedTime?: DateInput;
    /** Author names or profile URLs. */
    authors?: readonly string[];
    section?: string;
    tags?: readonly string[];
  };
  /** Keep this page out of search. `{ follow: false }` also asks crawlers not to follow its links. */
  noindex?: boolean | { follow?: boolean };
  /** Append the brand. Default true; a title that already names the brand never gets it twice. */
  brand?: boolean;
  alternates?: {
    /** hreflang → path or URL, e.g. { "en-US": "/", "es": "/es", "x-default": "/" }. */
    languages?: Readonly<Record<string, string>>;
    /** MIME type → path or URL, e.g. { "application/rss+xml": "/feed.xml" }. */
    types?: Readonly<Record<string, string>>;
  };
}

export interface OgImage {
  url: string;
  width?: number;
  height?: number;
  alt?: string;
  type?: string;
}

interface OpenGraphBase {
  url: string;
  title: string;
  description: string;
  siteName: string;
  locale: string;
  images: OgImage[];
}

export type PageOpenGraph =
  | (OpenGraphBase & { type: "website" })
  | (OpenGraphBase & {
      type: "article";
      publishedTime?: string;
      modifiedTime?: string;
      authors?: string[];
      section?: string;
      tags?: string[];
    })
  | (OpenGraphBase & { type: "profile" });

export interface RobotsDirectives {
  index: boolean;
  follow: boolean;
  nocache?: boolean;
  "max-image-preview"?: "none" | "standard" | "large";
  "max-snippet"?: number;
  "max-video-preview"?: number;
}

export interface RobotsMeta extends RobotsDirectives {
  googleBot?: RobotsDirectives;
}

export interface PageTwitter {
  card: "summary_large_image" | "summary";
  title: string;
  description: string;
  images: OgImage[];
  site?: string;
  creator?: string;
}

export interface PageMetadata {
  title: { absolute: string };
  description: string;
  alternates: {
    canonical: string;
    languages?: Record<string, string>;
    types?: Record<string, string>;
  };
  openGraph: PageOpenGraph;
  twitter: PageTwitter;
  robots: RobotsMeta;
}

/**
 * The title with the brand in it exactly once: "Pricing" → "Pricing | Brand".
 * A title that already names the brand (as a whole word, any case) gets no
 * suffix, and a brand suffix on a title that names the brand earlier is
 * removed: "X | Brand | Brand" → "X | Brand", "Brand — Tagline | Brand" →
 * "Brand — Tagline" (both shapes were live on trailcards). A hyphen joins
 * words, so "Go-Kart Racing" does not name the brand "Go".
 */
export function brandTitle(site: Pick<Site, "name" | "titleSeparator">, title: string, options: { brand?: boolean } = {}): string {
  let clean = oneLine(title);
  if (options.brand === false) return clean;
  const brand = escapeRegExp(site.name);
  const named = new RegExp(`(?:^|[^\\p{L}\\p{N}-])${brand}(?=$|[^\\p{L}\\p{N}-])`, "giu");
  const count = (value: string): number => value.match(named)?.length ?? 0;
  if (count(clean) === 0) return `${clean}${site.titleSeparator}${site.name}`;
  const trailing = new RegExp(`\\s*[|·•—–:-]\\s*${brand}$`, "iu");
  while (count(clean) > 1 && trailing.test(clean)) clean = clean.replace(trailing, "");
  return clean;
}

const INDEX_DIRECTIVES: RobotsMeta = {
  index: true,
  follow: true,
  "max-image-preview": "large",
  "max-snippet": -1,
  "max-video-preview": -1,
  googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
};

/** `nocache` is Bing's "keep no cached copy"; Google ignores it (and no longer keeps one). */
const OFF_PRODUCTION: RobotsMeta = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: { index: false, follow: false },
};

function robotsFor(site: Site, path: string, noindex: PageInput["noindex"]): RobotsMeta {
  if (!site.indexable) return { ...OFF_PRODUCTION, googleBot: { ...OFF_PRODUCTION.googleBot! } };
  const rule = pathRule(site.paths, path);
  if (rule === "private") return { index: false, follow: false, googleBot: { index: false, follow: false } };
  if (noindex || rule === "noindex") {
    const follow = typeof noindex === "object" && noindex.follow === false ? false : true;
    return { index: false, follow, googleBot: { index: false, follow } };
  }
  return { ...INDEX_DIRECTIVES, googleBot: { ...INDEX_DIRECTIVES.googleBot! } };
}

function toOgImage(image: ShareImageMeta, fallbackAlt: string): OgImage {
  return {
    url: image.url,
    ...(image.width !== undefined ? { width: image.width } : {}),
    ...(image.height !== undefined ? { height: image.height } : {}),
    alt: image.alt ?? fallbackAlt,
    ...(image.type ? { type: image.type } : {}),
  };
}

function absoluteMap(site: Site, map: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) out[key] = absoluteUrl(site, value);
  return Object.keys(out).length > 0 ? out : undefined;
}

export function pageMetadata(site: Site, page: PageInput): PageMetadata {
  const issues = new Issues("pageMetadata");
  issues.check(typeof page.path === "string" && page.path.trim() !== "", "path is required: the canonical is the page itself");
  issues.check(typeof page.title === "string" && oneLine(page.title) !== "", "title is required");
  issues.throwIfAny();

  const canonical = pageUrl(site, page.path);
  const title = brandTitle(site, page.title, { brand: page.brand });
  const description = oneLine(page.description ?? "") || site.description || "";
  if (description === "") {
    issues.add("description is required when the site has no default description");
    issues.throwIfAny();
  }

  const pageImages = page.image === undefined ? [] : Array.isArray(page.image) ? page.image : [page.image as ShareImageInput];
  const images = (pageImages.length > 0 ? pageImages.map((image, i) => resolveShareImage(site, image, `image[${i}]`)) : site.image ? [site.image] : []).map(
    (image) => toOgImage(image, title),
  );

  const type = page.type ?? "website";
  const base: OpenGraphBase = { url: canonical, title, description, siteName: site.name, locale: site.locale, images };
  let openGraph: PageOpenGraph;
  if (type === "article") {
    const article = page.article ?? {};
    const when = (value: DateInput | undefined, field: string): string | null => {
      if (value === undefined) return null;
      const check = checkDate(value);
      if ("problem" in check) issues.add(`${field} ${check.problem}`);
      return "iso" in check ? check.iso : null;
    };
    const published = when(article.publishedTime, "article.publishedTime");
    const modified = when(article.modifiedTime, "article.modifiedTime");
    issues.throwIfAny();
    openGraph = {
      ...base,
      type: "article",
      ...(published ? { publishedTime: published } : {}),
      ...(modified ? { modifiedTime: modified } : {}),
      ...(article.authors && article.authors.length > 0
        ? { authors: article.authors.map((author) => (author.startsWith("/") ? absoluteUrl(site, author) : author)) }
        : {}),
      ...(article.section ? { section: article.section } : {}),
      ...(article.tags && article.tags.length > 0 ? { tags: [...article.tags] } : {}),
    };
  } else {
    openGraph = { ...base, type };
  }

  const languages = absoluteMap(site, page.alternates?.languages);
  const types = absoluteMap(site, page.alternates?.types);
  return {
    title: { absolute: title },
    description,
    alternates: { canonical, ...(languages ? { languages } : {}), ...(types ? { types } : {}) },
    openGraph,
    twitter: {
      card: images.length > 0 ? "summary_large_image" : "summary",
      title,
      description,
      images,
      ...(site.twitter?.site ? { site: site.twitter.site } : {}),
      ...(site.twitter?.creator ? { creator: site.twitter.creator } : {}),
    },
    robots: robotsFor(site, page.path, page.noindex),
  };
}

export interface SiteMetadata {
  metadataBase: URL;
  title: { default: string; template: string };
  description?: string;
  applicationName: string;
  openGraph: { type: "website"; siteName: string; locale: string; title: string; description?: string; images: OgImage[] };
  twitter: { card: "summary_large_image" | "summary"; title: string; description?: string; images: OgImage[]; site?: string; creator?: string };
  robots: RobotsMeta;
}

/**
 * The root layout's defaults. Pages built with `pageMetadata` override every
 * field that matters; this covers the pages that are not, and Next's own
 * not-found and error pages. Deliberately NO canonical and NO `openGraph.url`:
 * a layout's values are inherited by every page that does not set its own,
 * so a canonical here would mark every such page as a copy of the homepage
 * (and an og:url here would point every share at the homepage, as trailcards'
 * did on eight pages).
 */
export function siteMetadata(site: Site, options: { homeTitle?: string } = {}): SiteMetadata {
  const home = oneLine(options.homeTitle ?? site.name);
  const images = site.image ? [toOgImage(site.image, home)] : [];
  return {
    metadataBase: new URL(`${site.url}/`),
    title: { default: home, template: `%s${site.titleSeparator}${site.name}` },
    ...(site.description ? { description: site.description } : {}),
    applicationName: site.name,
    openGraph: {
      type: "website",
      siteName: site.name,
      locale: site.locale,
      title: home,
      ...(site.description ? { description: site.description } : {}),
      images,
    },
    twitter: {
      card: images.length > 0 ? "summary_large_image" : "summary",
      title: home,
      ...(site.description ? { description: site.description } : {}),
      images,
      ...(site.twitter?.site ? { site: site.twitter.site } : {}),
      ...(site.twitter?.creator ? { creator: site.twitter.creator } : {}),
    },
    robots: site.indexable ? { ...INDEX_DIRECTIVES, googleBot: { ...INDEX_DIRECTIVES.googleBot! } } : { ...OFF_PRODUCTION, googleBot: { ...OFF_PRODUCTION.googleBot! } },
  };
}

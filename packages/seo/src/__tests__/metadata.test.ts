import { describe, expect, it } from "vitest";
import { brandTitle, defineSite, isIndexable, pageMetadata, siteMetadata, SeoError } from "../index.js";
import { site, SITE_INPUT, staging } from "./fixtures.js";

describe("canonical: always the page itself", () => {
  it("is the page's own absolute URL, never the homepage", () => {
    const meta = pageMetadata(site, { path: "/pricing", title: "Pricing" });
    expect(meta.alternates.canonical).toBe("https://riddlergo.com/pricing");
    expect(meta.openGraph.url).toBe("https://riddlergo.com/pricing");
  });

  it("refuses to build without a path rather than falling back to the homepage (trailcards' /subscribe)", () => {
    expect(() => pageMetadata(site, { path: "", title: "Subscribe" })).toThrow(SeoError);
    expect(() => pageMetadata(site, { title: "Subscribe" } as never)).toThrow(/path is required/);
  });

  it("drops campaign parameters and the fragment, keeps real query parameters", () => {
    const meta = pageMetadata(site, { path: "/templates?type=bridal&utm_source=x&gclid=1&fbclid=2#top", title: "Bridal" });
    expect(meta.alternates.canonical).toBe("https://riddlergo.com/templates?type=bridal");
  });

  it("follows the site's trailing-slash rule, and the homepage is the origin with a slash", () => {
    expect(pageMetadata(site, { path: "/pricing/", title: "P" }).alternates.canonical).toBe("https://riddlergo.com/pricing");
    const slashed = defineSite({ ...SITE_INPUT, trailingSlash: true });
    expect(pageMetadata(slashed, { path: "/pricing", title: "P" }).alternates.canonical).toBe("https://riddlergo.com/pricing/");
    expect(pageMetadata(slashed, { path: "/feed.xml", title: "Feed" }).alternates.canonical).toBe("https://riddlergo.com/feed.xml");
    expect(pageMetadata(site, { path: "/", title: "Riddler Go" }).alternates.canonical).toBe("https://riddlergo.com/");
  });

  it("refuses a canonical on another host: pointing off-site is a decision, not a fallback", () => {
    expect(() => pageMetadata(site, { path: "https://www.riddlergo.com/pricing", title: "P" })).toThrow(/not on https:\/\/riddlergo.com/);
    expect(pageMetadata(site, { path: "https://riddlergo.com/pricing", title: "P" }).alternates.canonical).toBe("https://riddlergo.com/pricing");
  });
});

describe("brand suffix: once", () => {
  it("appends the brand to a plain title, as an absolute title a layout template cannot touch", () => {
    expect(pageMetadata(site, { path: "/pricing", title: "Pricing" }).title).toEqual({ absolute: "Pricing | Riddler Go" });
  });

  it("never doubles it: every shape that shipped doubled on trailcards or Riddler Go", () => {
    expect(brandTitle(site, "Pricing — Riddler Go")).toBe("Pricing — Riddler Go");
    expect(brandTitle(site, "Pricing | Riddler Go | Riddler Go")).toBe("Pricing | Riddler Go");
    expect(brandTitle(site, "Templates · riddler go")).toBe("Templates · riddler go");
    expect(brandTitle(site, "Riddler Go — puzzle events | Riddler Go")).toBe("Riddler Go — puzzle events");
    expect(brandTitle(site, "Riddler Go vs GooseChase")).toBe("Riddler Go vs GooseChase");
    const traildek = defineSite({ url: "https://traildek.com", name: "Traildek", indexable: true, description: "d" });
    expect(brandTitle(traildek, "All Trail Decks | Traildek")).toBe("All Trail Decks | Traildek");
    expect(brandTitle(traildek, "Traildek — The Trail Atlas Series | Traildek")).toBe("Traildek — The Trail Atlas Series");
  });

  it("matches the brand as a whole word only", () => {
    const go = defineSite({ url: "https://go.dev", name: "Go", indexable: true, description: "d" });
    expect(brandTitle(go, "Gopher facts")).toBe("Gopher facts | Go");
    expect(brandTitle(go, "Learn Go fast")).toBe("Learn Go fast");
  });

  it("does not count a hyphenated word as the brand: Go-Kart Racing does not name Go", () => {
    const go = defineSite({ url: "https://go.dev", name: "Go", indexable: true, description: "d" });
    expect(brandTitle(go, "Go-Kart Racing")).toBe("Go-Kart Racing | Go");
    expect(brandTitle(go, "A go-to guide")).toBe("A go-to guide | Go");
    expect(brandTitle(go, "Pricing - Go")).toBe("Pricing - Go");
    expect(brandTitle(site, "Riddler Go's templates")).toBe("Riddler Go's templates");
  });

  it("uses the site's separator, collapses whitespace, and can be switched off", () => {
    const dot = defineSite({ ...SITE_INPUT, titleSeparator: " · " });
    expect(brandTitle(dot, "  How   it\nworks ")).toBe("How it works · Riddler Go");
    expect(pageMetadata(site, { path: "/", title: "Puzzle events for any occasion", brand: false }).title.absolute).toBe("Puzzle events for any occasion");
  });
});

describe("Open Graph and Twitter: always merged with the site defaults", () => {
  it("re-states site name, locale, URL and the default share image on a page with no image (Riddler Go /pricing lost it)", () => {
    const meta = pageMetadata(site, { path: "/pricing", title: "Pricing", description: "Plans for every event." });
    expect(meta.openGraph).toEqual({
      type: "website",
      url: "https://riddlergo.com/pricing",
      title: "Pricing | Riddler Go",
      description: "Plans for every event.",
      siteName: "Riddler Go",
      locale: "en_US",
      images: [{ url: "https://riddlergo.com/opengraph-image", width: 1200, height: 630, alt: "Riddler Go: puzzle events" }],
    });
    expect(meta.twitter).toEqual({
      card: "summary_large_image",
      title: "Pricing | Riddler Go",
      description: "Plans for every event.",
      images: meta.openGraph.images,
      site: "@riddlergo",
    });
  });

  it("uses the page's own image when given, absolute, with the title as alt text", () => {
    const meta = pageMetadata(site, { path: "/templates/bridal", title: "Bridal shower hunt", image: "/templates/bridal/opengraph-image" });
    expect(meta.openGraph.images).toEqual([{ url: "https://riddlergo.com/templates/bridal/opengraph-image", alt: "Bridal shower hunt | Riddler Go" }]);
    expect(meta.twitter.images).toEqual(meta.openGraph.images);
  });

  it("falls back to the site description, and requires one when there is none", () => {
    expect(pageMetadata(site, { path: "/join", title: "Join" }).description).toBe(SITE_INPUT.description);
    expect(pageMetadata(site, { path: "/join", title: "Join", description: "  " }).description).toBe(SITE_INPUT.description);
    const bare = defineSite({ url: "https://x.example.com", name: "X", indexable: true });
    expect(() => pageMetadata(bare, { path: "/", title: "Home" })).toThrow(/description is required/);
  });

  it("writes article times as ISO strings and author paths as URLs", () => {
    const meta = pageMetadata(site, {
      path: "/blog/launch",
      title: "Launch",
      type: "article",
      article: { publishedTime: "2026-10-01", modifiedTime: new Date("2026-10-05T10:00:00Z"), authors: ["/team/dallin"], tags: ["launch"] },
    });
    expect(meta.openGraph).toMatchObject({
      type: "article",
      publishedTime: "2026-10-01",
      modifiedTime: "2026-10-05T10:00:00.000Z",
      authors: ["https://riddlergo.com/team/dallin"],
      tags: ["launch"],
    });
  });

  it("refuses an article time with no time zone, which each server would read in its own zone", () => {
    expect(() => pageMetadata(site, { path: "/blog/x", title: "X", type: "article", article: { publishedTime: "2026-10-01T09:00" } })).toThrow(
      /article.publishedTime has no time zone/,
    );
    expect(pageMetadata(site, { path: "/blog/x", title: "X", type: "article", article: { publishedTime: "2026-10-01T09:00:00-06:00" } }).openGraph).toMatchObject({
      publishedTime: "2026-10-01T09:00:00-06:00",
    });
  });

  it("uses a summary card when the site has no image at all", () => {
    const bare = defineSite({ url: "https://x.example.com", name: "X", indexable: true, description: "d" });
    const meta = pageMetadata(bare, { path: "/", title: "Home" });
    expect(meta.twitter.card).toBe("summary");
    expect(meta.openGraph.images).toEqual([]);
  });
});

describe("noindex: one switch, plus the path list and the deployment", () => {
  it("indexes a public page with large previews and full snippets", () => {
    expect(pageMetadata(site, { path: "/pricing", title: "P" }).robots).toEqual({
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
      googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
    });
  });

  it("noindexes on request, following links unless told not to", () => {
    expect(pageMetadata(site, { path: "/thanks", title: "T", noindex: true }).robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });
    expect(pageMetadata(site, { path: "/thanks", title: "T", noindex: { follow: false } }).robots.follow).toBe(false);
  });

  it("noindexes a path the list calls noindex or private, whatever the page asked for", () => {
    expect(pageMetadata(site, { path: "/sign-in", title: "Sign in" }).robots.index).toBe(false);
    expect(pageMetadata(site, { path: "/dashboard/events", title: "Events" }).robots).toEqual({ index: false, follow: false, googleBot: { index: false, follow: false } });
    expect(pageMetadata(site, { path: "/elm-street-church/spring-hunt", title: "Spring hunt" }).robots.index).toBe(true);
    expect(pageMetadata(site, { path: "/join", title: "Join" }).robots.index).toBe(true);
  });

  it("noindexes everything off production, and asks caches to drop it", () => {
    const meta = pageMetadata(staging, { path: "/pricing", title: "Pricing" });
    expect(meta.robots).toEqual({ index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } });
    expect(meta.alternates.canonical).toBe("https://staging.riddlergo.com/pricing");
  });
});

describe("alternates", () => {
  it("makes language and type alternates absolute", () => {
    const meta = pageMetadata(site, {
      path: "/",
      title: "Home",
      alternates: { languages: { "en-US": "/", es: "/es", "x-default": "/" }, types: { "application/rss+xml": "/feed.xml" } },
    });
    expect(meta.alternates).toEqual({
      canonical: "https://riddlergo.com/",
      languages: { "en-US": "https://riddlergo.com/", es: "https://riddlergo.com/es", "x-default": "https://riddlergo.com/" },
      types: { "application/rss+xml": "https://riddlergo.com/feed.xml" },
    });
  });
});

describe("siteMetadata: the root layout's defaults", () => {
  it("has a title template and NO canonical or og:url for pages to inherit", () => {
    const meta = siteMetadata(site, { homeTitle: "Riddler Go — puzzle events for any occasion" });
    expect(meta.title).toEqual({ default: "Riddler Go — puzzle events for any occasion", template: "%s | Riddler Go" });
    expect(meta.metadataBase.href).toBe("https://riddlergo.com/");
    expect(meta).not.toHaveProperty("alternates");
    expect(meta.openGraph).not.toHaveProperty("url");
    expect(meta.openGraph.images[0]?.url).toBe("https://riddlergo.com/opengraph-image");
    expect(meta.robots.index).toBe(true);
    expect(siteMetadata(staging).robots.index).toBe(false);
  });
});

describe("defineSite", () => {
  it("refuses a URL with a path, a missing indexable decision and an empty name", () => {
    expect(() => defineSite({ url: "https://x.com/app", name: "X", indexable: true })).toThrow(/base paths are not supported/);
    expect(() => defineSite({ url: "x.com", name: "X", indexable: true })).toThrow(/absolute http/);
    expect(() => defineSite({ url: "https://x.com", name: " ", indexable: true })).toThrow(/name is required/);
    expect(() => defineSite({ url: "https://x.com", name: "X" } as never)).toThrow(/indexable is required/);
  });

  it("names the CI fallback when the URL is missing, and that fallback is a valid, never-indexable site", () => {
    expect(() => defineSite({ url: undefined as never, name: "X", indexable: false })).toThrow(/NEXT_PUBLIC_APP_URL \?\? "http:\/\/localhost:3000"/);
    const env: { NEXT_PUBLIC_APP_URL?: string } = {};
    const ci = defineSite({ url: env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000", name: "X", indexable: isIndexable({ env: "production", host: env.NEXT_PUBLIC_APP_URL }) });
    expect(ci.indexable).toBe(false);
  });

  it("checks a path list passed as plain input, even a frozen one", () => {
    expect(() => defineSite({ ...SITE_INPUT, paths: Object.freeze({ private: ["/_next/"] }) })).toThrow(/_next/);
    expect(defineSite({ ...SITE_INPUT, paths: { private: ["/admin/"] } }).paths.private).toEqual(["/admin"]);
  });

  it("refuses a default share image under a private path (Twitterbot obeys robots.txt)", () => {
    expect(() => defineSite({ ...SITE_INPUT, image: "/api/og" })).toThrow(/private path/);
  });

  it("normalises Twitter handles and keeps the origin without a trailing slash", () => {
    const s = defineSite({ ...SITE_INPUT, url: "https://riddlergo.com/", twitter: { site: "@riddlergo", creator: "dallin" } });
    expect(s.url).toBe("https://riddlergo.com");
    expect(s.twitter).toEqual({ site: "@riddlergo", creator: "@dallin" });
    expect(s.language).toBe("en-US");
  });
});

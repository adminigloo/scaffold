import type { Metadata, MetadataRoute } from "next";
import { describe, expect, it } from "vitest";
import { pageMetadata, pathEntries, robotsPolicy, siteMetadata, sitemapEntries, toNextSitemap } from "../index.js";
import { site } from "./fixtures.js";

/**
 * The package has no runtime dependency on Next, but its objects are what
 * Next's metadata files return. These assignments are checked by `tsc`
 * (`pnpm typecheck` covers the tests): if Next's types and ours drift apart,
 * the typecheck fails here, not in an app.
 */
describe("assignable to Next's own types", () => {
  it("pageMetadata and siteMetadata are Metadata (website and article pages)", () => {
    const page: Metadata = pageMetadata(site, {
      path: "/pricing",
      title: "Pricing",
      alternates: { languages: { "en-US": "/pricing", "x-default": "/pricing" } },
    });
    const post: Metadata = pageMetadata(site, { path: "/blog/x", title: "X", type: "article", article: { publishedTime: "2026-10-01" } });
    const root: Metadata = siteMetadata(site);
    expect([page.title, post.openGraph && "type" in post.openGraph ? post.openGraph.type : null, root.title]).toEqual([
      { absolute: "Pricing | Riddler Go" },
      "article",
      { default: "Riddler Go", template: "%s | Riddler Go" },
    ]);
  });

  it("robotsPolicy is MetadataRoute.Robots and toNextSitemap is MetadataRoute.Sitemap", () => {
    const robots: MetadataRoute.Robots = robotsPolicy(site);
    const sitemap: MetadataRoute.Sitemap = toNextSitemap(sitemapEntries(site, pathEntries(site)));
    expect(Array.isArray(robots.rules)).toBe(true);
    expect(sitemap[0]?.url).toBe("https://riddlergo.com/");
  });
});

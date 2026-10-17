import { describe, expect, it } from "vitest";
import {
  definePaths,
  defineSite,
  graph,
  isAllowedByRobots,
  localBusiness,
  pageMetadata,
  pageUrl,
  pathRule,
  robotsHeader,
  robotsPolicy,
  robotsTxt,
  SeoError,
  serializeJsonLd,
  sitemapEntries,
  webPage,
} from "../index.js";

/**
 * 0.2: EVERY COMPANY'S PUBLIC PAGES ON ONE SITE — a platform where each
 * business has /t/{web address} (its home, its estimate and booking pages)
 * and token pages behind its emails (/t/{web address}/quote/{token}). The
 * path list says "any company's quote pages" with a whole-segment `*`, so
 * robots.txt, the noindex header and the sitemap agree; and each company's
 * page carries its own LocalBusiness, even before it has entered an address.
 */

const paths = definePaths({
  public: ["/", "/pricing"],
  private: ["/admin", "/app", "/api", "/t/*/quote", "/t/*/visit", "/t/*/invoice"],
  noindex: ["/sign-in"],
});
const site = defineSite({ url: "https://lawnco.com", name: "Lawnco", indexable: true, paths });

describe("a whole-segment * in the path list", () => {
  it("covers every company's token pages and nothing else", () => {
    expect(pathRule(paths, "/t/green-acres/quote/abc123")).toBe("private");
    expect(pathRule(paths, "/t/summit/visit/xyz")).toBe("private");
    expect(pathRule(paths, "/t/summit/invoice")).toBe("private");
    expect(pathRule(paths, "/t/green-acres")).toBe("unlisted");
    expect(pathRule(paths, "/t/green-acres/estimate")).toBe("unlisted");
    expect(pathRule(paths, "/t/quote")).toBe("unlisted");
    expect(robotsHeader(site, "/t/green-acres/quote/abc")).toBe("noindex, nofollow");
    expect(robotsHeader(site, "/t/green-acres/book-visit")).toBeNull();
  });

  it("is written into robots.txt so a crawler skips the token pages and reads the rest", () => {
    const text = robotsTxt(robotsPolicy(site));
    expect(text).toContain("Disallow: /t/*/quote/");
    expect(text).toContain("Disallow: /t/*/quote$");
    expect(isAllowedByRobots(text, "Googlebot", "/t/green-acres/quote/abc")).toBe(false);
    expect(isAllowedByRobots(text, "Googlebot", "/t/green-acres")).toBe(true);
    expect(isAllowedByRobots(text, "Googlebot", "/t/green-acres/estimate")).toBe(true);
    expect(isAllowedByRobots(text, "GPTBot", "/t/green-acres/visit/x")).toBe(false);
  });

  it("refuses a * inside a segment or as the first segment, and in a public path", () => {
    for (const bad of ["/t/a*/quote", "/*/quote", "/t/*x"]) {
      expect(() => definePaths({ private: [bad] }), bad).toThrow(SeoError);
    }
    expect(() => definePaths({ public: ["/t/*"] })).toThrow(SeoError);
    // A company's quote page can't be listed as public under the * rule.
    expect(() => definePaths({ public: ["/t/acme/quote"], private: ["/t/*/quote"] })).toThrow(/inside/);
  });

  it("keeps a company's token pages out of the sitemap and its other pages in", () => {
    const entries = sitemapEntries(
      site,
      [
        { url: "/t/green-acres", lastModified: null },
        { url: "/t/green-acres/estimate", lastModified: null },
        { url: "/t/green-acres/quote/abc", lastModified: null },
      ],
      { onInvalid: () => {} },
    );
    expect(entries.map((entry) => entry.url)).toEqual(["https://lawnco.com/t/green-acres", "https://lawnco.com/t/green-acres/estimate"]);
  });
});

describe("a company's page on the platform", () => {
  it("has its own canonical, title and LocalBusiness — not the platform's", () => {
    const meta = pageMetadata(site, { path: "/t/green-acres", title: "Green Acres", description: "Lawn care in Boise.", brand: false });
    expect(meta.alternates.canonical).toBe("https://lawnco.com/t/green-acres");
    expect(meta.title).toEqual({ absolute: "Green Acres" });
    const node = localBusiness(site, {
      id: `${pageUrl(site, "/t/green-acres")}#business`,
      url: pageUrl(site, "/t/green-acres"),
      name: "Green Acres",
      telephone: "+1 208 555 0100",
      address: { streetAddress: "1 Main St", addressLocality: "Boise", addressRegion: "ID", postalCode: "83702", addressCountry: "US" },
      parentOrganization: false,
    });
    expect(node).toMatchObject({ "@type": "LocalBusiness", "@id": "https://lawnco.com/t/green-acres#business", name: "Green Acres", url: "https://lawnco.com/t/green-acres" });
    expect(node).not.toHaveProperty("parentOrganization");
    const doc = graph(webPage(site, { path: "/t/green-acres", name: "Green Acres" }), node);
    expect(serializeJsonLd(doc)).toContain('"LocalBusiness"');
  });

  it("names a business with no address yet when it is not offered as a rich result", () => {
    expect(() => localBusiness(site, { name: "Summit", url: "https://lawnco.com/t/summit" })).toThrow(/address is required/);
    const node = localBusiness(site, { name: "Summit", url: "https://lawnco.com/t/summit", email: "hi@summitlawn.com", richResult: false, parentOrganization: false });
    expect(node).toMatchObject({ "@type": "LocalBusiness", name: "Summit", email: "hi@summitlawn.com" });
    expect(node).not.toHaveProperty("address");
  });
});

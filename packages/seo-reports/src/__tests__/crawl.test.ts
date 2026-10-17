import { describe, expect, it } from "vitest";
import { runSiteCheck, type SiteCheckResult } from "../crawl.js";
import { fakeNetwork, html, type FakePage } from "./fake-network.js";

/**
 * A WHOLE SEARCH CHECK (0.2) against a fake site: the new checks (main
 * address, X-Robots-Tag, noindex, duplicate titles, broken links, llms.txt),
 * the fixed robots reading in the report, a company's pages under a path on
 * a shared site, and the caps — with the network a table.
 */

const TEXT = { "content-type": "text/plain" };

function siteOf(extra: Record<string, FakePage> = {}): Record<string, FakePage> {
  return {
    "https://greenacres.com/robots.txt": { headers: TEXT, body: "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nSitemap: https://greenacres.com/sitemap.xml" },
    "https://greenacres.com/llms.txt": { headers: TEXT, body: "# Green Acres\n- /prices" },
    "https://greenacres.com/sitemap.xml": {
      headers: { "content-type": "application/xml" },
      body: "<urlset><url><loc>https://greenacres.com/</loc></url><url><loc>https://greenacres.com/prices</loc></url><url><loc>https://elsewhere.example/x</loc></url></urlset>",
    },
    "https://greenacres.com/": {
      body: html({
        title: "Green Acres lawn care in Raleigh",
        description: "Weekly mowing, edging and spring clean-ups across Raleigh, with prices up front and no contracts.",
        canonical: "https://greenacres.com/",
        body: '<a href="/prices">Prices</a> <a href="/about">About</a> <a href="/gone">Old page</a> <a href="https://elsewhere.example/">Partner</a> <a href="/menu.pdf">Menu</a>',
      }),
    },
    "https://greenacres.com/prices": {
      body: html({ title: "Green Acres lawn care in Raleigh", description: "Prices for mowing and clean-ups.", canonical: "https://greenacres.com/" }),
    },
    "https://greenacres.com/about": {
      headers: { "x-robots-tag": "noindex, nofollow" },
      body: html({ title: "About Green Acres", head: '<meta name="robots" content="noindex">' }),
    },
    ...extra,
  };
}

function find(result: SiteCheckResult, id: string, path?: string) {
  if (path === undefined) return result.siteChecks.find((c) => c.id === id);
  return result.pages.find((p) => p.path === path)?.checks.find((c) => c.id === id);
}

describe("runSiteCheck", () => {
  it("reads the company's site and names every problem with its evidence", async () => {
    const net = fakeNetwork(siteOf());
    const result = await runSiteCheck({ targets: [{ label: "Our website", baseUrl: "https://greenacres.com" }], ...net });
    expect(result.pages.map((p) => p.path).sort()).toEqual(["/", "/about", "/gone", "/prices"]);
    // Only the company's own host was ever asked for.
    expect(net.requests.every((r) => new URL(r.url).hostname === "greenacres.com")).toBe(true);
    // The 0.1 false pass: GPTBot and ClaudeBot share a blocked group.
    const ai = find(result, "site.ai-crawlers");
    expect(ai?.status).toBe("warn");
    expect(ai?.detail).toContain("ChatGPT's reader (GPTBot)");
    expect(ai?.detail).toContain("ClaudeBot");
    expect(ai?.detail).not.toContain("PerplexityBot");
    expect(find(result, "site.search-crawlers")?.status).toBe("pass");
    expect(find(result, "site.llms-txt")?.status).toBe("pass");
    expect(find(result, "site.sitemap")?.status).toBe("pass");
    // Main address: the home page names itself; /prices names the home page.
    expect(find(result, "page.canonical", "/")?.status).toBe("pass");
    expect(find(result, "page.canonical", "/prices")?.status).toBe("warn");
    // noindex, both ways.
    expect(find(result, "page.noindex", "/about")?.status).toBe("fail");
    expect(find(result, "page.x-robots-tag", "/about")?.status).toBe("fail");
    expect(find(result, "page.x-robots-tag", "/")?.status).toBe("pass");
    // Two pages, one title.
    const dup = find(result, "site.duplicate-titles");
    expect(dup?.status).toBe("warn");
    expect(dup?.detail).toContain("/prices");
    // A link from the home page to a page that isn't there.
    const broken = find(result, "site.broken-links");
    expect(broken?.status).toBe("fail");
    expect(broken?.detail).toContain("/ links to /gone (404)");
    expect(result.stopped).toBeNull();
    expect(result.counts.fail).toBeGreaterThan(0);
  });

  it("fails a missing llms.txt, and a site that keeps Google out", async () => {
    const pages = siteOf({ "https://greenacres.com/robots.txt": { headers: TEXT, body: "User-agent: *\nDisallow: /" } });
    delete pages["https://greenacres.com/llms.txt"];
    const result = await runSiteCheck({ targets: [{ label: "Our website", baseUrl: "https://greenacres.com" }], ...fakeNetwork(pages) });
    expect(find(result, "site.llms-txt")?.status).toBe("fail");
    expect(find(result, "site.search-crawlers")?.status).toBe("fail");
  });

  it("doesn't take a catch-all HTML page for llms.txt", async () => {
    const result = await runSiteCheck({
      targets: [{ label: "Our website", baseUrl: "https://greenacres.com" }],
      ...fakeNetwork(siteOf({ "https://greenacres.com/llms.txt": { body: "<!doctype html><html><body>Not found</body></html>" } })),
    });
    expect(find(result, "site.llms-txt")?.status).toBe("fail");
  });

  it("reads only a company's pages under its path on a shared site, and doesn't score the site's own files", async () => {
    const net = fakeNetwork({
      "https://app.example/robots.txt": { headers: TEXT, body: "User-agent: *\nAllow: /" },
      "https://app.example/sitemap.xml": {
        headers: { "content-type": "application/xml" },
        body: "<urlset><url><loc>https://app.example/t/green-acres</loc></url><url><loc>https://app.example/t/green-acres/estimate</loc></url><url><loc>https://app.example/t/summit</loc></url></urlset>",
      },
      "https://app.example/t/green-acres": { body: html({ title: "Green Acres on App", description: "x".repeat(80), body: '<a href="/t/summit">A neighbour</a> <a href="/t/green-acres/estimate">Estimate</a>' }) },
      "https://app.example/t/green-acres/estimate": { body: html({ title: "Get an estimate from Green Acres", description: "y".repeat(80) }) },
      "https://app.example/t/summit": { body: html({ title: "Summit — must never be read for Green Acres" }) },
    });
    const result = await runSiteCheck({ targets: [{ label: "Your pages", baseUrl: "https://app.example", pathPrefix: "/t/green-acres" }], ...net });
    expect(result.pages.map((p) => p.path).sort()).toEqual(["/t/green-acres", "/t/green-acres/estimate"]);
    expect(net.requests.some((r) => r.url.includes("/t/summit"))).toBe(false);
    // Only the company's own pages and the host's own files were ever asked for.
    expect(net.requests.every((r) => /\/t\/green-acres|\/robots\.txt$|\/sitemap\.xml$/.test(r.url))).toBe(true);
    expect(net.requests.some((r) => r.url.endsWith("/llms.txt"))).toBe(false);
    expect(find(result, "site.robots")).toBeUndefined();
    expect(find(result, "site.sitemap")?.status).toBe("pass");
  });

  it("records a link that moves to another site instead of following it", async () => {
    const net = fakeNetwork(
      siteOf({
        "https://greenacres.com/": { body: html({ title: "Green Acres lawn care in Raleigh", body: '<a href="/shop">Shop</a>' }) },
        "https://greenacres.com/shop": { status: 302, headers: { location: "https://shop-platform.example/greenacres" } },
      }),
    );
    const result = await runSiteCheck({ targets: [{ label: "Our website", baseUrl: "https://greenacres.com" }], ...net });
    expect(find(result, "site.moved-away")?.detail).toContain("/shop → https://shop-platform.example/greenacres");
    expect(net.requests.some((r) => r.url.includes("shop-platform"))).toBe(false);
  });

  it("refuses a company address that resolves to a private network, and says why", async () => {
    const result = await runSiteCheck({
      targets: [{ label: "Our website", baseUrl: "https://greenacres.com" }],
      ...fakeNetwork(siteOf(), { "greenacres.com": ["192.168.0.10"] }),
    });
    expect(find(result, "page.fetch", "/")?.detail).toContain("private network");
  });

  it("stops at the page cap and says so; shares it between addresses", async () => {
    const pages: Record<string, FakePage> = {};
    for (const host of ["a.example", "b.example"]) {
      const links = Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("");
      pages[`https://${host}/`] = { body: html({ title: `Home of ${host} site`, body: links }) };
      for (let i = 0; i < 20; i += 1) pages[`https://${host}/p${i}`] = { body: html({ title: `Page ${i} of ${host}` }) };
    }
    const result = await runSiteCheck({
      targets: [
        { label: "A", baseUrl: "https://a.example" },
        { label: "B", baseUrl: "https://b.example" },
      ],
      ...fakeNetwork(pages),
      limits: { maxPages: 10 },
    });
    expect(result.pageCount).toBe(10);
    expect(result.pages.filter((p) => p.url?.includes("b.example")).length).toBe(5);
    expect(result.stopped).toBe("pages");
    expect(find(result, "site.crawl-cap")?.status).toBe("warn");
  });

  it("stops at the time cap", async () => {
    const slow = fakeNetwork(siteOf());
    const result = await runSiteCheck({
      targets: [{ label: "Our website", baseUrl: "https://greenacres.com" }],
      resolve: slow.resolve,
      transport: async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return slow.transport(req);
      },
      limits: { totalTimeMs: 60 },
    });
    expect(result.stopped).toBe("time");
  });

  it("refuses to run with no address", async () => {
    await expect(runSiteCheck({ targets: [] })).rejects.toThrow(/no web address/);
    await expect(runSiteCheck({ targets: [{ label: "x", baseUrl: "ftp://greenacres.com" }] })).rejects.toThrow(/no web address/);
  });
});

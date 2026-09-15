import { describe, expect, it } from "vitest";
import { AI_CRAWLERS, auditPage, robotsBlocks, runSeoReport } from "../index.js";

const GOOD_PAGE = `<!doctype html><html><head>
<title>Feedback that fixes itself — adminigloo</title>
<meta name="description" content="Customer feedback with screenshots, click trails and browser errors attached, triaged on a board your team already understands.">
<link rel="canonical" href="https://example.com/">
<meta property="og:title" content="adminigloo">
<meta property="og:image" content="https://example.com/og.png">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"adminigloo"}</script>
</head><body>
<h1>Admin features your app is missing</h1>
<h2>The feedback loop</h2><h2>Three ways to buy</h2>
<img src="/board.png" alt="The triage board">
</body></html>`;

const BAD_PAGE = `<html><head><meta name="robots" content="noindex"></head><body>
<h1>One</h1><h1>Two</h1>
<img src="/naked.png">
<script type="application/ld+json">{not json</script>
</body></html>`;

function statusOf(page: ReturnType<typeof auditPage>, id: string) {
  return page.checks.find((c) => c.id === id)?.status;
}

describe("auditPage", () => {
  it("passes a well-formed page on every check", () => {
    const page = auditPage("/", GOOD_PAGE);
    for (const c of page.checks) {
      expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    }
  });

  it("names each defect on a hostile page, and never false-passes", () => {
    const page = auditPage("/bad", BAD_PAGE);
    expect(statusOf(page, "page.title")).toBe("fail");
    expect(statusOf(page, "page.description")).toBe("fail");
    expect(statusOf(page, "page.h1")).toBe("warn");
    expect(statusOf(page, "page.robots")).toBe("warn");
    expect(statusOf(page, "page.img-alt")).toBe("warn");
    // Present-but-broken JSON-LD is a warn, not a pass — the block exists,
    // the machine-readability it promises does not.
    expect(statusOf(page, "page.structured-data")).toBe("warn");
  });

  it("treats an image-free page as passing alt coverage", () => {
    const page = auditPage("/text", "<html><head><title>A perfectly reasonable title</title></head><body><h1>x</h1></body></html>");
    expect(statusOf(page, "page.img-alt")).toBe("pass");
  });
});

describe("robotsBlocks", () => {
  it("reads a full disallow under a matching agent", () => {
    const txt = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:";
    expect(robotsBlocks(txt, "GPTBot")).toBe(true);
    expect(robotsBlocks(txt, "ClaudeBot")).toBe(false);
  });

  it("reads a wildcard disallow as blocking everyone", () => {
    const txt = "User-agent: *\nDisallow: /";
    for (const agent of AI_CRAWLERS) expect(robotsBlocks(txt, agent)).toBe(true);
  });

  it("path-scoped disallows do not count as blocked", () => {
    expect(robotsBlocks("User-agent: *\nDisallow: /admin", "GPTBot")).toBe(false);
  });
});

describe("runSeoReport", () => {
  /** A whole site served from a map — the crawl with the network removed. */
  function siteFetch(routes: Record<string, string>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      const body = routes[path];
      return body === undefined
        ? new Response("", { status: 404 })
        : new Response(body, { status: 200 });
    }) as typeof fetch;
  }

  const ROUTES = {
    "/robots.txt": "User-agent: *\nDisallow:",
    "/llms.txt": "# adminigloo\n- /: the offer",
    "/sitemap.xml": `<urlset><url><loc>https://example.com/</loc></url><url><loc>https://example.com/bad</loc></url><url><loc>https://elsewhere.com/x</loc></url></urlset>`,
    "/": GOOD_PAGE,
    "/bad": BAD_PAGE,
  };

  it("crawls the sitemap, same-origin only, and scores both halves", async () => {
    const report = await runSeoReport({
      baseUrl: "https://example.com",
      fetchImpl: siteFetch(ROUTES),
    });
    // The foreign origin in the sitemap must not be crawled.
    expect(report.pages.map((p) => p.path)).toEqual(["/", "/bad"]);
    expect(report.pageCount).toBe(2);
    // A perfect page plus a hostile one: both scores strictly between the poles.
    expect(report.seoScore).toBeGreaterThan(0);
    expect(report.seoScore).toBeLessThan(100);
    expect(report.aeoScore).toBeGreaterThan(0);
    expect(report.aeoScore).toBeLessThan(100);
    expect(report.score).toBe(Math.round((report.seoScore + report.aeoScore) / 2));
    // Site-level truths.
    const ids = report.siteChecks.map((c) => `${c.id}:${c.status}`);
    expect(ids).toContain("site.robots:pass");
    expect(ids).toContain("site.llms-txt:pass");
    expect(ids).toContain("site.sitemap:pass");
    expect(ids).toContain("site.ai-crawlers:pass");
  });

  it("fails llms.txt when absent and records a sitemap-listed page that 404s", async () => {
    const { "/llms.txt": _omitted, "/bad": _gone, ...rest } = ROUTES;
    const report = await runSeoReport({
      baseUrl: "https://example.com",
      fetchImpl: siteFetch(rest),
    });
    expect(report.siteChecks.find((c) => c.id === "site.llms-txt")?.status).toBe("fail");
    const bad = report.pages.find((p) => p.path === "/bad");
    expect(bad?.checks[0]?.id).toBe("page.fetch");
    expect(bad?.checks[0]?.status).toBe("fail");
  });

  it("caps the crawl and says so instead of silently sampling", async () => {
    const locs = Array.from({ length: 5 }, (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`);
    const routes: Record<string, string> = {
      ...ROUTES,
      "/sitemap.xml": `<urlset>${locs.join("")}</urlset>`,
    };
    for (let i = 0; i < 5; i++) routes[`/p${i}`] = GOOD_PAGE;
    const report = await runSeoReport({
      baseUrl: "https://example.com",
      fetchImpl: siteFetch(routes),
      maxPages: 2,
    });
    expect(report.pageCount).toBe(2);
    expect(report.siteChecks.find((c) => c.id === "site.crawl-cap")?.status).toBe("warn");
  });
});

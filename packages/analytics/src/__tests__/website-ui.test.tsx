import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEACON_SCRIPT, websiteSnippet } from "../beacon-script.js";
import { createAnalyticsTransport, WebsitesSettings, WebsiteTraffic } from "../dashboard.js";
import type { Metric } from "../reports.js";
import type { WebsiteReportWire, WebsitesWire } from "../wire.js";

/**
 * The drop-in screens on the server (the first paint of every page) and the
 * snippet's script in a stand-in browser. The interactive flows — the range,
 * the website filter, "count everyone", adding a website — run in a real
 * browser at a phone's width and a laptop's (the generated project's check).
 */

const metric = (current: number, prior = 0): Metric => ({ current, prior, deltaPct: null, priorPartial: true, smallSample: current < 30 });

const REPORT: WebsiteReportWire = {
  version: "v1",
  range: { days: 30, from: "2026-09-09T06:00:00.000Z", to: "2026-10-09T06:00:00.000Z", timeZone: "America/Denver" },
  site: "all",
  websites: [{ id: "w1", name: "Green Acres" }],
  ownPagesLabel: "Your pages on Lawnco",
  includeInternal: false,
  trackingSince: "2026-09-01T00:00:00.000Z",
  overview: {
    visits: metric(42),
    dailyVisitors: metric(37),
    pageViews: metric(96),
    engagedVisits: metric(20),
    conversions: metric(3),
    engagedRate: 47.6,
    avgEngagedMs: 31_000,
    pagesPerVisit: 2.3,
  },
  trend: [{ date: "2026-10-08", visits: 4, dailyVisitors: 4, pageViews: 9, engaged: 2, aiCrawlerHits: 1 }],
  sources: [
    { source: "organic", visits: 20, prior: 0, deltaPct: null, engagedRate: 50 },
    { source: "aiAssistant", visits: 6, prior: 0, deltaPct: null, engagedRate: 66 },
  ],
  searchEngines: [{ host: "google.com", visits: 18 }],
  referrers: [{ host: "yelp.com", source: "referral", visits: 4 }],
  ai: { visits: 6, engines: [{ engine: "chatgpt", label: "ChatGPT", visits: 5, engagedRate: 60, conversions: 1, assistantFetches: 2, assistantFetchesVerified: 1 }] },
  topPages: [{ path: "/spring-cleanup", views: 30, visits: 22 }],
  crawlers: { bots: [], byKind: { "ai-assistant": 0, "ai-search": 0, "ai-training": 0, search: 0, social: 0, "seo-tool": 0, other: 0 }, aiHits: 0, aiVerifiedHits: 0, topPaths: [] },
  excluded: { total: 12, byReason: { role: 10, automation: 2 }, unit: "sessions", sentence: "Left out: 12 visits (your team 10, automation 2)." },
  health: { trackingSince: null, lastPageView: null, lastEvent: null, lastWebVital: null, lastConversion: null, lastCrawlerHit: null, lastAiCrawlerHit: null },
};

const never = { report: () => new Promise<WebsiteReportWire>(() => {}) };

describe("<WebsiteTraffic>", () => {
  it("draws the server's report on first paint: numbers, sources, search, AI assistants, pages and the left-out line", () => {
    const html = renderToStaticMarkup(<WebsiteTraffic transport={never} initial={REPORT} />);
    for (const text of [
      "Website visits",
      "Left out: 12 visits (your team 10, automation 2).",
      "Count everyone",
      "42",
      "Where visits came from",
      "google.com",
      "ChatGPT",
      "/spring-cleanup",
      "yelp.com",
      "AI crawlers and search engines reading your pages",
      "All websites",
      "Your pages on Lawnco",
      "Green Acres",
    ]) {
      expect(html, text).toContain(text.replace(/&/g, "&amp;"));
    }
  });

  it("says it is counting everyone when asked, and has no left-out line without an audience", () => {
    const counting = renderToStaticMarkup(<WebsiteTraffic transport={never} initial={{ ...REPORT, includeInternal: true, excluded: null }} />);
    expect(counting).toContain("Counting everyone");
    expect(counting).toContain("Leave them out again");
    const none = renderToStaticMarkup(<WebsiteTraffic transport={never} initial={{ ...REPORT, excluded: null }} />);
    expect(none).not.toContain("Left out");
  });

  it("explains that a website of the company's own can't see crawlers", () => {
    const html = renderToStaticMarkup(<WebsiteTraffic transport={never} initial={{ ...REPORT, site: "w1" }} />);
    expect(html).toContain("Crawlers don&#x27;t run the snippet");
  });
});

describe("<WebsitesSettings>", () => {
  const WEBSITES: WebsitesWire = {
    websites: [{ id: "w1", name: "Green Acres", domains: ["greenacres.com"], siteKey: "aws_abcdefghijklmnopqrstuvwx", snippet: websiteSnippet("https://app.lawnco.com/api/w/v1/beacon.js", "aws_abcdefghijklmnopqrstuvwx"), createdAt: "2026-10-01T00:00:00Z", lastVisitAt: null }],
    canManage: true,
    limit: null,
    limitMessage: null,
    ownPages: { label: "Your pages on Lawnco", url: "https://app.lawnco.com/t/green-acres", lastVisitAt: new Date(Date.now() - 5 * 60_000).toISOString() },
  };
  const transport = createAnalyticsTransport({ baseUrl: "/api/app/c1/website", fetch: async () => new Response("{}") });

  it("lists the company's pages and websites with the line to paste, and the add form and 'these are my visits' for a manager", () => {
    const html = renderToStaticMarkup(<WebsitesSettings transport={transport} initial={WEBSITES} />);
    expect(html).toContain("Your pages on Lawnco");
    expect(html).toContain("Counting — last visit 5 min ago");
    expect(html).toContain("No visits yet. Paste the line, then open your site once.");
    expect(html).toContain("&lt;script async src=&quot;https://app.lawnco.com/api/w/v1/beacon.js&quot; data-site=&quot;aws_abcdefghijklmnopqrstuvwx&quot;&gt;&lt;/script&gt;");
    expect(html).toContain("Copy the line");
    expect(html).toContain("Add website");
    expect(html).toContain("Leave out your own visits");
    // The first-party "leave this device out" links: the site's own opt-out switch, set on that device.
    expect(html).toContain('href="https://greenacres.com/?analytics=off"');
    expect(html).toContain('href="https://app.lawnco.com/t/green-acres?analytics=off"');
    expect(html).toContain("internet connection");
  });

  it("says how to paste the line on WordPress, Wix, Squarespace and anything else", () => {
    const html = renderToStaticMarkup(<WebsitesSettings transport={transport} initial={WEBSITES} />);
    for (const builder of ["WordPress", "Wix", "Squarespace", "Something else, or not sure", "whoever looks after your website"]) expect(html).toContain(builder);
  });

  it("never shows a setup message for whoever runs the app: no line yet is just 'not ready yet'", () => {
    const html = renderToStaticMarkup(<WebsitesSettings transport={transport} initial={{ ...WEBSITES, websites: WEBSITES.websites.map((w) => ({ ...w, snippet: null })) }} />);
    expect(html).toContain("The line to paste isn&rsquo;t ready yet".replace("&rsquo;", "’"));
    expect(html).not.toContain("public web address");
  });

  it("uses the server's sentence when the plan has no room, a plan of none included", () => {
    const none = renderToStaticMarkup(
      <WebsitesSettings transport={transport} initial={{ ...WEBSITES, websites: [], limit: 0, limitMessage: "Your plan doesn't include websites of your own. Choose a plan that does to add one." }} />,
    );
    expect(none).toContain("Choose a plan that does to add one.");
    expect(none).not.toContain("Add website");
  });

  it("shows no buttons that change anything to someone who can only look, and the plan's limit when it is reached", () => {
    const viewer = renderToStaticMarkup(<WebsitesSettings transport={transport} initial={{ ...WEBSITES, canManage: false }} />);
    expect(viewer).not.toContain("Add website");
    expect(viewer).not.toContain("Stop counting");
    expect(viewer).not.toContain("leave this device out");
    const full = renderToStaticMarkup(<WebsitesSettings transport={transport} initial={{ ...WEBSITES, limit: 1, limitMessage: "Your plan includes 1 website. Stop counting one or choose a bigger plan to add another." }} />);
    expect(full).toContain("Your plan includes 1 website.");
    expect(full).not.toContain("Add website");
  });
});

describe("the transport", () => {
  it("asks the right routes and turns a refusal into its sentence", async () => {
    const calls: string[] = [];
    const transport = createAnalyticsTransport({
      baseUrl: "/api/app/c1/website/",
      fetch: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        if (String(input).includes("/remove")) return Response.json({ error: { code: "not_found", message: "That isn't here." } }, { status: 404 });
        return Response.json(String(input).includes("websites") && init?.method === "POST" ? { website: { id: "w9" } } : {});
      },
    });
    await transport.report({ days: 7, site: "all", includeInternal: false });
    await transport.report({ days: 30, site: "pages", includeInternal: true });
    await transport.report({ days: 90, site: "w1", includeInternal: false });
    expect((await transport.addWebsite({ name: "X", domains: "x.com" })).id).toBe("w9");
    await expect(transport.removeWebsite("w1")).rejects.toMatchObject({ code: "not_found", status: 404, message: "That isn't here." });
    expect(calls).toEqual([
      "GET /api/app/c1/website/v1/report?days=7",
      "GET /api/app/c1/website/v1/report?days=30&includeInternal=1&site=pages",
      "GET /api/app/c1/website/v1/websites/w1/report?days=90",
      "POST /api/app/c1/website/v1/websites",
      "POST /api/app/c1/website/v1/websites/w1/remove",
    ]);
  });
});

/** Run the snippet's script in a stand-in page. Returns what it sent. */
function runScript(options: { dnt?: boolean; key?: string; search?: string } = {}) {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const listeners: Record<string, Array<() => void>> = {};
  const location = { pathname: "/spring-cleanup", search: options.search ?? "", host: "greenacres.com", href: "https://greenacres.com/spring-cleanup" };
  const storage = new Map<string, string>();
  const win: Record<string, unknown> = {};
  const document = {
    currentScript: { src: "https://app.lawnco.com/api/w/v1/beacon.js", getAttribute: (name: string) => (name === "data-site" ? (options.key ?? "aws_abcdefghijklmnopqrstuvwx") : null) },
    referrer: "https://www.google.com/search?q=lawn",
    visibilityState: "visible",
    addEventListener: (name: string, fn: () => void) => (listeners[name] ??= []).push(fn),
  };
  const navigator = {
    doNotTrack: options.dnt ? "1" : null,
    webdriver: false,
    sendBeacon: (url: string, body: string) => {
      sent.push({ url, body: JSON.parse(body) as Record<string, unknown> });
      return true;
    },
  };
  const history = { pushState() {}, replaceState() {} };
  const run = new Function(
    "window", "document", "navigator", "location", "history", "addEventListener", "localStorage", "crypto", "URL", "URLSearchParams", "setTimeout", "fetch",
    BEACON_SCRIPT,
  );
  run(
    win, document, navigator, location, history,
    (name: string, fn: () => void) => (listeners[name] ??= []).push(fn),
    { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
    globalThis.crypto, URL, URLSearchParams, (fn: () => void) => fn(), () => Promise.resolve(),
  );
  return { sent, listeners, history: history as unknown as { pushState: (...args: unknown[]) => void }, location };
}

describe("the snippet's script", () => {
  it("sends a page view to collect?site=… beside itself, with the referrer's host only and the query once", () => {
    const { sent } = runScript({ search: "?utm_source=newsletter" });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://app.lawnco.com/api/w/v1/collect?site=aws_abcdefghijklmnopqrstuvwx");
    expect(sent[0]!.body).toMatchObject({ t: "pageview", p: "/spring-cleanup", r: "www.google.com", q: "?utm_source=newsletter" });
    expect(String(sent[0]!.body.d)).toMatch(/^[a-z0-9]{8,20}$/);
  });

  it("counts an in-page navigation, and sends nothing under Do Not Track or with a malformed key", () => {
    const page = runScript();
    page.location.pathname = "/contact";
    page.history.pushState({}, "", "/contact");
    expect(page.sent.map((s) => s.body.p)).toEqual(["/spring-cleanup", "/contact"]);
    expect(page.sent[1]!.body.r).toBeUndefined();
    expect(runScript({ dnt: true }).sent).toEqual([]);
    expect(runScript({ key: "not-a-key" }).sent).toEqual([]);
  });

  it("the snippet escapes what it is given", () => {
    expect(websiteSnippet('https://x.test/a"b.js', 'aws_a"<b')).toBe('<script async src="https://x.test/a%22b.js" data-site="aws_ab"></script>');
  });
});

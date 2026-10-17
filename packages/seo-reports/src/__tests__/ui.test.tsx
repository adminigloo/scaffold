import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildWorklist } from "../report.js";
import { createSearchCheckTransport, SearchCheck, SearchCheckReport } from "../ui.js";
import type { SearchCheckOverviewWire, SiteCheckWire } from "../wire.js";

/**
 * The search check screen's first paint: a worklist in plain words (no
 * "canonical", no "h1" in the to-dos), what's already good, Check now for
 * someone who may run it — and the transport's paths.
 */

const siteChecks = [
  { id: "site.llms-txt", label: "llms.txt", kind: "aeo" as const, status: "fail" as const, detail: "Not served." },
  { id: "site.robots", label: "robots.txt", kind: "seo" as const, status: "pass" as const, detail: "Served." },
];
const pages = [
  { path: "/", checks: [{ id: "page.title", label: "Page title", kind: "seo" as const, status: "fail" as const, detail: "The page has no title." }] },
  { path: "/prices", checks: [{ id: "page.title", label: "Page title", kind: "seo" as const, status: "warn" as const, detail: "Too long." }] },
];

const REPORT: SiteCheckWire = {
  id: "c1",
  status: "done",
  trigger: "manual",
  startedAt: "2026-10-16T15:00:00.000Z",
  finishedAt: "2026-10-16T15:00:20.000Z",
  score: 62,
  seoScore: 55,
  aeoScore: 70,
  pageCount: 2,
  passCount: 1,
  warnCount: 1,
  failCount: 2,
  stopped: null,
  addresses: ["Our website — greenacres.com"],
  ...buildWorklist(siteChecks, pages),
  siteChecks,
  pages,
};

describe("buildWorklist", () => {
  it("groups by what to do, fails first, with every place it was found", () => {
    const { worklist, done } = buildWorklist(siteChecks, pages);
    expect(worklist.map((w) => [w.id, w.status, w.evidence.length])).toEqual([
      ["page.title", "fail", 2],
      ["site.llms-txt", "fail", 1],
    ]);
    expect(worklist[0]?.todo).toBe("Give each page a clear title");
    expect(done).toEqual(["Serve a robots.txt file"]);
  });
});

describe("<SearchCheck>", () => {
  it("shows the worklist in plain words and Check now for someone who may run it", () => {
    const overview: SearchCheckOverviewWire = {
      checks: [REPORT],
      latest: REPORT,
      canRun: true,
      addresses: ["Our website — greenacres.com"],
      addressSentence: "Your pages on Snowplow (app.snowplow.test/t/green-acres) and your website “Green Acres” (greenacres.com)",
      waiting: ["Your website “Shop” (shop.greenacres.com): We'll check this site once your visits line is working."],
      month: { used: 1, limit: 20, resetsAt: "2026-11-01T00:00:00.000Z" },
      notice: null,
      nextAutomaticAt: "2026-10-23T15:00:00.000Z",
    };
    const markup = renderToStaticMarkup(<SearchCheck transport={createSearchCheckTransport({ baseUrl: "/x" })} initial={overview} />);
    expect(markup).toContain("Search check");
    expect(markup).toContain("Check now");
    expect(markup).toContain("Give each page a clear title");
    expect(markup).toContain("Add an llms.txt file");
    expect(markup).toContain("Already good");
    expect(markup).toContain("1 of 20 Check now presses used this month; a weekly check is included.");
    expect(markup).toContain("read your pages on Snowplow (app.snowplow.test/t/green-acres) and your website “Green Acres” (greenacres.com).");
    expect(markup).toContain("We&#x27;ll check this site once your visits line is working.");
    expect(markup).toContain("Next automatic check around Oct 23");
    expect(renderToStaticMarkup(<SearchCheck transport={createSearchCheckTransport({ baseUrl: "/x" })} initial={{ ...overview, canRun: false }} />)).not.toContain(">Check now</button>");
  });

  it("says when there's nothing to fix", () => {
    const clean = { ...REPORT, worklist: [], done: ["Give each page a clear title"] };
    expect(renderToStaticMarkup(<SearchCheckReport report={clean} />)).toContain("Nothing to fix");
  });
});

describe("createSearchCheckTransport", () => {
  it("calls the package's routes, and turns a refusal into its sentence", async () => {
    const seen: string[] = [];
    const transport = createSearchCheckTransport({
      baseUrl: "/api/app/c1/search-check/",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response(JSON.stringify({ error: { code: "limit_reached", message: "You've used this month's checks." } }), { status: 409 });
      }) as typeof fetch,
    });
    await expect(transport.checkNow()).rejects.toThrow("You've used this month's checks.");
    await expect(transport.check("a b")).rejects.toThrow();
    expect(seen).toEqual(["POST /api/app/c1/search-check/v1/checks", "GET /api/app/c1/search-check/v1/checks/a%20b"]);
  });
});

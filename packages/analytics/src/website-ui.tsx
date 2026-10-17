import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { AI_ENGINE_LABELS } from "./sources.js";
import {
  AnalyticsScope,
  BarList,
  CrawlerPanel,
  DataTable,
  HealthStrip,
  KpiCard,
  KpiGrid,
  Panel,
  RangeTabs,
  SourceBars,
  TrendChart,
  formatNumber,
} from "./dashboard.js";
import type { MineWire, WebsiteFilterWire, WebsiteReportWire, WebsitesWire, WebsiteWire } from "./wire.js";

/**
 * THE DROP-IN WEBSITE SCREENS (0.3), on the `./dashboard` entry:
 *
 *   <WebsiteTraffic transport={t} initial={report} />    a company's visits
 *   <WebsitesSettings transport={t} />                   its websites, the
 *                                                        snippet, "these are
 *                                                        my visits"
 *
 * Both talk to the package's admin handlers through a TRANSPORT —
 * `createAnalyticsTransport({ baseUrl: "/api/app/{id}/website" })` — or to
 * whatever a host app wires instead (server actions, tRPC): the transport is
 * an interface, the components never fetch on their own. The report shape
 * is `WebsiteReportWire`, which `buildWebsiteReport` makes on the server.
 *
 * Plain words on screen, 44px targets, the `.aia` tokens (light and dark),
 * and nothing that breaks at a phone's width.
 */

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

export interface WebsiteReportRequest {
  days: number;
  site: WebsiteFilterWire;
  includeInternal: boolean;
}

/** What the screens ask of the server. Every method but `report` is optional: a screen without one hides that control. */
export interface WebsiteTransport {
  report(request: WebsiteReportRequest): Promise<WebsiteReportWire>;
  websites?(): Promise<WebsitesWire>;
  addWebsite?(input: { name: string; domains: string }): Promise<WebsiteWire>;
  updateWebsite?(id: string, input: { name?: string; domains?: string }): Promise<WebsiteWire>;
  removeWebsite?(id: string): Promise<void>;
  /** "These are my visits": leave this device's visits out. */
  markMine?(): Promise<MineWire>;
  /** "Count my visits again". */
  unmarkMine?(): Promise<MineWire>;
}

/** A refusal from the handlers, with the sentence to show. */
export class AnalyticsTransportError extends Error {
  readonly name = "AnalyticsTransportError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AnalyticsTransportOptions {
  /** Where the admin handlers are mounted, e.g. `/api/app/${company.id}/website`. */
  baseUrl: string;
  fetch?: typeof fetch;
}

/** The transport over the package's own admin handlers (`createAnalyticsAdminHandlers`). */
export function createAnalyticsTransport(options: AnalyticsTransportOptions): Required<WebsiteTransport> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  async function call<T>(path: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method: init?.method ?? "GET",
        credentials: "same-origin",
        headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
    } catch {
      throw new AnalyticsTransportError("offline", 0, "Couldn't reach the server. Check your connection and try again.");
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new AnalyticsTransportError(error?.code ?? "internal", res.status, error?.message ?? "Something went wrong. Please try again.");
    }
    return data as T;
  }
  return {
    report: ({ days, site, includeInternal }) => {
      const query = new URLSearchParams({ days: String(days) });
      if (includeInternal) query.set("includeInternal", "1");
      if (site !== "all" && site !== "pages") return call(`v1/websites/${encodeURIComponent(site)}/report?${query.toString()}`);
      if (site === "pages") query.set("site", "pages");
      return call(`v1/report?${query.toString()}`);
    },
    websites: () => call("v1/websites"),
    addWebsite: async (input) => (await call<{ website: WebsiteWire }>("v1/websites", { method: "POST", body: input })).website,
    updateWebsite: async (id, input) => (await call<{ website: WebsiteWire }>(`v1/websites/${encodeURIComponent(id)}`, { method: "POST", body: input })).website,
    removeWebsite: async (id) => {
      await call(`v1/websites/${encodeURIComponent(id)}/remove`, { method: "POST", body: {} });
    },
    markMine: () => call("v1/visits/mine", { method: "POST", body: {} }),
    unmarkMine: () => call("v1/visits/mine/undo", { method: "POST", body: {} }),
  };
}

// ---------------------------------------------------------------------------
// Styles (aiw-: analytics website), inside the `.aia` token scope
// ---------------------------------------------------------------------------

const STYLE_ID = "aiw-styles";
const CSS = `
.aiw { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.aiw-bar { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: center; }
.aiw-title { font-size: 20px; font-weight: 700; letter-spacing: -.01em; margin: 0; flex: 1 1 200px; }
.aiw-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.aiw .aim-tabs button { min-height: 40px; padding: 6px 12px; }
.aiw-select, .aiw-input { font: inherit; font-size: 14px; min-height: 44px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--aim-line-strong);
  background: var(--aim-surface); color: var(--aim-ink); max-width: 100%; box-sizing: border-box; }
.aiw-input { width: 100%; }
.aiw-select:focus-visible, .aiw-input:focus-visible, .aiw-button:focus-visible, .aiw-link:focus-visible { outline: 2px solid var(--aim-accent); outline-offset: 2px; }
.aiw-button { font: inherit; font-size: 14px; font-weight: 600; min-height: 44px; padding: 8px 16px; border-radius: 10px; border: 1px solid var(--aim-line-strong);
  background: var(--aim-surface); color: var(--aim-ink); cursor: pointer; }
.aiw-button:hover { background: var(--aim-surface-2); }
.aiw-button[disabled] { opacity: .6; cursor: default; }
.aiw-primary { background: var(--aim-accent); border-color: var(--aim-accent); color: #fff; }
.aiw-primary:hover { background: var(--aim-accent); filter: brightness(.95); }
.aiw-danger { color: var(--aim-bad); }
.aiw-link { all: unset; cursor: pointer; color: var(--aim-accent); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; min-height: 44px; display: inline-flex; align-items: center; }
.aiw-note { font-size: 13px; color: var(--aim-ink-muted); line-height: 1.5; margin: 0; }
.aiw-left-out { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; font-size: 13px; color: var(--aim-ink-muted);
  background: var(--aim-surface-2); border: 1px solid var(--aim-line); border-radius: 10px; padding: 4px 4px 4px 12px; }
.aiw-left-out b { color: var(--aim-ink); font-weight: 600; }
.aiw-counting { border-color: var(--aim-warn); background: var(--aim-warn-soft); color: var(--aim-ink); }
.aiw-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 16px; }
.aiw-error { border: 1px solid var(--aim-bad); background: var(--aim-bad-soft); color: var(--aim-ink); border-radius: 10px; padding: 10px 12px; font-size: 14px; }
.aiw-ok { border: 1px solid var(--aim-good); background: var(--aim-good-soft); color: var(--aim-ink); border-radius: 10px; padding: 10px 12px; font-size: 14px; }
.aiw-sub { font-size: 12px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--aim-ink-faint); margin: 4px 0 8px; }
.aiw-sites { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.aiw-site { border: 1px solid var(--aim-line); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.aiw-site-head { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.aiw-site-name { font-weight: 650; font-size: 15px; }
.aiw-domains { font-size: 13px; color: var(--aim-ink-muted); overflow-wrap: anywhere; }
.aiw-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: var(--aim-surface-2); border: 1px solid var(--aim-line);
  border-radius: 8px; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; user-select: all; }
.aiw-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.aiw-form { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); align-items: end; }
.aiw-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; min-width: 0; }
.aiw-field span { color: var(--aim-ink-muted); font-weight: 500; font-size: 12px; }
.aiw-loading { opacity: .6; transition: opacity .15s; }
.aiw-help { font-size: 13px; color: var(--aim-ink-muted); }
.aiw-help summary { cursor: pointer; color: var(--aim-accent); font-weight: 600; min-height: 44px; display: flex; align-items: center; }
.aiw-help-item { margin: 4px 0 8px; } .aiw-help-item b { color: var(--aim-ink); } .aiw-help ol { margin: 4px 0 0; padding-left: 20px; line-height: 1.5; }
.aiw-confirm { border: 1px solid var(--aim-bad); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.aiw-leave { list-style: none; margin: 6px 0; padding: 0; display: flex; flex-direction: column; }
@media (max-width: 480px) { .aiw-title { font-size: 18px; } .aiw-controls { width: 100%; } .aiw-select { flex: 1 1 100%; } }
`;

function useWebsiteStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }, []);
}

const DAY_OPTIONS = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Please try again.";
}

// ---------------------------------------------------------------------------
// <WebsiteTraffic>
// ---------------------------------------------------------------------------

export interface WebsiteTrafficProps {
  transport: Pick<WebsiteTransport, "report">;
  /** The first report, made on the server (`buildWebsiteReport`), so the page draws numbers before any request. */
  initial?: WebsiteReportWire | null;
  /** The heading. Default "Website visits". */
  title?: string;
  /** Show the website filter (when there is more than the company's own pages). Default true. */
  siteFilter?: boolean;
  /** Show the "is anything arriving" strip at the bottom. Default true. */
  showHealth?: boolean;
  /** Something to draw beside the heading (a link to the websites settings). */
  actions?: ReactNode;
  /** What this app counts as someone acting on a visit. Default "Took action". */
  conversionsLabel?: string;
  /** The line under it. Default "asked for a quote, booked or signed up". */
  conversionsHint?: string;
}

/** "Oct 3, 2026" — a day as people write it. */
function dayWords(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The trend from the first day anything was counted: a new company's chart
 * starts the day it started counting rather than drawing weeks of nothing.
 */
export function trendFromStart<P extends { date: string; visits: number | null }>(points: readonly P[]): { points: readonly P[]; startedOn: string | null } {
  const first = points.findIndex((point) => point.visits !== null);
  if (first <= 0) return { points, startedOn: null };
  return { points: points.slice(first), startedOn: points[first]!.date };
}

/**
 * A company's visits, drop-in: the range, the website filter, the "left out"
 * line with "count everyone" for one look, the headline numbers, the trend,
 * where visits came from (search, AI assistants, other sites), the AI
 * assistants by name, the pages read, the AI crawlers, and whether anything
 * is arriving at all.
 */
export function WebsiteTraffic(props: WebsiteTrafficProps): ReactElement {
  useWebsiteStyles();
  const { transport } = props;
  const [days, setDays] = useState<number>(props.initial?.range.days ?? 30);
  const [site, setSite] = useState<WebsiteFilterWire>(props.initial?.site ?? "all");
  const [includeInternal, setIncludeInternal] = useState<boolean>(props.initial?.includeInternal ?? false);
  const [report, setReport] = useState<WebsiteReportWire | null>(props.initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!props.initial);
  const asked = useRef(0);
  const first = useRef(Boolean(props.initial));
  const selectId = useId();

  const load = useCallback(
    async (request: WebsiteReportRequest) => {
      const ticket = ++asked.current;
      setLoading(true);
      setError(null);
      try {
        const next = await transport.report(request);
        if (ticket === asked.current) setReport(next);
      } catch (cause) {
        if (ticket === asked.current) setError(messageOf(cause));
      } finally {
        if (ticket === asked.current) setLoading(false);
      }
    },
    [transport],
  );

  useEffect(() => {
    // The server's first report is already on screen: no second request for it.
    if (first.current) {
      first.current = false;
      return;
    }
    void load({ days, site, includeInternal });
  }, [days, site, includeInternal, load]);

  const periodLabel = `${days} days`;
  const title = props.title ?? "Website visits";
  const filterOptions = report
    ? [
        { value: "all", label: "All websites" },
        { value: "pages", label: report.ownPagesLabel },
        ...report.websites.map((website) => ({ value: website.id, label: website.name })),
      ]
    : [{ value: "all", label: "All websites" }];
  const externalSite = site !== "all" && site !== "pages";
  const trend = report ? trendFromStart(report.trend) : { points: [], startedOn: null };

  return (
    <AnalyticsScope>
      <div className="aiw" aria-busy={loading}>
        <div className="aiw-bar">
          <h2 className="aiw-title">{title}</h2>
          <div className="aiw-controls">
            {props.siteFilter !== false && report && report.websites.length > 0 ? (
              <>
                <label htmlFor={selectId} className="aiw-note" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                  Which website
                </label>
                <select id={selectId} className="aiw-select" value={site} onChange={(event) => setSite(event.target.value)}>
                  {filterOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
            <RangeTabs value={days} options={DAY_OPTIONS} onChange={(value) => setDays(value)} label="How far back" />
            {props.actions}
          </div>
        </div>

        {error ? (
          <div className="aiw-error" role="alert">
            {error}{" "}
            <button type="button" className="aiw-link" onClick={() => void load({ days, site, includeInternal })}>
              Try again
            </button>
          </div>
        ) : null}

        {report ? (
          <div className={loading ? "aiw aiw-loading" : "aiw"}>
            <LeftOutLine report={report} includeInternal={includeInternal} onToggle={() => setIncludeInternal((value) => !value)} />
            <KpiGrid>
              <KpiCard label="Visits" metric={report.overview.visits} periodLabel={periodLabel} />
              <KpiCard label="Daily visitors" metric={report.overview.dailyVisitors} periodLabel={periodLabel} hint="each person once a day" />
              <KpiCard label="Pages read" metric={report.overview.pageViews} periodLabel={periodLabel} />
              <KpiCard
                label="Visits that stayed"
                metric={report.overview.engagedVisits}
                periodLabel={periodLabel}
                hint={`${report.overview.engagedRate === null ? "" : `${Math.round(report.overview.engagedRate)}%: `}10 seconds or more, or 2 pages`}
              />
              {/* Only once this app records any: a card that can only ever say 0 explains nothing. */}
              {report.health.lastConversion ? (
                <KpiCard label={props.conversionsLabel ?? "Took action"} metric={report.overview.conversions} periodLabel={periodLabel} hint={props.conversionsHint ?? "asked for a quote, booked or signed up"} />
              ) : null}
            </KpiGrid>
            <Panel
              title="Visits by day"
              subtitle={
                trend.startedOn
                  ? `Started counting on ${dayWords(trend.startedOn)}, in ${report.range.timeZone.replace(/_/g, " ")} time.`
                  : `The last ${days} days, in ${report.range.timeZone.replace(/_/g, " ")} time.`
              }
            >
              <TrendChart
                points={trend.points}
                series={[
                  { key: "visits", label: "Visits", tone: "accent" },
                  { key: "pageViews", label: "Pages read", tone: "muted", area: false },
                  ...(externalSite ? [] : [{ key: "aiCrawlerHits", label: "AI crawler reads", tone: "ai" as const, area: false }]),
                ]}
              />
            </Panel>
            <div className="aiw-two">
              <Panel title="Where visits came from" subtitle="Search, AI assistants, other sites, social, email and people who typed the address.">
                <SourceBars rows={report.sources} empty="No visits in this range yet." />
              </Panel>
              <Panel title="Search engines and AI assistants" subtitle="Which search engine or AI assistant sent each visit.">
                <div className="aiw-sub">Search engines</div>
                <BarList rows={report.searchEngines.map((row) => ({ key: row.host, label: row.host, value: row.visits }))} empty="No visits from search yet." />
                <div className="aiw-sub" style={{ marginTop: 12 }}>AI assistants</div>
                <BarList
                  rows={report.ai.engines.map((engine) => ({
                    key: engine.engine,
                    label: engine.label ?? AI_ENGINE_LABELS[engine.engine as keyof typeof AI_ENGINE_LABELS] ?? engine.engine,
                    value: engine.visits,
                    tone: "ai" as const,
                    hint: engine.assistantFetches > 0 ? `${formatNumber(engine.assistantFetches)} reads` : undefined,
                  }))}
                  empty="No visits from AI assistants yet. ChatGPT, Claude, Perplexity and the rest show up here."
                />
              </Panel>
            </div>
            <div className="aiw-two">
              <Panel title="Pages read" subtitle="The pages people opened most.">
                <DataTable
                  rows={report.topPages}
                  csvName="pages.csv"
                  initialSort={{ key: "views" }}
                  limit={15}
                  empty="No pages read in this range yet."
                  columns={[
                    { key: "path", label: "Page", value: (row) => row.path, mono: true },
                    { key: "views", label: "Reads", value: (row) => row.views, numeric: true, format: "number" },
                    { key: "visits", label: "Visits", value: (row) => row.visits, numeric: true, format: "number" },
                  ]}
                />
              </Panel>
              <Panel title="Other sites that sent visits" subtitle="Links to you from other websites and apps.">
                <DataTable
                  rows={report.referrers}
                  initialSort={{ key: "visits" }}
                  limit={15}
                  empty="No visits from other sites yet."
                  columns={[
                    { key: "host", label: "Site", value: (row) => row.host, mono: true },
                    { key: "visits", label: "Visits", value: (row) => row.visits, numeric: true, format: "number" },
                  ]}
                />
              </Panel>
            </div>
            <Panel
              title="AI crawlers and search engines reading your pages"
              subtitle={
                externalSite
                  ? "Crawlers don't run the snippet, so they can only be counted on your pages here."
                  : "Bots that fetched your pages here: AI assistants answering someone, AI search, AI training and search engines."
              }
            >
              {externalSite ? (
                <p className="aiw-note">Pick “All websites” or “{report.ownPagesLabel}” to see which crawlers read your pages.</p>
              ) : (
                <CrawlerPanel report={report.crawlers} />
              )}
            </Panel>
            {props.showHealth !== false ? (
              <Panel title="Is anything arriving?" subtitle="When each thing was last counted — your team's visits too.">
                <HealthStrip health={report.health} items={report.health.lastConversion ? ["pageView", "event", "conversion", "crawler", "aiCrawler"] : ["pageView", "event", "crawler", "aiCrawler"]} />
              </Panel>
            ) : null}
          </div>
        ) : loading ? (
          <p className="aiw-note" role="status">
            Loading the numbers…
          </p>
        ) : null}
      </div>
    </AnalyticsScope>
  );
}

function LeftOutLine(props: { report: WebsiteReportWire; includeInternal: boolean; onToggle: () => void }): ReactElement | null {
  const { report, includeInternal } = props;
  if (includeInternal) {
    return (
      <div className="aiw-left-out aiw-counting" role="note">
        <span>
          <b>Counting everyone</b>, your own team and devices too — for this look only.
        </span>
        <button type="button" className="aiw-link" onClick={props.onToggle}>
          Leave them out again
        </button>
      </div>
    );
  }
  if (!report.excluded) return null;
  return (
    <div className="aiw-left-out" role="note">
      <span>{report.excluded.sentence}</span>
      <button type="button" className="aiw-link" onClick={props.onToggle}>
        Count everyone
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// <WebsitesSettings>
// ---------------------------------------------------------------------------

export interface WebsitesSettingsProps {
  transport: WebsiteTransport;
  initial?: WebsitesWire | null;
  title?: string;
}

/** Where the line goes on the website builders people use, in a few steps each. */
const PASTE_STEPS: ReadonlyArray<{ readonly name: string; readonly steps: readonly string[] }> = [
  {
    name: "WordPress",
    steps: [
      "Install a plugin that adds code to the header, like “WPCode” (Plugins → Add New).",
      "Open it, choose Header, paste the line and save.",
    ],
  },
  {
    name: "Wix",
    steps: ["Go to Settings → Custom Code (under Advanced).", "Choose “Add Custom Code”, paste the line, pick “All pages” and “Head”, and apply."],
  },
  {
    name: "Squarespace",
    steps: ["Go to Settings → Advanced → Code Injection.", "Paste the line in the Header box and save."],
  },
  {
    name: "Something else, or not sure",
    steps: [
      "Look for a setting called “header code”, “custom code” or “tracking code”, and paste the line there for every page.",
      "Or send the line to whoever looks after your website: it goes just before </head> on every page.",
    ],
  },
];

/** "3 min ago", "2 h ago", "Oct 3" — when something last happened. */
function agoWords(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A website's first address as a link that opens it with this device left out (`?analytics=off`, kept on the device). */
function leaveOutLink(address: string): string {
  const base = /^https?:\/\//.test(address) ? address : `https://${address}`;
  try {
    const url = new URL(base);
    url.searchParams.set("analytics", "off");
    return url.toString();
  } catch {
    return `${base}?analytics=off`;
  }
}

function StatusLine({ lastVisitAt, waiting }: { lastVisitAt: string | null | undefined; waiting: string }): ReactElement {
  return lastVisitAt ? (
    <span className="aim-tag aim-tag-good">Counting — last visit {agoWords(lastVisitAt)}</span>
  ) : (
    <span className="aim-tag">{waiting}</span>
  );
}

/**
 * A company's websites: its pages here (always counted), each website of its
 * own with the one line to paste, how to paste it, whether visits are
 * arriving, adding and removing one, and leaving the owner's own devices out.
 */
export function WebsitesSettings(props: WebsitesSettingsProps): ReactElement {
  useWebsiteStyles();
  const { transport } = props;
  const [state, setState] = useState<WebsitesWire | null>(props.initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameId = useId();
  const domainsId = useId();

  const refresh = useCallback(async () => {
    if (!transport.websites) return;
    setLoading(true);
    try {
      setState(await transport.websites());
      setLoadError(null);
    } catch (cause) {
      setLoadError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [transport]);

  useEffect(() => {
    if (!props.initial) void refresh();
  }, [props.initial, refresh]);

  async function run(work: () => Promise<string | null>): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const said = await work();
      if (said) setNotice(said);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!transport.addWebsite) return;
    await run(async () => {
      const added = await transport.addWebsite!({ name, domains });
      setName("");
      setDomains("");
      await refresh();
      return `Added ${added.name}. Paste its line on every page of the website, then open the website once: its visits start counting.`;
    });
  }

  async function copy(website: WebsiteWire): Promise<void> {
    if (!website.snippet) return;
    try {
      await navigator.clipboard.writeText(website.snippet);
      setCopied(website.id);
      setTimeout(() => setCopied((value) => (value === website.id ? null : value)), 2500);
    } catch {
      setNotice("Select the line and copy it.");
    }
  }

  const canManage = state?.canManage ?? false;
  const atLimit = state !== null && state.limit !== null && state.websites.length >= state.limit;
  const limitWords =
    state?.limitMessage ??
    (state && state.limit !== null
      ? state.limit <= 0
        ? "Your plan doesn't include websites of your own."
        : `Your plan includes ${state.limit === 1 ? "1 website" : `${state.limit} websites`}. Stop counting one, or choose a bigger plan, to add another.`
      : "");
  const leaveOutPlaces = state
    ? [
        ...(state.ownPages.url ? [{ key: "pages", label: state.ownPages.label, href: leaveOutLink(state.ownPages.url) }] : []),
        ...state.websites.filter((website) => website.domains[0]).map((website) => ({ key: website.id, label: website.name, href: leaveOutLink(website.domains[0]!) })),
      ]
    : [];

  return (
    <AnalyticsScope>
      <div className="aiw">
        {error ? (
          <div className="aiw-error" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="aiw-ok" role="status">
            {notice}
          </div>
        ) : null}
        <Panel title={props.title ?? "Your websites"} subtitle="Every website whose visits count here. Your pages on this site always count; add your own website to count it too.">
          {state ? (
            <ul className="aiw-sites">
              <li className="aiw-site">
                <div className="aiw-site-head">
                  <span className="aiw-site-name">{state.ownPages.label}</span>
                  <StatusLine lastVisitAt={state.ownPages.lastVisitAt} waiting="Always counted — no visits yet" />
                </div>
                {state.ownPages.url ? <div className="aiw-domains">{state.ownPages.url}</div> : null}
              </li>
              {state.websites.map((website) => (
                <li key={website.id} className="aiw-site">
                  <div className="aiw-site-head">
                    <span className="aiw-site-name">{website.name}</span>
                    <span className="aiw-domains">{website.domains.join(", ")}</span>
                  </div>
                  <div>
                    <StatusLine lastVisitAt={website.lastVisitAt} waiting="No visits yet. Paste the line, then open your site once." />
                  </div>
                  {website.snippet ? (
                    <>
                      <p className="aiw-note">Paste this line on every page of the website, in its &ldquo;header code&rdquo; setting (or just before &lt;/head&gt;):</p>
                      <pre className="aiw-code">{website.snippet}</pre>
                      <details className="aiw-help">
                        <summary>How to paste it on WordPress, Wix, Squarespace or another site</summary>
                        {PASTE_STEPS.map((builder) => (
                          <div key={builder.name} className="aiw-help-item">
                            <b>{builder.name}</b>
                            <ol>
                              {builder.steps.map((step) => (
                                <li key={step}>{step}</li>
                              ))}
                            </ol>
                          </div>
                        ))}
                      </details>
                    </>
                  ) : (
                    <p className="aiw-note">The line to paste isn&rsquo;t ready yet. Check back soon.</p>
                  )}
                  <div className="aiw-row">
                    {website.snippet ? (
                      <button type="button" className="aiw-button" onClick={() => void copy(website)}>
                        {copied === website.id ? "Copied" : "Copy the line"}
                      </button>
                    ) : null}
                    {canManage && transport.removeWebsite && confirming !== website.id ? (
                      <button type="button" className="aiw-button aiw-danger" disabled={busy} onClick={() => setConfirming(website.id)}>
                        Stop counting
                      </button>
                    ) : null}
                  </div>
                  {confirming === website.id ? (
                    <div className="aiw-confirm" role="group" aria-label={`Stop counting ${website.name}?`}>
                      <p className="aiw-note">
                        Stop counting <b>{website.name}</b>? Its visits so far stay in your numbers. To count it again later you&rsquo;ll add it again and paste a
                        new line — this one stops working.
                      </p>
                      <div className="aiw-row">
                        <button
                          type="button"
                          className="aiw-button aiw-danger"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await transport.removeWebsite!(website.id);
                              setConfirming(null);
                              await refresh();
                              return `Stopped counting ${website.name}. Its visits so far stay in the numbers.`;
                            })
                          }
                        >
                          Yes, stop counting
                        </button>
                        <button type="button" className="aiw-button" disabled={busy} onClick={() => setConfirming(null)}>
                          Keep counting
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : loadError ? (
            <div className="aiw-error" role="alert">
              {loadError}{" "}
              <button type="button" className="aiw-link" disabled={loading} onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          ) : (
            <p className="aiw-note" role="status">
              Loading your websites…
            </p>
          )}
          {state && canManage && transport.addWebsite ? (
            atLimit ? (
              <p className="aiw-note" style={{ marginTop: 12 }}>
                {limitWords}
              </p>
            ) : (
              <form className="aiw-form" style={{ marginTop: 16 }} onSubmit={(event) => void add(event)}>
                <label className="aiw-field" htmlFor={nameId}>
                  Website name
                  <input id={nameId} className="aiw-input" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Our website" required />
                </label>
                <label className="aiw-field" htmlFor={domainsId}>
                  Its web address
                  <span>Add more with a comma, like greenacres.com, shop.greenacres.com</span>
                  <input
                    id={domainsId}
                    className="aiw-input"
                    value={domains}
                    onChange={(event) => setDomains(event.target.value)}
                    placeholder="greenacres.com"
                    inputMode="url"
                    autoComplete="url"
                    required
                  />
                </label>
                <button type="submit" className="aiw-button aiw-primary" disabled={busy}>
                  Add website
                </button>
              </form>
            )
          ) : null}
        </Panel>
        {state && canManage ? (
          <Panel title="Leave out your own visits" subtitle="So the numbers are your customers, not you.">
            <p className="aiw-note">
              Your team&rsquo;s visits are already left out while they&rsquo;re signed in. For a phone or computer you use to look at your website, open it from a
              link below once, on that device. That device is left out from then on.
            </p>
            {leaveOutPlaces.length ? (
              <ul className="aiw-leave">
                {leaveOutPlaces.map((place) => (
                  <li key={place.key}>
                    <a className="aiw-link" href={place.href} target="_blank" rel="noopener">
                      Open {place.label} and leave this device out
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="aiw-note">
              At the office? Add its internet connection under &ldquo;Leave these people out&rdquo;, and every device on it is left out.
            </p>
            {transport.markMine ? (
              <>
                <p className="aiw-note" style={{ marginTop: 10 }}>
                  Already looked today on this device? This leaves out its visits from yesterday and today.
                </p>
                <div className="aiw-row" style={{ marginTop: 6 }}>
                  <button type="button" className="aiw-button" disabled={busy} onClick={() => void run(async () => (await transport.markMine!()).message)}>
                    Leave out today&rsquo;s visits from this device
                  </button>
                  {transport.unmarkMine ? (
                    <button type="button" className="aiw-button" disabled={busy} onClick={() => void run(async () => (await transport.unmarkMine!()).message)}>
                      Count them again
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
          </Panel>
        ) : null}
      </div>
    </AnalyticsScope>
  );
}

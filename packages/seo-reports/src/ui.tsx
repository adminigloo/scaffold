import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { SearchCheckOverviewWire, SiteCheckSummaryWire, SiteCheckWire, WorkItemWire } from "./wire.js";

/**
 * THE DROP-IN SEARCH CHECK SCREEN (0.2), on the `./ui` entry:
 *
 *   <SearchCheck transport={createSearchCheckTransport({ baseUrl: "/api/app/{id}/search-check" })} />
 *
 * The latest report as a worklist in plain words ("Give each page a clear
 * title — /prices, /about"), what's already good, the past checks, and
 * "Check now". It talks to the package's handlers through a TRANSPORT — or to
 * whatever a host app wires instead (server actions, tRPC); the component
 * never fetches on its own. 44px targets, light and dark, phone width.
 */

export interface SearchCheckTransport {
  overview(): Promise<SearchCheckOverviewWire>;
  check(id: string): Promise<SiteCheckWire>;
  /** Absent: no button (a host that only shows reports). */
  checkNow?(): Promise<SiteCheckWire>;
}

export class SearchCheckTransportError extends Error {
  readonly name = "SearchCheckTransportError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createSearchCheckTransport(options: { baseUrl: string; fetch?: typeof fetch }): Required<SearchCheckTransport> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  async function call<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method,
        credentials: "same-origin",
        headers: method === "POST" ? { "content-type": "application/json" } : undefined,
        body: method === "POST" ? "{}" : undefined,
      });
    } catch {
      throw new SearchCheckTransportError("offline", 0, "Couldn't reach the server. Check your connection and try again.");
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
      throw new SearchCheckTransportError(error?.code ?? "internal", res.status, error?.message ?? "Something went wrong. Please try again.");
    }
    return data as T;
  }
  return {
    overview: () => call("v1/checks"),
    check: (id) => call(`v1/checks/${encodeURIComponent(id)}`),
    checkNow: () => call("v1/checks", "POST"),
  };
}

const STYLE_ID = "aisc-styles";
const CSS = `
.aisc { --aisc-surface:#fff; --aisc-surface-2:#f5f7f9; --aisc-ink:#0e161c; --aisc-muted:#55636f; --aisc-line:#e1e7ec; --aisc-accent:#0f766e;
  --aisc-good:#1b7a43; --aisc-good-soft:#dcf1e4; --aisc-warn:#8a5a00; --aisc-warn-soft:#fbefd5; --aisc-bad:#b3261e; --aisc-bad-soft:#f9e0dd;
  color: var(--aisc-ink); display:flex; flex-direction:column; gap:16px; min-width:0; font-size:14px; line-height:1.5; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .aisc { --aisc-surface:#161d23; --aisc-surface-2:#0f1418; --aisc-ink:#e8edf1; --aisc-muted:#93a2ae;
  --aisc-line:#29343d; --aisc-accent:#45c4ad; --aisc-good:#5fd08f; --aisc-good-soft:#12301f; --aisc-warn:#e2b553; --aisc-warn-soft:#332608; --aisc-bad:#f08a80; --aisc-bad-soft:#3a1512; } }
:root[data-theme="dark"] .aisc { --aisc-surface:#161d23; --aisc-surface-2:#0f1418; --aisc-ink:#e8edf1; --aisc-muted:#93a2ae;
  --aisc-line:#29343d; --aisc-accent:#45c4ad; --aisc-good:#5fd08f; --aisc-good-soft:#12301f; --aisc-warn:#e2b553; --aisc-warn-soft:#332608; --aisc-bad:#f08a80; --aisc-bad-soft:#3a1512; }
.aisc-bar { display:flex; flex-wrap:wrap; gap:10px 12px; align-items:center; }
.aisc-title { font-size:20px; font-weight:700; margin:0; flex:1 1 220px; }
.aisc-sub { color: var(--aisc-muted); margin:2px 0 0; }
.aisc-button { font:inherit; font-weight:600; min-height:44px; padding:8px 16px; border-radius:10px; border:1px solid var(--aisc-accent); background: var(--aisc-accent); color:#fff; cursor:pointer; }
.aisc-button[disabled] { opacity:.6; cursor:default; }
.aisc-link { font:inherit; min-height:44px; padding:8px 4px; background:none; border:none; color: var(--aisc-accent); cursor:pointer; text-align:left; }
.aisc-button:focus-visible, .aisc-link:focus-visible { outline:2px solid var(--aisc-accent); outline-offset:2px; }
.aisc-panel { background: var(--aisc-surface); border:1px solid var(--aisc-line); border-radius:14px; padding:16px; min-width:0; }
.aisc-scores { display:grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap:12px; }
.aisc-score { background: var(--aisc-surface-2); border-radius:12px; padding:12px; }
.aisc-score b { display:block; font-size:28px; }
.aisc-score span { color: var(--aisc-muted); font-size:13px; }
.aisc-notice { background: var(--aisc-warn-soft); color: var(--aisc-warn); border-radius:10px; padding:10px 12px; }
.aisc-error { background: var(--aisc-bad-soft); color: var(--aisc-bad); border-radius:10px; padding:10px 12px; }
.aisc-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.aisc-item { border:1px solid var(--aisc-line); border-radius:12px; padding:12px; background: var(--aisc-surface); }
.aisc-item h4 { margin:0; font-size:15px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.aisc-pill { font-size:12px; font-weight:700; border-radius:999px; padding:2px 8px; }
.aisc-pill-fail { background: var(--aisc-bad-soft); color: var(--aisc-bad); }
.aisc-pill-warn { background: var(--aisc-warn-soft); color: var(--aisc-warn); }
.aisc-why { color: var(--aisc-muted); margin:4px 0 0; }
.aisc-evidence { margin:8px 0 0; padding-left:18px; color: var(--aisc-ink); overflow-wrap:anywhere; }
.aisc-done { margin:0; padding-left:18px; color: var(--aisc-good); }
.aisc-history td, .aisc-history th { text-align:left; padding:8px 6px; border-bottom:1px solid var(--aisc-line); }
.aisc-history { width:100%; border-collapse:collapse; font-size:13px; }
.aisc-scroll { overflow-x:auto; }
`;

function useStyles(): void {
  useEffect(() => {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }, []);
}

function lowerFirst(text: string): string {
  return text.startsWith("Your ") ? `your ${text.slice(5)}` : text;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function WorkItem({ item }: { item: WorkItemWire }): ReactElement {
  const shown = item.evidence.slice(0, 10);
  const places = item.evidence.filter((e) => e.page !== null).length;
  return (
    <li className="aisc-item">
      <h4>
        <span className={`aisc-pill aisc-pill-${item.status}`}>{item.status === "fail" ? "Fix" : "Worth a look"}</span>
        {item.todo}
        {places > 1 ? <span className="aisc-why">· {places} pages</span> : null}
      </h4>
      {item.why ? <p className="aisc-why">{item.why}</p> : null}
      <ul className="aisc-evidence">
        {shown.map((e, i) => (
          <li key={i}>
            {e.page ? <strong>{e.page}: </strong> : null}
            {e.detail}
          </li>
        ))}
        {item.evidence.length > shown.length ? <li>…and {item.evidence.length - shown.length} more.</li> : null}
      </ul>
    </li>
  );
}

/** One report: the scores, the worklist, what's already good. */
export function SearchCheckReport({ report }: { report: SiteCheckWire }): ReactElement {
  useStyles();
  const fixes = report.worklist.filter((w) => w.status === "fail").length;
  const looks = report.worklist.length - fixes;
  return (
    <div className="aisc">
      <div className="aisc-scores">
        <div className="aisc-score">
          <b>{report.score}</b>
          <span>Overall, out of 100</span>
        </div>
        <div className="aisc-score">
          <b>{report.seoScore}</b>
          <span>How search engines read you</span>
        </div>
        <div className="aisc-score">
          <b>{report.aeoScore}</b>
          <span>How AI assistants read you</span>
        </div>
        <div className="aisc-score">
          <b>{report.pageCount}</b>
          <span>Pages checked {when(report.startedAt)}</span>
        </div>
      </div>
      <h3 style={{ margin: 0, fontSize: 16 }}>
        {report.worklist.length === 0 ? "Nothing to fix. Nice work." : `To do: ${fixes} to fix, ${looks} worth a look`}
      </h3>
      {report.worklist.length > 0 ? (
        <ul className="aisc-list">
          {report.worklist.map((item) => (
            <WorkItem key={item.id} item={item} />
          ))}
        </ul>
      ) : null}
      {report.done.length > 0 ? (
        <div className="aisc-panel">
          <strong>Already good</strong>
          <ul className="aisc-done">
            {report.done.map((todo) => (
              <li key={todo}>{todo}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export interface SearchCheckProps {
  transport: SearchCheckTransport;
  /** The first paint's data, when the page has it already. */
  initial?: SearchCheckOverviewWire | null;
  /** The heading's level (default 2). */
  headingLevel?: 2 | 3;
}

/** The whole section: what's checked, Check now, the latest worklist, past checks. */
export function SearchCheck(props: SearchCheckProps): ReactElement {
  useStyles();
  const { transport } = props;
  const [overview, setOverview] = useState<SearchCheckOverviewWire | null>(props.initial ?? null);
  const [shown, setShown] = useState<SiteCheckWire | null>(props.initial?.latest ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await transport.overview();
      setOverview(next);
      setShown((current) => (current && next.checks.some((c) => c.id === current.id) ? current : next.latest));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }, [transport]);

  useEffect(() => {
    if (!props.initial) void load();
  }, [load, props.initial]);

  async function checkNow() {
    if (!transport.checkNow) return;
    setBusy(true);
    setError(null);
    try {
      const report = await transport.checkNow();
      setShown(report);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function open(row: SiteCheckSummaryWire) {
    try {
      setShown(await transport.check(row.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    }
  }

  const Heading = props.headingLevel === 3 ? "h3" : "h2";
  const month = overview?.month;
  return (
    <section className="aisc" aria-label="Search check">
      <div className="aisc-bar">
        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
          <Heading className="aisc-title">Search check</Heading>
          <p className="aisc-sub">
            How Google, Bing and AI assistants like ChatGPT read{" "}
            {overview && overview.addressSentence ? lowerFirst(overview.addressSentence) : "your website and pages"}.
            {month
              ? ` ${month.used}${month.limit !== null ? ` of ${month.limit}` : ""} Check now press${(month.limit ?? month.used) === 1 ? "" : "es"} used this month; a weekly check is included.`
              : ""}
            {overview?.nextAutomaticAt ? ` Next automatic check around ${when(overview.nextAutomaticAt)}.` : ""}
          </p>
        </div>
        {overview?.canRun && transport.checkNow ? (
          <button type="button" className="aisc-button" onClick={() => void checkNow()} disabled={busy || (overview.notice !== null && overview.addresses.length === 0)}>
            {busy ? "Checking… (up to a minute)" : "Check now"}
          </button>
        ) : null}
      </div>
      {overview?.notice ? <p className="aisc-notice">{overview.notice}</p> : null}
      {overview?.waiting.map((line) => (
        <p key={line} className="aisc-notice">
          {line}
        </p>
      ))}
      {error ? (
        <p className="aisc-error" role="alert">
          {error}
        </p>
      ) : null}
      {overview === null && error === null ? <p className="aisc-sub">Loading…</p> : null}
      {overview !== null && shown === null ? <p className="aisc-sub">No checks yet. {overview.canRun ? "Press “Check now” to see how your site reads." : ""}</p> : null}
      {shown ? <SearchCheckReport report={shown} /> : null}
      {overview && overview.checks.length > 1 ? (
        <div className="aisc-panel aisc-scroll">
          <strong>Past checks</strong>
          <table className="aisc-history">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Score</th>
                <th scope="col">To fix</th>
                <th scope="col">Worth a look</th>
                <th scope="col">How</th>
                <th scope="col">
                  <span style={{ position: "absolute", left: -9999 }}>Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.checks.map((row) => (
                <tr key={row.id}>
                  <td>{when(row.startedAt)}</td>
                  <td>{row.status === "done" ? row.score : row.status === "running" ? "Checking…" : "Didn't finish"}</td>
                  <td>{row.status === "done" ? row.failCount : "—"}</td>
                  <td>{row.status === "done" ? row.warnCount : "—"}</td>
                  <td>{row.trigger === "schedule" ? "Weekly" : "Check now"}</td>
                  <td>
                    {row.status === "done" ? (
                      <button type="button" className="aisc-link" onClick={() => void open(row)} aria-current={shown?.id === row.id ? "true" : undefined}>
                        {shown?.id === row.id ? "Showing" : "Show"}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { formatDate, formatMoney, formatRange } from "../format.js";
import type { ClientError } from "../http.js";
import { CameraIcon, Loading, Notice, SparkIcon, useMounted } from "../parts.js";
import { ESTIMATE_FILTERS } from "./client.js";
import { adminErrorText, FILTER_EMPTY, FILTER_LABEL, showsRange, SOURCE_LABEL, statusLabel, timeAgo } from "./helpers.js";
import type { EstimateFilter, EstimateListRow } from "./types.js";
import { AdminFrame, LoadError, useAdminBasics, useAdminTransport, type AdminChromeProps } from "./ui.js";
import type { EstimateSource } from "../types.js";

/**
 * <EstimatesQueue> — every lead and quote, newest first (contract 9.7):
 * search, the filters an office works by (Leads, Drafts, Sent, Accepted,
 * Declined, Expired, Invoiced, All, Archived — each with its count), where it
 * came from, and "Load more". A row says who, how much (a range while it's a
 * lead), where it stands (words and an icon, never colour alone), how old it
 * is, whether a photo came with it and whether the AI read it.
 *
 * Opening a row goes to `estimateHref` (a link) or `onOpen(id)`.
 */

/**
 * An href from a pattern or a function (Tenancy 2a). A server page can't pass
 * a function to a client component, so a string is a pattern whose `{id}` is
 * replaced with the encoded id: `estimateHref="/app/estimates/{id}"`.
 */
export function hrefFor(href: string | ((id: string) => string), id: string): string {
  return typeof href === "function" ? href(id) : href.split("{id}").join(encodeURIComponent(id));
}

export interface EstimatesQueueProps extends AdminChromeProps {
  onOpen?: (id: string) => void;
  /** Where a row opens: a pattern with `{id}` ("/app/estimates/{id}"), or a function. */
  estimateHref?: string | ((id: string) => string);
  /** Refresh when the window regains focus (someone answered a quote while you were away). Default true. */
  pollOnFocus?: boolean;
  /** The filter to start on. Default "leads". */
  initialFilter?: EstimateFilter;
  /**
   * Default true; false = read-only (Tenancy 2a: a company's viewer, who may
   * look at estimates but not work them): no "New estimate". The server
   * refuses the create anyway; this stops offering it. Pass
   * `can.includes("estimator.estimates.manage")`.
   */
  canManage?: boolean;
  /**
   * The heading over the list. Default "Estimates"; `false` draws none, for a
   * host page whose own header already says it (New estimate stays).
   */
  title?: string | false;
  /** The company's public estimate page, for the empty list's "Open your estimate page". */
  estimatePageUrl?: string;
}

const STATUS_ICON: Record<string, string> = { accent: "●", muted: "○", warn: "◔", ok: "✓", danger: "✕" };

export function EstimatesQueue(props: EstimatesQueueProps) {
  const transport = useAdminTransport(props.transport, props.baseUrl);
  const basics = useAdminBasics(transport);
  const ids = useId();
  const mounted = useMounted();
  const locale = props.locale ?? basics.settings?.locale ?? "en-US";
  const [filter, setFilter] = useState<EstimateFilter>(props.initialFilter ?? "leads");
  const [source, setSource] = useState<EstimateSource | "">("");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<EstimateListRow[] | null>(null);
  const [counts, setCounts] = useState<Record<EstimateFilter, number> | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const requestId = useRef(0);
  const now = Date.now();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const id = ++requestId.current;
    setError(null);
    void transport.listEstimates({ filter, ...(debounced ? { q: debounced } : {}), ...(source ? { source } : {}) }).then((res) => {
      if (id !== requestId.current || !mounted.current) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setRows(res.data.estimates);
      setCounts(res.data.counts);
      setCursor(res.data.nextCursor);
    });
  }, [transport, filter, debounced, source, tick, mounted]);

  // Someone answered a quote while staff were in another tab: catch up on return.
  useEffect(() => {
    if (props.pollOnFocus === false || typeof window === "undefined") return;
    const onFocus = () => setTick((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [props.pollOnFocus]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const id = requestId.current;
    const res = await transport.listEstimates({ filter, ...(debounced ? { q: debounced } : {}), ...(source ? { source } : {}), cursor });
    if (!mounted.current || id !== requestId.current) return;
    setLoadingMore(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRows((list) => [...(list ?? []), ...res.data.estimates]);
    setCursor(res.data.nextCursor);
  }, [cursor, loadingMore, transport, filter, debounced, source, mounted]);

  const open = (id: string) => {
    if (props.estimateHref && typeof window !== "undefined") window.location.assign(hrefFor(props.estimateHref, id));
    else props.onOpen?.(id);
  };

  const newEstimate = async () => {
    setCreating(true);
    setCreateError(null);
    const res = await transport.createEstimate({});
    if (!mounted.current) return;
    setCreating(false);
    if (!res.ok) {
      setCreateError(adminErrorText(res.error));
      return;
    }
    open(res.data.estimate.id);
  };

  const emptyText = debounced ? `Nothing matches “${debounced}”.` : FILTER_EMPTY[filter];

  return (
    <AdminFrame chrome={props} basics={basics} data={{ "aiew-queue": rows ? "ready" : error ? "error" : "loading" }}>
      <div className="aiew-admin-head" data-titled={props.title === false ? undefined : ""}>
        {props.title === false ? null : <h2 className="aiew-admin-title">{props.title ?? "Estimates"}</h2>}
        {props.canManage !== false ? (
          <button type="button" className="aiew-btn aiew-btn-primary" onClick={() => void newEstimate()} disabled={creating} aria-busy={creating || undefined}>
            {creating ? "Starting…" : "New estimate"}
          </button>
        ) : null}
      </div>
      {createError ? <Notice tone="error">{createError}</Notice> : null}
      <div className="aiew-search" role="search">
        <label className="aiew-sr" htmlFor={`${ids}-q`}>
          Search estimates
        </label>
        <input
          id={`${ids}-q`}
          className="aiew-input"
          type="search"
          placeholder="Search by name, email, phone, address or number"
          maxLength={100}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="aiew-sr" htmlFor={`${ids}-source`}>
          Where it came from
        </label>
        <select id={`${ids}-source`} className="aiew-input" value={source} onChange={(event) => setSource(event.target.value as EstimateSource | "")}>
          <option value="">From anywhere</option>
          {(Object.keys(SOURCE_LABEL) as EstimateSource[]).map((key) => (
            <option key={key} value={key}>
              {SOURCE_LABEL[key]}
            </option>
          ))}
        </select>
      </div>
      <div className="aiew-chips" role="group" aria-label="Show" data-aiew-filters="">
        {ESTIMATE_FILTERS.map((key) => (
          <button key={key} type="button" className="aiew-filter" aria-pressed={filter === key} data-filter={key} onClick={() => setFilter(key)}>
            {FILTER_LABEL[key]}
            {counts ? <span className="aiew-count">{counts[key]}</span> : null}
          </button>
        ))}
      </div>
      {error ? <LoadError error={error} onRetry={() => setTick((n) => n + 1)} /> : null}
      {!rows && !error ? <Loading label="Loading estimates…" /> : null}
      {rows && rows.length === 0 ? (
        !debounced && !source && (filter === "leads" || filter === "all") && counts !== null && counts.all === 0 ? (
          // A new company's first look: what this list does once it's in use,
          // and the one thing that puts a row here.
          <div className="aiew-empty aiew-empty-card" data-aiew-empty={filter}>
            <p className="aiew-empty-title">No estimate requests yet</p>
            <p className="aiew-empty-text">
              Once your estimate page is out there, customers price their own job in about a minute. Every request lands here with
              their answers and photos, ready to turn into a quote you send with one click.
            </p>
            <div className="aiew-empty-actions">
              {props.estimatePageUrl ? (
                <a className="aiew-btn aiew-btn-primary" href={props.estimatePageUrl} target="_blank" rel="noreferrer">
                  Open your estimate page
                </a>
              ) : null}
              {props.canManage !== false ? (
                <button type="button" className={`aiew-btn ${props.estimatePageUrl ? "aiew-btn-secondary" : "aiew-btn-primary"}`} onClick={() => void newEstimate()} disabled={creating}>
                  Write one yourself
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <p className="aiew-empty" data-aiew-empty={filter}>
            {emptyText}
          </p>
        )
      ) : null}
      {rows && rows.length > 0 ? (
        <ul className="aiew-rows" aria-label={`${FILTER_LABEL[filter]} estimates`}>
          {rows.map((row) => (
            <li key={row.id}>
              <QueueRow row={row} locale={locale} now={now} href={props.estimateHref ? hrefFor(props.estimateHref, row.id) : undefined} onOpen={() => open(row.id)} />
            </li>
          ))}
        </ul>
      ) : null}
      {cursor ? (
        <button type="button" className="aiew-btn aiew-btn-secondary" onClick={() => void loadMore()} disabled={loadingMore} aria-busy={loadingMore || undefined}>
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </AdminFrame>
  );
}

function QueueRow({ row, locale, now, href, onOpen }: { row: EstimateListRow; locale: string; now: number; href?: string; onOpen: () => void }) {
  const status = statusLabel(row);
  const amount = showsRange(row) ? formatRange(row.rangeLow, row.rangeHigh, row.currency, locale) : formatMoney(row.total, row.currency, locale);
  const content = (
    <>
      <span className="aiew-qrow-main">
        <span className="aiew-qrow-who">
          {row.customerName || row.customerEmail || "No name yet"} <span className="aiew-muted">· {row.number}</span>
        </span>
        <span className="aiew-qrow-meta">
          <span>{timeAgo(row.createdAt, now, locale)}</span>
          <span>{SOURCE_LABEL[row.source]}</span>
          {row.jobAddress ? <span>{row.jobAddress}</span> : null}
          {row.photoCount > 0 ? (
            <span className="aiew-tag" title={`${row.photoCount} photo${row.photoCount === 1 ? "" : "s"}`}>
              <CameraIcon />
              {row.photoCount}
              <span className="aiew-sr"> photo{row.photoCount === 1 ? "" : "s"}</span>
            </span>
          ) : null}
          {row.hasReading ? (
            <span className="aiew-tag aiew-tag-accent">
              <SparkIcon />
              AI read
            </span>
          ) : null}
          {(row.status === "sent" || row.status === "viewed") && row.validUntil ? <span>Good until {formatDate(row.validUntil, locale)}</span> : null}
        </span>
      </span>
      <span className="aiew-qrow-side">
        <span className="aiew-qrow-amount">{amount}</span>
        <span className={`aiew-tag aiew-tag-${status.tone}`} data-aiew-status={row.status}>
          <span aria-hidden="true">{STATUS_ICON[status.tone]}</span>
          {status.label}
        </span>
      </span>
    </>
  );
  return href ? (
    <a className="aiew-qrow" href={href} data-aiew-row={row.id}>
      {content}
    </a>
  ) : (
    <button type="button" className="aiew-qrow" onClick={onOpen} data-aiew-row={row.id}>
      {content}
    </button>
  );
}

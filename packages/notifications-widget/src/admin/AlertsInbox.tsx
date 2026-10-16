import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { channelName, openAlertsChannel, type AlertsChannel } from "../channel.js";
import { createAlertsClient, type AlertsTransport } from "../client.js";
import { go, safeHref } from "../href.js";
import type { AlertWire } from "../types.js";
import { AlertItem, Root, Spinner, type ChromeProps } from "../ui.js";
import { ALERTS, ALL_READ, dayHeading, EMPTY, EMPTY_UNREAD, LOAD_MORE, MARK_ALL, NOT_ON_A_LIST, SETTINGS, TRY_AGAIN } from "./words.js";

/**
 * `<AlertsInbox>` (Tenancy 2b-1, section 5): the full alerts page.
 *
 *   <AlertsInbox baseUrl={`/api/app/${companyId}/alerts`} />
 *
 * All / Unread, grouped by day ("Today", "Yesterday", "Mon, Nov 2"), "Load
 * more", "Mark all as read" and a link to Alert settings. Choosing an alert
 * follows the bell's rule (marked read, then its page on this site only). It
 * shares the bell's channel, so the header's badge follows what is read here,
 * and a mark in another tab reloads this list.
 */

export interface AlertsInboxProps extends ChromeProps {
  baseUrl?: string;
  transport?: AlertsTransport;
  locale?: string;
  /**
   * Leave out the "Alerts" heading and its "Alert settings" link: for a page
   * whose own header already shows both (review BO-11). "Mark all as read"
   * stays.
   */
  hideTitle?: boolean;
}

const PAGE = 20;

interface Loaded {
  alerts: AlertWire[];
  nextCursor: string | null;
  unread: number;
  reachable: boolean;
  settings: string | null;
}

export function AlertsInbox({ baseUrl, transport: given, locale, hideTitle, theme, nonce, className, style }: AlertsInboxProps) {
  const transport = useMemo(() => given ?? (baseUrl ? createAlertsClient({ baseUrl }) : null), [given, baseUrl]);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const channelRef = useRef<AlertsChannel | null>(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const load = useCallback(
    async (which: "all" | "unread", cursor?: string) => {
      if (!transport) return;
      setBusy(true);
      const answer = await transport.list({ unread: which === "unread", limit: PAGE, ...(cursor ? { cursor } : {}) });
      setBusy(false);
      if (!answer.ok) {
        setError(answer.error.message);
        return;
      }
      setError(null);
      setLoaded((current) => ({
        alerts: cursor && current ? [...current.alerts, ...answer.data.alerts.filter((a) => !current.alerts.some((b) => b.id === a.id))] : answer.data.alerts,
        nextCursor: answer.data.nextCursor,
        unread: answer.data.unread,
        reachable: answer.data.reachable,
        settings: safeHref(answer.data.links.settings) ? answer.data.links.settings : null,
      }));
    },
    [transport],
  );

  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  useEffect(() => {
    if (!transport) return;
    const channel = openAlertsChannel(channelName(baseUrl), () => void load(filterRef.current));
    channelRef.current = channel;
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [transport, baseUrl, load]);

  const choose = async (alert: AlertWire) => {
    if (!transport) return;
    if (!alert.read) {
      const answer = await transport.markRead(alert.id);
      if (answer.ok) {
        channelRef.current?.post({ unread: answer.data.unread });
        setLoaded((current) =>
          current ? { ...current, unread: answer.data.unread, alerts: current.alerts.map((a) => (a.id === alert.id ? { ...a, read: true } : a)) } : current,
        );
      }
    }
    go(alert.href);
  };

  const markAll = async () => {
    if (!transport) return;
    const answer = await transport.markAllRead();
    if (!answer.ok) {
      setStatus(answer.error.message);
      return;
    }
    channelRef.current?.post({ unread: answer.data.unread });
    setStatus(ALL_READ);
    if (filterRef.current === "unread") void load("unread");
    else setLoaded((current) => (current ? { ...current, unread: answer.data.unread, alerts: current.alerts.map((a) => ({ ...a, read: true })) } : current));
  };

  const now = new Date();
  const groups: { heading: string; alerts: AlertWire[] }[] = [];
  for (const alert of loaded?.alerts ?? []) {
    const heading = dayHeading(alert.at, now, locale);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.alerts.push(alert);
    else groups.push({ heading, alerts: [alert] });
  }

  return (
    <Root theme={theme} nonce={nonce} className={className} style={style}>
      <div className="ainw-page">
        {!hideTitle || (loaded && loaded.unread > 0) ? (
          <div className="ainw-head">
            {hideTitle ? null : <h2 className="ainw-title">{ALERTS}</h2>}
            <div className="ainw-row">
              {loaded && loaded.unread > 0 ? (
                <button type="button" className="ainw-btn ainw-btn-secondary" onClick={() => void markAll()}>
                  {MARK_ALL}
                </button>
              ) : null}
              {!hideTitle && loaded?.settings ? (
                <a className="ainw-link" href={loaded.settings}>
                  {SETTINGS}
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="ainw-tabs" role="group" aria-label="Show">
          <button type="button" className="ainw-tab" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All
          </button>
          <button type="button" className="ainw-tab" aria-pressed={filter === "unread"} onClick={() => setFilter("unread")}>
            Unread
          </button>
        </div>
        <p className="ainw-status" role="status">
          {status}
        </p>
        {error ? (
          <div className="ainw-notice ainw-notice-error ainw-row">
            <span>{error}</span>
            <button type="button" className="ainw-btn ainw-btn-secondary" onClick={() => void load(filter)}>
              {TRY_AGAIN}
            </button>
          </div>
        ) : null}
        {!loaded && !error ? <Spinner label="Loading your alerts…" /> : null}
        {loaded ? (
          <div className="ainw-card ainw-card-flush">
            {loaded.alerts.length === 0 ? (
              <p className="ainw-empty">{!loaded.reachable ? NOT_ON_A_LIST : filter === "unread" ? EMPTY_UNREAD : EMPTY}</p>
            ) : (
              groups.map((group) => (
                <Fragment key={group.heading}>
                  <h3 className="ainw-h3 ainw-day">{group.heading}</h3>
                  <ul className="ainw-list">
                    {group.alerts.map((alert) => (
                      <AlertItem key={alert.id} alert={alert} now={now} locale={locale} onChoose={(a) => void choose(a)} />
                    ))}
                  </ul>
                </Fragment>
              ))
            )}
          </div>
        ) : null}
        {loaded?.nextCursor ? (
          <div>
            <button type="button" className="ainw-btn ainw-btn-secondary" disabled={busy} onClick={() => void load(filter, loaded.nextCursor ?? undefined)}>
              {LOAD_MORE}
            </button>
          </div>
        ) : null}
      </div>
    </Root>
  );
}

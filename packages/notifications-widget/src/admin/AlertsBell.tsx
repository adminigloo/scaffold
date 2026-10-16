import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { channelName, openAlertsChannel, type AlertsChannel } from "../channel.js";
import { createAlertsClient, type AlertsTransport } from "../client.js";
import { go, safeHref } from "../href.js";
import { startPoller, type Poller } from "../idle.js";
import type { AlertCountWire, AlertListWire, AlertWire } from "../types.js";
import { AlertItem, BellIcon, CrossIcon, focusables, Root, Spinner, type ChromeProps } from "../ui.js";
import { ALERTS, ALL_READ, badgeText, bellLabel, CLOSE, EMPTY, MARK_ALL, NOT_ON_A_LIST, SEE_ALL, SETTINGS, TRY_AGAIN } from "./words.js";

/**
 * `<AlertsBell>` (Tenancy 2b-1, section 5): the bell in the header with the
 * person's unread alerts in the company they are working in.
 *
 *   <AlertsBell baseUrl={`/api/app/${companyId}/alerts`} />
 *
 * - A 44 px button with the unread count as a badge (hidden at 0, "99+" past
 *   99). Its name says the count: "Alerts, 3 unread".
 * - The count is fetched on mount, every `pollMs` while the page is visible,
 *   and at once on focus and on becoming visible; after 15 idle minutes the
 *   poll slows to every 10 minutes (../idle.ts, review BO-25).
 * - A `count` answered 401 or 403 renders NOTHING and stops polling: someone
 *   who can't get alerts here sees no bell at all. A network failure keeps
 *   the last count and tries again on the next tick.
 * - Open: the latest 10, "Mark all as read", "See all alerts" and "Alert
 *   settings" when the server gives their links. A popover from 640 px; a
 *   sheet across the top of a phone, focus trapped, Escape and Close.
 * - Choosing an alert marks it read, then goes to its page, only on this
 *   site (../href.ts, review G15).
 * - Two tabs: a mark posts the new count on a BroadcastChannel; the other
 *   tabs' bells follow (../channel.ts).
 */

export interface AlertsBellProps extends ChromeProps {
  /** Where `createNotificationHandlers` is mounted, e.g. "/api/app/{companyId}/alerts". */
  baseUrl?: string;
  /** A host's own transport (a server action, tRPC); default: HTTP at `baseUrl`. */
  transport?: AlertsTransport;
  /** Background count refresh while the page is visible, in ms. Default 60000; 0 off. */
  pollMs?: number;
  /** For dates ("Mon, Nov 2"). Default the browser's. */
  locale?: string;
}

/** Below this width the list is a sheet across the top of the screen. */
export const SHEET_BELOW_PX = 640;

type ListState = { status: "idle" } | { status: "loading" } | { status: "ready"; data: AlertListWire } | { status: "error"; message: string };

export function AlertsBell({ baseUrl, transport: given, pollMs = 60_000, locale, theme, nonce, className, style }: AlertsBellProps) {
  const transport = useMemo(() => given ?? (baseUrl ? createAlertsClient({ baseUrl }) : null), [given, baseUrl]);
  const [count, setCount] = useState<AlertCountWire | null>(null);
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"popover" | "sheet">("popover");
  const [list, setList] = useState<ListState>({ status: "idle" });
  const [status, setStatus] = useState("");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const channelRef = useRef<AlertsChannel | null>(null);
  const pollerRef = useRef<Poller | null>(null);
  const openRef = useRef(false);
  openRef.current = open;
  const panelId = useId();

  const loadList = useCallback(async () => {
    if (!transport) return;
    setList((current) => (current.status === "ready" ? current : { status: "loading" }));
    const answer = await transport.list({ limit: 10 });
    if (answer.ok) {
      setList({ status: "ready", data: answer.data });
      setCount({ unread: answer.data.unread, reachable: answer.data.reachable });
    } else {
      setList({ status: "error", message: answer.error.message });
    }
  }, [transport]);

  // The count: polled, and followed across tabs.
  useEffect(() => {
    if (!transport) return;
    let alive = true;
    const poller = startPoller({
      pollMs,
      tick: async () => {
        const answer = await transport.count();
        if (!alive) return;
        if (answer.ok) {
          setCount(answer.data);
          return;
        }
        if (answer.error.status === 401 || answer.error.status === 403) {
          // Someone who can't get alerts here: no bell, and no more asking.
          setHidden(true);
          poller.stop();
        }
        // A network failure keeps the last count; the next tick tries again.
      },
    });
    pollerRef.current = poller;
    const channel = openAlertsChannel(channelName(baseUrl), (message) => {
      setCount((current) => ({ unread: message.unread, reachable: current?.reachable ?? true }));
      if (openRef.current) void loadList();
    });
    channelRef.current = channel;
    return () => {
      alive = false;
      poller.stop();
      channel.close();
      pollerRef.current = null;
      channelRef.current = null;
    };
  }, [transport, pollMs, baseUrl, loadList]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setStatus("");
    if (refocus) setTimeout(() => buttonRef.current?.focus(), 0);
  }, []);

  const toggle = () => {
    if (open) return close();
    const narrow = typeof window !== "undefined" && window.innerWidth < SHEET_BELOW_PX;
    setMode(narrow ? "sheet" : "popover");
    setOpen(true);
    void loadList();
  };

  // While open: Escape closes; a click outside closes the popover; the panel takes focus.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const onDown = (event: MouseEvent) => {
      if (mode === "sheet") return;
      if (wrapRef.current && event.target instanceof Node && !wrapRef.current.contains(event.target)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    const panel = panelRef.current;
    if (panel) (focusables(panel)[0] ?? panel).focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, mode, close]);

  /** The sheet is modal on a phone: Tab stays inside it. */
  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== "sheet" || event.key !== "Tab" || !panelRef.current) return;
    const items = focusables(panelRef.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const told = (next: AlertCountWire) => {
    setCount(next);
    channelRef.current?.post({ unread: next.unread });
  };

  const choose = async (alert: AlertWire) => {
    if (!transport) return;
    if (!alert.read) {
      const answer = await transport.markRead(alert.id);
      if (answer.ok) told(answer.data);
      setList((current) =>
        current.status === "ready"
          ? { ...current, data: { ...current.data, alerts: current.data.alerts.map((a) => (a.id === alert.id ? { ...a, read: true } : a)) } }
          : current,
      );
    }
    // Only a path on this site is followed; anything else stays marked read.
    if (go(alert.href)) close(false);
  };

  const markAll = async () => {
    if (!transport) return;
    const answer = await transport.markAllRead();
    if (!answer.ok) {
      setStatus(answer.error.message);
      return;
    }
    told(answer.data);
    setStatus(ALL_READ);
    setList((current) =>
      current.status === "ready" ? { ...current, data: { ...current.data, alerts: current.data.alerts.map((a) => ({ ...a, read: true })) } } : current,
    );
  };

  if (hidden || !transport) return null;
  const unread = count?.unread ?? 0;
  const badge = badgeText(unread);
  const now = new Date();
  const data = list.status === "ready" ? list.data : null;
  const inbox = safeHref(data?.links.inbox ?? null) ? data!.links.inbox : null;
  const settings = safeHref(data?.links.settings ?? null) ? data!.links.settings : null;

  return (
    <Root theme={theme} nonce={nonce} className={className} style={style} extraClass="ainw-bell-root" as="span">
      <span ref={wrapRef} className="ainw-bell-wrap">
        <button
          ref={buttonRef}
          type="button"
          className="ainw-bell"
          aria-label={bellLabel(unread)}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-haspopup="dialog"
          onClick={toggle}
        >
          <BellIcon />
          {badge ? (
            <span className="ainw-badge" aria-hidden="true" data-ainw-badge="">
              {badge}
            </span>
          ) : null}
        </button>
        {open ? (
          <>
            {mode === "sheet" ? <div className="ainw-backdrop" onMouseDown={() => close()} /> : null}
            <div
              ref={panelRef}
              id={panelId}
              className="ainw-panel"
              data-ainw-mode={mode}
              role="dialog"
              aria-modal={mode === "sheet" ? true : undefined}
              aria-label={ALERTS}
              tabIndex={-1}
              onKeyDown={trap}
            >
              <div className="ainw-panel-head">
                <h2 className="ainw-panel-title">{ALERTS}</h2>
                <button type="button" className="ainw-close" aria-label={CLOSE} onClick={() => close()}>
                  <CrossIcon />
                </button>
              </div>
              <div className="ainw-panel-body">
                {list.status === "loading" || list.status === "idle" ? <Spinner label="Loading your alerts…" /> : null}
                {list.status === "error" ? (
                  <div className="ainw-empty">
                    <p>{list.message}</p>
                    <button type="button" className="ainw-btn ainw-btn-secondary" onClick={() => void loadList()}>
                      {TRY_AGAIN}
                    </button>
                  </div>
                ) : null}
                {data && data.alerts.length === 0 ? <p className="ainw-empty">{data.reachable ? EMPTY : NOT_ON_A_LIST}</p> : null}
                {data && data.alerts.length > 0 ? (
                  <ul className="ainw-list">
                    {data.alerts.map((alert) => (
                      <AlertItem key={alert.id} alert={alert} now={now} locale={locale} onChoose={(a) => void choose(a)} />
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="ainw-panel-foot">
                <span className="ainw-sr" role="status">
                  {status}
                </span>
                {unread > 0 ? (
                  <button type="button" className="ainw-btn ainw-btn-link" onClick={() => void markAll()}>
                    {MARK_ALL}
                  </button>
                ) : (
                  <span />
                )}
                <span className="ainw-row">
                  {inbox ? (
                    <a className="ainw-link" href={inbox}>
                      {SEE_ALL}
                    </a>
                  ) : null}
                  {settings ? (
                    <a className="ainw-link" href={settings}>
                      {SETTINGS}
                    </a>
                  ) : null}
                </span>
              </div>
            </div>
          </>
        ) : null}
      </span>
    </Root>
  );
}

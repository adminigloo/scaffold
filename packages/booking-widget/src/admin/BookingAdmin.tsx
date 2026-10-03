import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Loading, Notice } from "../parts.js";
import { injectStyles } from "../styles.js";
import { AvailabilityPanel } from "./AvailabilityPanel.js";
import { BookingsPanel } from "./BookingsPanel.js";
import { setupChecklist, type AdminTab, type ChecklistItem } from "./helpers.js";
import { HostCard, SettingsPanel } from "./SettingsPanel.js";
import { injectAdminStyles } from "./styles.js";
import type { AdminBlackout, AdminBookingType, AdminHost, BookingAdminAdapter } from "./types.js";
import { useResource } from "./ui.js";

/**
 * <BookingAdmin> — the host's side of booking, ready to drop into any admin:
 * the calls (upcoming and past, with confirm, move, cancel and outcome),
 * when people can book (the week, time off, holidays), and the settings
 * behind the booking page (host, real calendar, feed, call types), with a
 * "Finish setting up" list above the tabs naming anything still unfinished.
 *
 * It talks to your server only through `adapter` (see ./types.ts) — wire it
 * to tRPC, server actions or fetch. Styled by itself like the widget (same
 * tokens, light and dark, no Tailwind), accessible (a real tablist, labelled
 * fields, announced results), and laid out to work from 390px up.
 */

export interface BookingAdminProps {
  adapter: BookingAdminAdapter;
  /** The heading. Default "Calls". */
  title?: string;
  /** Linked as "Open the booking page ↗" in the header. */
  bookingPageUrl?: string;
  /** The tab to open on. Default "upcoming". */
  initialTab?: AdminTab;
  /** Formatting locale. Default "en-US" (the copy is English). */
  locale?: string;
  /** Pin a theme; "auto" (default) follows prefers-color-scheme. */
  theme?: "auto" | "light" | "dark";
  className?: string;
  style?: CSSProperties;
}

const TABS: ReadonlyArray<{ key: AdminTab; label: string }> = [
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
  { key: "availability", label: "Availability" },
  { key: "settings", label: "Settings" },
];

interface Overview {
  hosts: AdminHost[];
  types: AdminBookingType[];
  blackouts: AdminBlackout[];
  holds: number | null;
}

export function BookingAdmin(props: BookingAdminProps) {
  const { adapter } = props;
  const locale = props.locale ?? "en-US";
  const [tab, setTab] = useState<AdminTab>(props.initialTab ?? "upcoming");
  const [hostId, setHostId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [weekSavedFor, setWeekSavedFor] = useState<ReadonlySet<string>>(() => new Set());
  const [defaultHours, setDefaultHours] = useState<{ hostId: string; value: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    injectStyles();
    injectAdminStyles();
  }, []);

  const overview = useResource<Overview>(async () => {
    const [hosts, types, blackouts, holds] = await Promise.all([
      adapter.listHosts(),
      adapter.listTypes(),
      adapter.listBlackouts(),
      adapter.countLiveHolds ? adapter.countLiveHolds().catch(() => null) : Promise.resolve(null),
    ]);
    return { hosts, types, blackouts, holds };
  }, "overview");

  const data = overview.data;
  const hosts = data?.hosts ?? [];
  const host = hosts.find((candidate) => candidate.id === hostId) ?? hosts[0] ?? null;
  const types = data?.types ?? [];

  // Placeholder hours: only the app knows its defaults, so the adapter says
  // — asked again whenever the overview reloads. Saving the week here
  // clears it at once, whatever the adapter answers next. Read through a ref
  // and stored only when it changes: an app that builds its adapter inline
  // hands over a new function on every render of its own, and keying on it
  // would ask the server again each time.
  const hoursRef = useRef(adapter.hoursAreDefault);
  hoursRef.current = adapter.hoursAreDefault;
  const hostKey = host ? `${host.id}:${String(host.updatedAt ?? "")}` : "";
  useEffect(() => {
    const source = hoursRef.current;
    if (!host || source === undefined) return;
    const store = (value: boolean) =>
      setDefaultHours((current) =>
        current && current.hostId === host.id && current.value === value ? current : { hostId: host.id, value },
      );
    if (typeof source === "boolean") {
      store(source);
      return;
    }
    let alive = true;
    Promise.resolve()
      .then(() => source(host))
      .then((value) => {
        if (alive) store(Boolean(value));
      })
      .catch(() => {
        if (alive) setDefaultHours(null);
      });
    return () => {
      alive = false;
    };
    // hostKey covers the host; `data` (a new object per load) covers a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey, data]);
  const hoursAreDefault =
    host !== null && !weekSavedFor.has(host.id) && defaultHours?.hostId === host.id && defaultHours.value;

  // Recomputed every render, deliberately not memoized on `host`: an
  // in-memory or cached adapter may hand back the SAME row object, updated
  // in place, and a memo keyed on its identity kept a fixed item listed.
  const checklist: ChecklistItem[] = host
    ? setupChecklist({ host, types, emailsEnabled: adapter.emailsEnabled, hoursAreDefault })
    : [];

  // A checklist button switches tab, then moves focus to the card it named
  // (its heading), scrolled into view. The card may not exist yet — "Your
  // week" renders only once the tab's own data loads, which re-renders the
  // panel, not this component — so the DOM is watched until it appears,
  // for a few seconds at most.
  useEffect(() => {
    const root = rootRef.current;
    if (!focusTarget || !root) return;
    const selector = `[data-aibk-card="${focusTarget}"] .aibk-card-title, [data-aibk-target="${focusTarget}"] .aibk-card-title`;
    const tryFocus = (): boolean => {
      const heading = root.querySelector<HTMLElement>(selector);
      if (!heading) return false;
      heading.focus();
      if (typeof heading.scrollIntoView === "function") heading.scrollIntoView({ block: "start" });
      setFocusTarget(null);
      return true;
    };
    if (tryFocus()) return;
    const observer = typeof MutationObserver === "function" ? new MutationObserver(() => void tryFocus()) : null;
    observer?.observe(root, { childList: true, subtree: true });
    const timer = setTimeout(() => setFocusTarget(null), 5000);
    return () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [focusTarget]);

  const go = (item: ChecklistItem) => {
    if (!item.action) return;
    setTab(item.action.tab);
    setFocusTarget(item.action.target);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    const target = TABS[next];
    if (!target) return;
    setTab(target.key);
    tabRefs.current[next]?.focus();
  };

  const rootClass = `aibk-root aibk-admin${props.className ? ` ${props.className}` : ""}`;
  const theme = props.theme && props.theme !== "auto" ? props.theme : undefined;

  return (
    <div className={rootClass} style={props.style} data-theme={theme} data-aibk-admin={tab} ref={rootRef}>
      <div className="aibk-admin-inner">
        <header className="aibk-admin-head">
          <div className="aibk-head">
            <h2 className="aibk-admin-title">{props.title ?? "Calls"}</h2>
            <p className="aibk-sub">
              Calls people book with you: who's coming and how, when you can be booked, and the calendar behind it.
            </p>
          </div>
          {props.bookingPageUrl ? (
            <a href={props.bookingPageUrl} target="_blank" rel="noopener noreferrer">
              Open the booking page ↗<span className="aibk-sr"> (opens in a new tab)</span>
            </a>
          ) : null}
        </header>

        {overview.loading && !data ? <Loading label="Loading…" /> : null}
        {overview.error && !data ? (
          <Notice tone="error">
            Couldn't load your booking settings: {overview.error}{" "}
            <button type="button" className="aibk-btn aibk-btn-link" onClick={overview.reload}>
              Try again
            </button>
          </Notice>
        ) : null}

        {data && host?.busySync.error ? (
          <Notice tone="warn">
            <strong>Calendar sync is failing.</strong> Your real calendar can't be read ({host.busySync.error}). Only calls
            booked here block time until it's fixed under Settings.
          </Notice>
        ) : null}
        {data && data.holds ? (
          <Notice tone="info">
            {data.holds === 1 ? "1 time is" : `${data.holds} times are`} held right now by people filling in the booking
            form. Each hold lasts a few minutes; if this number stays high, someone may be holding times to keep your
            calendar full.
          </Notice>
        ) : null}

        {checklist.length > 0 ? (
          <section className="aibk-checklist" aria-labelledby="aibk-checklist-title" data-aibk-checklist="">
            <h3 className="aibk-checklist-title" id="aibk-checklist-title">
              Finish setting up
            </h3>
            <ul className="aibk-checklist-items">
              {checklist.map((item) => (
                <li key={item.key} className="aibk-checklist-item" data-aibk-check={item.key}>
                  <span className="aibk-checklist-line">
                    <span className="aibk-checklist-dot" aria-hidden="true" />
                    <span className="aibk-checklist-text">{item.text}</span>
                  </span>
                  {item.action ? (
                    <button type="button" className="aibk-btn aibk-btn-secondary" onClick={() => go(item)}>
                      {item.action.label}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {data && !host ? (
          <HostCard adapter={adapter} host={null} onSaved={overview.reload} />
        ) : null}

        {data && host ? (
          <>
            {hosts.length > 1 ? (
              <div className="aibk-field aibk-host-pick">
                <label className="aibk-label" htmlFor="aibk-host-pick">
                  Host
                </label>
                <select id="aibk-host-pick" className="aibk-input" value={host.id} onChange={(event) => setHostId(event.target.value)}>
                  {hosts.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.displayName}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div role="tablist" aria-label="Booking admin" className="aibk-tabs">
              {TABS.map((item, index) => (
                <button
                  key={item.key}
                  ref={(element) => {
                    tabRefs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  className="aibk-tab"
                  id={`aibk-tab-${item.key}`}
                  aria-selected={tab === item.key}
                  aria-controls={`aibk-panel-${item.key}`}
                  tabIndex={tab === item.key ? 0 : -1}
                  onClick={() => setTab(item.key)}
                  onKeyDown={(event) => onTabKey(event, index)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div role="tabpanel" id={`aibk-panel-${tab}`} aria-labelledby={`aibk-tab-${tab}`} className="aibk-tabpanel">
              {tab === "upcoming" || tab === "past" ? (
                <BookingsPanel key={tab} adapter={adapter} scope={tab} types={types} locale={locale} onChanged={overview.reload} />
              ) : null}
              {tab === "availability" ? (
                <AvailabilityPanel
                  key={host.id}
                  adapter={adapter}
                  host={host}
                  blackouts={data.blackouts}
                  locale={locale}
                  onBlackoutsChanged={overview.reload}
                  onWeekSaved={() => {
                    setWeekSavedFor((current) => new Set(current).add(host.id));
                    overview.reload();
                  }}
                />
              ) : null}
              {tab === "settings" ? (
                <SettingsPanel
                  key={host.id}
                  adapter={adapter}
                  host={host}
                  hostCount={hosts.length}
                  types={types}
                  locale={locale}
                  onChanged={overview.reload}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

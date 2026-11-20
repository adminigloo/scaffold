import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  version as reactVersion,
  type AnchorHTMLAttributes,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import type { Glance, GlanceRow, GlanceSpark, GlanceTile, Tone } from "./glance.js";
import {
  CARD_SIZES,
  drawOrder,
  resizeCard,
  starCard,
  toggleCard,
  type CardSize,
  type DashboardLayout,
} from "./layout.js";
import { FeatureIcon, UiIcon } from "./ui-icons.js";
import { DASHBOARD_CSS } from "./ui-styles.js";
import type { BoardResponse, CatalogCard, GlanceResult, GlancesResponse } from "./widget.js";

export type { BoardResponse, CatalogCard, GlanceResult } from "./widget.js";

/**
 * <Dashboard />: the staff dashboard page.
 *
 * A card for each feature this person may open, each showing that feature's
 * small version (its glance): what needs them, a few counts, a short list, and
 * the way to the full page. "Customize" opens the catalog beside the cards:
 * tick a card on or off, star the one that leads the page, drag cards into
 * order (or use the arrows), pick a width. Every change saves at once, for
 * this person, on the server.
 *
 * The page never shows a card the server didn't offer, and a card's contents
 * come from the server already checked against this person's permissions.
 * Nothing here decides who may see what.
 */
export interface DashboardProps {
  /** Where the dashboard's routes are mounted, e.g. "/api/admin/dashboard". */
  readonly api: string;
  readonly title?: string;
  readonly description?: ReactNode;
  /** For tests. The browser's fetch otherwise. */
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  /**
   * The app's link, for links that don't reload the page: in a Next.js app,
   * pass `Link` from next/link (from a client component). A plain <a> otherwise.
   */
  readonly linkComponent?: LinkComponent;
}

/** Anything that renders like <a href>: next/link's Link, or a router's own. */
export type LinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;

const LinkContext = createContext<LinkComponent | null>(null);

/** Every link on the dashboard: the app's link component when it gave one. */
function Go(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }): ReactElement {
  const Link = useContext(LinkContext);
  return Link ? <Link {...props} /> : <a {...props} />;
}

interface CardState {
  readonly result?: GlanceResult;
  readonly loading: boolean;
  /** A refresh that failed while an older glance is still on show. */
  readonly refreshError?: string;
}

const STYLE_ID = "aid-dashboard-styles";
const HOISTED_STYLES = Number.parseInt(reactVersion, 10) >= 19;
const TICK_MS = 15_000;
const SAVE_DELAY_MS = 350;
const MAX_KEYS_PER_REQUEST = 40;

function DashboardStyles(): ReactElement | null {
  useEffect(() => {
    if (HOISTED_STYLES || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = DASHBOARD_CSS;
    document.head.appendChild(style);
  }, []);
  if (!HOISTED_STYLES) return null;
  return (
    <style href={STYLE_ID} precedence="medium">
      {DASHBOARD_CSS}
    </style>
  );
}

async function messageOf(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // Not JSON: the fallback says it well enough.
  }
  return fallback;
}

export function Dashboard(props: DashboardProps): ReactElement {
  return (
    <LinkContext.Provider value={props.linkComponent ?? null}>
      <DashboardPage {...props} />
    </LinkContext.Provider>
  );
}

function DashboardPage({ api, title = "Dashboard", description, fetcher }: DashboardProps): ReactElement {
  const send = useMemo(() => fetcher ?? ((input: string, init?: RequestInit) => fetch(input, init)), [fetcher]);
  const base = api.replace(/\/+$/, "");

  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [layout, setLayout] = useState<DashboardLayout | null>(null);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [customizing, setCustomizing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The last layout the server accepted, to put back if a save fails.
  const saved = useRef<DashboardLayout | null>(null);
  const pending = useRef<DashboardLayout | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inflight = useRef(new Set<string>());
  const latest = useRef<{ layout: DashboardLayout | null; board: BoardResponse | null; cards: Record<string, CardState> }>({
    layout: null,
    board: null,
    cards: {},
  });
  latest.current = { layout, board, cards };

  const catalogByKey = useMemo(() => new Map((board?.catalog ?? []).map((c) => [c.key, c])), [board]);
  const canSave = board?.storage !== "unavailable";

  const loadBoard = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await send(`${base}/v1/board`, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) {
        setLoadError(await messageOf(res, "Couldn't load your dashboard."));
        return;
      }
      const body = (await res.json()) as BoardResponse;
      saved.current = body.layout;
      setBoard(body);
      setLayout(body.layout);
    } catch {
      setLoadError("Couldn't reach the server. Check your connection, then try again.");
    }
  }, [base, send]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const loadGlances = useCallback(
    async (keys: readonly string[]) => {
      const wanted = keys.filter((key) => !inflight.current.has(key));
      if (wanted.length === 0) return;
      for (const key of wanted) inflight.current.add(key);
      setCards((prev) => {
        const next = { ...prev };
        for (const key of wanted) next[key] = { ...next[key], loading: true };
        return next;
      });
      try {
        for (let i = 0; i < wanted.length; i += MAX_KEYS_PER_REQUEST) {
          const chunk = wanted.slice(i, i + MAX_KEYS_PER_REQUEST);
          let results: readonly GlanceResult[];
          try {
            const res = await send(`${base}/v1/glances?keys=${encodeURIComponent(chunk.join(","))}`, {
              cache: "no-store",
              credentials: "same-origin",
            });
            if (!res.ok) throw new Error(await messageOf(res, "Couldn't load these cards."));
            results = ((await res.json()) as GlancesResponse).results;
          } catch (error) {
            const message = error instanceof Error && error.message ? error.message : "Couldn't load these cards.";
            const at = new Date().toISOString();
            results = chunk.map((key) => ({ key, error: message, at }));
          }
          setCards((prev) => {
            const next = { ...prev };
            for (const result of results) {
              const before = prev[result.key]?.result;
              // A failed refresh keeps the glance already on show, marked as
              // out of date, rather than blanking a card that was fine a
              // minute ago.
              next[result.key] =
                result.error && before?.glance
                  ? { result: before, loading: false, refreshError: result.error }
                  : { result, loading: false };
            }
            return next;
          });
        }
      } finally {
        for (const key of wanted) inflight.current.delete(key);
      }
    },
    [base, send],
  );

  // Cards that are on and have never loaded.
  useEffect(() => {
    if (!layout) return;
    const missing = layout.items.map((item) => item.key).filter((key) => !cards[key] && !inflight.current.has(key));
    if (missing.length > 0) void loadGlances(missing);
  }, [layout, cards, loadGlances]);

  // The clock for "updated 2 min ago", and each card's own refresh, while
  // the page is in view. A hidden tab asks nothing.
  const loadGlancesRef = useRef(loadGlances);
  loadGlancesRef.current = loadGlances;
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const { layout: l, board: b, cards: c } = latest.current;
      if (!l || !b) return;
      const at = Date.now();
      const stale = l.items
        .map((item) => item.key)
        .filter((key) => {
          const entry = b.catalog.find((card) => card.key === key);
          const last = c[key]?.result?.at;
          if (!entry || entry.refreshSeconds <= 0 || !last || c[key]?.loading) return false;
          return at - new Date(last).getTime() >= entry.refreshSeconds * 1000;
        });
      if (stale.length > 0) void loadGlancesRef.current(stale);
    };
    const timer = setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const flush = useCallback(async (keepalive = false) => {
    const sending = pending.current;
    if (!sending) return;
    pending.current = null;
    try {
      const res = await send(`${base}/v1/layout`, {
        method: "PUT",
        keepalive,
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: sending }),
      });
      if (!res.ok) throw new Error(await messageOf(res, "Couldn't save that change. Try again."));
      const body = (await res.json()) as { layout: DashboardLayout };
      saved.current = body.layout;
      // Take the server's version (it may have dropped a card this person
      // can no longer open), unless another change is already on its way.
      if (!pending.current) setLayout(body.layout);
      setSaveError(null);
    } catch (error) {
      if (pending.current) return;
      setSaveError(error instanceof Error && error.message ? error.message : "Couldn't save that change. Try again.");
      if (saved.current) setLayout(saved.current);
    }
  }, [base, send]);

  // Leaving the page inside the save delay still saves: the last change goes
  // out with keepalive, which the browser finishes after the page is gone.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const leave = () => {
      clearTimeout(saveTimer.current);
      if (pending.current) void flushRef.current(true);
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);

  /** Apply a change at once, and save it a moment later (a drag is one save, not ten). */
  const change = useCallback(
    (next: DashboardLayout) => {
      setLayout(next);
      setSaveError(null);
      if (!canSave) return;
      pending.current = next;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [canSave, flush],
  );

  const resetLayout = useCallback(async () => {
    clearTimeout(saveTimer.current);
    pending.current = null;
    try {
      const res = await send(`${base}/v1/layout`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error(await messageOf(res, "Couldn't reset your dashboard. Try again."));
      const body = (await res.json()) as { layout: DashboardLayout };
      saved.current = body.layout;
      setLayout(body.layout);
      setSaveError(null);
    } catch (error) {
      setSaveError(error instanceof Error && error.message ? error.message : "Couldn't reset your dashboard. Try again.");
    }
  }, [base, send]);

  const catalog = useMemo(() => board?.catalog ?? [], [board]);
  const toggle = (key: string, on: boolean) => layout && change(toggleCard(layout, key, on, catalog));
  // Removing a card with its X can be undone for a few seconds: the card
  // goes back where it was (and starred, if it was), and nothing else changes.
  const [removed, setRemoved] = useState<{ title: string; index: number; item: DashboardLayout["items"][number]; wasMain: boolean } | null>(null);
  const removeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const remove = (key: string) => {
    if (!layout) return;
    const index = layout.items.findIndex((item) => item.key === key);
    const item = layout.items[index];
    if (!item) return;
    setRemoved({ title: catalogByKey.get(key)?.title ?? "That card", index, item, wasMain: layout.main === key });
    clearTimeout(removeTimer.current);
    removeTimer.current = setTimeout(() => setRemoved(null), 8000);
    toggle(key, false);
  };
  const undoRemove = () => {
    if (!removed || !layout) return;
    setRemoved(null);
    if (layout.items.some((item) => item.key === removed.item.key)) return;
    const items = [...layout.items];
    items.splice(Math.min(removed.index, items.length), 0, removed.item);
    change({ ...layout, items, main: removed.wasMain ? removed.item.key : layout.main });
  };
  useEffect(() => () => clearTimeout(removeTimer.current), []);
  const star = (key: string) => layout && change(starCard(layout, layout.main === key ? null : key, catalog));
  const resize = (key: string, size: CardSize) => layout && change(resizeCard(layout, key, size));
  const refreshAll = () => layout && void loadGlances(layout.items.map((item) => item.key));

  /** Put the cards (other than the starred one, which always leads) in this order. */
  const reorder = (rest: readonly string[]) => {
    if (!layout) return;
    const byKey = new Map(layout.items.map((item) => [item.key, item]));
    const main = layout.main ? byKey.get(layout.main) : undefined;
    const items = [...(main ? [main] : []), ...rest.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : []))];
    change({ ...layout, items });
  };

  const drawn = layout ? drawOrder(layout).filter((item) => catalogByKey.has(item.key)) : [];
  const rest = drawn.map((item) => item.key).filter((key) => key !== layout?.main);

  const nudge = (key: string, by: -1 | 1) => {
    const at = rest.indexOf(key);
    const to = at + by;
    if (at < 0 || to < 0 || to >= rest.length) return;
    const next = [...rest];
    [next[at], next[to]] = [next[to]!, next[at]!];
    reorder(next);
  };

  // Dragging, while customising: hold a card's grip and move it over another
  // card; it lands before or after that one, by which half the pointer is
  // over. Pointer events rather than the browser's drag and drop, so it works
  // the same with a mouse, a finger and a pen; the arrows in each card's
  // arranging strip do the same from the keyboard. Only the order changes.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; side: "before" | "after" } | null>(null);
  // The same, read by the handlers: a fast drag can release the pointer
  // before React has drawn the last move, and the drop must be where the
  // pointer actually was, not where the last render thought it was.
  const drag = useRef<{ key: string | null; drop: { key: string; side: "before" | "after" } | null }>({ key: null, drop: null });
  const dragStart = (event: ReactPointerEvent<HTMLElement>, key: string) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { key, drop: null };
    setDragKey(key);
    setDrop(null);
  };
  const dragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const moving = drag.current.key;
    if (!moving) return;
    const under = typeof document.elementFromPoint === "function" ? document.elementFromPoint(event.clientX, event.clientY) : null;
    const target = under instanceof Element ? under.closest<HTMLElement>(".aid-card[data-key]") : null;
    const key = target?.dataset.key;
    let next: { key: string; side: "before" | "after" } | null = null;
    if (target && key && key !== moving) {
      const rect = target.getBoundingClientRect();
      next = { key, side: event.clientX - rect.left < rect.width / 2 ? "before" : "after" };
    }
    const was = drag.current.drop;
    if (was?.key === next?.key && was?.side === next?.side) return;
    drag.current = { key: moving, drop: next };
    setDrop(next);
  };
  const dragEnd = (commit: boolean) => {
    const { key: moving, drop: landing } = drag.current;
    drag.current = { key: null, drop: null };
    if (commit && moving && landing && layout && landing.key !== moving) {
      const order = rest.filter((k) => k !== moving);
      // The starred card always leads, so dropping on it means "first after it".
      const target = landing.key === layout.main ? 0 : order.indexOf(landing.key) + (landing.side === "after" ? 1 : 0);
      order.splice(Math.max(0, target), 0, moving);
      reorder(order);
    }
    setDragKey(null);
    setDrop(null);
  };

  const lastUpdated = useMemo(() => {
    const times = Object.values(cards)
      .map((card) => card.result?.at)
      .filter((at): at is string => typeof at === "string")
      .map((at) => new Date(at).getTime());
    return times.length > 0 ? Math.max(...times) : null;
  }, [cards]);

  return (
    <div className="aid-root" data-customizing={customizing ? "true" : "false"}>
      <DashboardStyles />
      <div className="aid-top">
        <div>
          <h1 className="aid-title">{title}</h1>
          {description ? <p className="aid-lede">{description}</p> : null}
        </div>
        <div className="aid-top-actions">
          {lastUpdated ? <span className="aid-stamp">Updated {sinceText(lastUpdated, now)}</span> : null}
          <button type="button" className="aid-btn" onClick={refreshAll} disabled={!layout || layout.items.length === 0}>
            <UiIcon name="refresh" size={15} />
            Refresh
          </button>
          <button
            type="button"
            className="aid-btn"
            aria-expanded={customizing}
            aria-controls={customizing ? "aid-catalog" : undefined}
            onClick={() => setCustomizing((open) => !open)}
            disabled={!board}
          >
            <UiIcon name={customizing ? "check" : "customize"} size={15} />
            {customizing ? "Done" : "Customize"}
          </button>
        </div>
      </div>

      {saveError ? (
        <div className="aid-notice" data-tone="bad" role="alert">
          <UiIcon name="bad" size={16} />
          <p>{saveError}</p>
        </div>
      ) : null}
      {removed ? (
        <div className="aid-notice" data-tone="info" role="status">
          <p>
            {removed.title} is off your dashboard. It's in Customize whenever you want it back.
          </p>
          <button
            type="button"
            className="aid-btn"
            onClick={undoRemove}
          >
            Undo
          </button>
        </div>
      ) : null}
      {board?.storage === "unavailable" ? (
        <div className="aid-notice" role="status">
          <UiIcon name="warn" size={16} />
          <p>
            Changes to this layout last until you leave the page: the table that keeps them isn't in the database yet.
            Run the migrations to keep them.
          </p>
        </div>
      ) : null}

      {loadError ? (
        <div className="aid-blank" role="alert">
          <h2>Couldn't load your dashboard</h2>
          <p>{loadError}</p>
          <button type="button" className="aid-btn" onClick={() => void loadBoard()}>
            Try again
          </button>
        </div>
      ) : !board || !layout ? (
        <div className="aid-grid" aria-busy="true" aria-label="Loading your dashboard">
          {[0, 1, 2].map((n) => (
            <div key={n} className="aid-card" data-size={n === 0 ? "m" : "s"}>
              <div className="aid-content">
                <div className="aid-skel">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="aid-body">
          <div className="aid-gridwrap">
            {drawn.length === 0 ? (
              <div className="aid-blank">
                <h2>{catalog.length === 0 ? "No cards for your role yet" : "Your dashboard is empty"}</h2>
                <p>
                  {catalog.length === 0
                    ? "Cards appear here for the parts of the site your staff role can open."
                    : "Choose the cards you want to keep an eye on. Each one shows what needs you in one part of the site, and opens its full page."}
                </p>
                {catalog.length > 0 && !customizing ? (
                  <button type="button" className="aid-btn aid-btn-primary" onClick={() => setCustomizing(true)}>
                    Choose cards
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="aid-grid">
                {drawn.map((item) => {
                  const entry = catalogByKey.get(item.key)!;
                  const isMain = item.key === layout.main;
                  const at = rest.indexOf(item.key);
                  return (
                    <Card
                      key={item.key}
                      entry={entry}
                      size={item.size}
                      main={isMain}
                      state={cards[item.key]}
                      now={now}
                      customizing={customizing}
                      dragging={dragKey === item.key}
                      dropSide={drop?.key === item.key ? drop.side : null}
                      canEarlier={!isMain && at > 0}
                      canLater={!isMain && at >= 0 && at < rest.length - 1}
                      onRefresh={() => void loadGlances([item.key])}
                      onRemove={() => remove(item.key)}
                      onStar={() => star(item.key)}
                      onResize={(size) => resize(item.key, size)}
                      onEarlier={() => nudge(item.key, -1)}
                      onLater={() => nudge(item.key, 1)}
                      onGripDown={(event) => dragStart(event, item.key)}
                      onGripMove={dragMove}
                      onGripUp={() => dragEnd(true)}
                      onGripCancel={() => dragEnd(false)}
                    />
                  );
                })}
              </div>
            )}
          </div>
          {customizing ? (
            <Catalog
              catalog={catalog}
              layout={layout}
              onToggle={toggle}
              onStar={star}
              onReset={() => void resetLayout()}
              onDone={() => setCustomizing(false)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ cards */

interface CardProps {
  readonly entry: CatalogCard;
  readonly size: CardSize;
  readonly main: boolean;
  readonly state: CardState | undefined;
  readonly now: number;
  readonly customizing: boolean;
  readonly dragging: boolean;
  readonly dropSide: "before" | "after" | null;
  readonly canEarlier: boolean;
  readonly canLater: boolean;
  readonly onRefresh: () => void;
  readonly onRemove: () => void;
  readonly onStar: () => void;
  readonly onResize: (size: CardSize) => void;
  readonly onEarlier: () => void;
  readonly onLater: () => void;
  readonly onGripDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onGripMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onGripUp: () => void;
  readonly onGripCancel: () => void;
}

const SIZE_NAMES: Record<CardSize, string> = { s: "Small", m: "Medium", l: "Large" };

function Card(props: CardProps): ReactElement {
  const { entry, size, main, state, now, customizing } = props;
  const headingId = `aid-card-${entry.key.replace(/[^a-z0-9-]/gi, "-")}`;
  const glance = state?.result?.glance;
  const attention = glance?.attention ?? 0;
  const link = glance?.link ?? { href: entry.href, label: `Open ${entry.title}` };

  return (
    <section
      className="aid-card"
      aria-labelledby={headingId}
      data-size={size}
      data-main={main ? "true" : "false"}
      data-dragging={props.dragging ? "true" : undefined}
      data-drop={props.dropSide ?? undefined}
      data-key={entry.key}
    >
      <header className="aid-head">
        {customizing && !main ? (
          <span
            className="aid-grip"
            aria-hidden="true"
            title="Drag to move"
            onPointerDown={props.onGripDown}
            onPointerMove={props.onGripMove}
            onPointerUp={props.onGripUp}
            onPointerCancel={props.onGripCancel}
          >
            <UiIcon name="grip" size={16} />
          </span>
        ) : null}
        <span className="aid-ico">
          <FeatureIcon name={entry.icon} size={16} />
        </span>
        <div className="aid-names">
          <h2 className="aid-name" id={headingId}>
            <Go href={entry.href}>{entry.title}</Go>
          </h2>
          <p className="aid-section">{main ? `${entry.section} · starred` : entry.section}</p>
        </div>
        {attention > 0 ? (
          <span className="aid-attn" title={`${attention} need${attention === 1 ? "s" : ""} you`}>
            {attention > 99 ? "99+" : attention}
            <span className="aid-sr"> need{attention === 1 ? "s" : ""} you</span>
          </span>
        ) : null}
        <div className="aid-actions">
          {customizing ? null : (
            <>
              <button
                type="button"
                className="aid-iconbtn"
                aria-label={`Refresh ${entry.title}`}
                title="Refresh"
                onClick={props.onRefresh}
                disabled={state?.loading}
              >
                <UiIcon name="refresh" size={15} />
              </button>
              <Go className="aid-iconbtn" href={link.href} aria-label={link.label} title={link.label}>
                <UiIcon name="open" size={15} />
              </Go>
            </>
          )}
          <button
            type="button"
            className="aid-iconbtn"
            aria-label={`Remove ${entry.title} from your dashboard`}
            title="Remove from your dashboard"
            onClick={props.onRemove}
          >
            <UiIcon name="close" size={15} />
          </button>
        </div>
      </header>
      {customizing ? (
        // The arranging controls get their own strip, so a narrow card keeps
        // its title readable while it's being arranged.
        <div className="aid-editbar" role="group" aria-label={`Arrange ${entry.title}`}>
          <button
            type="button"
            className="aid-chipbtn"
            aria-pressed={main}
            aria-label={main ? `Unstar ${entry.title}` : `Star ${entry.title}: show it first, larger`}
            title={main ? "Starred: shown first" : "Star: show it first, larger"}
            onClick={props.onStar}
          >
            <UiIcon name="star" size={14} fill={main} />
            {main ? "Starred" : "Star"}
          </button>
          <span className="aid-sizes" role="group" aria-label={`Width of ${entry.title}`}>
            {CARD_SIZES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={size === option}
                aria-label={SIZE_NAMES[option]}
                title={SIZE_NAMES[option]}
                onClick={() => props.onResize(option)}
              >
                {option.toUpperCase()}
              </button>
            ))}
          </span>
          <span className="aid-editbar-move">
            <button
              type="button"
              className="aid-iconbtn"
              aria-label={`Move ${entry.title} earlier`}
              title="Move earlier"
              disabled={!props.canEarlier}
              onClick={props.onEarlier}
            >
              <UiIcon name="left" size={16} />
            </button>
            <button
              type="button"
              className="aid-iconbtn"
              aria-label={`Move ${entry.title} later`}
              title="Move later"
              disabled={!props.canLater}
              onClick={props.onLater}
            >
              <UiIcon name="right" size={16} />
            </button>
          </span>
        </div>
      ) : null}

      <div className="aid-content" aria-busy={state?.loading && !glance ? "true" : undefined}>
        {glance ? (
          <GlanceView glance={glance} at={state?.result?.at} />
        ) : state?.result?.error ? (
          <div className="aid-problem" role="status">
            <p>{state.result.error}</p>
            <button type="button" className="aid-btn" onClick={props.onRefresh} disabled={state.loading}>
              Try again
            </button>
          </div>
        ) : (
          <div className="aid-skel" aria-label="Loading">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <footer className="aid-foot">
        <span>
          {state?.refreshError
            ? "Couldn't refresh: showing the last figures"
            : state?.result?.at && glance
              ? `Updated ${sinceText(new Date(state.result.at).getTime(), now)}`
              : " "}
        </span>
        <Go href={link.href}>{link.label} →</Go>
      </footer>
    </section>
  );
}

/* ---------------------------------------------------------------- glances */

const TONE_ICON: Record<Tone, "good" | "warn" | "bad" | "neutral"> = {
  good: "good",
  warn: "warn",
  bad: "bad",
  neutral: "neutral",
};

/** Big standalone figures read best compact past five digits: 12.9K. */
function figure(value: number | string): string {
  if (typeof value === "string") return value;
  if (Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  return value.toLocaleString();
}

export function GlanceView({ glance, at }: { readonly glance: Glance; readonly at?: string }): ReactElement {
  if (glance.setup) {
    return (
      <div className="aid-setup">
        <p>{glance.setup.text}</p>
        {glance.setup.href ? (
          <Go className="aid-btn" href={glance.setup.href}>
            {glance.setup.label ?? "Set it up"}
          </Go>
        ) : null}
      </div>
    );
  }
  return (
    <>
      {glance.status ? (
        <p className="aid-status" data-tone={glance.status.tone}>
          <UiIcon name={TONE_ICON[glance.status.tone]} size={16} />
          <span>{glance.status.text}</span>
        </p>
      ) : null}
      {glance.tiles && glance.tiles.length > 0 ? (
        <div className="aid-tiles">
          {glance.tiles.map((tile, i) => (
            <Tile key={`${tile.label}-${i}`} tile={tile} />
          ))}
        </div>
      ) : null}
      {glance.spark ? <Spark spark={glance.spark} at={at} /> : null}
      {glance.list ? (
        <div className="aid-list">
          {glance.list.title ? <h3>{glance.list.title}</h3> : null}
          {glance.list.rows.length > 0 ? (
            <ul>
              {glance.list.rows.map((row, i) => (
                <Row key={`${row.title}-${i}`} row={row} />
              ))}
            </ul>
          ) : (
            <p className="aid-empty">{glance.list.empty ?? "Nothing to show."}</p>
          )}
        </div>
      ) : null}
      {glance.note ? <p className="aid-note">{glance.note}</p> : null}
    </>
  );
}

function Tile({ tile }: { readonly tile: GlanceTile }): ReactElement {
  const inner = (
    <>
      <span className="aid-tile-label">{tile.label}</span>
      <span className="aid-tile-value">{figure(tile.value)}</span>
      {tile.hint ? <span className="aid-tile-hint">{tile.hint}</span> : null}
    </>
  );
  return tile.href ? (
    <Go className="aid-tile" href={tile.href} data-tone={tile.tone}>
      {inner}
    </Go>
  ) : (
    <div className="aid-tile" data-tone={tile.tone}>
      {inner}
    </div>
  );
}

function Row({ row }: { readonly row: GlanceRow }): ReactElement {
  return (
    <li className="aid-row">
      {row.badge ? (
        <span className="aid-chip" data-tone={row.tone}>
          {row.badge}
        </span>
      ) : null}
      {row.href ? (
        <Go className="aid-row-title" href={row.href} title={row.title}>
          {row.title}
        </Go>
      ) : (
        <span className="aid-row-title" title={row.title}>
          {row.title}
        </span>
      )}
      {row.meta ? <span className="aid-row-meta">{row.meta}</span> : null}
    </li>
  );
}

/**
 * A small bar chart of one series by day, the latest day in the accent. Hover
 * (or focus) a day for its figure; the same figures are in a list for screen
 * readers, so the chart is never the only way to read them.
 */
function Spark({ spark, at }: { readonly spark: GlanceSpark; readonly at?: string }): ReactElement {
  const [hover, setHover] = useState<number | null>(null);
  const points = spark.points;
  const n = points.length;
  const max = Math.max(1, ...points);
  const total = points.reduce((sum, p) => sum + p, 0);
  const width = 100;
  const height = 44;
  const gap = n > 20 ? 0.6 : 1.2;
  const barWidth = (width - gap * (n - 1)) / n;
  const end = at ? new Date(at) : new Date();
  const dayLabel = (i: number) => {
    const back = n - 1 - i;
    if (back === 0) return spark.lastLabel ?? "Today";
    if (back === 1) return "Yesterday";
    const day = new Date(end.getTime() - back * 24 * 60 * 60 * 1000);
    return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const bar = (i: number, p: number) => {
    const x = i * (barWidth + gap);
    const h = p === 0 ? 0 : Math.max(2, (p / max) * (height - 4));
    const y = height - h;
    const r = Math.min(1.6, barWidth / 2, h);
    return `M${x},${height} V${y + r} Q${x},${y} ${x + r},${y} H${x + barWidth - r} Q${x + barWidth},${y} ${x + barWidth},${y + r} V${height} Z`;
  };
  const last = points[n - 1] ?? 0;
  return (
    <div className="aid-spark">
      <div className="aid-spark-head">
        <span>{spark.label}</span>
        <span>
          {spark.lastLabel ?? "Today"} <strong>{last.toLocaleString()}</strong> · {n} days <strong>{total.toLocaleString()}</strong>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${spark.label}: ${total.toLocaleString()} over ${n} days, ${last.toLocaleString()} ${
          spark.lastLabel?.toLowerCase() ?? "today"
        }`}
        onMouseLeave={() => setHover(null)}
      >
        <line className="aid-base" x1="0" x2={width} y1={height} y2={height} vectorEffect="non-scaling-stroke" />
        {points.map((p, i) => (
          <path key={i} className="aid-bar" d={bar(i, p)} data-last={i === n - 1 ? "true" : undefined} data-hover={hover === i ? "true" : undefined} />
        ))}
        {points.map((_, i) => (
          <rect
            key={`hit-${i}`}
            x={i * (barWidth + gap) - gap / 2}
            y={0}
            width={barWidth + gap}
            height={height}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null ? (
        <span className="aid-tip" style={{ left: `${((hover + 0.5) / n) * 100}%` }}>
          {dayLabel(hover)}: {(points[hover] ?? 0).toLocaleString()}
        </span>
      ) : null}
      <ul className="aid-sr">
        {points.map((p, i) => (
          <li key={i}>
            {dayLabel(i)}: {p.toLocaleString()}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- catalog */

interface CatalogProps {
  readonly catalog: readonly CatalogCard[];
  readonly layout: DashboardLayout;
  readonly onToggle: (key: string, on: boolean) => void;
  readonly onStar: (key: string) => void;
  readonly onReset: () => void;
  readonly onDone: () => void;
}

function Catalog({ catalog, layout, onToggle, onStar, onReset, onDone }: CatalogProps): ReactElement {
  const [query, setQuery] = useState("");
  const on = new Set(layout.items.map((item) => item.key));
  const q = query.trim().toLowerCase();
  const shown = q
    ? catalog.filter((card) => `${card.title} ${card.description} ${card.section}`.toLowerCase().includes(q))
    : catalog;
  // Sections in the order their first card appears, which is the sidebar's order.
  const sections: { name: string; cards: CatalogCard[] }[] = [];
  for (const card of shown) {
    let section = sections.find((s) => s.name === card.section);
    if (!section) sections.push((section = { name: card.section, cards: [] }));
    section.cards.push(card);
  }
  return (
    <aside className="aid-catalog" id="aid-catalog" aria-label="Cards you can add">
      <div className="aid-cat-head">
        <h2>Cards</h2>
        <p>
          {on.size} of {catalog.length} on. Tick a card to add it; the star shows one first, larger.
        </p>
        <input
          className="aid-search"
          type="search"
          placeholder="Find a card"
          aria-label="Find a card"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="aid-cat-list">
        {sections.length === 0 ? <p className="aid-empty" style={{ padding: "8px" }}>No card matches “{query}”.</p> : null}
        {sections.map((section) => (
          <div key={section.name} className="aid-cat-section">
            <h3>{section.name}</h3>
            {section.cards.map((card) => {
              const id = `aid-cat-${card.key.replace(/[^a-z0-9-]/gi, "-")}`;
              const starred = layout.main === card.key;
              return (
                <div key={card.key} className="aid-cat-row">
                  <input id={id} type="checkbox" checked={on.has(card.key)} onChange={(event) => onToggle(card.key, event.target.checked)} />
                  <label htmlFor={id}>
                    <span className="aid-cat-title">
                      <FeatureIcon name={card.icon} size={14} />
                      {card.title}
                    </span>
                    <span className="aid-cat-desc">{card.description}</span>
                  </label>
                  <button
                    type="button"
                    className="aid-iconbtn"
                    aria-pressed={starred}
                    aria-label={starred ? `Unstar ${card.title}` : `Star ${card.title}`}
                    title={starred ? "Starred: shown first" : "Star: show it first, larger"}
                    onClick={() => onStar(card.key)}
                  >
                    <UiIcon name="star" size={16} fill={starred} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="aid-cat-foot">
        <button type="button" className="aid-btn" onClick={onReset} title="The cards everyone starts with">
          <UiIcon name="undo" size={15} />
          Reset
        </button>
        <button type="button" className="aid-btn aid-btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ words */

function sinceText(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

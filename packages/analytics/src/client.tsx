import { useEffect, useRef, useSyncExternalStore } from "react";
import { classifySource, clickIdKindOf, referrerHostOf, SOURCE_LABELS, type SourceBucket } from "./sources.js";
import { parseUserAgent, type DeviceKind } from "./visitor.js";

export { classifySource, referrerHostOf, SOURCE_LABELS, type SourceBucket } from "./sources.js";
export { parseUserAgent, type DeviceKind } from "./visitor.js";

/**
 * The beacon — the `./client` entry. One small component the host mounts once
 * in its public shell and feeds the current pathname (`usePathname()` in Next),
 * so soft navigations count without this package knowing the router.
 *
 * What leaves the browser, per beacon: a per-document random id held in memory
 * (never a cookie or storage), the path, foreground milliseconds since the last
 * beacon, and on the first view only the referrer HOST and the query string
 * (read server-side for UTM tags and click ids, then dropped). Clicks send a
 * name and a short label; vitals send the metric, value and its id.
 *
 * It sends nothing when the browser says not to (Global Privacy Control, Do Not
 * Track), when the visitor opted out on this site (`?analytics=off`, or the
 * switch on the privacy page via `setAnalyticsOptOut`), under automation
 * (`navigator.webdriver` — test runs are not visitors), or when `disabled`.
 */

export interface AnalyticsBeaconProps {
  /** Pathname of the current page. Pass `usePathname()`. */
  path: string;
  /** The ingest route. Default `/api/analytics`. */
  endpoint?: string;
  /** Skip collection entirely, e.g. for signed-in staff. */
  disabled?: boolean;
  /**
   * Record clicks on any link or button (true), or only on elements marked
   * `data-track="name"` (false, the default). A function decides per path —
   * auto-capture public marketing pages, never an app screen with customer data.
   */
  autoClicks?: boolean | ((path: string) => boolean);
  /** Clicks inside these are never recorded. Clerk's UI and `[data-analytics-ignore]` always are. */
  ignoreSelectors?: readonly string[];
  /** Collect Core Web Vitals (LCP, INP, CLS). Default true. */
  vitals?: boolean;
}

/** Where the visit stands, for a "this visit was just counted" moment elsewhere on the page. */
export type AnalyticsVisitState =
  | { status: "idle" }
  | { status: "sent"; path: string; at: number; pageViews: number }
  | { status: "skipped"; reason: "gpc" | "dnt" | "opt-out" | "automation" | "disabled" };

export const ANALYTICS_OPT_OUT_KEY = "adminigloo:analytics-off";
const ALWAYS_IGNORE = ['[class*="cl-"]', "[data-analytics-ignore]", "input", "textarea", "select", "[contenteditable]"];
const MAX_DELTA_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Document-wide state. Module scope on purpose: StrictMode mounts twice and a
// layout can remount, but a document is one visit-in-progress with one id.
// ---------------------------------------------------------------------------

interface ActiveConfig {
  endpoint: string;
  autoClicks: boolean | ((path: string) => boolean);
  ignore: string;
}

let docId: string | null = null;
let hardLoadPath: string | null = null;
let lastSentPath: string | null = null;
let firstViewSent = false;
let currentPath = "/";
let active: ActiveConfig | null = null;
let listenersInstalled = false;
let vitalsStarted = false;
let visibleSince: number | null = null;
let bankedMs = 0;

const IDLE: AnalyticsVisitState = { status: "idle" };
let visitState: AnalyticsVisitState = IDLE;
const subscribers = new Set<() => void>();
function setVisitState(next: AnalyticsVisitState): void {
  visitState = next;
  subscribers.forEach((notify) => notify());
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 20);
}

/** Foreground milliseconds since the last beacon; resets the meter. */
function takeMs(): number {
  let ms = bankedMs;
  if (visibleSince !== null) {
    const now = performance.now();
    ms += now - visibleSince;
    visibleSince = now;
  }
  bankedMs = 0;
  return Math.max(0, Math.min(Math.round(ms), MAX_DELTA_MS));
}

function send(payload: Record<string, unknown>): void {
  if (!active || !docId) return;
  const body = JSON.stringify({ d: docId, ...payload });
  try {
    if (navigator.sendBeacon?.(active.endpoint, body)) return;
  } catch {
    /* fall through to fetch */
  }
  void fetch(active.endpoint, { method: "POST", body, keepalive: true, credentials: "same-origin", headers: { "content-type": "text/plain" } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Consent and opt-out.
// ---------------------------------------------------------------------------

function skipReason(): Extract<AnalyticsVisitState, { status: "skipped" }>["reason"] | null {
  if (typeof navigator === "undefined") return "automation";
  if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true) return "gpc";
  if (navigator.doNotTrack === "1") return "dnt";
  if (navigator.webdriver) return "automation";
  if (isAnalyticsOptedOut()) return "opt-out";
  return null;
}

/** True when this browser opted out of this site's analytics. */
export function isAnalyticsOptedOut(): boolean {
  try {
    return localStorage.getItem(ANALYTICS_OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Opt this browser out (true) or back in (false). The privacy page's switch. */
export function setAnalyticsOptOut(optOut: boolean): void {
  try {
    if (optOut) localStorage.setItem(ANALYTICS_OPT_OUT_KEY, "1");
    else localStorage.removeItem(ANALYTICS_OPT_OUT_KEY);
  } catch {
    /* storage blocked: nothing is collected without it either way */
  }
  if (optOut) setVisitState({ status: "skipped", reason: "opt-out" });
}

/** `?analytics=off` / `?analytics=on` on any page flips the opt-out — a link the site owner can hand out. */
function applyQueryOptOut(): void {
  try {
    const flag = new URLSearchParams(location.search).get("analytics");
    if (flag === "off") setAnalyticsOptOut(true);
    else if (flag === "on") setAnalyticsOptOut(false);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Page views and leave.
// ---------------------------------------------------------------------------

function referrerForBeacon(): string | undefined {
  const referrer = document.referrer;
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    // Host only — the path of the page someone came from is theirs, not ours.
    // An Android app referrer keeps its scheme, since the package IS the source.
    return url.protocol === "android-app:" ? `android-app://${url.host}` : url.host;
  } catch {
    return undefined;
  }
}

function sendPageView(path: string): void {
  const payload: Record<string, unknown> = { t: "pageview", p: path };
  const ms = takeMs();
  if (ms > 0) payload.ms = ms;
  if (!firstViewSent) {
    const referrer = referrerForBeacon();
    if (referrer) payload.r = referrer;
    if (location.search.length > 1) payload.q = location.search.slice(0, 2000);
    firstViewSent = true;
  }
  send(payload);
  lastSentPath = path;
  const pageViews = visitState.status === "sent" ? visitState.pageViews + 1 : 1;
  setVisitState({ status: "sent", path, at: Date.now(), pageViews });
}

function flushLeave(): void {
  const ms = takeMs();
  if (ms > 0 && lastSentPath) send({ t: "leave", p: lastSentPath, ms });
}

// ---------------------------------------------------------------------------
// Clicks.
// ---------------------------------------------------------------------------

function eventName(raw: string): string | null {
  let name = raw.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "_").slice(0, 40);
  if (!name) return null;
  if (!/^[a-z]/.test(name)) name = `e_${name}`.slice(0, 40);
  return name;
}

function textOf(element: Element): string | null {
  const label = element.getAttribute("aria-label") ?? (element as HTMLElement).innerText ?? element.textContent ?? "";
  const text = label.replace(/\s+/g, " ").trim().slice(0, 80);
  return text || null;
}

function onClick(event: MouseEvent): void {
  if (!active || event.button > 1) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || target.closest(active.ignore)) return;

  const tracked = target.closest("[data-track]");
  if (tracked) {
    const name = eventName(tracked.getAttribute("data-track") ?? "");
    if (name) send({ t: "event", p: currentPath, n: name, ...labelOf(tracked.getAttribute("data-track-label")) });
    return;
  }

  const auto = typeof active.autoClicks === "function" ? active.autoClicks(currentPath) : active.autoClicks;
  const link = target.closest("a[href]") as HTMLAnchorElement | null;
  if (link) {
    const href = link.getAttribute("href") ?? "";
    // mailto/tel/outbound are always worth knowing and carry nothing personal:
    // the address itself is never sent, only that the channel was used.
    if (/^mailto:/i.test(href)) return send({ t: "event", p: currentPath, n: "mailto" });
    if (/^tel:/i.test(href)) return send({ t: "event", p: currentPath, n: "tel" });
    let url: URL | null = null;
    try {
      url = new URL(link.href, location.href);
    } catch {
      url = null;
    }
    if (url && /^https?:$/.test(url.protocol) && url.host !== location.host) {
      return send({ t: "event", p: currentPath, n: "outbound", l: url.hostname.replace(/^www\./, "") });
    }
    if (link.hasAttribute("download") || (url && /\.(pdf|zip|csv|xlsx?|docx?|pptx?|dmg|exe)$/i.test(url.pathname))) {
      return send({ t: "event", p: currentPath, n: "download", ...labelOf(url?.pathname.split("/").pop() ?? null) });
    }
    if (auto) send({ t: "event", p: currentPath, n: "click", ...labelOf(textOf(link)) });
    return;
  }
  if (!auto) return;
  const button = target.closest('button, [role="button"]');
  if (button) send({ t: "event", p: currentPath, n: "click", ...labelOf(textOf(button)) });
}

function labelOf(label: string | null | undefined): { l?: string } {
  const text = label?.replace(/\s+/g, " ").trim().slice(0, 200);
  return text ? { l: text } : {};
}

// ---------------------------------------------------------------------------
// Core Web Vitals — dynamic import, so the library costs nothing until idle.
// ---------------------------------------------------------------------------

function startVitals(): void {
  if (vitalsStarted) return;
  vitalsStarted = true;
  const report = (metric: { name: string; value: number; id: string }) => {
    // A document's vitals belong to the page it LOADED on: LCP and CLS describe
    // that load, whatever soft navigations followed.
    send({ t: "event", p: hardLoadPath ?? currentPath, n: "web_vital", l: metric.name, v: metric.value, i: metric.id.slice(0, 80) });
  };
  import("web-vitals")
    .then(({ onLCP, onINP, onCLS }) => {
      onLCP(report);
      onINP(report);
      onCLS(report);
    })
    .catch(() => {
      /* vitals are a bonus; the visit still counts */
    });
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  visibleSince = document.visibilityState === "visible" ? performance.now() : null;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (visibleSince !== null) bankedMs += performance.now() - visibleSince;
      visibleSince = null;
      flushLeave();
    } else {
      visibleSince = performance.now();
    }
  });
  addEventListener("pagehide", flushLeave);
  addEventListener("pageshow", (event) => {
    // Back/forward cache restore: the page is shown again without a navigation.
    if (event.persisted && active) {
      visibleSince = performance.now();
      sendPageView(currentPath);
    }
  });
  document.addEventListener("click", onClick, { capture: true });
  document.addEventListener("auxclick", onClick, { capture: true });
}

// ---------------------------------------------------------------------------
// The component.
// ---------------------------------------------------------------------------

export function AnalyticsBeacon({ path, endpoint = "/api/analytics", disabled = false, autoClicks = false, ignoreSelectors = [], vitals = true }: AnalyticsBeaconProps): null {
  const autoRef = useRef(autoClicks);
  autoRef.current = autoClicks;
  const ignore = [...ALWAYS_IGNORE, ...ignoreSelectors].join(", ");

  useEffect(() => {
    applyQueryOptOut();
    const reason = disabled ? "disabled" : skipReason();
    if (reason) {
      active = null;
      setVisitState({ status: "skipped", reason });
      return;
    }
    docId ??= randomId();
    active = { endpoint, autoClicks: (current) => (typeof autoRef.current === "function" ? autoRef.current(current) : autoRef.current), ignore };
    installListeners();
    if (vitals) startVitals();
    return () => {
      active = null;
    };
  }, [disabled, endpoint, ignore, vitals]);

  useEffect(() => {
    currentPath = path;
    hardLoadPath ??= path;
    if (!active || path === lastSentPath) return;
    sendPageView(path);
  }, [path, disabled, endpoint]);

  return null;
}

/** Live state of this visit's beacon — e.g. to say "your visit was just counted" in a live-data panel. */
export function useAnalyticsVisit(): AnalyticsVisitState {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify);
      return () => subscribers.delete(notify);
    },
    () => visitState,
    () => IDLE,
  );
}

/**
 * How the server will file THIS visit — source bucket, device, browser — worked
 * out in the browser with the same pure classifiers ingest uses. For showing a
 * visitor their own visit ("Direct · desktop · Chrome"); it is their own data,
 * computed on their own machine, and nothing here is sent anywhere.
 */
export function describeThisVisit(): { source: SourceBucket; sourceLabel: string; referrerHost: string | null; device: DeviceKind; browser: string; os: string } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(location.search);
  const referrerHost = referrerHostOf(document.referrer, [location.host]);
  const source = classifySource({
    referrerHost,
    utmSource: params.get("utm_source"),
    utmMedium: params.get("utm_medium"),
    clickIdKind: clickIdKindOf(params),
  });
  return { source, sourceLabel: SOURCE_LABELS[source], referrerHost, ...parseUserAgent(navigator.userAgent) };
}

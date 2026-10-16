import { useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import { firstLine, timeAgo } from "./admin/words.js";
import { injectAlertsStyles } from "./styles.js";
import { useHostTheme, useStyles, type ThemeChoice } from "./theme.js";
import type { AlertWire } from "./types.js";

/**
 * The screens' building blocks: the themed root, the icons, and one alert in
 * a list (the bell and the inbox share it, so the open-and-mark rule and the
 * words are the same in both). COPIED in spirit from comms-widget's ui.tsx
 * (never imported: a widget never imports another widget package, D16).
 */

export interface ChromeProps {
  /** "auto" (default) follows the host page; "light" / "dark" pin it. */
  theme?: ThemeChoice;
  /** A CSP nonce for the injected <style>. */
  nonce?: string;
  className?: string;
  style?: CSSProperties;
}

export function Root({
  children,
  theme = "auto",
  nonce,
  className,
  style,
  extraClass,
  as = "div",
}: ChromeProps & { children: ReactNode; extraClass?: string; as?: "div" | "span" }) {
  const ref = useRef<HTMLElement | null>(null);
  const inject = useCallback(() => injectAlertsStyles(nonce ? { nonce } : {}), [nonce]);
  useStyles(inject);
  const resolved = useHostTheme(ref, theme);
  const Tag = as;
  return (
    <Tag
      ref={ref as never}
      className={`ainw-root${extraClass ? ` ${extraClass}` : ""}${className ? ` ${className}` : ""}`}
      style={style}
      data-theme={resolved}
    >
      {children}
    </Tag>
  );
}

const svg = { viewBox: "0 0 24 24", "aria-hidden": true, focusable: false, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function BellIcon() {
  return (
    <svg {...svg}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function CrossIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** One icon per category heading the 2a packages use; anything else is the bell. */
export function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case "Estimates":
      return (
        <svg {...svg}>
          <rect x="6" y="4" width="12" height="17" rx="2" />
          <path d="M9 4h6v3H9zM9 12h6M9 16h4" />
        </svg>
      );
    case "Visits":
      return (
        <svg {...svg}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      );
    case "Invoices":
      return (
        <svg {...svg}>
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
      );
    case "Messages":
      return (
        <svg {...svg}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="m3 7 9 6 9-6" />
        </svg>
      );
    case "Team":
      return (
        <svg {...svg}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 11a3 3 0 1 0 0-6M21 20c0-2.6-1.7-4.8-4-5.6" />
        </svg>
      );
    case "Files":
      return (
        <svg {...svg}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    default:
      return <BellIcon />;
  }
}

/**
 * One alert. What a customer typed (the title, the body) is rendered as TEXT,
 * never as HTML or a link (D18): React escapes it, and the only navigation is
 * the button's own, through the same-origin check.
 */
export function AlertItem({ alert, now, locale, onChoose }: { alert: AlertWire; now: Date; locale?: string; onChoose: (alert: AlertWire) => void }) {
  const preview = firstLine(alert.body);
  return (
    <li className={`ainw-item${alert.read ? "" : " ainw-unread"}`} data-ainw-alert={alert.id}>
      <button type="button" className="ainw-item-btn" onClick={() => onChoose(alert)}>
        <span className="ainw-icon" title={alert.category}>
          <CategoryIcon category={alert.category} />
        </span>
        <span className="ainw-item-text">
          <span className="ainw-item-title">
            {alert.read ? null : <span className="ainw-sr">Unread: </span>}
            {alert.title}
          </span>
          {preview ? <span className="ainw-item-body">{preview}</span> : null}
          <span className="ainw-item-when">{timeAgo(alert.at, now, locale)}</span>
        </span>
        {alert.read ? <span /> : <span className="ainw-dot" aria-hidden="true" />}
      </button>
    </li>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="ainw-loading" role="status">
      <span className="ainw-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
}

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { injectTenancyStyles } from "./styles.js";
import { useHostTheme, useStyles, type ThemeChoice } from "./theme.js";
import { W, type Noun } from "./words.js";

/**
 * The presentational pieces every component is built from: the root, icons,
 * notices, fields, the copy-a-link field and the dialog. Props in, markup out,
 * no fetching.
 */

// ---------------------------------------------------------------------------
// Props every component takes (contract 8.2)
// ---------------------------------------------------------------------------

export interface ChromeProps {
  /** "auto" (default) follows the host page, then the OS; "light" / "dark" pin it. */
  theme?: ThemeChoice;
  /** A CSP nonce for the injected <style> tag(s). */
  nonce?: string;
  className?: string;
  style?: CSSProperties;
  /** Formatting locale for dates. Default "en-US" (the copy is English). */
  locale?: string;
}

export interface NounProps {
  /** What this project calls a tenant, e.g. { singular: "shop", plural: "shops" }. Default company / companies. */
  noun?: { singular: string; plural: string };
}

// ---------------------------------------------------------------------------
// The root every component renders
// ---------------------------------------------------------------------------

/**
 * The widget root: injects the stylesheet(s) once, reads the host's theme and
 * writes it as `data-theme`. `extraStyles` is how the admin entry adds its
 * own sheet without the company entry ever importing it. The root has no card
 * chrome of its own (`.aitw-panel` is the card), so the header switcher can
 * sit in a nav bar.
 */
export function WidgetRoot({
  theme = "auto",
  nonce,
  className,
  style,
  extraClass,
  extraStyles,
  children,
  data,
}: {
  theme?: ThemeChoice;
  nonce?: string;
  className?: string;
  style?: CSSProperties;
  extraClass?: string;
  extraStyles?: (nonce?: string) => void;
  children: ReactNode;
  /** `data-*` attributes for the root (tests and host CSS hooks). */
  data?: Record<string, string | undefined>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inject = useCallback(() => {
    injectTenancyStyles(nonce ? { nonce } : {});
    extraStyles?.(nonce);
  }, [nonce, extraStyles]);
  useStyles(inject);
  const resolved = useHostTheme(ref, theme);
  const dataAttrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) if (value !== undefined) dataAttrs[`data-${key}`] = value;
  return (
    <div
      ref={ref}
      className={`aitw-root${extraClass ? ` ${extraClass}` : ""}${className ? ` ${className}` : ""}`}
      style={style}
      data-theme={resolved}
      {...dataAttrs}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons (inline: no icon font or library for a buyer to install)
// ---------------------------------------------------------------------------

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function CheckCircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.8 2.8L16.5 9.5" />
    </svg>
  );
}

export function CircleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function CrossIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9.5l6 6 6-6" />
    </svg>
  );
}

export function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 8.5v7M14 8.5v7" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type NoticeTone = "info" | "ok" | "warn" | "error";

/**
 * A message block. Errors are `role="alert"`, announced the moment they
 * appear; everything else is static text (the component's own live region
 * announces outcomes, so a notice never double-announces).
 */
export function Notice({ tone, children, live }: { tone: NoticeTone; children: ReactNode; live?: boolean }) {
  return (
    <div className={`aitw-notice aitw-notice-${tone}`} role={tone === "error" ? "alert" : live ? "status" : undefined}>
      {children}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="aitw-loading" role="status" data-aitw-loading="">
      <span className="aitw-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/**
 * The component's ONE polite status region and its alert (contract 8.13):
 * outcomes ("Role changed") are announced politely; a failed write is an
 * alert. Both regions are always in the page, so additions are announced.
 */
export function LiveRegion({ status, alert, srOnly }: { status: string; alert: string; srOnly?: boolean | "status" }) {
  // srOnly: a page whose sections show their own visible "Saved" lines only
  // needs the announcement, not a second copy of the words on screen.
  // "status" hides only the successes (they show beside the control that made
  // them) and keeps a failure visible: a long page's success line in green at
  // the bottom, far from what was pressed, read as noise (review T1-15).
  const hideStatus = srOnly === true || srOnly === "status";
  return (
    <>
      <p className={hideStatus ? "aitw-sr" : "aitw-status aitw-ok-text"} role="status" aria-live="polite" data-aitw-status="">
        {status}
      </p>
      <p className={srOnly === true ? "aitw-sr" : "aitw-status aitw-danger-text"} role="alert" data-aitw-alert="">
        {alert}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

/** A labelled field with its hint and error wired for screen readers (`${id}-hint`, `${id}-error`). */
export function Field({
  id,
  label,
  hint,
  error,
  children,
  width,
  labelId,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  width?: "full" | "half";
  labelId?: string;
}) {
  return (
    <div className="aitw-field" data-width={width} data-field={id}>
      <label className="aitw-label" htmlFor={id} id={labelId}>
        {label}
      </label>
      {children}
      {hint ? (
        <span className="aitw-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="aitw-field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** `aria-describedby` for a field: its hint (when it has one) and its error (when there is one). */
export function describedBy(id: string, hasHint: boolean, error: string | null | undefined): string | undefined {
  const ids = [hasHint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

// ---------------------------------------------------------------------------
// A link to copy (the invitation link when the email didn't go)
// ---------------------------------------------------------------------------

/**
 * Copy text to the clipboard: the async Clipboard API where allowed, else the
 * old select-and-execCommand path. False when neither worked; the text is
 * then left selected for the person to copy by hand.
 */
export async function copyText(text: string, field?: HTMLInputElement | null): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection path */
  }
  try {
    if (field && typeof document !== "undefined") {
      field.focus();
      field.select();
      return typeof document.execCommand === "function" ? document.execCommand("copy") : false;
    }
  } catch {
    /* nothing more to try */
  }
  return false;
}

/** A read-only field with a copy button: one tap selects all of a long link. */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: ReactNode }) {
  const id = useId();
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  return (
    <div className="aitw-field aitw-copy" data-aitw-copy="">
      <label className="aitw-label" htmlFor={id}>
        {label}
      </label>
      <div className="aitw-copy-row">
        <input
          id={id}
          ref={fieldRef}
          className="aitw-input aitw-copy-input"
          type="text"
          readOnly
          value={value}
          spellCheck={false}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="aitw-btn aitw-btn-secondary"
          onClick={() => void copyText(value, fieldRef.current).then((ok) => setCopied(ok ? "ok" : "failed"))}
        >
          {copied === "ok" ? W.copied : W.copyLink}
        </button>
      </div>
      {hint ? (
        <span className="aitw-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      <span className="aitw-sr" aria-live="polite">
        {copied === "ok" ? W.copiedSr : copied === "failed" ? W.copyFailed : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog (scheduling-widget's admin/ui.tsx, copied)
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && !el.hasAttribute("disabled"));
}

/** The open dialogs, innermost last: Escape closes only the one on top. */
const openDialogs: symbol[] = [];

/**
 * A modal dialog. Focus moves into it on open (the first control, or the one
 * marked `data-autofocus`), Tab and Shift+Tab stay inside it, Escape closes
 * it, and on close focus returns to whatever opened it.
 *
 * ESCAPE IS HEARD ON THE DOCUMENT, by the topmost dialog: once the focused
 * button is removed (the Remove button of a member just removed) focus falls
 * to the page, and a listener on the dialog element would hear nothing. For
 * the same reason, focus that falls out of the dialog because its element
 * went away is put back on the dialog.
 *
 * STRICTMODE. React's development double-run unmounts and remounts the dialog
 * at once; the first unmount's "give focus back to the opener" used to land
 * after the remount and pull focus out of the open dialog. Focus is handed
 * back only when the dialog is really gone.
 *
 * Rendered in place inside the widget root rather than in a portal, so it
 * inherits the widget's tokens and the host's theme; it is `position: fixed`,
 * so nothing on the page clips it.
 */
export function Dialog({
  title,
  onClose,
  children,
  describedBy: describedById,
  data,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  describedBy?: string;
  data?: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openerRef = useRef<HTMLElement | null>(null);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    if (openerRef.current === null && typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      // The opener is outside this dialog (a StrictMode re-run finds focus already inside it).
      if (active && !ref.current?.contains(active)) openerRef.current = active;
    }
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const first =
        root.querySelector<HTMLElement>("[data-autofocus]") ??
        focusables(root).find((el) => !el.classList.contains("aitw-dialog-close")) ??
        root;
      first.focus();
    }
    const id = Symbol("dialog");
    openDialogs.push(id);
    const onDocumentKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || openDialogs[openDialogs.length - 1] !== id) return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onDocumentKey);
    return () => {
      alive.current = false;
      document.removeEventListener("keydown", onDocumentKey);
      const at = openDialogs.indexOf(id);
      if (at >= 0) openDialogs.splice(at, 1);
      const target = openerRef.current;
      // After the dialog unmounts, and only if it stayed unmounted (StrictMode remounts at once).
      setTimeout(() => {
        if (!alive.current && target && target.isConnected) target.focus();
      }, 0);
    };
  }, []);

  /** Focus that fell out because its element was removed goes back to the dialog, not the page. */
  const onBlur = () => {
    setTimeout(() => {
      const root = ref.current;
      if (!alive.current || !root || !root.isConnected) return;
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) root.focus();
    }, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !ref.current) return;
    const items = focusables(ref.current);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === ref.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const dataAttrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) dataAttrs[`data-${key}`] = value;

  return (
    <div
      className="aitw-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={ref}
        className="aitw-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedById}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        {...dataAttrs}
      >
        <div className="aitw-dialog-head">
          <h2 className="aitw-dialog-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="aitw-dialog-close" aria-label={W.close} onClick={() => onCloseRef.current()}>
            <CrossIcon />
          </button>
        </div>
        <div className="aitw-dialog-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * A yes / no question in a dialog: the sentence, then the confirming button
 * (danger when it takes something away) and Cancel. The confirm button gets
 * focus on open only when it isn't destructive; for a removal, Cancel does, so
 * a stray Enter never removes anyone.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  tone = "danger",
  busy,
  error,
  onConfirm,
  onCancel,
  children,
  confirmDisabled,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
  /** The confirm button waits for a choice inside the dialog (review R2 T1BO-10). */
  confirmDisabled?: boolean;
}) {
  const bodyId = useId();
  return (
    <Dialog title={title} onClose={onCancel} describedBy={bodyId} data={{ "aitw-confirm": "" }}>
      <p id={bodyId}>{body}</p>
      {children}
      {error ? (
        <p className="aitw-danger-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="aitw-dialog-actions">
        <button type="button" className="aitw-btn aitw-btn-secondary" onClick={onCancel} data-autofocus={tone === "danger" ? "" : undefined}>
          {W.cancel}
        </button>
        <button
          type="button"
          className={`aitw-btn ${tone === "danger" ? "aitw-btn-danger" : "aitw-btn-primary"}`}
          disabled={busy || confirmDisabled}
          aria-busy={busy || undefined}
          onClick={onConfirm}
          data-autofocus={tone === "primary" ? "" : undefined}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A date as the locale writes it ("Oct 12, 2026"); "" for anything
 * unreadable. `timeZone` undefined means the viewer's own zone.
 */
export function formatDate(instant: string | null | undefined, locale = "en-US", timeZone?: string): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", ...(timeZone ? { timeZone } : {}) };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  }
}

/**
 * A date WITH the time of day ("Oct 12, 2026, 3:04 PM"): the operator's
 * activity list needs it to answer "when exactly?" (review T1-17).
 */
export function formatDateTime(instant: string | null | undefined, locale = "en-US", timeZone?: string): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", options).format(date);
  }
}

/** False on the server and on the first client render (hydration), true after. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * The zone dates are shown in: UTC until the component has mounted, then the
 * viewer's own. A server (in UTC) and a browser (in Denver) would otherwise
 * print a 9 pm join on different days, and React would throw the
 * server-rendered page away over the mismatch.
 */
export function useDateZone(): string | undefined {
  return useMounted() ? undefined : "UTC";
}

/** "Summit Window Co." → "SW": two letters for a company with no logo. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words.slice(0, 2).map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, "")][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

/** A company's logo at 24px, or its initials in a badge. Decorative: the name is always beside it. */
export function CompanyMark({ name, logoUrl }: { name: string; logoUrl: string | null }) {
  if (logoUrl) return <img className="aitw-logo-sm" src={logoUrl} alt="" width={24} height={24} />;
  return (
    <span className="aitw-initials" aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

/**
 * A full page load to `href`. Deliberately not client-side routing: after
 * creating, joining or switching a company, every server-rendered screen
 * (header, gate, page) must resolve the active company again.
 */
export function navigate(href: string): void {
  if (typeof window === "undefined") return;
  window.location.assign(href);
}

/** The noun prop with its default, for components. */
export type { Noun };

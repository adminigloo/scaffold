import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { brandStyle, injectEstimatorStyles, normalizeHex } from "./styles.js";
import { useHostTheme, useStyles, type ThemeChoice } from "./theme.js";

/**
 * The presentational pieces every component is built from. Props in, markup
 * out, no fetching — which is also what lets the tests render them to a
 * string and assert on the words a customer actually reads. The shapes are
 * scheduling-widget's (`parts.tsx`, its admin `Dialog`), copied; change both
 * or neither.
 */

// ---------------------------------------------------------------------------
// The root every component renders
// ---------------------------------------------------------------------------

/** The props every component takes (contract 9.2). */
export interface ChromeProps {
  /** "auto" (default) follows the host page, then the OS; "light" / "dark" pin it. */
  theme?: ThemeChoice;
  /** A CSP nonce for the injected <style> tag(s). */
  nonce?: string;
  className?: string;
  style?: CSSProperties;
  /** Formatting locale for money and dates. Default: the business's setting. */
  locale?: string;
}

/**
 * The widget root: injects the stylesheet(s) once, reads the host's theme and
 * writes it as `data-theme`, and brands itself with the business's colour.
 * `extraStyles` is how the admin entry adds its own sheet without the public
 * entry ever importing it.
 *
 * THE COLOUR. `accent` is the resolved choice — a `#rrggbb`, or null for the
 * stylesheet's own. Both themes' brand tokens go inline (`brandStyle`) and the
 * stylesheet picks the pair that matches the theme, so a branded widget is
 * right before hydration and follows a live theme switch.
 */
export function WidgetRoot({
  theme = "auto",
  nonce,
  className,
  style,
  extraClass,
  extraStyles,
  accent,
  children,
  data,
  as = "div",
}: {
  theme?: ThemeChoice;
  nonce?: string;
  className?: string;
  style?: CSSProperties;
  extraClass?: string;
  extraStyles?: (nonce?: string) => void;
  accent?: string | null;
  children: ReactNode;
  /** `data-*` attributes for the root (tests and host CSS hooks). */
  data?: Record<string, string | undefined>;
  as?: "div" | "span";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const inject = useCallback(() => {
    injectEstimatorStyles(nonce ? { nonce } : {});
    extraStyles?.(nonce);
  }, [nonce, extraStyles]);
  useStyles(inject);
  const resolved = useHostTheme(ref, theme);
  const colour = normalizeHex(accent);
  const dataAttrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) if (value !== undefined) dataAttrs[`data-${key}`] = value;
  const props = {
    ref: ref as never,
    className: `aiew-root${extraClass ? ` ${extraClass}` : ""}${className ? ` ${className}` : ""}`,
    style: colour ? ({ ...brandStyle(colour), ...(style ?? {}) } as CSSProperties) : style,
    "data-theme": resolved,
    ...(colour ? { "data-brand": "" } : {}),
    ...dataAttrs,
  };
  return as === "span" ? <span {...props}>{children}</span> : <div {...props}>{children}</div>;
}

/** The colour to brand with: the prop when given (null = none), else the business's setting. */
export function resolveAccent(prop: string | null | undefined, fromServer: string | null | undefined): string | null {
  if (prop === null) return null;
  return normalizeHex(prop ?? fromServer ?? null);
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * A ref for a heading (with tabIndex={-1}); focus moves to it whenever `step`
 * CHANGES — never on mount, so the widget doesn't steal focus from the page it
 * loads into. Compared against the previous value rather than a "first run"
 * flag, because StrictMode runs mount effects twice.
 */
export function useStepFocus<T extends HTMLElement>(step: unknown) {
  const ref = useRef<T | null>(null);
  const previous = useRef(step);
  useEffect(() => {
    if (Object.is(previous.current, step)) return;
    previous.current = step;
    ref.current?.focus();
  }, [step]);
  return ref;
}

/** True after mount, false after unmount: async answers check it before setting state. */
export function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

// ---------------------------------------------------------------------------
// Icons (inline: no icon font or library for a buyer to install)
// ---------------------------------------------------------------------------

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
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

export function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10H4z" />
      <circle cx="12" cy="13.2" r="3.4" />
    </svg>
  );
}

export function ChevronIcon({ direction = "right" }: { direction?: "left" | "right" | "up" | "down" }) {
  const d = { left: "M14.5 6l-6 6 6 6", right: "M9.5 6l6 6-6 6", up: "M6 14.5l6-6 6 6", down: "M6 9.5l6 6 6-6" }[direction];
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Text-sized (1em) unless a rule sizes it: unsized, an inline SVG fills its box (review EST-R11). */
export function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
      <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
    </svg>
  );
}

export function PrintIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
      <path d="M7 9V4h10v5M7 17H5v-6h14v6h-2M7 14h10v6H7z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type NoticeTone = "info" | "ok" | "warn" | "error";

/**
 * A message block. Warnings and errors are `role="alert"`, announced the
 * moment they appear; the rest are polite status messages.
 */
export function Notice({ tone, children, data }: { tone: NoticeTone; children: ReactNode; data?: string }) {
  const urgent = tone === "warn" || tone === "error";
  return (
    <div className={`aiew-notice aiew-notice-${tone}`} role={urgent ? "alert" : "status"} data-aiew-notice={data}>
      {children}
    </div>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="aiew-loading" role="status">
      <span className="aiew-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

/** A grey placeholder in the shape of the card, while the business's details load. */
export function Skeleton({ label }: { label: string }) {
  return (
    <div className="aiew-skeleton" role="status" aria-label={label} data-aiew-skeleton="">
      <span className="aiew-skeleton-bar" />
      <span className="aiew-skeleton-bar" />
      <span className="aiew-skeleton-bar" />
      <span className="aiew-skeleton-bar" />
      <span className="aiew-sr">{label}</span>
    </div>
  );
}

/** `tel:` with the digits and a leading "+" of a number as typed. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}

/**
 * The business's phone and email as links: "Call (801) 555-0143 or email
 * office@…." — `lowercase` for the middle of a sentence. Nothing when it has
 * neither.
 */
export function ContactLinks({ phone, email, lowercase }: { phone: string | null; email: string | null; lowercase?: boolean }) {
  if (!phone && !email) return null;
  return (
    <span className="aiew-contact">
      {phone ? (
        <>
          {lowercase ? "call" : "Call"} <a href={telHref(phone)}>{phone}</a>
        </>
      ) : null}
      {phone && email ? " or " : null}
      {email ? (
        <>
          {phone || lowercase ? "email" : "Email"} <a href={`mailto:${email}`}>{email}</a>
        </>
      ) : null}
      .
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

/** A labelled field with its hint and error wired for screen readers (`${id}-hint`, `${id}-error`). */
export function Field({
  id,
  label,
  optional,
  hint,
  error,
  badge,
  children,
}: {
  id: string;
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="aiew-field">
      <label className="aiew-label" htmlFor={id}>
        <span>
          {label} {optional ? <span className="aiew-optional">(optional)</span> : null}
        </span>
        {badge}
      </label>
      {children}
      {hint ? (
        <span className="aiew-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="aiew-field-error" id={`${id}-error`}>
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

/**
 * The honeypot: a field a person never sees. Off-screen rather than
 * display:none, out of the tab order, hidden from assistive tech, and never
 * autofilled.
 */
export function Honeypot({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className="aiew-hp" aria-hidden="true" data-aiew-honeypot="">
      <label htmlFor={id}>Website</label>
      <input id={id} name="website" type="text" tabIndex={-1} autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/**
 * Copy text to the clipboard: the async Clipboard API where allowed, else the
 * old select-and-execCommand path. False when neither worked; the text is
 * then left selected for the person to copy by hand.
 */
export async function copyText(text: string, field?: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
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

/** A read-only field with a copy button: one tap selects all of a long link or key. */
export const CopyField = forwardRef<HTMLDivElement, { label: string; value: string; buttonLabel: string; hint?: ReactNode }>(
  function CopyField({ label, value, buttonLabel, hint }, ref) {
    const id = useId();
    const fieldRef = useRef<HTMLInputElement | null>(null);
    const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
    return (
      <div className="aiew-field aiew-copy" data-aiew-copy="" ref={ref}>
        <label className="aiew-label" htmlFor={id}>
          {label}
        </label>
        <div className="aiew-copy-row">
          <input
            id={id}
            ref={fieldRef}
            className="aiew-input aiew-copy-input"
            type="text"
            readOnly
            value={value}
            spellCheck={false}
            aria-describedby={hint ? `${id}-hint` : undefined}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="aiew-btn aiew-btn-secondary"
            onClick={() => void copyText(value, fieldRef.current).then((ok) => setCopied(ok ? "ok" : "failed"))}
          >
            {copied === "ok" ? "Copied" : buttonLabel}
          </button>
        </div>
        {hint ? (
          <span className="aiew-hint" id={`${id}-hint`}>
            {hint}
          </span>
        ) : null}
        <span className="aiew-sr" aria-live="polite">
          {copied === "ok" ? "Copied." : copied === "failed" ? "Couldn't copy. It's selected; copy it by hand." : ""}
        </span>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([tabindex="-1"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && !el.closest(".aiew-hp") && !el.hasAttribute("disabled"));
}

/** The open dialogs, innermost last: Escape closes only the one on top. */
const openDialogs: symbol[] = [];
/** How many dialogs hold the page's scroll; the first to open saves the page's own overflow. */
let scrollLocks = 0;
let savedOverflow = "";

/**
 * A modal dialog (copied from scheduling-widget's admin Dialog; change both or
 * neither). Focus moves into it on open, Tab and Shift+Tab stay inside it,
 * Escape and a click on the backdrop close it, the page doesn't scroll behind
 * it, and on close focus returns to `returnFocus()` or to whatever had focus
 * before (the button that opened it).
 *
 * ESCAPE IS HEARD ON THE DOCUMENT, by the topmost dialog: a dialog that only
 * listened on itself went deaf once the focused button inside it was removed.
 * For the same reason, focus that falls out because its element went away is
 * put back on the dialog.
 *
 * STRICTMODE. React's development double-run unmounts and remounts at once;
 * focus is handed back only when the dialog is really gone, and the scroll
 * lock is counted, so the remount never leaves the page locked or unlocked
 * wrongly.
 *
 * Rendered in place inside a widget root rather than in a portal, so it
 * inherits the widget's tokens and the host's theme; it is `position: fixed`.
 */
export function Dialog({
  title,
  subtitle,
  onClose,
  children,
  wide,
  returnFocus,
  describedBy: described,
  labelledBy,
  hideTitle,
  data,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  returnFocus?: () => HTMLElement | null;
  describedBy?: string;
  /** Label the dialog by an element inside it instead of the head's title. */
  labelledBy?: string;
  /** The head shows only the close button (the content carries its own heading). */
  hideTitle?: boolean;
  data?: Record<string, string>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnRef = useRef(returnFocus);
  returnRef.current = returnFocus;
  const openerRef = useRef<HTMLElement | null>(null);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    if (openerRef.current === null && typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      if (active && !ref.current?.contains(active)) openerRef.current = active;
    }
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const first =
        root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root).find((el) => !el.classList.contains("aiew-dialog-close")) ?? root;
      first.focus();
    }
    const id = Symbol("dialog");
    openDialogs.push(id);
    if (scrollLocks === 0 && document.body) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    scrollLocks += 1;
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
      scrollLocks = Math.max(0, scrollLocks - 1);
      if (scrollLocks === 0 && document.body) document.body.style.overflow = savedOverflow;
      const target = returnRef.current?.() ?? openerRef.current;
      setTimeout(() => {
        if (!alive.current && target && target.isConnected) target.focus();
      }, 0);
    };
  }, []);

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
      className="aiew-backdrop"
      data-aiew-backdrop=""
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={ref}
        className={`aiew-dialog${wide ? " aiew-dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? titleId}
        aria-describedby={described}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        {...dataAttrs}
      >
        <div className="aiew-dialog-head">
          <div className={hideTitle ? "aiew-sr" : undefined}>
            <h2 className="aiew-dialog-title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <p className="aiew-dialog-sub">{subtitle}</p> : null}
          </div>
          <button type="button" className="aiew-dialog-close" aria-label="Close" onClick={() => onCloseRef.current()}>
            <CrossIcon />
          </button>
        </div>
        <div className="aiew-dialog-body">{children}</div>
      </div>
    </div>
  );
}

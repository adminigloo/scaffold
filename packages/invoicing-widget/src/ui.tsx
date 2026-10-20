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
import { brandStyle, injectInvoicingAdminStyles, injectInvoicingStyles, normalizeHex } from "./styles.js";
import { useHostTheme, useStyles, type ThemeChoice } from "./theme.js";

/**
 * The pieces every screen is built from: the themed (and, on the customer's
 * page, branded) root and an accessible dialog. COPIED in spirit from
 * @adminigloo/scheduling-widget and estimator-widget; never imported.
 */

export interface ChromeProps {
  /** "auto" (default) follows the host page; "light" / "dark" pin it. */
  theme?: ThemeChoice;
  /** A CSP nonce for the injected <style>. */
  nonce?: string;
  className?: string;
  style?: CSSProperties;
  /** Formatting locale for money and dates. Default: the business's. */
  locale?: string;
}

export function Root({
  children,
  theme = "auto",
  nonce,
  className,
  style,
  admin = false,
  accent,
  data,
}: Omit<ChromeProps, "locale"> & { children: ReactNode; admin?: boolean; accent?: string | null; data?: Record<string, string> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inject = useCallback(
    () => (admin ? injectInvoicingAdminStyles(nonce ? { nonce } : {}) : injectInvoicingStyles(nonce ? { nonce } : {})),
    [nonce, admin],
  );
  useStyles(inject);
  const resolved = useHostTheme(ref, theme);
  const colour = normalizeHex(accent);
  const dataAttrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) dataAttrs[`data-${key}`] = value;
  return (
    <div
      ref={ref}
      className={`aiiw-root${admin ? " aiiw-admin" : ""}${className ? ` ${className}` : ""}`}
      style={colour ? ({ ...brandStyle(colour), ...(style ?? {}) } as CSSProperties) : style}
      data-theme={resolved}
      {...(colour ? { "data-brand": "" } : {})}
      {...dataAttrs}
    >
      {children}
    </div>
  );
}

export function CrossIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function Loading({ text }: { text: string }) {
  return (
    <div className="aiiw-loading">
      <span className="aiiw-spinner" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
}

const openDialogs: symbol[] = [];

/**
 * A modal dialog: focus moves in, Tab stays inside, Escape (heard on the
 * document by the topmost dialog) closes it, and focus goes back to whatever
 * opened it once the dialog is really gone (StrictMode remounts at once).
 */
export function Dialog({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
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
      if (active && !ref.current?.contains(active)) openerRef.current = active;
    }
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root).find((el) => !el.classList.contains("aiiw-dialog-close")) ?? root;
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
      setTimeout(() => {
        if (!alive.current && target && target.isConnected) target.focus();
      }, 0);
    };
  }, []);

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

  return (
    <div
      className="aiiw-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div ref={ref} className="aiiw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="aiiw-dialog-head">
          <h2 className="aiiw-dialog-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="aiiw-dialog-close" aria-label="Close" onClick={() => onCloseRef.current()}>
            <CrossIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A labelled input with its error, wired for screen readers. */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="aiiw-field">
      <label className="aiiw-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint ? (
        <span className="aiiw-hint" id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="aiiw-field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** aria-* for an input inside a <Field>. */
export function fieldAria(id: string, error: string | null | undefined, hint?: boolean) {
  const described = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return {
    id,
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(described ? { "aria-describedby": described } : {}),
  };
}

/** One thing left to finish, for <SetupCard>. */
export interface SetupItem {
  readonly code: string;
  /** What an owner reads. */
  readonly text: string;
  /** Where to fix it (owner items only). */
  readonly href?: string | null;
  /** The site operator's job (email, file storage): no link, grouped apart. */
  readonly operator?: boolean;
  /** The technical detail, shown only with `showTechnical` (staff of the site). */
  readonly detail?: string | null;
}

const SETUP_DISMISS_KEY = "aiiw-setup-dismissed";

/**
 * The page's ONE setup card: "2 things to finish", collapsed until opened,
 * dismissible until the list changes. Owner jobs first with where to fix
 * them; the operator's after, in plain words.
 */
export function SetupCard({ items, showTechnical = false }: { items: readonly SetupItem[]; showTechnical?: boolean }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const signature = items.map((item) => item.code).join(",");
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissed(typeof localStorage === "undefined" ? null : localStorage.getItem(SETUP_DISMISS_KEY));
    } catch {
      setDismissed(null);
    }
  }, []);
  if (items.length === 0 || dismissed === signature) return null;
  const owner = items.filter((item) => !item.operator);
  const operator = items.filter((item) => item.operator);
  const dismiss = () => {
    try {
      localStorage.setItem(SETUP_DISMISS_KEY, signature);
    } catch {
      // Private mode: dismissed for this view only.
    }
    setDismissed(signature);
  };
  const row = (item: SetupItem) => (
    <li key={item.code} data-aiiw-notice={item.code} data-operator={item.operator ? "" : undefined}>
      {item.href && !item.operator ? <a href={item.href}>{item.text}</a> : item.text}
      {showTechnical && item.detail ? <span className="aiiw-setup-detail">{item.detail}</span> : null}
    </li>
  );
  return (
    <section className="aiiw-setup" data-aiiw-setup="" aria-label="Things to finish">
      <div className="aiiw-setup-head">
        <button type="button" className="aiiw-setup-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          <span className="aiiw-setup-count" aria-hidden="true">
            {items.length}
          </span>
          <span className="aiiw-setup-title">{items.length === 1 ? "1 thing to finish" : `${items.length} things to finish`}</span>
          <svg className="aiiw-setup-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={open ? "M6 14.5l6-6 6 6" : "M6 9.5l6 6 6-6"} />
          </svg>
        </button>
        <button type="button" className="aiiw-setup-dismiss" aria-label="Dismiss until something changes" onClick={dismiss}>
          <CrossIcon />
        </button>
      </div>
      <div id={panelId} className="aiiw-setup-body" hidden={!open}>
        {owner.length > 0 ? <ul className="aiiw-setup-list">{owner.map(row)}</ul> : null}
        {operator.length > 0 ? (
          <>
            <p className="aiiw-setup-sub">Waiting on whoever runs this site</p>
            <ul className="aiiw-setup-list">{operator.map(row)}</ul>
          </>
        ) : null}
      </div>
    </section>
  );
}

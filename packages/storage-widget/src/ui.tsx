import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { injectFilesStyles } from "./styles.js";
import { useHostTheme, useStyles, type ThemeChoice } from "./theme.js";

/**
 * The screens' building blocks: the themed root, an accessible dialog and the icons.
 * COPIED from @adminigloo/comms-widget's ui.tsx (never
 * imported, so the widget installs alone).
 */

export interface ChromeProps {
  /** "auto" (default) follows the host page; "light" / "dark" pin it. */
  theme?: ThemeChoice;
  /** A CSP nonce for the injected <style>. */
  nonce?: string;
  className?: string;
  style?: CSSProperties;
}

export function Root({ children, theme = "auto", nonce, className, style }: ChromeProps & { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inject = useCallback(() => injectFilesStyles(nonce ? { nonce } : {}), [nonce]);
  useStyles(inject);
  const resolved = useHostTheme(ref, theme);
  return (
    <div ref={ref} className={`aifw-root${className ? ` ${className}` : ""}`} style={style} data-theme={resolved}>
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
}

/** The open dialogs, innermost last: Escape closes only the one on top. */
const openDialogs: symbol[] = [];

/**
 * A modal dialog: focus moves in on open, Tab stays inside, Escape (heard on
 * the document, by the topmost dialog) closes it, and focus goes back to
 * whatever opened it. Rendered in place, inside the widget root, so it keeps
 * the widget's tokens and theme; `position: fixed` keeps it on screen.
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
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root).find((el) => !el.classList.contains("aifw-dialog-close")) ?? root;
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
      // Only once the dialog stayed unmounted: StrictMode remounts at once.
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
      className="aifw-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div ref={ref} className="aifw-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="aifw-dialog-head">
          <h2 className="aifw-dialog-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="aifw-dialog-close" aria-label="Close" onClick={() => onCloseRef.current()}>
            <CrossIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A document's icon: a page with a folded corner. */
export function DocumentIcon() {
  return (
    <svg className="aifw-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 3h7l5 5v13H7z M14 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** A photo's icon (a HEIC shown as a row: the browser can't draw it). */
export function PhotoIcon() {
  return (
    <svg className="aifw-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" fill="none" />
      <path d="M3 16l5-5 4 4 3-3 6 6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="aifw-loading" role="status">
      <span className="aifw-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

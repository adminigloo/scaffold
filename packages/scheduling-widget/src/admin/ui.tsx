import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { Result } from "../http.js";
import { CrossIcon, WidgetRoot, type ChromeProps } from "../parts.js";
import { createSchedulingAdminClient, type SchedulingAdminTransport } from "./client.js";
import { injectSchedulingAdminStyles } from "./styles.js";
import type { AdminNotice, AdminStatus } from "./types.js";

/**
 * The staff screens' building blocks: the root, the transport choice, an
 * accessible dialog (focus trapped, Escape closes, focus goes back where it
 * came from), toasts announced politely, and a switch.
 */

// ---------------------------------------------------------------------------
// Root and transport
// ---------------------------------------------------------------------------

export function AdminRoot({ children, data, ...chrome }: ChromeProps & { children: ReactNode; data?: Record<string, string | undefined> }) {
  return (
    <WidgetRoot
      theme={chrome.theme}
      nonce={chrome.nonce}
      className={chrome.className}
      style={chrome.style}
      extraClass="aisw-admin"
      extraStyles={injectAdminWithNonce}
      data={data}
    >
      {children}
    </WidgetRoot>
  );
}

function injectAdminWithNonce(nonce?: string) {
  injectSchedulingAdminStyles(nonce ? { nonce } : {});
}

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This screen isn't connected to the scheduling server yet.", status: 0 },
};

function missingAdminTransport(): SchedulingAdminTransport {
  const fail = () => Promise.resolve(MISSING);
  return new Proxy({} as SchedulingAdminTransport, { get: () => fail });
}

/** `transport` wins over `baseUrl` (contract 8.1); with neither, every call answers one plain error. */
export function useAdminTransport(transport: SchedulingAdminTransport | undefined, baseUrl: string | undefined): SchedulingAdminTransport {
  return useMemo(
    () => transport ?? (baseUrl ? createSchedulingAdminClient({ baseUrl }) : missingAdminTransport()),
    [transport, baseUrl],
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]") && !el.hasAttribute("disabled"));
}

/** The open dialogs, innermost last: Escape closes only the one on top. */
const openDialogs: symbol[] = [];

/**
 * A modal dialog (or, with `variant="drawer"`, a panel down the right edge —
 * full width on a phone). Focus moves into it on open, Tab and Shift+Tab stay
 * inside it, Escape closes it, and on close focus returns to `returnFocus()`
 * (the visit block that opened it) or to whatever had focus before.
 *
 * ESCAPE IS HEARD ON THE DOCUMENT, by the topmost dialog. It used to be heard
 * on the dialog element only, so once the focused button was removed — the
 * Accept button of a request just accepted — focus fell to the page and
 * Escape did nothing. For the same reason, focus that falls out of the dialog
 * because its element went away is put back on the dialog.
 *
 * STRICTMODE. React's development double-run unmounts and remounts the
 * dialog at once; the first unmount's "give focus back to the opener" used to
 * land after the remount and pull focus out of the open drawer (every
 * `next dev`). Focus is handed back only when the dialog is really gone.
 *
 * Rendered in place inside the widget root rather than in a portal, so it
 * inherits the widget's tokens and the host's theme; it is `position: fixed`,
 * so the calendar's own scrolling never clips it.
 */
export function Dialog({
  title,
  onClose,
  children,
  variant = "modal",
  returnFocus,
  describedBy,
  data,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  variant?: "modal" | "drawer";
  returnFocus?: () => HTMLElement | null;
  describedBy?: string;
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
      // The opener is outside this dialog (a StrictMode re-run finds focus already inside it).
      if (active && !ref.current?.contains(active)) openerRef.current = active;
    }
    const root = ref.current;
    if (root && !root.contains(document.activeElement)) {
      const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(root).find((el) => !el.classList.contains("aisw-dialog-close")) ?? root;
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
      const target = returnRef.current?.() ?? openerRef.current;
      // After the dialog unmounts (the block it returns to may re-render
      // first) — and only if it stayed unmounted: StrictMode remounts at once.
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
      className="aisw-backdrop"
      data-variant={variant}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={ref}
        className="aisw-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        {...dataAttrs}
      >
        <div className="aisw-dialog-head">
          <h2 className="aisw-dialog-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="aisw-dialog-close" aria-label="Close" onClick={() => onCloseRef.current()}>
            <CrossIcon />
          </button>
        </div>
        <div className="aisw-dialog-body">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What the office should know (the status banner)
// ---------------------------------------------------------------------------

/**
 * The server's `status`: whether customers are emailed and reminded, and what
 * is left to set up. Null until it answers — and null for good when the
 * transport can't say (an older server, a host transport without the
 * method), in which case the screens behave as before rather than hide the
 * email choices on a guess.
 */
export function useAdminStatus(transport: SchedulingAdminTransport, reload = 0): AdminStatus | null {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  useEffect(() => {
    let alive = true;
    if (typeof transport.status !== "function") return;
    void transport.status().then((res) => {
      if (alive && res.ok) setStatus(res.data);
    });
    return () => {
      alive = false;
    };
  }, [transport, reload]);
  return status;
}

/** The banner: one line per notice, warnings first as the server ordered them. Static, not announced on load. */
export function AdminNotices({ notices }: { notices: readonly AdminNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="aisw-stack-sm" data-aisw-notices="">
      {notices.map((notice) => (
        <div key={`${notice.code}:${notice.message}`} className={`aisw-notice aisw-notice-${notice.tone}`} data-notice={notice.code}>
          {notice.message}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

export interface Toast {
  id: number;
  tone: "ok" | "warn" | "error";
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);
  const push = useCallback(
    (tone: Toast["tone"], text: string) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-3), { id, tone, text }]);
      // Errors stay until dismissed or replaced: someone looking away from the
      // screen mid-drag must still see why the visit jumped back.
      if (tone !== "error") timers.current.set(id, setTimeout(() => dismiss(id), 7000));
      return id;
    },
    [dismiss],
  );
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);
  return { toasts, push, dismiss };
}

/** The toast region: always in the page (so additions are announced), polite, errors as alerts. */
export function ToastRegion({ toasts, onDismiss }: { toasts: readonly Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="aisw-toasts" aria-live="polite" aria-relevant="additions text" data-aisw-toasts="">
      {toasts.map((toast) => (
        <div key={toast.id} className={`aisw-toast aisw-toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} data-tone={toast.tone}>
          <span className="aisw-toast-text">{toast.text}</span>
          <button type="button" className="aisw-dialog-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
            <CrossIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

/** An on/off switch: a real checkbox with `role="switch"`, its label and one sentence of help. */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <label className="aisw-switch" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="aisw-switch-text">
        <strong>{label}</strong>
        {hint ? (
          <span className="aisw-hint" id={`${inputId}-hint`}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

/** A checkbox with its label: "Email the customer about this". */
export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="aisw-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A saved / failed line beside a button, announced. */
export function Outcome({ ok, error }: { ok?: string | null; error?: string | null }) {
  if (error) {
    return (
      <span className="aisw-danger-text" role="alert">
        {error}
      </span>
    );
  }
  return (
    <span className="aisw-ok-text" role="status">
      {ok ?? ""}
    </span>
  );
}

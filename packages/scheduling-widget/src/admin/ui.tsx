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

/**
 * The jobs a site's OPERATOR does, not the office's (the email service, the
 * reminder schedule): an owner can't fix them, so they never get a link and
 * never get the server's own wording (which may name a setting). The owner
 * reads one plain consequence; staff (`showTechnical`) also read the detail.
 */
const OPERATOR_NOTICES: Readonly<Record<string, string>> = {
  emails_off: "Email isn't switched on for this site yet, so your customers won't get emails about their visits. Call them yourself until it is.",
  reminders_off: "Visit reminders aren't switched on for this site yet, so customers aren't reminded before a visit.",
};

/** Is this notice the operator's job? */
export function isOperatorNotice(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPERATOR_NOTICES, code);
}

const SETUP_DISMISS_KEY = "aisw-setup-dismissed";

function readDismissed(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(SETUP_DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * The page's ONE setup card (review: five yellow banners read as "broken"):
 * "3 things to finish", calm, collapsed until opened, and dismissible — until
 * the list changes, when it comes back. The office's jobs first, each with
 * the server's words and where to fix it; then the operator's, in one plain
 * sentence each. Static, not announced on load.
 */
export function AdminNotices({ notices, showTechnical = false }: { notices: readonly AdminNotice[]; showTechnical?: boolean }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const signature = notices.map((notice) => notice.code).join(",");
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setDismissed(readDismissed()), []);
  if (notices.length === 0 || dismissed === signature) return null;
  const owner = notices.filter((notice) => !isOperatorNotice(notice.code));
  const operator = notices.filter((notice) => isOperatorNotice(notice.code));
  const count = notices.length;
  const dismiss = () => {
    try {
      localStorage.setItem(SETUP_DISMISS_KEY, signature);
    } catch {
      // Private mode: dismissed for this view only.
    }
    setDismissed(signature);
  };
  return (
    <section className="aisw-setup" data-aisw-notices="" aria-label="Things to finish">
      <div className="aisw-setup-head">
        <button type="button" className="aisw-setup-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          <span className="aisw-setup-count" aria-hidden="true">
            {count}
          </span>
          <span className="aisw-setup-title">{count === 1 ? "1 thing to finish" : `${count} things to finish`}</span>
          <svg className="aisw-setup-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={open ? "M6 14.5l6-6 6 6" : "M6 9.5l6 6 6-6"} />
          </svg>
        </button>
        <button type="button" className="aisw-setup-dismiss" aria-label="Dismiss until something changes" onClick={dismiss}>
          <CrossIcon />
        </button>
      </div>
      <div id={panelId} className="aisw-setup-body" hidden={!open}>
        {owner.length > 0 ? (
          <ul className="aisw-setup-list">
            {owner.map((notice) => (
              <li key={`${notice.code}:${notice.message}`} data-notice={notice.code}>
                {notice.message}
                {/* Where to fix it, when the server said (company settings, a crew picker). */}
                {notice.link ? (
                  <>
                    {" "}
                    <a href={notice.link.href}>{notice.link.label}</a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {operator.length > 0 ? (
          <>
            <p className="aisw-setup-sub">Waiting on whoever runs this site</p>
            <ul className="aisw-setup-list">
              {operator.map((notice) => (
                <li key={`${notice.code}:${notice.message}`} data-notice={notice.code} data-operator="">
                  {OPERATOR_NOTICES[notice.code]}
                  {showTechnical ? <span className="aisw-setup-detail">{notice.message}</span> : null}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </section>
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
  /**
   * One sentence of help — or one for each state, so the words under the
   * switch always describe what is true NOW ("On: …" while it's on, "Off: …"
   * while it's off), never the other state's consequence.
   */
  hint?: string | { readonly on: string; readonly off: string };
  disabled?: boolean;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? auto;
  const help = typeof hint === "string" || hint === undefined ? hint : checked ? hint.on : hint.off;
  return (
    <label className="aisw-switch" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={help ? `${inputId}-hint` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="aisw-switch-text">
        <strong>{label}</strong>
        {help ? (
          <span className="aisw-hint" id={`${inputId}-hint`}>
            {help}
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

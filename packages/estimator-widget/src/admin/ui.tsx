import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ClientError, Result } from "../http.js";
import { CrossIcon, Loading, Notice, resolveAccent, WidgetRoot, type ChromeProps } from "../parts.js";
import { createEstimatorAdminClient, type EstimatorAdminTransport } from "./client.js";
import { adminErrorText } from "./helpers.js";
import { injectEstimatorAdminStyles } from "./styles.js";
import type { AdminStatus, EstimatorSettingsWire } from "./types.js";

/**
 * The staff screens' building blocks: the root, the transport choice, the
 * status every screen reads once, toasts announced politely, cards, a switch,
 * and the "you can't see this" panel that replaces a section the signed-in
 * person has no permission for — never a blank panel.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const MISSING: Result<never> = {
  ok: false,
  error: { code: "bad_response", message: "This screen isn't connected to the estimator server yet.", status: 0 },
};

function missingAdminTransport(): EstimatorAdminTransport {
  const fail = () => Promise.resolve(MISSING);
  return new Proxy({} as EstimatorAdminTransport, { get: () => fail });
}

/** `transport` wins over `baseUrl` (contract 9.1); with neither, every call answers one plain error. */
export function useAdminTransport(transport: EstimatorAdminTransport | undefined, baseUrl: string | undefined): EstimatorAdminTransport {
  return useMemo(() => transport ?? (baseUrl ? createEstimatorAdminClient({ baseUrl }) : missingAdminTransport()), [transport, baseUrl]);
}

/** The props every admin component takes. */
export interface AdminChromeProps extends ChromeProps {
  /** The mounted staff handlers, e.g. "/api/admin/estimator". Ignored when `transport` is given. */
  baseUrl?: string;
  transport?: EstimatorAdminTransport;
  /** Undefined: the business's colour from Settings; null: the stylesheet's; a `#rrggbb`: that. */
  accentColor?: string | null;
}

// ---------------------------------------------------------------------------
// The status and settings every screen reads once
// ---------------------------------------------------------------------------

export interface AdminBasics {
  status: AdminStatus | null;
  /** The business's settings, when this person may view them (null until known, or refused). */
  settings: EstimatorSettingsWire | null;
  /** Why the settings couldn't be read (a 403 for someone without access), or null. */
  settingsError: ClientError | null;
  /** Read both again (after a save that changes what the notices say). */
  refresh: () => void;
  /** Set settings from a save, without a round trip. */
  setSettings: (settings: EstimatorSettingsWire) => void;
  /** True inside <EstimatorAdmin>: the shell shows the notices and the root once. */
  embedded: boolean;
}

const ShellContext = createContext<AdminBasics | null>(null);

function useOwnBasics(transport: EstimatorAdminTransport | null): AdminBasics {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [settings, setSettings] = useState<EstimatorSettingsWire | null>(null);
  const [settingsError, setSettingsError] = useState<ClientError | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!transport) return;
    let alive = true;
    if (typeof transport.status === "function") {
      void transport.status().then((res) => {
        if (alive && res.ok) setStatus(res.data);
      });
    }
    if (typeof transport.getSettings === "function") {
      void transport.getSettings().then((res) => {
        if (!alive) return;
        if (res.ok) {
          setSettings(res.data.settings);
          setSettingsError(null);
        } else setSettingsError(res.error);
      });
    }
    return () => {
      alive = false;
    };
  }, [transport, tick]);
  return useMemo(
    () => ({ status, settings, settingsError, refresh: () => setTick((n) => n + 1), setSettings, embedded: false }),
    [status, settings, settingsError],
  );
}

/** The screen's status and settings: the shell's inside <EstimatorAdmin>, else read here, once. */
export function useAdminBasics(transport: EstimatorAdminTransport): AdminBasics {
  const shell = useContext(ShellContext);
  const own = useOwnBasics(shell ? null : transport);
  return shell ?? own;
}

/** <EstimatorAdmin> shares one status and one settings read with every section inside it. */
export function AdminShellProvider({ value, children }: { value: AdminBasics; children: ReactNode }) {
  return <ShellContext.Provider value={{ ...value, embedded: true }}>{children}</ShellContext.Provider>;
}

/** Read status + settings for the shell itself. */
export function useShellBasics(transport: EstimatorAdminTransport): AdminBasics {
  return useOwnBasics(transport);
}

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------

function injectAdminWithNonce(nonce?: string) {
  injectEstimatorAdminStyles(nonce ? { nonce } : {});
}

/**
 * An admin screen's frame: the widget root (styles, theme, the business's
 * colour) with the admin sheet, the notices at the top — or, inside
 * <EstimatorAdmin>, just a section, since the shell has drawn all that once.
 */
export function AdminFrame({
  chrome,
  basics,
  data,
  children,
}: {
  chrome: AdminChromeProps;
  basics: AdminBasics;
  data?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  if (basics.embedded) {
    const attrs: Record<string, string> = {};
    for (const [key, value] of Object.entries(data ?? {})) if (value !== undefined) attrs[`data-${key}`] = value;
    return (
      <div className="aiew-stack" {...attrs}>
        {children}
      </div>
    );
  }
  return (
    <AdminRoot chrome={chrome} brandColor={basics.settings?.brandColor ?? null} data={data}>
      <div className="aiew-admin-inner">
        {basics.status ? <AdminNotices notices={basics.status.notices} /> : null}
        {children}
      </div>
    </AdminRoot>
  );
}

export function AdminRoot({
  chrome,
  brandColor,
  data,
  children,
}: {
  chrome: AdminChromeProps;
  brandColor: string | null;
  data?: Record<string, string | undefined>;
  children: ReactNode;
}) {
  return (
    <WidgetRoot
      theme={chrome.theme}
      nonce={chrome.nonce}
      className={chrome.className}
      style={chrome.style}
      extraClass="aiew-admin"
      extraStyles={injectAdminWithNonce}
      accent={resolveAccent(chrome.accentColor, brandColor)}
      data={data}
    >
      {children}
    </WidgetRoot>
  );
}

/** The banner: one line per notice, in the server's order. Static, not announced on load. */
export function AdminNotices({ notices }: { notices: ReadonlyArray<{ code: string; message: string }> }) {
  if (notices.length === 0) return null;
  return (
    <div className="aiew-stack-sm" data-aiew-notices="">
      {notices.map((notice) => (
        <div key={`${notice.code}:${notice.message}`} className="aiew-notice aiew-notice-warn" data-notice={notice.code}>
          {notice.message}
        </div>
      ))}
    </div>
  );
}

/**
 * A section's load failed. A refusal for want of permission shows the
 * server's own sentence ("You don't have permission to do that.") in place of
 * the section; anything else offers to try again.
 */
export function LoadError({ error, onRetry }: { error: ClientError; onRetry?: () => void }) {
  const forbidden = error.code === "forbidden" || error.status === 403;
  return (
    <Notice tone={forbidden ? "info" : "error"} data={forbidden ? "forbidden" : "load-error"}>
      {adminErrorText(error)}{" "}
      {!forbidden && onRetry ? (
        <button type="button" className="aiew-btn aiew-btn-link" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </Notice>
  );
}

export { Loading };

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export function Panel({ id, title, hint, children, actions }: { id?: string; title: ReactNode; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  const headingId = useId();
  return (
    <section className="aiew-panel" aria-labelledby={headingId} data-aiew-panel={id}>
      <div className="aiew-panel-head">
        <h3 className="aiew-panel-title" id={headingId}>
          {title}
        </h3>
        {actions}
        {hint ? <p className="aiew-panel-hint">{hint}</p> : null}
      </div>
      <div className="aiew-panel-body">{children}</div>
    </section>
  );
}

/** A section's Save button, its "Unsaved changes" mark, and "Saved" / the problem, announced. */
export function SaveRow({
  dirty,
  busy,
  saved,
  error,
  problem,
  label = "Save",
  disabled,
}: {
  dirty: boolean;
  busy: boolean;
  saved: boolean;
  error: ClientError | null;
  problem?: string | null;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="aiew-row">
      <button type="submit" className="aiew-btn aiew-btn-primary" disabled={disabled || !dirty || busy || Boolean(problem)} aria-busy={busy || undefined}>
        {busy ? "Saving…" : label}
      </button>
      {dirty ? <span className="aiew-dirty">Unsaved changes</span> : null}
      <Outcome ok={saved && !dirty ? "Saved" : null} error={problem ?? (error ? errorSummary(error) : null)} />
    </div>
  );
}

export function errorSummary(error: ClientError): string {
  if (error.code === "invalid" && error.issues && error.issues.length > 0) return "Check the highlighted fields.";
  return adminErrorText(error);
}

/** A saved / failed line beside a button, announced. */
export function Outcome({ ok, error }: { ok?: string | null; error?: string | null }) {
  if (error) {
    return (
      <span className="aiew-danger-text" role="alert">
        {error}
      </span>
    );
  }
  return (
    <span className="aiew-ok-text" role="status">
      {ok ?? ""}
    </span>
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
      // Errors stay until dismissed or replaced: someone who looked away must still see why.
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
    <div className="aiew-toasts" aria-live="polite" aria-relevant="additions text" data-aiew-toasts="">
      {toasts.map((toast) => (
        <div key={toast.id} className={`aiew-toast aiew-toast-${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} data-tone={toast.tone}>
          <span className="aiew-toast-text">{toast.text}</span>
          <button type="button" className="aiew-dialog-close" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}>
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
    <label className="aiew-switch" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="aiew-switch-text">
        <strong>{label}</strong>
        {hint ? (
          <span className="aiew-hint" id={`${inputId}-hint`}>
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
    <label className="aiew-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

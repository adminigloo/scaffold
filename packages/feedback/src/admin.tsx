import { useCallback, useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  FeedbackAdminClient,
  FeedbackAdminError,
  type FeedbackCategoryWire,
  type FeedbackColumnWire,
  type FeedbackKeyWire,
  type FeedbackSettingsTransport,
} from "./board-client";
import { BoardStyles, useBoardStyles } from "./board-styles";

export type { FeedbackSettingsTransport } from "./board-client";

/**
 * `@adminigloo/feedback/admin` (0.11.0): the board's settings as package
 * screens — the column editor, the category editor and the website keys —
 * so an npm-only buyer gets the whole feedback board, not just its server
 * functions. 0.10 shipped these as create-app's own settings page; they are
 * now this entry, and that page is a few lines around them.
 *
 * Every screen speaks a `FeedbackSettingsTransport` — the methods the editors
 * need. `FeedbackAdminClient` over the package's routes is one (pass
 * `baseUrl` and the screens make it); a host whose tickets live in its own
 * tables passes its own object. Controlled by the server: each change is
 * sent, then the list is read again, because the server's copy is the board.
 *
 * `canManage` only decides what is OFFERED; the server refuses every change
 * to someone without the permission anyway.
 *
 * Plain words throughout: a column's short name (what tickets point at) is
 * made from its name when it's added and never shown or changed afterwards.
 */

export interface SettingsScreenProps {
  /** The routes' base (`/api/app/${company.id}/feedback`, `/api/admin/feedback`): a client is made over it. */
  baseUrl?: string;
  /** Or your own transport (a host with its own tables); wins over `baseUrl`. */
  transport?: FeedbackSettingsTransport;
  /** Offer changes. Default true. */
  canManage?: boolean;
  theme?: "auto" | "light" | "dark";
}

function useTransport(props: SettingsScreenProps): FeedbackSettingsTransport {
  const { baseUrl, transport } = props;
  return useMemo(() => {
    if (transport) return transport;
    if (!baseUrl) throw new Error("@adminigloo/feedback/admin: pass baseUrl or transport");
    return new FeedbackAdminClient(baseUrl);
  }, [baseUrl, transport]);
}

function sentence(error: unknown): string {
  if (error instanceof FeedbackAdminError) return error.message;
  if (error instanceof Error && error.message && !/^[A-Z_]+$/.test(error.message)) return error.message;
  return "That didn't save. Please try again.";
}

/** A name turned into the short name tickets point at: "Waiting on customer" → "waiting_on_customer". */
export function shortNameOf(label: string): string {
  const base = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  if (!base) return `c_${Date.now().toString(36)}`;
  return /^[a-z]/.test(base) ? base : `c_${base}`.slice(0, 50);
}

/** "" ↔ null for the optional whole-number fields, without NaN leaking through. */
function wholeOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

function moved(ids: readonly string[], index: number, direction: -1 | 1): string[] | null {
  const target = index + direction;
  if (target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function Frame({ theme = "auto", children }: { theme?: "auto" | "light" | "dark"; children: ReactNode }): ReactElement {
  useBoardStyles();
  return (
    <div className="aib-admin" data-aib-theme={theme}>
      <BoardStyles />
      {children}
    </div>
  );
}

function Notice({ text, onDismiss }: { text: string | null; onDismiss: () => void }): ReactElement | null {
  if (!text) return null;
  return (
    <div className="aib-notice" role="status">
      <span>{text}</span>
      <button type="button" className="aib-tool-btn" onClick={onDismiss}>
        OK
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** The colours offered with one click; any CSS colour can still be typed. */
export const COLUMN_SWATCHES: readonly string[] = ["#1f6fff", "#0891b2", "#12b23b", "#ca8a04", "#ff8a00", "#e11d48", "#a855f7", "#6b7280"];

function Swatches({ value, onChange, disabled, label }: { value: string; onChange: (color: string) => void; disabled?: boolean; label: string }) {
  return (
    <div className="aib-swatches" role="group" aria-label={label}>
      <button
        type="button"
        className="aib-swatch aib-swatch-none"
        aria-pressed={value === ""}
        aria-label="No colour"
        title="No colour"
        disabled={disabled}
        onClick={() => onChange("")}
      />
      {COLUMN_SWATCHES.map((color) => (
        <button
          key={color}
          type="button"
          className="aib-swatch"
          style={{ background: color }}
          aria-pressed={value.toLowerCase() === color}
          aria-label={`Colour ${color}`}
          title={color}
          disabled={disabled}
          onClick={() => onChange(color)}
        />
      ))}
      <input
        className="aib-input aib-narrow"
        style={{ width: 96 }}
        value={value}
        placeholder="#1f6fff"
        aria-label="Any colour"
        disabled={disabled}
        maxLength={30}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ColumnRow({
  column,
  others,
  canManage,
  isFirst,
  isLast,
  onMove,
  onSave,
  onDelete,
}: {
  column: FeedbackColumnWire;
  others: FeedbackColumnWire[];
  canManage: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: -1 | 1) => void;
  onSave: (patch: Parameters<FeedbackSettingsTransport["updateColumn"]>[1]) => Promise<void>;
  onDelete: (moveTo: string | null) => Promise<void>;
}): ReactElement {
  const [label, setLabel] = useState(column.label);
  const [color, setColor] = useState(column.color ?? "");
  const [finished, setFinished] = useState(column.isTerminal);
  const [wip, setWip] = useState(column.wipLimit?.toString() ?? "");
  const [warn, setWarn] = useState(column.agingWarnHours?.toString() ?? "");
  const [stale, setStale] = useState(column.agingStaleHours?.toString() ?? "");
  const [deleting, setDeleting] = useState(false);
  const [moveTo, setMoveTo] = useState(others[0]?.key ?? "");
  const [busy, setBusy] = useState(false);
  const count = column.ticketCount ?? 0;
  const nameId = useId();
  const dirty =
    label.trim() !== column.label ||
    (color.trim() || null) !== column.color ||
    finished !== column.isTerminal ||
    wholeOrNull(wip) !== column.wipLimit ||
    wholeOrNull(warn) !== column.agingWarnHours ||
    wholeOrNull(stale) !== column.agingStaleHours;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="aib-admin-row">
      <div className="aib-admin-line">
        <span className="aib-col-dot" aria-hidden="true" style={{ background: color || "var(--aib-line-strong)" }} />
        <label htmlFor={nameId} className="aib-sr">
          Column name
        </label>
        <input
          id={nameId}
          className="aib-input"
          value={label}
          maxLength={60}
          disabled={!canManage}
          onChange={(event) => setLabel(event.target.value)}
        />
        <span className={`aib-pill${count > 0 ? " aib-pill-on" : ""}`}>
          {count} ticket{count === 1 ? "" : "s"}
        </span>
        {column.isTerminal ? <span className="aib-pill">Finished</span> : null}
        {canManage ? (
          <div className="aib-admin-actions">
            <button type="button" className="aib-tool-btn" disabled={isFirst || busy} aria-label={`Move ${column.label} left`} onClick={() => onMove(-1)}>
              ←
            </button>
            <button type="button" className="aib-tool-btn" disabled={isLast || busy} aria-label={`Move ${column.label} right`} onClick={() => onMove(1)}>
              →
            </button>
            <button
              type="button"
              className="aib-tool-btn aib-tool-primary"
              disabled={!dirty || !label.trim() || busy}
              onClick={() =>
                void run(() =>
                  onSave({
                    label: label.trim(),
                    color: color.trim() || null,
                    isTerminal: finished,
                    wipLimit: wholeOrNull(wip),
                    agingWarnHours: wholeOrNull(warn),
                    agingStaleHours: wholeOrNull(stale),
                  }),
                )
              }
            >
              Save
            </button>
            <button type="button" className="aib-tool-btn aib-tool-danger" disabled={busy} onClick={() => setDeleting(true)}>
              Delete
            </button>
          </div>
        ) : null}
      </div>
      {canManage ? <Swatches value={color} onChange={setColor} label={`Colour of ${column.label}`} /> : null}
      <div className="aib-admin-opts">
        <label>
          <input type="checkbox" checked={finished} disabled={!canManage} onChange={(event) => setFinished(event.target.checked)} />
          Finished: tickets here are done
        </label>
        <label title="How many tickets this column comfortably holds; past it, its header turns red">
          At most
          <input className="aib-input" inputMode="numeric" value={wip} placeholder="—" disabled={!canManage} onChange={(event) => setWip(event.target.value)} />
          tickets
        </label>
        <label title="Hours in this column before a card gets an amber mark">
          Amber after
          <input className="aib-input" inputMode="numeric" value={warn} placeholder="—" disabled={!canManage} onChange={(event) => setWarn(event.target.value)} />
          hours
        </label>
        <label title="Hours in this column before the mark turns red">
          Red after
          <input className="aib-input" inputMode="numeric" value={stale} placeholder="—" disabled={!canManage} onChange={(event) => setStale(event.target.value)} />
          hours
        </label>
      </div>
      {deleting ? (
        <div className="aib-notice" role="group" aria-label={`Delete ${column.label}`}>
          {count > 0 ? (
            others.length > 0 ? (
              <>
                <span>
                  {count === 1 ? "Its ticket" : `Its ${count} tickets`} will move to
                </span>
                <select className="aib-select" style={{ width: "auto" }} value={moveTo} aria-label="Move its tickets to" onChange={(event) => setMoveTo(event.target.value)}>
                  {others.map((other) => (
                    <option key={other.key} value={other.key}>
                      {other.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="aib-tool-btn aib-tool-primary"
                  disabled={!moveTo || busy}
                  onClick={() => void run(() => onDelete(moveTo))}
                >
                  Move them and delete
                </button>
              </>
            ) : (
              <span>This is the only column, and it holds tickets. Add another column first.</span>
            )
          ) : (
            <>
              <span>Delete the {column.label} column? It holds no tickets.</span>
              <button type="button" className="aib-tool-btn aib-tool-primary" disabled={busy} onClick={() => void run(() => onDelete(null))}>
                Delete it
              </button>
            </>
          )}
          <button type="button" className="aib-tool-btn" onClick={() => setDeleting(false)}>
            Keep it
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The board's columns: add, rename, recolour, reorder (← →), mark finished,
 * set a limit and the aging marks, and delete — a column holding tickets asks
 * which column they go to first.
 */
export function ColumnEditor(props: SettingsScreenProps): ReactElement {
  const transport = useTransport(props);
  const canManage = props.canManage ?? true;
  const [columns, setColumns] = useState<FeedbackColumnWire[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("");
  const [finished, setFinished] = useState(false);
  const say = useCallback((error: unknown) => setNotice(sentence(error)), []);
  const refresh = useCallback(() => transport.columns().then(setColumns, say), [transport, say]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNotice(null);
    } catch (error) {
      say(error);
    }
    await refresh();
  };

  return (
    <Frame theme={props.theme}>
      <section className="aib-admin-section" aria-labelledby="aib-columns-h">
        <h2 id="aib-columns-h" className="aib-admin-h">
          Board columns
        </h2>
        <p className="aib-admin-sub">
          Each row is a column on the board, left to right. A finished column holds work that&rsquo;s done: &ldquo;Archive
          finished&rdquo; sweeps it, and customers can&rsquo;t reply on a ticket in it.
        </p>
        <Notice text={notice} onDismiss={() => setNotice(null)} />
        <div className="aib-admin-card">
          {columns === null ? <p className="aib-admin-sub">Loading the columns…</p> : null}
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {(columns ?? []).map((column, index) => (
              <ColumnRow
                key={`${column.id}:${column.label}:${column.color ?? ""}:${column.isTerminal}:${column.wipLimit ?? ""}:${column.agingWarnHours ?? ""}:${column.agingStaleHours ?? ""}`}
                column={column}
                others={(columns ?? []).filter((other) => other.id !== column.id)}
                canManage={canManage}
                isFirst={index === 0}
                isLast={index === (columns?.length ?? 0) - 1}
                onMove={(direction) => {
                  const order = moved((columns ?? []).map((c) => c.id), index, direction);
                  if (order) void act(() => transport.reorderColumns(order));
                }}
                onSave={(patch) => act(() => transport.updateColumn(column.id, patch))}
                onDelete={(moveTo) => act(() => transport.deleteColumn(column.id, moveTo))}
              />
            ))}
          </ol>
          {canManage ? (
            <form
              className="aib-admin-row"
              onSubmit={(event) => {
                event.preventDefault();
                const name = label.trim();
                if (!name) return;
                void act(async () => {
                  await transport.createColumn({ key: shortNameOf(name), label: name, color: color.trim() || null, isTerminal: finished });
                  setLabel("");
                  setColor("");
                  setFinished(false);
                });
              }}
            >
              <div className="aib-admin-line">
                <label className="aib-field" style={{ flex: "1 1 220px" }}>
                  New column
                  <input className="aib-input" value={label} maxLength={60} placeholder="Waiting on customer" onChange={(event) => setLabel(event.target.value)} />
                </label>
                <button type="submit" className="aib-tool-btn aib-tool-primary" disabled={!label.trim()} style={{ alignSelf: "flex-end" }}>
                  Add column
                </button>
              </div>
              <Swatches value={color} onChange={setColor} label="New column's colour" />
              <div className="aib-admin-opts">
                <label>
                  <input type="checkbox" checked={finished} onChange={(event) => setFinished(event.target.checked)} />
                  Finished: tickets here are done
                </label>
              </div>
            </form>
          ) : null}
        </div>
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

function CategoryRow({
  category,
  canManage,
  isFirst,
  isLast,
  onMove,
  onSave,
  onDelete,
}: {
  category: FeedbackCategoryWire;
  canManage: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (direction: -1 | 1) => void;
  onSave: (patch: { label?: string; description?: string | null; showToCustomer?: boolean }) => Promise<void>;
  onDelete: () => Promise<void>;
}): ReactElement {
  const [label, setLabel] = useState(category.label);
  const [description, setDescription] = useState(category.description ?? "");
  const [offered, setOffered] = useState(category.showToCustomer);
  const [deleting, setDeleting] = useState(false);
  const dirty = label.trim() !== category.label || (description.trim() || null) !== category.description || offered !== category.showToCustomer;
  return (
    <li className="aib-admin-row">
      <div className="aib-admin-line">
        <input className="aib-input" aria-label="Category name" value={label} maxLength={60} disabled={!canManage} onChange={(event) => setLabel(event.target.value)} />
        <input
          className="aib-input"
          aria-label="One line under it"
          placeholder="One line under it (optional)"
          value={description}
          maxLength={200}
          disabled={!canManage}
          onChange={(event) => setDescription(event.target.value)}
        />
        {!category.showToCustomer ? <span className="aib-pill">Only for sorting</span> : null}
        {canManage ? (
          <div className="aib-admin-actions">
            <button type="button" className="aib-tool-btn" disabled={isFirst} aria-label={`Move ${category.label} up`} onClick={() => onMove(-1)}>
              ↑
            </button>
            <button type="button" className="aib-tool-btn" disabled={isLast} aria-label={`Move ${category.label} down`} onClick={() => onMove(1)}>
              ↓
            </button>
            <button
              type="button"
              className="aib-tool-btn aib-tool-primary"
              disabled={!dirty || !label.trim()}
              onClick={() => void onSave({ label: label.trim(), description: description.trim() || null, showToCustomer: offered })}
            >
              Save
            </button>
            <button type="button" className="aib-tool-btn aib-tool-danger" onClick={() => setDeleting(true)}>
              Delete
            </button>
          </div>
        ) : null}
      </div>
      <div className="aib-admin-opts">
        <label>
          <input type="checkbox" checked={offered} disabled={!canManage} onChange={(event) => setOffered(event.target.checked)} />
          Offered to customers
        </label>
      </div>
      {deleting ? (
        <div className="aib-notice" role="group" aria-label={`Delete ${category.label}`}>
          <span>Delete the {category.label} category?</span>
          <button type="button" className="aib-tool-btn aib-tool-primary" onClick={() => void onDelete().then(() => setDeleting(false))}>
            Delete it
          </button>
          <button type="button" className="aib-tool-btn" onClick={() => setDeleting(false)}>
            Keep it
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * What a customer can call their feedback, in order: add, rename, describe,
 * reorder, offer or keep for sorting, delete. A category tickets are filed
 * under can't be deleted (the server says how many): untick "Offered" instead.
 */
export function CategoryEditor(props: SettingsScreenProps): ReactElement {
  const transport = useTransport(props);
  const canManage = props.canManage ?? true;
  const [rows, setRows] = useState<FeedbackCategoryWire[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const say = useCallback((error: unknown) => setNotice(sentence(error)), []);
  const refresh = useCallback(() => transport.categories().then(setRows, say), [transport, say]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setNotice(null);
    } catch (error) {
      say(error);
    }
    await refresh();
  };

  return (
    <Frame theme={props.theme}>
      <section className="aib-admin-section" aria-labelledby="aib-categories-h">
        <h2 id="aib-categories-h" className="aib-admin-h">
          Categories
        </h2>
        <p className="aib-admin-sub">
          What someone sending feedback can call it, in this order. Untick &ldquo;Offered to customers&rdquo; to keep a
          category for your own sorting.
        </p>
        <Notice text={notice} onDismiss={() => setNotice(null)} />
        <div className="aib-admin-card">
          {rows === null ? <p className="aib-admin-sub">Loading the categories…</p> : null}
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {(rows ?? []).map((row, index) => (
              <CategoryRow
                key={`${row.id}:${row.label}:${row.description ?? ""}:${row.showToCustomer}`}
                category={row}
                canManage={canManage}
                isFirst={index === 0}
                isLast={index === (rows?.length ?? 0) - 1}
                onMove={(direction) => {
                  const order = moved((rows ?? []).map((r) => r.id), index, direction);
                  if (order) void act(() => transport.reorderCategories(order));
                }}
                onSave={(patch) => act(() => transport.updateCategory(row.id, patch))}
                onDelete={() => act(() => transport.deleteCategory(row.id))}
              />
            ))}
          </ol>
          {canManage ? (
            <form
              className="aib-admin-row"
              onSubmit={(event) => {
                event.preventDefault();
                const name = label.trim();
                if (!name) return;
                void act(async () => {
                  await transport.createCategory({ key: shortNameOf(name), label: name, description: description.trim() || null });
                  setLabel("");
                  setDescription("");
                });
              }}
            >
              <div className="aib-admin-line">
                <label className="aib-field" style={{ flex: "1 1 200px" }}>
                  New category
                  <input className="aib-input" value={label} maxLength={60} placeholder="Billing question" onChange={(event) => setLabel(event.target.value)} />
                </label>
                <label className="aib-field" style={{ flex: "2 1 240px" }}>
                  One line under it <span className="aib-hint">(optional)</span>
                  <input
                    className="aib-input"
                    value={description}
                    maxLength={200}
                    placeholder="Charges and invoices"
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
                <button type="submit" className="aib-tool-btn aib-tool-primary" disabled={!label.trim()} style={{ alignSelf: "flex-end" }}>
                  Add category
                </button>
              </div>
            </form>
          ) : null}
        </div>
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Website keys
// ---------------------------------------------------------------------------

export interface KeysPanelProps extends SettingsScreenProps {
  /** This site's widget intake, absolute (`{app}/api/igloo`): the snippet a developer pastes. */
  intakeUrl: string;
  /** The company's own feedback page, when it has one: the link any website can carry. */
  publicPageUrl?: string | null;
  /** The npm name of the widget, for the snippet. Default `@adminigloo/feedback-widget`. */
  widgetPackage?: string;
}

/**
 * Feedback on the company's own website: its feedback page's address (a link
 * any site, email or printed card can carry), and website keys — make one per
 * site, see each once, switch any off without touching the others.
 */
export function KeysPanel(props: KeysPanelProps): ReactElement {
  const transport = useTransport(props);
  const canManage = props.canManage ?? true;
  const widget = props.widgetPackage ?? "@adminigloo/feedback-widget";
  const [keys, setKeys] = useState<FeedbackKeyWire[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<{ label: string; secret: string } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const say = useCallback((error: unknown) => setNotice(sentence(error)), []);
  const hasKeys = typeof transport.keys === "function";
  const refresh = useCallback(async () => {
    if (!transport.keys) return;
    await transport.keys().then(setKeys, say);
  }, [transport, say]);
  useEffect(() => {
    if (canManage) void refresh();
  }, [refresh, canManage]);
  const live = (keys ?? []).filter((key) => key.revokedAt === null);
  const off = (keys ?? []).filter((key) => key.revokedAt !== null);

  const snippet = fresh
    ? `import { FeedbackButton, FeedbackModal, FeedbackProvider } from "${widget}";

<FeedbackProvider config={{ baseUrl: "${props.intakeUrl}", clientKey: "${fresh.secret}" }}>
  {children}
  <FeedbackButton />
  <FeedbackModal />
</FeedbackProvider>`
    : "";

  return (
    <Frame theme={props.theme}>
      <section className="aib-admin-section" aria-labelledby="aib-website-h">
        <h2 id="aib-website-h" className="aib-admin-h">
          On your website
        </h2>
        {props.publicPageUrl ? (
          <>
            <p className="aib-admin-sub">
              Your feedback page is{" "}
              <a href={props.publicPageUrl} target="_blank" rel="noreferrer">
                {props.publicPageUrl}
              </a>
              . Link to it from your website, your emails or a printed card — nothing to set up. Your customers can follow
              what happens to their feedback there.
            </p>
            <pre className="aib-code">{`<a href="${props.publicPageUrl}">Send us feedback</a>`}</pre>
          </>
        ) : null}
        {canManage && hasKeys ? (
          <>
            <h3 className="aib-admin-h" style={{ fontSize: 14 }}>
              For developers: the feedback button on a website you build
            </h3>
            <p className="aib-admin-sub">
              A website key lets a site built with React show the feedback button, with screenshots. Feedback sent with it
              lands on this board. Make one key per website, so you can switch one off without touching the others.
            </p>
            <Notice text={notice} onDismiss={() => setNotice(null)} />
            <div className="aib-admin-card">
              {fresh ? (
                <div className="aib-notice" role="status" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <strong>Your new key for {fresh.label}. Copy it now — it won&rsquo;t be shown again.</strong>
                  <pre className="aib-code">{snippet}</pre>
                </div>
              ) : null}
              {keys === null ? <p className="aib-admin-sub">Loading the keys…</p> : null}
              {keys !== null && live.length === 0 ? <p className="aib-admin-sub">No website keys yet.</p> : null}
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {live.map((key) => (
                  <li key={key.id} className="aib-admin-row">
                    <div className="aib-admin-line">
                      <strong>{key.label}</strong>
                      <span className="aib-admin-sub">made {new Date(key.createdAt).toLocaleDateString()}</span>
                      <div className="aib-admin-actions">
                        {switching === key.id ? (
                          <>
                            <span className="aib-admin-sub">The button on that website stops working.</span>
                            <button
                              type="button"
                              className="aib-tool-btn aib-tool-primary"
                              onClick={() =>
                                void transport.revokeKey!(key.id)
                                  .then(() => setNotice(null), say)
                                  .then(() => {
                                    setSwitching(null);
                                    return refresh();
                                  })
                              }
                            >
                              Switch it off
                            </button>
                            <button type="button" className="aib-tool-btn" onClick={() => setSwitching(null)}>
                              Keep it
                            </button>
                          </>
                        ) : (
                          <button type="button" className="aib-tool-btn aib-tool-danger" onClick={() => setSwitching(key.id)}>
                            Switch off
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {off.length > 0 ? (
                <p className="aib-admin-sub">
                  Switched off: {off.map((key) => key.label).join(", ")}. A website still using one of these shows no feedback button.
                </p>
              ) : null}
              <form
                className="aib-admin-line"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = label.trim();
                  if (!name || !transport.issueKey) return;
                  void transport.issueKey(name).then(
                    (issued) => {
                      setFresh({ label: issued.label, secret: issued.secret });
                      setLabel("");
                      setNotice(null);
                      return refresh();
                    },
                    say,
                  );
                }}
              >
                <label className="aib-field" style={{ flex: "1 1 220px" }}>
                  Which website is it for?
                  <input className="aib-input" value={label} maxLength={80} placeholder="Our main website" onChange={(event) => setLabel(event.target.value)} />
                </label>
                <button type="submit" className="aib-tool-btn aib-tool-primary" disabled={!label.trim()} style={{ alignSelf: "flex-end" }}>
                  Make a website key
                </button>
              </form>
            </div>
          </>
        ) : null}
      </section>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// All three, as the settings page
// ---------------------------------------------------------------------------

export interface FeedbackSettingsPanelProps extends SettingsScreenProps {
  intakeUrl: string;
  publicPageUrl?: string | null;
  widgetPackage?: string;
}

/**
 * The board's whole settings page: columns, categories, and the website.
 * One transport for all three, so they agree on the board they're editing.
 */
export function FeedbackSettingsPanel(props: FeedbackSettingsPanelProps): ReactElement {
  const transport = useTransport(props);
  const shared = { transport, canManage: props.canManage ?? true, ...(props.theme ? { theme: props.theme } : {}) };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <ColumnEditor {...shared} />
      <CategoryEditor {...shared} />
      {shared.canManage || props.publicPageUrl ? (
        <KeysPanel
          {...shared}
          intakeUrl={props.intakeUrl}
          {...(props.publicPageUrl !== undefined ? { publicPageUrl: props.publicPageUrl } : {})}
          {...(props.widgetPackage ? { widgetPackage: props.widgetPackage } : {})}
        />
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FeedbackAdminClient,
  FeedbackAdminError,
  type FeedbackCategoryWire,
  type FeedbackColumnWire,
  type FeedbackKeyWire,
} from "__SCOPE__/feedback/board";
import { Badge, Button, Card, CardBody, Input, Notice } from "@/components/ui";

/**
 * A feedback board's settings: its COLUMNS, the CATEGORIES customers choose
 * from, and the WEBSITE KEYS that put the feedback button on a website.
 *
 * One component for both boards that exist — a company's own
 * (/app/feedback/settings, over /api/app/{company id}/feedback) and this
 * site's own (/admin/feedback/settings, over /api/admin/feedback) — talking
 * to the package's routes through its client, so only `baseUrl` differs.
 *
 * Two rules it shows rather than hides: a column holding tickets refuses to be
 * deleted (move them first — the refusal says how many), and a column's or
 * category's short name is permanent once made, because tickets point at it.
 * The label is what people see; change it freely.
 *
 * `canManage` only decides what is OFFERED: the server refuses every change to
 * someone without the permission anyway.
 */
export function FeedbackSettings({
  baseUrl,
  canManage,
  intakeUrl,
  publicPageUrl = null,
}: {
  /** Where the board's routes are: `/api/app/${company.id}/feedback`, or `/api/admin/feedback`. */
  readonly baseUrl: string;
  readonly canManage: boolean;
  /** This site's widget intake, absolute (the snippet a developer pastes): `{app}/api/igloo`. */
  readonly intakeUrl: string;
  /** The company's own feedback page, when it has one: the link any website can carry. */
  readonly publicPageUrl?: string | null;
}) {
  const client = useMemo(() => new FeedbackAdminClient(baseUrl), [baseUrl]);
  const [notice, setNotice] = useState<string | null>(null);
  const say = useCallback((error: unknown) => {
    setNotice(error instanceof FeedbackAdminError ? error.message : "That didn't save. Please try again.");
  }, []);

  return (
    <div className="flex flex-col gap-8">
      {notice ? (
        <Notice tone="warn" role="status">
          {notice}
        </Notice>
      ) : null}
      <ColumnsSection client={client} canManage={canManage} onError={say} onDone={() => setNotice(null)} />
      <CategoriesSection client={client} canManage={canManage} onError={say} onDone={() => setNotice(null)} />
      {canManage ? (
        <KeysSection client={client} onError={say} onDone={() => setNotice(null)} intakeUrl={intakeUrl} publicPageUrl={publicPageUrl} />
      ) : null}
    </div>
  );
}

interface SectionProps {
  readonly client: FeedbackAdminClient;
  readonly onError: (error: unknown) => void;
  readonly onDone: () => void;
}

/** "" ↔ null for the optional number fields, without NaN leaking through. */
function parseHours(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

/** A label turned into a short name: "Waiting on customer" → "waiting_on_customer". */
function shortNameOf(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return /^[a-z]/.test(base) ? base : `c_${base}`.slice(0, 50);
}

function swap(ids: string[], index: number, direction: -1 | 1): string[] | null {
  const target = index + direction;
  if (target < 0 || target >= ids.length) return null;
  const next = [...ids];
  const a = next[index];
  const b = next[target];
  if (a === undefined || b === undefined) return null;
  next[index] = b;
  next[target] = a;
  return next;
}

function ColumnsSection({ client, canManage, onError, onDone }: SectionProps & { readonly canManage: boolean }) {
  const [columns, setColumns] = useState<FeedbackColumnWire[] | null>(null);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState("");
  const refresh = useCallback(() => {
    client.columns().then(setColumns, onError);
  }, [client, onError]);
  useEffect(refresh, [refresh]);

  const move = async (index: number, direction: -1 | 1) => {
    const order = swap((columns ?? []).map((column) => column.id), index, direction);
    if (!order) return;
    try {
      await client.reorderColumns(order);
      refresh();
    } catch (error) {
      onError(error);
    }
  };

  return (
    <section aria-labelledby="feedback-columns">
      <h2 id="feedback-columns" className="mb-1 text-lg font-semibold text-ink">
        Board columns
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        Each row is a column on the board, in this order. A finished column is one whose tickets are done: &ldquo;Archive
        finished&rdquo; sweeps it, and customers can&rsquo;t reply on a ticket in it.
      </p>
      <Card>
        <CardBody className="flex flex-col gap-2">
          {columns === null ? <p className="text-sm text-ink-muted">Loading the columns…</p> : null}
          {(columns ?? []).map((column, index) => (
            <ColumnRow
              key={column.id}
              column={column}
              canManage={canManage}
              isFirst={index === 0}
              isLast={index === (columns?.length ?? 0) - 1}
              onMoveUp={() => void move(index, -1)}
              onMoveDown={() => void move(index, 1)}
              onSave={async (patch) => {
                try {
                  await client.updateColumn(column.id, patch);
                  onDone();
                  refresh();
                } catch (error) {
                  onError(error);
                }
              }}
              onDelete={async () => {
                try {
                  await client.deleteColumn(column.id);
                  onDone();
                  refresh();
                } catch (error) {
                  onError(error);
                }
              }}
            />
          ))}
          {canManage ? (
            <form
              className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                const name = label.trim();
                if (!name) return;
                client
                  .createColumn({ key: shortNameOf(name), label: name, color: color.trim() || null })
                  .then(() => {
                    setLabel("");
                    setColor("");
                    onDone();
                    refresh();
                  }, onError);
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                New column
                <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Waiting on customer" className="w-56" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Colour (optional)
                <Input value={color} onChange={(event) => setColor(event.target.value)} placeholder="#6b7280" className="w-28 font-mono" />
              </label>
              <Button type="submit" variant="primary" disabled={!label.trim()}>
                Add column
              </Button>
            </form>
          ) : null}
        </CardBody>
      </Card>
    </section>
  );
}

function ColumnRow({
  column,
  canManage,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onSave,
  onDelete,
}: {
  readonly column: FeedbackColumnWire;
  readonly canManage: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onSave: (patch: {
    label?: string;
    color?: string | null;
    isTerminal?: boolean;
    wipLimit?: number | null;
    agingWarnHours?: number | null;
    agingStaleHours?: number | null;
  }) => Promise<void>;
  readonly onDelete: () => Promise<void>;
}) {
  const [label, setLabel] = useState(column.label);
  const [color, setColor] = useState(column.color ?? "");
  const [finished, setFinished] = useState(column.isTerminal);
  const [wip, setWip] = useState(column.wipLimit?.toString() ?? "");
  const [warn, setWarn] = useState(column.agingWarnHours?.toString() ?? "");
  const [stale, setStale] = useState(column.agingStaleHours?.toString() ?? "");
  const count = column.ticketCount ?? 0;
  const dirty =
    label !== column.label ||
    (color || null) !== column.color ||
    finished !== column.isTerminal ||
    parseHours(wip) !== column.wipLimit ||
    parseHours(warn) !== column.agingWarnHours ||
    parseHours(stale) !== column.agingStaleHours;

  return (
    <div className="flex flex-col gap-2 rounded-control border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className="h-3 w-3 shrink-0 rounded-pill border border-line" style={{ background: column.color ?? "var(--color-line)" }} />
        <Input value={label} onChange={(event) => setLabel(event.target.value)} className="w-52" disabled={!canManage} aria-label="Column name" />
        <Input
          value={color}
          onChange={(event) => setColor(event.target.value)}
          placeholder="#1f6fff"
          className="w-28 font-mono"
          disabled={!canManage}
          aria-label="Colour"
        />
        <Badge tone={count > 0 ? "accent" : "neutral"}>
          {count} ticket{count === 1 ? "" : "s"}
        </Badge>
        {canManage ? (
          <div className="ml-auto flex items-center gap-1">
            <Button onClick={onMoveUp} disabled={isFirst} aria-label={`Move ${column.label} left`}>
              ↑
            </Button>
            <Button onClick={onMoveDown} disabled={isLast} aria-label={`Move ${column.label} right`}>
              ↓
            </Button>
            <Button
              variant="primary"
              disabled={!dirty || !label.trim()}
              onClick={() =>
                void onSave({
                  label: label.trim(),
                  color: color.trim() || null,
                  isTerminal: finished,
                  wipLimit: parseHours(wip),
                  agingWarnHours: parseHours(warn),
                  agingStaleHours: parseHours(stale),
                })
              }
            >
              Save
            </Button>
            <Button variant="danger" onClick={() => void onDelete()}>
              Delete
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-5 text-xs text-ink-muted">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={finished} disabled={!canManage} onChange={(event) => setFinished(event.target.checked)} />
          Finished — tickets here are done
        </label>
        <label className="flex items-center gap-1.5" title="How many tickets this column comfortably holds; past it, its header turns red">
          At most
          <Input value={wip} onChange={(event) => setWip(event.target.value)} placeholder="—" className="w-16" disabled={!canManage} />
          tickets
        </label>
        <label className="flex items-center gap-1.5" title="Hours in this column before a card gets an amber mark">
          Amber after
          <Input value={warn} onChange={(event) => setWarn(event.target.value)} placeholder="—" className="w-16" disabled={!canManage} />
          hours
        </label>
        <label className="flex items-center gap-1.5" title="Hours in this column before the mark turns red">
          Red after
          <Input value={stale} onChange={(event) => setStale(event.target.value)} placeholder="—" className="w-16" disabled={!canManage} />
          hours
        </label>
      </div>
    </div>
  );
}

function CategoriesSection({ client, canManage, onError, onDone }: SectionProps & { readonly canManage: boolean }) {
  const [rows, setRows] = useState<FeedbackCategoryWire[] | null>(null);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const refresh = useCallback(() => {
    client.categories().then(setRows, onError);
  }, [client, onError]);
  useEffect(refresh, [refresh]);

  const move = async (index: number, direction: -1 | 1) => {
    const order = swap((rows ?? []).map((row) => row.id), index, direction);
    if (!order) return;
    try {
      await client.reorderCategories(order);
      refresh();
    } catch (error) {
      onError(error);
    }
  };

  return (
    <section aria-labelledby="feedback-categories">
      <h2 id="feedback-categories" className="mb-1 text-lg font-semibold text-ink">
        Categories
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        What someone sending feedback can call it, in this order. Untick &ldquo;Offered&rdquo; to keep a category for your
        own sorting without offering it.
      </p>
      <Card>
        <CardBody className="flex flex-col gap-2">
          {rows === null ? <p className="text-sm text-ink-muted">Loading the categories…</p> : null}
          {(rows ?? []).map((row, index) => (
            <CategoryRow
              key={row.id}
              category={row}
              canManage={canManage}
              isFirst={index === 0}
              isLast={index === (rows?.length ?? 0) - 1}
              onMoveUp={() => void move(index, -1)}
              onMoveDown={() => void move(index, 1)}
              onSave={async (patch) => {
                try {
                  await client.updateCategory(row.id, patch);
                  onDone();
                  refresh();
                } catch (error) {
                  onError(error);
                }
              }}
              onDelete={async () => {
                try {
                  await client.deleteCategory(row.id);
                  onDone();
                  refresh();
                } catch (error) {
                  onError(error);
                }
              }}
            />
          ))}
          {canManage ? (
            <form
              className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                const name = label.trim();
                if (!name) return;
                client
                  .createCategory({ key: shortNameOf(name), label: name, description: description.trim() || null })
                  .then(() => {
                    setLabel("");
                    setDescription("");
                    onDone();
                    refresh();
                  }, onError);
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                New category
                <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Billing question" className="w-52" />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                One line under it (optional)
                <Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Charges and invoices" className="w-64" />
              </label>
              <Button type="submit" variant="primary" disabled={!label.trim()}>
                Add category
              </Button>
            </form>
          ) : null}
        </CardBody>
      </Card>
    </section>
  );
}

function CategoryRow({
  category,
  canManage,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onSave,
  onDelete,
}: {
  readonly category: FeedbackCategoryWire;
  readonly canManage: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onSave: (patch: { label?: string; description?: string | null; showToCustomer?: boolean }) => Promise<void>;
  readonly onDelete: () => Promise<void>;
}) {
  const [label, setLabel] = useState(category.label);
  const [description, setDescription] = useState(category.description ?? "");
  const [offered, setOffered] = useState(category.showToCustomer);
  const dirty = label !== category.label || (description || null) !== category.description || offered !== category.showToCustomer;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-2">
      <Input value={label} onChange={(event) => setLabel(event.target.value)} className="w-52" disabled={!canManage} aria-label="Category name" />
      <Input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="One line under it"
        className="w-64"
        disabled={!canManage}
        aria-label="One line under it"
      />
      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        <input type="checkbox" checked={offered} disabled={!canManage} onChange={(event) => setOffered(event.target.checked)} />
        Offered
      </label>
      {!category.showToCustomer ? <Badge tone="neutral">Only for sorting</Badge> : null}
      {canManage ? (
        <div className="ml-auto flex items-center gap-1">
          <Button onClick={onMoveUp} disabled={isFirst} aria-label={`Move ${category.label} up`}>
            ↑
          </Button>
          <Button onClick={onMoveDown} disabled={isLast} aria-label={`Move ${category.label} down`}>
            ↓
          </Button>
          <Button
            variant="primary"
            disabled={!dirty || !label.trim()}
            onClick={() => void onSave({ label: label.trim(), description: description.trim() || null, showToCustomer: offered })}
          >
            Save
          </Button>
          <Button variant="danger" onClick={() => void onDelete()}>
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function KeysSection({
  client,
  onError,
  onDone,
  intakeUrl,
  publicPageUrl,
}: SectionProps & { readonly intakeUrl: string; readonly publicPageUrl: string | null }) {
  const [keys, setKeys] = useState<FeedbackKeyWire[] | null>(null);
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<{ label: string; secret: string } | null>(null);
  const refresh = useCallback(() => {
    client.keys().then(setKeys, onError);
  }, [client, onError]);
  useEffect(refresh, [refresh]);
  const live = (keys ?? []).filter((key) => key.revokedAt === null);
  const off = (keys ?? []).filter((key) => key.revokedAt !== null);

  const snippet = fresh
    ? `import { FeedbackButton, FeedbackModal, FeedbackProvider } from "@adminigloo/feedback-widget";

<FeedbackProvider config={{ baseUrl: "${intakeUrl}", clientKey: "${fresh.secret}" }}>
  {children}
  <FeedbackButton />
  <FeedbackModal />
</FeedbackProvider>`
    : "";

  return (
    <section aria-labelledby="feedback-website">
      <h2 id="feedback-website" className="mb-1 text-lg font-semibold text-ink">
        On your website
      </h2>
      {publicPageUrl ? (
        <div className="mb-4 flex flex-col gap-2 text-sm text-ink-muted">
          <p>
            Your feedback page is{" "}
            <a href={publicPageUrl} className="text-accent underline underline-offset-2" target="_blank" rel="noreferrer">
              {publicPageUrl}
            </a>
            . Link to it from your website, your emails or a printed card — no setup needed. Your customers can follow
            what happens to their feedback there.
          </p>
          <pre className="overflow-x-auto rounded-control bg-surface p-3 font-mono text-xs text-ink">{`<a href="${publicPageUrl}">Send us feedback</a>`}</pre>
        </div>
      ) : null}
      <h3 className="mb-1 text-sm font-semibold text-ink">For developers: the feedback button on a website you build</h3>
      <p className="mb-3 text-sm text-ink-muted">
        A website key lets a site built with React show the feedback button, with screenshots. Feedback sent with it lands on
        this board. Make one key per website, so you can switch one off without touching the others.
      </p>
      <Card>
        <CardBody className="flex flex-col gap-3">
          {fresh ? (
            <Notice tone="info">
              <span className="block font-medium">Your new key for {fresh.label}. Copy it now — it won&rsquo;t be shown again.</span>
              <pre className="mt-2 overflow-x-auto whitespace-pre rounded-control bg-surface p-3 font-mono text-xs text-ink">{snippet}</pre>
            </Notice>
          ) : null}
          {keys === null ? <p className="text-sm text-ink-muted">Loading the keys…</p> : null}
          {keys !== null && live.length === 0 ? <p className="text-sm text-ink-muted">No website keys yet.</p> : null}
          {live.map((key) => (
            <div key={key.id} className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-2 text-sm">
              <span className="font-medium text-ink">{key.label}</span>
              <span className="text-ink-muted">made {new Date(key.createdAt).toLocaleDateString()}</span>
              <Button
                variant="danger"
                className="ml-auto"
                onClick={() =>
                  void client.revokeKey(key.id).then(() => {
                    onDone();
                    refresh();
                  }, onError)
                }
              >
                Switch off
              </Button>
            </div>
          ))}
          {off.length > 0 ? (
            <p className="text-xs text-ink-muted">
              Switched off: {off.map((key) => key.label).join(", ")}. A website still using one of these shows no feedback button.
            </p>
          ) : null}
          <form
            className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              const name = label.trim();
              if (!name) return;
              client.issueKey(name).then((issued) => {
                setFresh({ label: issued.label, secret: issued.secret });
                setLabel("");
                onDone();
                refresh();
              }, onError);
            }}
          >
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
              Which website is it for?
              <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Our main website" className="w-64" />
            </label>
            <Button type="submit" variant="primary" disabled={!label.trim()}>
              Make a website key
            </Button>
          </form>
        </CardBody>
      </Card>
    </section>
  );
}

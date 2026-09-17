"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, EmptyState, Input, Notice, PageHeader } from "@/components/ui";

/**
 * The board's columns, as a settings screen.
 *
 * Rows in `feedback_statuses` ARE the board — adding one adds a column,
 * reordering reorders it — so this page is a plain editor over that table
 * rather than a "workflow designer". Two rules it surfaces instead of hiding:
 * a column holding tickets refuses to be deleted (move them first — the
 * refusal message says how many), and a key is permanent once created,
 * because tickets reference it as plain text and renaming it would strand
 * every one of them in a column that no longer exists. The label is what
 * people see; change it freely.
 */
export default function FeedbackStatusesPage() {
  const board = api.feedback.board.useQuery();
  const create = api.feedback.createStatus.useMutation();
  const update = api.feedback.updateStatus.useMutation();
  const remove = api.feedback.deleteStatus.useMutation();
  const reorder = api.feedback.reorderStatuses.useMutation();

  const [notice, setNotice] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newColor, setNewColor] = useState("");

  const statuses = board.data?.statuses ?? [];
  const countFor = (key: string) =>
    (board.data?.tickets ?? []).filter((ticket) => ticket.status === key).length;

  const refresh = () => void board.refetch();

  const move = async (index: number, direction: -1 | 1) => {
    const ids = statuses.map((status) => status.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const swapped = [...ids];
    const a = swapped[index];
    const b = swapped[target];
    if (a === undefined || b === undefined) return;
    swapped[index] = b;
    swapped[target] = a;
    await reorder.mutateAsync({ orderedIds: swapped });
    refresh();
  };

  return (
    <>
      <PageHeader
        title="Board columns"
        description="Each row is a column on the feedback board, in this order. Keys are permanent — tickets reference them — but labels and colors are yours to change."
        actions={
          <Link href="/admin/feedback/board" className="text-sm text-accent underline underline-offset-2">
            Back to the board
          </Link>
        }
      />

      {notice ? (
        <div className="mb-4">
          <Notice tone="warn" role="status">{notice}</Notice>
        </div>
      ) : null}

      {board.isLoading ? (
        <EmptyState title="Loading columns…">Reading the board configuration.</EmptyState>
      ) : (
        <Card>
          <CardBody className="flex flex-col gap-2">
            {statuses.map((status, index) => (
              <StatusRow
                key={status.id}
                status={status}
                ticketCount={countFor(status.key)}
                onSave={async (patch) => {
                  await update.mutateAsync({ id: status.id, ...patch });
                  refresh();
                }}
                onDelete={async () => {
                  const result = await remove.mutateAsync({ statusId: status.id });
                  if (!result.deleted) {
                    setNotice(
                      result.reason === "occupied"
                        ? `"${status.label}" holds ${result.ticketCount} ticket${result.ticketCount === 1 ? "" : "s"} — move them to another column first.`
                        : "That column no longer exists; refreshing.",
                    );
                  } else {
                    setNotice(null);
                  }
                  refresh();
                }}
                onMoveUp={() => void move(index, -1)}
                onMoveDown={() => void move(index, 1)}
                isFirst={index === 0}
                isLast={index === statuses.length - 1}
              />
            ))}

            <form
              className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-4"
              onSubmit={(event) => {
                event.preventDefault();
                void create
                  .mutateAsync({
                    key: newKey.trim(),
                    label: newLabel.trim(),
                    color: newColor.trim() || null,
                  })
                  .then(() => {
                    setNewKey("");
                    setNewLabel("");
                    setNewColor("");
                    setNotice(null);
                    refresh();
                  })
                  .catch((error: unknown) => {
                    setNotice(error instanceof Error ? error.message : "Could not add the column.");
                  });
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Key (permanent)
                <Input
                  value={newKey}
                  onChange={(event) => setNewKey(event.target.value)}
                  placeholder="wont_fix"
                  className="w-36 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Label
                <Input
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                  placeholder="Won't fix"
                  className="w-44"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Color (optional)
                <Input
                  value={newColor}
                  onChange={(event) => setNewColor(event.target.value)}
                  placeholder="#6b7280"
                  className="w-28 font-mono"
                />
              </label>
              <Button type="submit" variant="primary" disabled={!newKey.trim() || !newLabel.trim() || create.isPending}>
                Add column
              </Button>
            </form>
          </CardBody>
        </Card>
      )}
    </>
  );
}

/** "" ↔ null for the optional number fields, without NaN leaking through. */
function parseHours(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

function StatusRow({
  status,
  ticketCount,
  onSave,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  readonly status: {
    id: string;
    key: string;
    label: string;
    color: string | null;
    isTerminal: boolean;
    wipLimit: number | null;
    agingWarnHours: number | null;
    agingStaleHours: number | null;
  };
  readonly ticketCount: number;
  readonly onSave: (patch: {
    label?: string;
    color?: string | null;
    isTerminal?: boolean;
    wipLimit?: number | null;
    agingWarnHours?: number | null;
    agingStaleHours?: number | null;
  }) => Promise<void>;
  readonly onDelete: () => Promise<void>;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const [label, setLabel] = useState(status.label);
  const [color, setColor] = useState(status.color ?? "");
  const [terminal, setTerminal] = useState(status.isTerminal);
  const [wip, setWip] = useState(status.wipLimit?.toString() ?? "");
  const [warn, setWarn] = useState(status.agingWarnHours?.toString() ?? "");
  const [stale, setStale] = useState(status.agingStaleHours?.toString() ?? "");
  const dirty =
    label !== status.label ||
    (color || null) !== status.color ||
    terminal !== status.isTerminal ||
    parseHours(wip) !== status.wipLimit ||
    parseHours(warn) !== status.agingWarnHours ||
    parseHours(stale) !== status.agingStaleHours;

  return (
    <div className="flex flex-col gap-2 rounded-control border border-line px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-pill border border-line"
          style={{ background: status.color ?? "var(--color-line)" }}
        />
        <code className="w-28 truncate font-mono text-xs text-ink-muted" title={status.key}>
          {status.key}
        </code>
        <Input value={label} onChange={(event) => setLabel(event.target.value)} className="w-44" />
        <Input
          value={color}
          onChange={(event) => setColor(event.target.value)}
          placeholder="#1f6fff"
          className="w-28 font-mono"
        />
        <Badge tone={ticketCount > 0 ? "accent" : "neutral"}>
          {ticketCount} ticket{ticketCount === 1 ? "" : "s"}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button onClick={onMoveUp} disabled={isFirst} aria-label={`Move ${status.label} up`}>
            ↑
          </Button>
          <Button onClick={onMoveDown} disabled={isLast} aria-label={`Move ${status.label} down`}>
            ↓
          </Button>
          <Button
            variant="primary"
            disabled={!dirty}
            onClick={() =>
              void onSave({
                label: label.trim(),
                color: color.trim() || null,
                isTerminal: terminal,
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
      </div>
      {/* The column's kanban settings (0.7.0), one quiet second line. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pl-5 text-xs text-ink-muted">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={terminal}
            onChange={(event) => setTerminal(event.target.checked)}
          />
          Terminal — work here is finished; &ldquo;Archive done&rdquo; sweeps it
        </label>
        <label className="flex items-center gap-1.5">
          WIP limit
          <Input value={wip} onChange={(event) => setWip(event.target.value)} placeholder="—" className="w-16" />
        </label>
        <label className="flex items-center gap-1.5" title="Hours in this column before the card gets an amber dot">
          Age warn (h)
          <Input value={warn} onChange={(event) => setWarn(event.target.value)} placeholder="—" className="w-16" />
        </label>
        <label className="flex items-center gap-1.5" title="Hours in this column before the dot turns red">
          Age stale (h)
          <Input value={stale} onChange={(event) => setStale(event.target.value)} placeholder="—" className="w-16" />
        </label>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/trpc/client";
import { Badge, Button, Card, CardBody, EmptyState, Input, Notice, PageHeader } from "@/components/ui";

/**
 * The widget's dropdown, as a settings screen (0.7.0).
 *
 * Rows in `feedback_categories` ARE the options a reporter can choose — same
 * design as the board columns one page over, with one extra switch:
 * `showToCustomer`. Off, the category still exists for triage (tickets can
 * carry it, filters can use it) but the widget never offers it — an
 * "escalated" category should be reachable by staff and unreachable by the
 * person filing a bug. An EMPTY table means the widget's built-in defaults,
 * not an empty dropdown, so this page only takes over when you add a row.
 */
export default function FeedbackCategoriesPage() {
  const categories = api.feedback.listCategories.useQuery();
  const create = api.feedback.createCategory.useMutation();
  const update = api.feedback.updateCategory.useMutation();
  const remove = api.feedback.deleteCategory.useMutation();
  const reorder = api.feedback.reorderCategories.useMutation();

  const [notice, setNotice] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");

  const rows = categories.data ?? [];
  const refresh = () => void categories.refetch();

  const move = async (index: number, direction: -1 | 1) => {
    const ids = rows.map((row) => row.id);
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
        title="Feedback categories"
        description="What a reporter can call their report, in this order. Keys are permanent — tickets reference them — and 'in widget' decides whether the option is offered to reporters at all."
        actions={
          <Link href="/admin/feedback/statuses" className="text-sm text-accent underline underline-offset-2">
            Board columns
          </Link>
        }
      />

      {notice ? (
        <div className="mb-4">
          <Notice tone="warn" role="status">{notice}</Notice>
        </div>
      ) : null}

      {categories.isLoading ? (
        <EmptyState title="Loading categories…">Reading the widget configuration.</EmptyState>
      ) : (
        <Card>
          <CardBody className="flex flex-col gap-2">
            {rows.length === 0 ? (
              <p className="text-sm text-ink-muted">
                No categories configured &mdash; the widget is offering its built-in
                defaults. Add a row and this list takes over.
              </p>
            ) : null}
            {rows.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                onSave={async (patch) => {
                  await update.mutateAsync({ id: category.id, ...patch });
                  refresh();
                }}
                onDelete={async () => {
                  const result = await remove.mutateAsync({ categoryId: category.id });
                  if (!result.deleted) {
                    setNotice(
                      result.reason === "occupied"
                        ? `"${category.label}" is carried by ${result.ticketCount} ticket${result.ticketCount === 1 ? "" : "s"} — hide it from the widget instead, or wait out its history.`
                        : "That category no longer exists; refreshing.",
                    );
                  } else {
                    setNotice(null);
                  }
                  refresh();
                }}
                onMoveUp={() => void move(index, -1)}
                onMoveDown={() => void move(index, 1)}
                isFirst={index === 0}
                isLast={index === rows.length - 1}
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
                    description: newDescription.trim() || null,
                  })
                  .then(() => {
                    setNewKey("");
                    setNewLabel("");
                    setNewDescription("");
                    setNotice(null);
                    refresh();
                  })
                  .catch((error: unknown) => {
                    setNotice(error instanceof Error ? error.message : "Could not add the category.");
                  });
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Key (permanent)
                <Input
                  value={newKey}
                  onChange={(event) => setNewKey(event.target.value)}
                  placeholder="billing"
                  className="w-36 font-mono"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Label
                <Input
                  value={newLabel}
                  onChange={(event) => setNewLabel(event.target.value)}
                  placeholder="Billing question"
                  className="w-44"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Description (optional)
                <Input
                  value={newDescription}
                  onChange={(event) => setNewDescription(event.target.value)}
                  placeholder="Charges, invoices, plans"
                  className="w-56"
                />
              </label>
              <Button type="submit" variant="primary" disabled={!newKey.trim() || !newLabel.trim() || create.isPending}>
                Add category
              </Button>
            </form>
          </CardBody>
        </Card>
      )}
    </>
  );
}

function CategoryRow({
  category,
  onSave,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  readonly category: {
    id: string;
    key: string;
    label: string;
    description: string | null;
    showToCustomer: boolean;
  };
  readonly onSave: (patch: {
    label?: string;
    description?: string | null;
    showToCustomer?: boolean;
  }) => Promise<void>;
  readonly onDelete: () => Promise<void>;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const [label, setLabel] = useState(category.label);
  const [description, setDescription] = useState(category.description ?? "");
  const [visible, setVisible] = useState(category.showToCustomer);
  const dirty =
    label !== category.label ||
    (description || null) !== category.description ||
    visible !== category.showToCustomer;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control border border-line px-3 py-2">
      <code className="w-28 truncate font-mono text-xs text-ink-muted" title={category.key}>
        {category.key}
      </code>
      <Input value={label} onChange={(event) => setLabel(event.target.value)} className="w-44" />
      <Input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="one line under the label"
        className="w-56"
      />
      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => setVisible(event.target.checked)}
        />
        in widget
      </label>
      {!category.showToCustomer ? <Badge tone="neutral">staff only</Badge> : null}
      <div className="ml-auto flex items-center gap-1">
        <Button onClick={onMoveUp} disabled={isFirst} aria-label={`Move ${category.label} up`}>
          ↑
        </Button>
        <Button onClick={onMoveDown} disabled={isLast} aria-label={`Move ${category.label} down`}>
          ↓
        </Button>
        <Button
          variant="primary"
          disabled={!dirty}
          onClick={() =>
            void onSave({
              label: label.trim(),
              description: description.trim() || null,
              showToCustomer: visible,
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
  );
}

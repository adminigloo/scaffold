"use client";

import Link from "next/link";
import { api } from "@/trpc/client";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";

/** "3m ago" / "2h ago" / "5d ago" — short enough for a list row. */
function ageOf(value: Date | string): string {
  const then = new Date(value).getTime();
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Your inbox — yours alone, resolved from the session server-side.
 *
 * Rows are written by events (a new feedback ticket, a reporter's reply) at
 * the moment they happen, so this page is the answer to "what happened while
 * I was away" without anyone having to remember to check four screens.
 * Clicking a row marks it read and follows its link; unread is a fact with a
 * timestamp, not a dot that lies after a refresh.
 */
export default function InboxPage() {
  const list = api.notifications.list.useQuery({ limit: 50 });
  const count = api.notifications.unreadCount.useQuery();
  const markRead = api.notifications.markRead.useMutation();
  const markAll = api.notifications.markAllRead.useMutation();

  const refresh = () => {
    void list.refetch();
    void count.refetch();
  };

  const rows = list.data ?? [];
  const unread = count.data ?? 0;

  return (
    <>
      <PageHeader
        title="Inbox"
        description="What happened while you were away — new feedback, reporter replies, and whatever the suite learns to announce next."
        actions={
          <Button
            disabled={unread === 0 || markAll.isPending}
            onClick={() => void markAll.mutateAsync().then(refresh)}
          >
            Mark all read{unread > 0 ? ` (${unread})` : ""}
          </Button>
        }
      />

      {rows.length === 0 ? (
        <EmptyState title="Nothing yet">
          Notifications land here the moment something needs a human — the first feedback
          ticket or reporter reply will ring it.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map((row) => {
              const inner = (
                <span className="flex w-full items-baseline gap-3">
                  <span
                    aria-hidden
                    className={
                      row.readAt === null
                        ? "mt-1 h-2 w-2 shrink-0 self-center rounded-full bg-accent"
                        : "mt-1 h-2 w-2 shrink-0 self-center rounded-full bg-transparent"
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={
                        row.readAt === null
                          ? "block truncate text-sm font-medium text-ink"
                          : "block truncate text-sm text-ink-muted"
                      }
                    >
                      {row.title}
                    </span>
                    {row.body ? (
                      <span className="block truncate text-xs text-ink-muted">{row.body}</span>
                    ) : null}
                  </span>
                  <Badge tone="neutral">{row.kind.split(".")[0]}</Badge>
                  <span className="shrink-0 text-xs text-ink-muted tabular-nums">
                    {ageOf(row.createdAt)}
                  </span>
                </span>
              );
              return (
                <li key={row.id}>
                  {row.href ? (
                    <Link
                      href={row.href}
                      className="flex px-4 py-2.5 no-underline transition-colors hover:bg-canvas"
                      onClick={() => {
                        if (row.readAt === null) {
                          void markRead.mutateAsync({ id: row.id }).then(refresh);
                        }
                      }}
                    >
                      {inner}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="flex w-full px-4 py-2.5 text-left transition-colors hover:bg-canvas"
                      onClick={() => {
                        if (row.readAt === null) {
                          void markRead.mutateAsync({ id: row.id }).then(refresh);
                        }
                      }}
                    >
                      {inner}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </>
  );
}

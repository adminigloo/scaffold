"use client";

import Link from "next/link";
import { api } from "@/trpc/client";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * Who changed the assistant, when, and why — the append-only record. This is
 * the answer to "why did the bot start saying that?", and there is no path to
 * change the assistant's behavior that doesn't leave a row here.
 */
const ACTION_TONE: Record<string, BadgeTone> = {
  created: "ok",
  published: "accent",
  deactivated: "warn",
};

export default function AssistantChangeLogPage() {
  const log = api.assistant.changeLog.useQuery();

  return (
    <>
      <PageHeader
        title="Assistant change log"
        description="Every edit to the assistant's personality, newest first — author, section, and the version it produced."
        actions={
          <Link href="/admin/assistant" className="text-sm text-accent underline underline-offset-2">
            Back to personality
          </Link>
        }
      />
      {log.isLoading ? (
        <EmptyState title="Loading…">Reading the change log.</EmptyState>
      ) : (log.data ?? []).length === 0 ? (
        <EmptyState title="Nothing changed yet">
          Edits to the personality, tenant rules, and glossary land here the moment they happen.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {(log.data ?? []).map((row) => (
              <li key={String(row.id)} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <Badge tone={ACTION_TONE[row.action] ?? "neutral"}>{row.action}</Badge>
                <code className="font-mono text-xs text-ink-muted">{row.entityKey ?? row.entityType}</code>
                {row.versionNumber ? (
                  <span className="font-mono text-xs tabular-nums text-ink-faint">v{row.versionNumber}</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-ink-muted">{row.changeSummary ?? ""}</span>
                <span className="text-xs text-ink-faint">{row.performedBy ?? "—"}</span>
                <span className="text-xs text-ink-faint">{new Date(row.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

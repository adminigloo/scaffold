import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { api } from "@/trpc/server";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/components/ui";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * The feedback queue.
 *
 * Read through the tRPC caller rather than by querying `feedback_tickets`
 * here, for the same reason the audit page gives: a page is exactly where an
 * authorization rung gets forgotten, because the layout already let you in.
 *
 * Rows expand in place with <details> rather than opening a detail route: the
 * queue is triage, and triage is a scan — screenshot, story, next. The working
 * session on one ticket lives on the board, where clicking a card opens the
 * conversation panel.
 */
export default async function FeedbackPage() {
  if (!isDbConfigured(db)) return <NotConfigured />;

  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.dashboard.view")) {
    return (
      <>
        <PageHeader title="Feedback" />
        <Notice tone="warn">You do not have permission to view the feedback queue.</Notice>
      </>
    );
  }

  const { tickets } = await (await api()).feedback.list({ limit: 100 });

  return (
    <>
      <PageHeader
        title="Feedback"
        description="Submitted through the feedback widget by each tenant's end users, key-authenticated. The screenshot, click trail and browser errors arrive with the report — the context is already here."
      />

      {tickets.length === 0 ? (
        <EmptyState title="No feedback yet">
          Tickets appear here the moment someone presses the widget's Feedback button — or
          Ctrl+Shift+B — in an app holding a client key.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH className="w-40">When</TH>
                <TH className="w-28">Ticket</TH>
                <TH>Report</TH>
                <TH className="w-24">Priority</TH>
                <TH className="w-36">Tenant</TH>
                <TH className="w-28">Screenshot</TH>
              </TR>
            </THead>
            <TBody>
              {tickets.map((ticket) => (
                <TR key={ticket.id}>
                  <TD className="whitespace-nowrap align-top font-mono text-xs text-ink-muted">
                    {ticket.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                  </TD>
                  <TD className="align-top">
                    <span className="font-mono text-xs">{ticket.ticketNumber}</span>
                    <span className="mt-0.5 block text-xs text-ink-muted">{ticket.status}</span>
                  </TD>
                  <TD className="align-top">
                    <span className="text-ink">{ticket.title}</span>
                    {ticket.category && (
                      <Badge className="ml-2">{ticket.category}</Badge>
                    )}
                    <span className="mt-0.5 block text-xs text-ink-muted">
                      {ticket.pagePathname ?? "—"}
                      {ticket.reporterName || ticket.reporterEmail
                        ? ` · ${ticket.reporterName ?? ticket.reporterEmail}`
                        : ""}
                    </span>
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-accent">
                        Full report &amp; context
                      </summary>
                      <div className="mt-2 space-y-2 text-xs">
                        <p className="whitespace-pre-wrap text-ink">{ticket.description}</p>
                        <ContextDump label="Client metadata" value={ticket.clientMetadata} />
                        <ContextDump label="Browser errors" value={ticket.recentErrors} />
                      </div>
                    </details>
                  </TD>
                  <TD className="align-top">
                    <Badge tone={priorityTone(ticket.priority)}>{ticket.priority}</Badge>
                  </TD>
                  <TD className="align-top text-xs text-ink-muted">
                    {ticket.tenantName ?? ticket.tenantId}
                  </TD>
                  <TD className="align-top text-xs">
                    <ScreenshotLinks
                      screenshotUrl={ticket.screenshotUrl}
                      annotatedScreenshotUrl={ticket.annotatedScreenshotUrl}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}

function priorityTone(priority: string): BadgeTone {
  if (priority === "critical") return "danger";
  if (priority === "high") return "warn";
  return "neutral";
}

/**
 * Plain <a>s in a new tab, not <img> thumbnails: blob URLs are public but a
 * queue page that inlines every screenshot fetches megabytes to answer
 * "anything new?", and the annotated one is what triage actually opens.
 */
function ScreenshotLinks({
  screenshotUrl,
  annotatedScreenshotUrl,
}: {
  readonly screenshotUrl: string | null;
  readonly annotatedScreenshotUrl: string | null;
}) {
  if (!screenshotUrl && !annotatedScreenshotUrl) {
    return <span className="text-ink-muted">none</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      {annotatedScreenshotUrl && (
        <a
          href={annotatedScreenshotUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          annotated ↗
        </a>
      )}
      {screenshotUrl && (
        <a
          href={screenshotUrl}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          original ↗
        </a>
      )}
    </span>
  );
}

/**
 * `jsonb` in, `unknown` out, and it stays that way — the column holds whatever
 * the widget version that wrote it sent. Pretty-printed rather than cast,
 * because this block exists to be copied into a debugging session verbatim.
 */
function ContextDump({ label, value }: { readonly label: string; readonly value: unknown }) {
  if (value === null || value === undefined) return null;
  const json = JSON.stringify(value, null, 1);
  if (!json || json === "[]" || json === "{}") return null;
  return (
    <details>
      <summary className="cursor-pointer text-ink-muted">{label}</summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-[--radius-card] bg-surface p-2 font-mono text-[11px] text-ink-muted">
        {json}
      </pre>
    </details>
  );
}

function NotConfigured() {
  return (
    <>
      <PageHeader title="Feedback" />
      <EmptyState title="No database yet, so there is no queue to read">
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>{" "}
        lists what is missing; set <code className="font-mono">DATABASE_URL</code> and run{" "}
        <code className="font-mono">pnpm db:migrate</code>.
      </EmptyState>
    </>
  );
}

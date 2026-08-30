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
  cx,
} from "@/components/ui";

/**
 * Audit trail.
 *
 * Read through the tRPC caller rather than by querying `audit_log` here.
 * Reaching for `db` directly from a page skips the rung that authorizes it, and
 * a page is exactly where that gets forgotten — the layout already let you in,
 * so it feels checked.
 *
 * Sensitive reads have their own filter because "who looked at customer data"
 * is the question a compliance review actually asks, and it is a small slice of
 * a very large table with a partial index behind it.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured(db)) return <NotConfigured />;

  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.audit.view")) {
    return (
      <>
        <PageHeader title="Audit log" />
        <Notice tone="warn">You do not have permission to view the audit log.</Notice>
      </>
    );
  }

  const sensitiveOnly = (await searchParams).sensitive === "1";
  const { entries } = await (await api()).admin.recentAudit({
    limit: 100,
    sensitiveOnly,
  });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only. Nothing in the app updates or deletes a row here — a trail that can be edited answers a different question than the one it is kept for."
      />

      {/* Links, not buttons: the filter is in the URL, so it survives a reload,
          a bookmark and a paste into a compliance ticket. */}
      <div role="group" aria-label="Filter" className="mb-4 flex gap-1">
        <FilterLink href="/admin/audit" active={!sensitiveOnly}>
          Everything
        </FilterLink>
        <FilterLink href="/admin/audit?sensitive=1" active={sensitiveOnly}>
          Sensitive access only
        </FilterLink>
      </div>

      {entries.length === 0 ? (
        <EmptyState title={sensitiveOnly ? "No sensitive access recorded" : "Nothing recorded yet"}>
          {sensitiveOnly
            ? "Actions land here when their key is declared with `sensitive: true` in a defineAuditedActions registry — impersonation and permission grants, for example."
            : "A row is written whenever an audited action runs; changing someone's permissions on the Roles page writes one immediately. Actions must be declared with defineAuditedActions — one named with a bare string literal at the call site is invisible to every query written against this table."}
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH className="w-44">When</TH>
                <TH>Actor</TH>
                <TH>Action</TH>
                <TH>Target</TH>
              </TR>
            </THead>
            <TBody>
              {entries.map((entry) => (
                <TR key={String(entry.id)}>
                  <TD className="whitespace-nowrap font-mono text-xs text-ink-muted">
                    {entry.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </TD>
                  <TD>
                    {/* The audit tables carry no foreign keys, so the join misses
                        for a deleted user. Showing the raw id is the honest answer;
                        showing nothing would make the row look actorless. */}
                    <span className="text-ink">
                      {entry.actorName ?? entry.actorEmail ?? entry.actorUserId ?? "system"}
                    </span>
                    {entry.actorImpersonatedBy && (
                      <span className="mt-0.5 block text-xs text-danger">
                        impersonated by {entry.actorImpersonatedBy}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <span className="text-ink">{entry.label}</span>
                    {entry.isSensitive && (
                      <Badge tone="danger" className="ml-2" title="Recorded as sensitive access">
                        Sensitive
                      </Badge>
                    )}
                    <span className="mt-0.5 block font-mono text-xs text-ink-muted">
                      {entry.action}
                    </span>
                  </TD>
                  <TD className="font-mono text-xs text-ink-muted">
                    {entry.resourceType
                      ? `${entry.resourceType} ${entry.resourceId ?? ""}`
                      : "—"}
                    {entry.metadata !== null && (
                      <span className="mt-0.5 block break-all">
                        {summarise(entry.metadata)}
                      </span>
                    )}
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

function FilterLink({
  href,
  active,
  children,
}: {
  readonly href: string;
  readonly active: boolean;
  readonly children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cx(
        "rounded-[--radius-card] px-2.5 py-1 text-sm no-underline",
        active
          ? "bg-accent-soft font-medium text-accent"
          : "text-ink-muted hover:bg-surface hover:text-ink",
      )}
    >
      {children}
    </Link>
  );
}

/**
 * `metadata` is `jsonb`, so it is `unknown` and stays that way.
 *
 * Casting it to a shape would be a lie: the column holds whatever the action
 * that wrote it put there, including rows written by a version of the code that
 * no longer exists. Truncated, because one redacted Stripe payload would
 * otherwise take the whole row.
 */
function summarise(metadata: unknown): string {
  const json = JSON.stringify(metadata);
  if (!json) return "";
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

function NotConfigured() {
  return (
    <>
      <PageHeader title="Audit log" />
      <EmptyState title="No database yet, so there is no trail to read">
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>{" "}
        lists what is missing; set <code className="font-mono">DATABASE_URL</code>{" "}
        and run <code className="font-mono">pnpm db:migrate</code>.
      </EmptyState>
    </>
  );
}

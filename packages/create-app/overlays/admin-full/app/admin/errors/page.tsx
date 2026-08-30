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
 * One row per distinct bug, not one per occurrence.
 *
 * That is a property of how errors are WRITTEN — an upsert on the fingerprint —
 * not of how they are read here. A plain insert per occurrence turns one bad
 * deploy into millions of rows and pushes every other bug off the first page,
 * so if this list ever grows a hundred copies of the same message, the reporter
 * is what to fix.
 *
 * Gated on `staff.audit.view`: stack traces and error context routinely contain
 * customer data, so this is the same privilege as reading the audit log rather
 * than a lesser one.
 */
export default async function ErrorsPage() {
  if (!isDbConfigured(db)) return <NotConfigured />;

  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.audit.view")) {
    return (
      <>
        <PageHeader title="Errors" />
        <Notice tone="warn">You do not have permission to view errors.</Notice>
      </>
    );
  }

  const { errors } = await (await api()).admin.recentErrors({ limit: 100 });

  return (
    <>
      <PageHeader
        title="Errors"
        description="Unresolved first. The occurrence count is the triage signal — it is what separates a bug that fired once from one firing every second, and it exists only because repeated errors increment a row instead of inserting a new one."
      />

      {errors.length === 0 ? (
        <EmptyState title="Nothing recorded">
          Rows appear when something catches an error, computes a stable key with{" "}
          <code className="font-mono">errorFingerprint</code>, and upserts into{" "}
          <code className="font-mono">error_log</code> on that key. Nothing in the
          scaffold does that for you yet: an empty table here means either a
          healthy app or an unwired reporter, and the place to wire it is the{" "}
          <code className="font-mono">errorFormatter</code> in{" "}
          <code className="font-mono">src/server/trpc.ts</code> plus each webhook
          route.
        </EmptyState>
      ) : (
        <Card>
          <Table>
            <THead>
              <TR>
                <TH className="w-20">Count</TH>
                <TH>Error</TH>
                <TH className="w-40">Source</TH>
                <TH className="w-44">Last seen</TH>
              </TR>
            </THead>
            <TBody>
              {errors.map((row) => (
                <TR key={String(row.id)}>
                  <TD
                    className={cx(
                      "tabular-nums",
                      row.resolvedAt ? "text-ink-muted" : "text-ink",
                      row.occurrences > 1 && !row.resolvedAt && "font-semibold",
                    )}
                  >
                    {row.occurrences.toLocaleString()}
                  </TD>
                  <TD className="min-w-0">
                    <span className={row.resolvedAt ? "text-ink-muted" : "text-ink"}>
                      {row.message}
                    </span>
                    {row.resolvedAt && (
                      <Badge tone="accent" className="ml-2">
                        Resolved
                      </Badge>
                    )}
                    <span className="mt-0.5 block break-all font-mono text-xs text-ink-muted">
                      {row.fingerprint} · first seen{" "}
                      {row.firstSeenAt.toISOString().slice(0, 10)}
                    </span>
                  </TD>
                  <TD className="text-ink-muted">{row.source ?? "—"}</TD>
                  <TD className="whitespace-nowrap font-mono text-xs text-ink-muted">
                    {row.lastSeenAt.toISOString().replace("T", " ").slice(0, 19)}
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

function NotConfigured() {
  return (
    <>
      <PageHeader title="Errors" />
      <EmptyState title="No database yet, so nothing has been recorded">
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>{" "}
        lists what is missing; set <code className="font-mono">DATABASE_URL</code>{" "}
        and run <code className="font-mono">pnpm db:migrate</code>.
      </EmptyState>
    </>
  );
}

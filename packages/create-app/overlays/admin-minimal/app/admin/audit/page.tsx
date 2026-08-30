import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { api } from "@/trpc/server";

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
    return <p>You do not have permission to view the audit log.</p>;
  }

  const sensitiveOnly = (await searchParams).sensitive === "1";
  const { entries } = await (await api()).admin.recentAudit({
    limit: 100,
    sensitiveOnly,
  });

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.25rem" }}>Audit log</h1>
      <p style={{ color: "#6b7280", maxWidth: "62ch", marginTop: 0 }}>
        Append-only. Nothing in the app updates or deletes a row here — a trail
        that can be edited answers a different question than the one it is kept
        for.
      </p>

      <p style={{ fontSize: "0.8125rem", margin: "0 0 1rem" }}>
        <Link
          href="/admin/audit"
          style={{ fontWeight: sensitiveOnly ? 400 : 700 }}
        >
          Everything
        </Link>
        {" · "}
        <Link
          href="/admin/audit?sensitive=1"
          style={{ fontWeight: sensitiveOnly ? 700 : 400 }}
        >
          Sensitive access only
        </Link>
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #d1d5db" }}>
            <th style={{ padding: "0.5rem 0.75rem" }}>When</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Actor</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Action</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Target</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={String(entry.id)} style={{ borderBottom: "1px solid #f0f1f3" }}>
              <td
                style={{
                  padding: "0.5rem 0.75rem",
                  whiteSpace: "nowrap",
                  color: "#6b7280",
                }}
              >
                {entry.createdAt.toISOString().replace("T", " ").slice(0, 19)}
              </td>
              <td style={{ padding: "0.5rem 0.75rem" }}>
                {/* The audit tables carry no foreign keys, so the join misses
                    for a deleted user. Showing the raw id is the honest answer;
                    showing nothing would make the row look actorless. */}
                {entry.actorName ?? entry.actorEmail ?? entry.actorUserId ?? "system"}
                {entry.actorImpersonatedBy && (
                  <span style={{ display: "block", fontSize: "0.75rem", color: "#a02e21" }}>
                    impersonated by {entry.actorImpersonatedBy}
                  </span>
                )}
              </td>
              <td style={{ padding: "0.5rem 0.75rem" }}>
                {entry.label}
                {entry.isSensitive && (
                  <span
                    title="Recorded as sensitive access"
                    style={{
                      marginLeft: "0.5rem",
                      fontSize: "0.6875rem",
                      color: "#a02e21",
                      border: "1px solid #a02e21",
                      borderRadius: 3,
                      padding: "0 4px",
                    }}
                  >
                    SENSITIVE
                  </span>
                )}
                <span style={{ display: "block", fontSize: "0.75rem", color: "#6b7280" }}>
                  {entry.action}
                </span>
              </td>
              <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", fontSize: "0.75rem" }}>
                {entry.resourceType ? `${entry.resourceType} ${entry.resourceId ?? ""}` : "—"}
                {entry.metadata !== null && (
                  <span style={{ display: "block", color: "#6b7280" }}>
                    {summarise(entry.metadata)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {entries.length === 0 && (
        <p style={{ color: "#6b7280", maxWidth: "62ch" }}>
          {sensitiveOnly
            ? "No sensitive access recorded. Actions land here when their key is declared with `sensitive: true` in a defineAuditedActions registry — impersonation and permission grants, for example."
            : "Nothing recorded yet. A row is written whenever an audited action runs; changing someone's permissions on the Roles page writes one immediately. Actions must be declared with defineAuditedActions — one named with a bare string literal at the call site is invisible to every query written against this table."}
        </p>
      )}
    </>
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
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.25rem" }}>Audit log</h1>
      <p style={{ color: "#6b7280", maxWidth: "62ch" }}>
        No database yet, so there is no trail to read.{" "}
        <Link href="/setup">/setup</Link> lists what is missing; set{" "}
        <code>DATABASE_URL</code> and run <code>pnpm db:migrate</code>.
      </p>
    </>
  );
}

import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { api } from "@/trpc/server";

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
    return <p>You do not have permission to view errors.</p>;
  }

  const { errors } = await (await api()).admin.recentErrors({ limit: 100 });

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.25rem" }}>Errors</h1>
      <p style={{ color: "#6b7280", maxWidth: "62ch", marginTop: 0 }}>
        Unresolved first. The occurrence count is the triage signal — it is what
        separates a bug that fired once from one firing every second, and it
        exists only because repeated errors increment a row instead of inserting
        a new one.
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #d1d5db" }}>
            <th style={{ padding: "0.5rem 0.75rem", width: "5rem" }}>Count</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Error</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Source</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((row) => (
            <tr key={String(row.id)} style={{ borderBottom: "1px solid #f0f1f3" }}>
              <td
                style={{
                  padding: "0.5rem 0.75rem",
                  fontVariantNumeric: "tabular-nums",
                  fontWeight: row.occurrences > 1 ? 700 : 400,
                  color: row.resolvedAt ? "#6b7280" : "#111827",
                }}
              >
                {row.occurrences.toLocaleString()}
              </td>
              <td style={{ padding: "0.5rem 0.75rem", minWidth: 0 }}>
                <span style={{ color: row.resolvedAt ? "#6b7280" : "#111827" }}>
                  {row.message}
                </span>
                {row.resolvedAt && (
                  <span
                    style={{
                      marginLeft: "0.5rem",
                      fontSize: "0.6875rem",
                      color: "#15803d",
                      border: "1px solid #15803d",
                      borderRadius: 3,
                      padding: "0 4px",
                    }}
                  >
                    RESOLVED
                  </span>
                )}
                <span
                  style={{
                    display: "block",
                    fontFamily: "monospace",
                    fontSize: "0.75rem",
                    color: "#6b7280",
                  }}
                >
                  {row.fingerprint} · first seen{" "}
                  {row.firstSeenAt.toISOString().slice(0, 10)}
                </span>
              </td>
              <td style={{ padding: "0.5rem 0.75rem", color: "#6b7280" }}>
                {row.source ?? "—"}
              </td>
              <td
                style={{
                  padding: "0.5rem 0.75rem",
                  whiteSpace: "nowrap",
                  color: "#6b7280",
                }}
              >
                {row.lastSeenAt.toISOString().replace("T", " ").slice(0, 19)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {errors.length === 0 && (
        <p style={{ color: "#6b7280", maxWidth: "62ch" }}>
          Nothing recorded. Rows appear when something catches an error, computes
          a stable key with <code>errorFingerprint</code>, and upserts into{" "}
          <code>error_log</code> on that key. Nothing in the scaffold does that
          for you yet: an empty table here means either a healthy app or an
          unwired reporter, and the place to wire it is the{" "}
          <code>errorFormatter</code> in <code>src/server/trpc.ts</code> plus
          each webhook route.
        </p>
      )}
    </>
  );
}

function NotConfigured() {
  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.25rem" }}>Errors</h1>
      <p style={{ color: "#6b7280", maxWidth: "62ch" }}>
        No database yet, so nothing has been recorded.{" "}
        <Link href="/setup">/setup</Link> lists what is missing; set{" "}
        <code>DATABASE_URL</code> and run <code>pnpm db:migrate</code>.
      </p>
    </>
  );
}

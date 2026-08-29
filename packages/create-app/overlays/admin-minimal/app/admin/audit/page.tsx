import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * Audit trail.
 *
 * Reads the `audit_log` table from @adminigloo/observability once that package
 * is installed. Sensitive reads are flagged separately, because "who looked at
 * customer data" is the question a compliance review actually asks and it is a
 * small slice of a very large table.
 */
export default async function AuditPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.audit.view")) {
    return <p>You do not have permission to view the audit log.</p>;
  }

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>Audit log</h1>
      <p style={{ color: "#6b7280", maxWidth: "60ch" }}>
        Install <code>__SCOPE__/observability</code> and re-export its schema
        from <code>src/db/schema.ts</code> to populate this view.
      </p>
    </>
  );
}

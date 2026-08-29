import { desc } from "drizzle-orm";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * Read-only list of customer organisations.
 *
 * Gated again here rather than relying on the layout: a page can be rendered by
 * a route that does not sit under this layout, and "the parent checked" is not
 * a property the type system enforces.
 */
export default async function TenantsPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.tenants.view")) {
    return <p>You do not have permission to view __TENANT_LABEL_PLURAL__.</p>;
  }

  const rows = await db
    .select()
    .from(tenants)
    .orderBy(desc(tenants.createdAt))
    .limit(50);

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>__TENANT_LABEL_PLURAL__</h1>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #d1d5db" }}>
            <th style={{ padding: "0.5rem 0.75rem" }}>Name</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Slug</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Kind</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderBottom: "1px solid #f0f1f3" }}>
              <td style={{ padding: "0.5rem 0.75rem" }}>{row.name}</td>
              <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace" }}>
                {row.slug}
              </td>
              <td style={{ padding: "0.5rem 0.75rem" }}>{row.kind}</td>
              <td style={{ padding: "0.5rem 0.75rem" }}>
                {row.createdAt?.toISOString().slice(0, 10)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p style={{ color: "#6b7280" }}>No __TENANT_LABEL_LOWER__s yet.</p>
      )}
    </>
  );
}

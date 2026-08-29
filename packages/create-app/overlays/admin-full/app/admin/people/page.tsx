import { desc } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export default async function PeoplePage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.people.view")) {
    return <p>You do not have permission to view people.</p>;
  }

  const rows = await db.select().from(users).orderBy(desc(users.createdAt)).limit(50);

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>People</h1>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #d1d5db" }}>
            <th style={{ padding: "0.5rem 0.75rem" }}>Name</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Email</th>
            <th style={{ padding: "0.5rem 0.75rem" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderBottom: "1px solid #f0f1f3" }}>
              <td style={{ padding: "0.5rem 0.75rem" }}>{row.displayName ?? "—"}</td>
              <td style={{ padding: "0.5rem 0.75rem" }}>{row.email ?? "—"}</td>
              <td style={{ padding: "0.5rem 0.75rem" }}>
                {row.deletedAt ? "deleted" : "active"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

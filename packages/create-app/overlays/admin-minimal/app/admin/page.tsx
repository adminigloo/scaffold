import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export default async function AdminDashboard() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 1rem" }}>Dashboard</h1>
      <p style={{ color: "#4b5563", maxWidth: "60ch" }}>
        Signed in as {principal?.email ?? "unknown"}. You hold{" "}
        {can?.toArray().length ?? 0} staff permission
        {can?.toArray().length === 1 ? "" : "s"}.
      </p>
      <p style={{ color: "#6b7280", fontSize: "0.875rem", maxWidth: "60ch" }}>
        Widgets go here. Everything below the shell is yours to replace — this
        page is copied source, not a package.
      </p>
    </>
  );
}

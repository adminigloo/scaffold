import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
import { AdminUnavailable } from "@/components/admin/AdminUnavailable";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * The admin shell.
 *
 * COPIED SOURCE, on purpose — every client restyles this. What is NOT copied is
 * the part that decides who gets in: the principal and the permission set come
 * from the runtime packages, so a fix there reaches every client without anyone
 * re-running the generator.
 *
 * The layout gate is a convenience, not the security boundary. It stops a
 * non-staff user from seeing a broken page; every mutation underneath is gated
 * again by `requireStaff(...)` on its own procedure. A layout check alone is
 * one refactor away from being bypassed by a route that renders outside it.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  // The database may not be configured yet, and currentPrincipal() reads the
  // users table. Without this, an app with Clerk set up but no DATABASE_URL
  // 500s on /admin instead of showing the same "not configured" story the rest
  // of the app tells — and the layout runs BEFORE any page-level guard, so a
  // guard further down cannot save it.
  let principal: Awaited<ReturnType<typeof currentPrincipal>> = null;
  let can: Awaited<ReturnType<typeof loadStaffPermissions>> = null;
  try {
    principal = await currentPrincipal();
    if (principal) can = await loadStaffPermissions({ principal });
  } catch {
    return <AdminUnavailable reason="database" />;
  }

  if (!principal) redirect("/sign-in");
  // Not staff at all, which is different from staff holding no permissions.
  // An explicit page, NOT a redirect: a nav link that silently bounces you back
  // where you started reads as broken software, and the first thing anyone does
  // is click it again.
  if (!can) return <AdminUnavailable reason="not-staff" />;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "100vh" }}>
      <AdminNav granted={can.toArray()} />
      <main style={{ padding: "2rem", minWidth: 0 }}>{children}</main>
    </div>
  );
}

import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin/AdminNav";
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
  const principal = await currentPrincipal();
  if (!principal) redirect("/sign-in");

  const can = await loadStaffPermissions({ principal });
  // null means "not staff at all", which is different from "staff with no
  // permissions". Only the first should be sent away.
  if (!can) redirect("/");

  return (
    <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "100vh" }}>
      <AdminNav granted={can.toArray()} />
      <main style={{ padding: "2rem", minWidth: 0 }}>{children}</main>
    </div>
  );
}

import { UserButton } from "@clerk/nextjs";
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
    <div className="flex min-h-dvh">
      {/* `sticky top-0 h-dvh` rather than a scrolling column: an audit page a
          thousand rows long otherwise scrolls the nav off the top, and the way
          out of a long table should not be to scroll back up it. */}
      <aside className="sticky top-0 flex h-dvh w-60 shrink-0 flex-col border-r border-line bg-surface">
        <div className="border-b border-line px-4 py-4">
          <p className="truncate font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
            __PROJECT_NAME__
          </p>
          <p className="mt-0.5 text-sm font-semibold tracking-tight">Admin</p>
        </div>

        <AdminNav granted={can.toArray()} />

        {/* Who am I signed in as, and how do I get out — at the bottom, where
            every tool people already use puts it. Impersonation makes this more
            than decoration: the answer is not always the one you expect. */}
        <div className="mt-auto flex items-center gap-2 border-t border-line px-4 py-3">
          <UserButton />
          <span className="min-w-0 flex-1 truncate text-xs text-ink-muted" title={principal.email ?? undefined}>
            {principal.email ?? "signed in"}
          </span>
        </div>
      </aside>

      <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
    </div>
  );
}

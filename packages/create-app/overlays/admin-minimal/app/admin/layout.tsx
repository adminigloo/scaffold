import { UserButton } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { resolveAppEnv } from "__SCOPE__/env";
import { AdminNav } from "@/components/admin/AdminNav";
import { AlertsBellSlot } from "@/components/AlertsBellSlot";
import {
  AdminUnavailable,
  type AdminUnavailableReason,
} from "@/components/admin/AdminUnavailable";
import { SITE_NAME } from "@/seo";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { tenancy } from "@/server/tenancy";

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
  let refused: AdminUnavailableReason | null = null;
  try {
    principal = await currentPrincipal();
    if (principal) can = await loadStaffPermissions({ principal });
    if (principal && !can) {
      // SELF-HEALING FIRST RUN (Tenancy 1). While NO administrator exists, the
      // person allowed to be the first one (BOOTSTRAP_ADMIN_EMAIL, verified, on
      // a deployment; anyone on a laptop) becomes one right here — not only at
      // their very first sign-in. Signing in before the roles were installed
      // used to lock /admin for good; now the next visit after the seed lets
      // them in. Once an administrator exists this changes nothing.
      const healed = await tenancy.ensureBootstrapAdmin({
        userId: principal.userId,
        email: principal.email,
      });
      if (healed.granted) can = await loadStaffPermissions({ principal });
      else refused = healed.reason === "templates-missing" ? "not-seeded" : "not-staff";
    }
  } catch {
    return <AdminUnavailable reason="database" deployed={resolveAppEnv() !== "local"} />;
  }

  if (!principal) redirect("/sign-in?redirect_url=%2Fadmin");
  // Not staff at all, which is different from staff holding no permissions.
  // An explicit page, NOT a redirect: a nav link that silently bounces you back
  // where you started reads as broken software, and the first thing anyone does
  // is click it again. Which recovery it suggests depends on where it runs (a
  // command on a laptop, a workflow on a deployment) — a runtime environment
  // check, not a feature switch.
  if (!can) {
    return (
      <AdminUnavailable reason={refused ?? "not-staff"} deployed={resolveAppEnv() !== "local"} />
    );
  }

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      {/* `sticky top-0 h-dvh` rather than a scrolling column: an audit page a
          thousand rows long otherwise scrolls the nav off the top, and the way
          out of a long table should not be to scroll back up it.

          BELOW THE PAGE ON A PHONE (`order-last`, full width, under md). A
          240px sidebar beside the page leaves a 390px screen about 80px of
          content, and some of these pages are used on a phone first — a
          crew opening today's route at /admin/schedule/today should see their
          stops, not the menu. From md up it is the sticky sidebar as before. */}
      <aside className="order-last flex w-full flex-col border-t border-line bg-surface md:sticky md:top-0 md:order-none md:h-dvh md:w-60 md:shrink-0 md:border-r md:border-t-0">
        <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink-muted">{SITE_NAME}</p>
            <p className="mt-0.5 text-sm font-semibold tracking-tight">Admin</p>
          </div>
          {/* THE ALERTS BELL, where a single business's staff work (Tenancy
              2b-1). Generated in three variants (src/components/
              AlertsBellSlot.tsx): the staff bell in a single-business project
              with alerts; nothing in a companies project (a company's bell is
              in its own area's header) or without alerts. The person here is
              staff — the layout just checked. */}
          <AlertsBellSlot session={null} can={[]} isStaff />
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

      <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
    </div>
  );
}

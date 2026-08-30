import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { RoleEditor } from "@/components/admin/RoleEditor";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { EmptyState, Notice, PageHeader } from "@/components/ui";

/**
 * Roles and per-person overrides.
 *
 * A server component that resolves who is looking and hands one boolean to the
 * client. Everything else — the catalog, the template, the sealing rule, the
 * audit row — happens in `admin.*` on the server, so the browser never holds
 * the rules, only the answers.
 */
export default async function RolesPage() {
  // FIRST, before anything queries. `currentPrincipal()` reads the users table,
  // so on a fresh clone with no DATABASE_URL this page would otherwise 500 with
  // DatabaseNotConfiguredError before it could say what is missing. Asking the
  // handle does not trip the throw.
  if (!isDbConfigured(db)) return <NotConfigured />;

  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

  // Checked here as well as in the layout, and again on every procedure the
  // editor calls. A page can be rendered by a route that does not sit under
  // this layout, and "the parent checked" is not something the type system
  // enforces.
  if (!can?.can("staff.roles.view")) {
    return (
      <>
        <PageHeader title="Roles & permissions" />
        <Notice tone="warn">
          You do not have permission to view roles and permissions.
        </Notice>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="A template sets the baseline. Override an individual capability on top of it without inventing a new role. Sealed rows cannot be granted this way, and every change is written to the audit log."
      />
      <RoleEditor canManage={can.can("staff.roles.manage")} />
    </>
  );
}

function NotConfigured() {
  return (
    <>
      <PageHeader title="Roles & permissions" />
      <EmptyState title="No database yet">
        Role templates, people and overrides all live in Postgres, so there is
        nothing to show until <code className="font-mono">DATABASE_URL</code> is
        set.{" "}
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>{" "}
        lists what is missing and where to get it; then run{" "}
        <code className="font-mono">pnpm db:migrate</code> and{" "}
        <code className="font-mono">pnpm db:seed</code>.
      </EmptyState>
    </>
  );
}

import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { RoleEditor } from "@/components/admin/RoleEditor";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

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
    return <p>You do not have permission to view roles and permissions.</p>;
  }

  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.25rem" }}>
        Roles &amp; permissions
      </h1>
      <p style={{ color: "#6b7280", maxWidth: "62ch", marginTop: 0 }}>
        A template sets the baseline. Override an individual capability on top of
        it without inventing a new role. Sealed rows cannot be granted this way,
        and every change is written to the audit log.
      </p>
      <RoleEditor canManage={can.can("staff.roles.manage")} />
    </>
  );
}

function NotConfigured() {
  return (
    <>
      <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.25rem" }}>
        Roles &amp; permissions
      </h1>
      <p style={{ color: "#6b7280", maxWidth: "62ch" }}>
        No database yet. Role templates, people and overrides all live in
        Postgres, so there is nothing to show until <code>DATABASE_URL</code> is
        set. <Link href="/setup">/setup</Link> lists what is missing and where to
        get it; then run <code>pnpm db:migrate</code> and <code>pnpm db:seed</code>.
      </p>
    </>
  );
}

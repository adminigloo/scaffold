"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation, filtered by what the server already resolved.
 *
 * `granted` is the server's answer, passed down — the client never re-derives
 * it from role templates. That is deliberate: askLou's client hook preferred
 * custom role permissions while ~20 of its routers ignored them, so the UI and
 * the server disagreed by construction. One resolver, one answer, and the
 * browser is only ever told the result.
 */
export interface AdminNavProps {
  readonly granted: readonly string[];
}

interface NavItem {
  readonly href: string;
  readonly label: string;
  /** Hidden unless the viewer holds this. */
  readonly permission: string;
}

interface NavGroup {
  readonly heading: string;
  readonly items: readonly NavItem[];
}

/**
 * Grouped, and the grouping is the point: a flat list of eight links makes
 * every section look equally likely, and the two people actually use — the
 * dashboard and whatever they came to change — get no more weight than the
 * audit log.
 *
 * EVERY ITEM IS PERMISSION-GATED, including ones whose page ships in a
 * different overlay. `catalog.products.view` only exists once the catalog
 * package is installed, so on a project without it nobody holds the key, the
 * item never renders, and there is no dead link to explain. That is why there
 * is no entry for /admin/errors or /admin/support: both are admin-full pages
 * and neither has a permission of its own, so adding them here would put a 404
 * in the sidebar of every admin-minimal project.
 */
const GROUPS: readonly NavGroup[] = [
  {
    heading: "Overview",
    items: [{ href: "/admin", label: "Dashboard", permission: "staff.dashboard.view" }],
  },
  {
    heading: "Catalog",
    items: [
      { href: "/admin/products", label: "Products", permission: "catalog.products.view" },
    ],
  },
  {
    heading: "Accounts",
    items: [
      {
        href: "/admin/tenants",
        label: "__TENANT_LABEL_PLURAL__",
        permission: "staff.tenants.view",
      },
      { href: "/admin/people", label: "People", permission: "staff.people.view" },
    ],
  },
  {
    heading: "Governance",
    items: [
      { href: "/admin/roles", label: "Roles & permissions", permission: "staff.roles.view" },
      { href: "/admin/audit", label: "Audit log", permission: "staff.audit.view" },
    ],
  },
];

export function AdminNav({ granted }: AdminNavProps) {
  const pathname = usePathname();
  const allowed = new Set(granted);

  const visible = GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.permission)),
  })).filter((group) => group.items.length > 0);

  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-2 py-3">
      {visible.map((group) => (
        <div key={group.heading} className="mb-4 last:mb-0">
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-muted">
            {group.heading}
          </p>
          <ul>
            {group.items.map((item) => {
              // Exact match only. A `startsWith` test lights up "Dashboard" on
              // every page, because every admin route begins with /admin.
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={
                      active
                        ? "block rounded-[--radius-card] bg-accent-soft px-2 py-1.5 text-sm font-medium text-accent no-underline"
                        : "block rounded-[--radius-card] px-2 py-1.5 text-sm text-ink-muted no-underline hover:bg-canvas hover:text-ink"
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {visible.length === 0 && (
        <p className="px-2 text-[13px] text-ink-muted">
          You have staff access but no sections have been granted yet. Someone
          holding <code className="font-mono">staff.roles.manage</code> can grant
          them on the Roles page.
        </p>
      )}
    </nav>
  );
}

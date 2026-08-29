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

const ITEMS: readonly NavItem[] = [
  { href: "/admin", label: "Dashboard", permission: "staff.dashboard.view" },
  {
    href: "/admin/tenants",
    label: "__TENANT_LABEL_PLURAL__",
    permission: "staff.tenants.view",
  },
  { href: "/admin/people", label: "People", permission: "staff.people.view" },
  { href: "/admin/roles", label: "Roles & permissions", permission: "staff.roles.view" },
  { href: "/admin/audit", label: "Audit log", permission: "staff.audit.view" },
];

export function AdminNav({ granted }: AdminNavProps) {
  const pathname = usePathname();
  const allowed = new Set(granted);
  const visible = ITEMS.filter((item) => allowed.has(item.permission));

  return (
    <nav
      aria-label="Admin"
      style={{
        borderRight: "1px solid #e3e6ea",
        padding: "1.5rem 1rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.25rem",
      }}
    >
      <p
        style={{
          fontSize: "0.6875rem",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "#6b7280",
          margin: "0 0 1rem 0.5rem",
        }}
      >
        __PROJECT_NAME__ admin
      </p>

      {visible.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            style={{
              padding: "0.5rem",
              borderRadius: 4,
              textDecoration: "none",
              fontSize: "0.875rem",
              color: active ? "#111827" : "#4b5563",
              background: active ? "#f3f4f6" : "transparent",
              fontWeight: active ? 600 : 400,
            }}
          >
            {item.label}
          </Link>
        );
      })}

      {visible.length === 0 && (
        <p style={{ fontSize: "0.8125rem", color: "#6b7280", padding: "0.5rem" }}>
          You have staff access but no sections have been granted yet.
        </p>
      )}
    </nav>
  );
}

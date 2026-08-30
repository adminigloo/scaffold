import Link from "next/link";

export type AdminUnavailableReason = "database" | "not-staff";

/**
 * Why you cannot see the admin panel, said out loud.
 *
 * This replaces a `redirect("/")`. A nav link that bounces you back where you
 * started is indistinguishable from a broken link — the first thing anyone does
 * is click it again, and the second is assume the app is broken. Neither
 * reaction is wrong, because nothing told them otherwise.
 *
 * It also deliberately does not say WHO has access or list the roles. The page
 * is reachable by any signed-in user, and an access-denied screen that
 * enumerates the privileged set is a reconnaissance tool.
 */
export function AdminUnavailable({ reason }: { reason: AdminUnavailableReason }) {
  const copy =
    reason === "database"
      ? {
          title: "The database is not configured",
          body: "The admin panel reads from Postgres, and DATABASE_URL is not set yet.",
          action: { href: "/setup", label: "See what is configured" },
        }
      : {
          title: "You do not have access to the admin panel",
          body: "Your account is signed in, but it holds no staff role. Someone who already has one can grant you access.",
          action: { href: "/", label: "Back to the app" },
        };

  return (
    <main
      style={{
        fontFamily: "system-ui",
        display: "grid",
        placeItems: "center",
        minHeight: "70vh",
        padding: "2rem",
      }}
    >
      <div style={{ maxWidth: "44ch", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>{copy.title}</h1>
        <p style={{ color: "#4b5563", lineHeight: 1.6, margin: "0 0 1.25rem" }}>
          {copy.body}
        </p>
        <Link
          href={copy.action.href}
          style={{
            display: "inline-block",
            padding: "0.45rem 0.95rem",
            border: "1px solid #d1d5db",
            borderRadius: 4,
            textDecoration: "none",
            fontSize: "0.875rem",
            color: "#111827",
          }}
        >
          {copy.action.label}
        </Link>
      </div>
    </main>
  );
}

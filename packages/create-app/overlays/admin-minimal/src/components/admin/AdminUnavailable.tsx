import Link from "next/link";
import { buttonClass } from "@/components/ui";

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
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="max-w-[44ch] text-center">
        <h1 className="text-xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{copy.body}</p>
        <Link href={copy.action.href} className={buttonClass("secondary", "mt-5")}>
          {copy.action.label}
        </Link>
      </div>
    </main>
  );
}

import Link from "next/link";
import { buttonClass } from "@/components/ui";

export type AdminUnavailableReason = "database" | "not-seeded" | "not-staff";

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
 * enumerates the privileged set is a reconnaissance tool. It does say HOW
 * access is given — by an administrator, from People — and what the person
 * who runs the site does when they are the one locked out.
 *
 * `deployed` picks the recovery that works WHERE THIS RUNS (TB-DEPLOY-08): on a
 * laptop, a command in the project folder; on a deployed site, the deploy and
 * the "Admin grant" workflow — because `pnpm admin:grant` on a laptop reaches
 * only the database in .env.local (staging), never production.
 */
export function AdminUnavailable({
  reason,
  deployed = false,
}: {
  readonly reason: AdminUnavailableReason;
  readonly deployed?: boolean;
}) {
  const copy =
    reason === "database"
      ? {
          title: "The database is not configured",
          body: "The admin panel reads from Postgres, and DATABASE_URL is not set yet.",
          detail: null,
          action: { href: "/setup", label: "See what is configured" },
        }
      : reason === "not-seeded"
        ? {
            title: "The roles aren't installed yet",
            body: deployed
              ? "This site's roles haven't been installed yet. Deploy again — every deploy installs them — then reload."
              : "This site's roles haven't been installed yet. Run pnpm db:seed, then reload.",
            detail: null,
            action: { href: "/", label: "Back to the app" },
          }
        : {
            title: "You do not have access to the admin panel",
            body: "Your account is signed in, but it holds no staff role. An administrator can give you one, from People.",
            detail: deployed
              ? "If you run this site and are locked out, run the Admin grant workflow in GitHub Actions (Actions, then Deploy, then Run workflow) with your email."
              : "If you run this site and are locked out, run pnpm admin:grant you@example.com from the project folder.",
            action: { href: "/", label: "Back to the app" },
          };

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="max-w-[44ch] text-center">
        <h1 className="text-xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{copy.body}</p>
        {copy.detail ? <p className="mt-2 text-xs text-ink-muted">{copy.detail}</p> : null}
        <Link href={copy.action.href} className={buttonClass("secondary", "mt-5")}>
          {copy.action.label}
        </Link>
      </div>
    </main>
  );
}

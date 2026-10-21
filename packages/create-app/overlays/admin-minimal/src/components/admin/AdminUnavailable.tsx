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
 * laptop — a production build on a localhost address included — the command,
 * with the signed-in person's own email in it; on a deployed site, the same
 * command pointed at that site's database, and the "Admin grant" workflow only
 * for a project that deploys from GitHub (.github/workflows/deploy.yml), since
 * `pnpm admin:grant` reaches only the database in .env.local.
 */
export function AdminUnavailable({
  reason,
  deployed = false,
  email = null,
}: {
  readonly reason: AdminUnavailableReason;
  readonly deployed?: boolean;
  /** The signed-in person's email, so the command to run is theirs. */
  readonly email?: string | null;
}) {
  const command = `pnpm admin:grant ${email ?? "you@example.com"}`;
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
              ? `If you run this site and are locked out, run ${command} from the project folder with this site's DATABASE_URL in .env.local — or, if the project deploys from GitHub, the Admin grant workflow (Actions, then Deploy, then Run workflow) with your email.`
              : `If you run this site and are locked out, run ${command} in the project folder, then reload this page.`,
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

import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { env } from "@/env";
import { APP_LINKS, SITE_LINKS } from "@/nav";
import { buttonClass } from "@/components/ui";

/**
 * The public destinations, sign in / out, and whatever a signed-in user gets.
 *
 * A SERVER component reading `auth()`, deliberately. Clerk Core 3 (@clerk/nextjs
 * v7) removed the `<SignedIn>` / `<SignedOut>` control components that every
 * older example still uses — they throw at render, not at build, so the code
 * looks correct until the page 500s.
 *
 * Renders no Clerk UI when Clerk is unconfigured: `auth()` throws without keys,
 * and the root layout mounts no ClerkProvider for `<UserButton>` to read from.
 *
 * The public links render in ALL THREE states, including signed out and Clerk
 * off. They are public routes — a storefront you cannot find without an account
 * is a storefront nobody finds, which is the same bug one level up from the one
 * that put this list here.
 *
 * Mounted by `app/(site)/layout.tsx`, not by a page. It used to be mounted by
 * the landing page alone, which meant the nav existed on exactly one route.
 */
export async function AuthHeader() {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        <SiteLinks />
        <p className="text-sm text-ink-muted">
          Sign-in is off until Clerk is configured &mdash;{" "}
          <Link href="/setup" className="text-accent underline underline-offset-2">
            /setup
          </Link>
        </p>
      </div>
    );
  }

  const { userId } = await auth();

  if (!userId) {
    return (
      <div className="flex items-center gap-4">
        <SiteLinks />
        <Link href="/sign-in" className={buttonClass("secondary")}>
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4">
      <SiteLinks />
      <AppLinks />
      <UserButton />
    </div>
  );
}

/**
 * Whatever this project was generated with, in order.
 *
 * `src/nav.ts` is written per project, which is why there is no test here for
 * whether a shop exists: a project that sells nothing contributes no entries
 * and this renders nothing at all. Quieter than the signed-in links on purpose
 * — these are where a customer goes.
 */
function SiteLinks() {
  return (
    <>
      {SITE_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-sm text-ink-muted no-underline hover:text-ink"
        >
          {link.label}
        </Link>
      ))}
    </>
  );
}

/**
 * Where a signed-in user goes that a visitor does not.
 *
 * This was a hardcoded link to /admin, and a project generated with
 * `--admin none` emits no `app/admin` route at all — so the header shipped a
 * 404 in the one configuration nobody generates. That is precisely the bug
 * `SITE_LINKS` was introduced to kill, in the file that introduced it. Read
 * from a generated array instead: no admin shell means no entry, and there is
 * no `if` here asking whether one was installed.
 *
 * Separate from SITE_LINKS because the audiences are different. The public
 * links render even signed out; these render only once there is a user, so an
 * empty array here is the normal state of most page views rather than a defect.
 *
 * NOT permission-filtered, on purpose. Reaching /admin without a staff role
 * renders `AdminUnavailable`, which says so — a link that explains itself when
 * clicked beats one that vanishes, and hiding it would need this component to
 * load the permission set on every public page view.
 */
function AppLinks() {
  return (
    <>
      {APP_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-sm text-accent underline underline-offset-2"
        >
          {link.label}
        </Link>
      ))}
    </>
  );
}

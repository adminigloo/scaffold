import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
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
 * It renders during a PRERENDER too, and that is not a detail — see `viewerId`
 * below. A header mounted by a layout is rendered by every route under it, so
 * whatever it cannot survive, none of those routes can survive either. Chrome
 * must never be the reason a page fails to build.
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

  const userId = await viewerId();

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
 * Who is signed in — and null both when nobody is and when nobody asked.
 *
 * THE SECOND CASE IS WHY THIS IS A FUNCTION. `auth()` reads request headers
 * that `proxy.ts` puts there, and a route rendered with
 * `dynamic = "force-static"` is rendered at BUILD time, where no proxy has run
 * and there is no request at all. Clerk answers that by throwing "auth() was
 * called but Clerk can't detect usage of clerkMiddleware()", which names
 * neither this component nor the page that asked to be prerendered — so
 * `next build` dies on a route whose own source has nothing to do with
 * authentication, and the message points at the one file that is innocent.
 *
 * It appears only once Clerk is CONFIGURED, because the branch above returns
 * before `auth()` when it is not. That is the whole reason it shipped: every
 * check this scaffold runs generated a project with no credentials, so the
 * header stopped at the first branch and the path that breaks was never taken.
 *
 * `headers()` is the detector, not a `try`/`catch` around `auth()`. Next seals
 * an EMPTY header set for a force-static render and a real request always
 * carries at least `host`, so an empty set means "there is no request" and
 * nothing else. Catching the throw instead would also swallow the case this
 * has to stay loud about — a deployment whose proxy stopped matching a route,
 * where every signed-in visitor would quietly be handed the signed-out header
 * and nothing anywhere would say so.
 *
 * Signed out is the honest answer for a prerender. Build-time HTML is served
 * to everybody, so the only header that can be right in it is the one that
 * assumes nothing about the reader, and the public links render in it either
 * way. A page that needs the signed-in header must not force static rendering:
 * `assertNoPrerenderedAuthRoutes` in the generator refuses to emit one that
 * does, and this is what happens to the ones somebody adds afterwards.
 */
async function viewerId(): Promise<string | null> {
  if ((await headers()).get("host") === null) return null;
  return (await auth()).userId;
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

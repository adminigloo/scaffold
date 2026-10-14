import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import Link from "next/link";
import type { Principal } from "__SCOPE__/auth";
import type { SessionState } from "__SCOPE__/tenancy/server";
import { env } from "@/env";
import { APP_LINKS, SITE_LINKS, type SiteLink } from "@/nav";
import { buttonClass } from "@/components/ui";
import { CompanySwitcherSlot } from "@/components/CompanySwitcherSlot";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions, loadTenantPermissions } from "@/server/permissions";
import { tenancy } from "@/server/tenancy";

/**
 * The public destinations, sign in / out, and whatever a signed-in user gets:
 * the company switcher, the links for their role, and the account menu.
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
 * ON A PHONE (below `sm`) the links fold into a "Menu" disclosure with 44px
 * rows, so the company switcher and the account button always fit on one line
 * — at 360px, the most common Android width, the row used to scroll sideways
 * and push the account (sign-out) button off the screen.
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
        <div className="hidden items-center gap-4 sm:flex">
          <SiteLinks />
        </div>
        <PhoneMenu app={[]} />
        <Link href="/sign-in" className={buttonClass("secondary")}>
          Sign in
        </Link>
      </div>
    );
  }

  const viewer = await signedInViewer();

  return (
    <div className="flex min-w-0 max-w-full items-center gap-3 sm:gap-4">
      <div className="hidden items-center gap-4 sm:flex">
        <SiteLinks />
      </div>
      {/* THE SWITCHER, before the app's links (Tenancy 1). Renders nothing for
          someone with one workspace in a single-business project, and nothing
          if the database can't answer — the header must never fail a page. */}
      <CompanySwitcherSlot principal={viewer.principal} session={viewer.session} />
      <div className="hidden items-center gap-4 sm:flex">
        <AppLinks viewer={viewer} />
      </div>
      <PhoneMenu app={visibleAppLinks(viewer)} />
      <UserButton />
    </div>
  );
}

/** Who is looking at the header, as much as it needs to know. */
interface Viewer {
  readonly principal: Principal | null;
  /** Resolved ONCE here and handed to the switcher, which used to resolve it again. */
  readonly session: SessionState | null;
  readonly isStaff: boolean;
  /** The permission keys the person holds in their ACTIVE company ([] with none, or suspended). */
  readonly can: readonly string[];
}

const NOBODY: Viewer = { principal: null, session: null, isStaff: false, can: [] };

/**
 * The signed-in person, their session, whether they are on the platform's
 * staff, and what their role in their active company lets them open (Tenancy
 * 2a) — made only for signed-in viewers, all inside one try/catch: a header
 * that throws takes every page with it, so a database that can't answer
 * draws the header with no company links instead.
 */
async function signedInViewer(): Promise<Viewer> {
  try {
    const principal = await currentPrincipal();
    if (!principal) return NOBODY;
    const session = await tenancy.resolveSession({ userId: principal.userId });
    const isStaff = (await loadStaffPermissions({ principal })) !== null;
    const can =
      session.state === "ready"
        ? ((await loadTenantPermissions({ principal, tenantId: session.company.id }))?.toArray() ?? [])
        : [];
    return { principal, session, isStaff, can };
  } catch {
    return NOBODY;
  }
}

/**
 * APP_LINKS for this viewer: the staff-only ones (Admin) only for staff, and
 * a company's own screens only for someone whose role in their active company
 * holds the link's key — a crew member's header shows Dashboard and Today's
 * route, nothing else (Tenancy 2a).
 *
 * A RUNTIME PERMISSION FILTER OVER A GENERATED LIST, not a feature `if`: which
 * links exist was settled when src/nav.ts was generated (no admin shell, no
 * Admin entry; no scheduling, no Schedule); who sees them is settled here, per
 * request. The checks cost a query or two per signed-in page view — the
 * switcher loads the person anyway — and a business owner's header never
 * offers a link that opens on "you don't have access".
 */
function visibleAppLinks(viewer: Viewer): readonly SiteLink[] {
  return APP_LINKS.filter(
    (link) =>
      (link.audience !== "staff" || viewer.isStaff) &&
      (link.permission === undefined || viewer.can.includes(link.permission)),
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
 * Where a signed-in user goes that a visitor does not, filtered for this
 * viewer (see `visibleAppLinks`).
 *
 * Read from a generated array: no admin shell means no Admin entry, and there
 * is no `if` here asking whether one was installed. Separate from SITE_LINKS
 * because the audiences are different — these render only once there is a
 * user.
 */
function AppLinks({ viewer }: { readonly viewer: Viewer }) {
  return (
    <>
      {visibleAppLinks(viewer).map((link) => (
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

/**
 * The same links, folded into a disclosure below `sm`. A native <details>, so
 * it works with no JavaScript and the keyboard and screen readers already know
 * it; each row is at least 44px tall, the size a thumb can hit.
 */
function PhoneMenu({ app }: { readonly app: readonly SiteLink[] }) {
  const links = [...SITE_LINKS, ...app];
  if (links.length === 0) return null;
  return (
    <details className="relative sm:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-[4px] border border-line px-3 text-sm text-ink">
        Menu
      </summary>
      <nav
        aria-label="Menu"
        className="absolute right-0 z-20 mt-1 flex w-56 max-w-[calc(100vw-2rem)] flex-col rounded-[6px] border border-line bg-surface py-1 shadow-lg"
      >
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="flex min-h-11 items-center px-4 text-sm text-ink no-underline hover:bg-canvas"
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </details>
  );
}

import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import type { Principal } from "__SCOPE__/auth";
import type { SessionState } from "__SCOPE__/tenancy/server";
import { env } from "@/env";
import { APP_LINKS, SITE_LINKS, type SiteLink } from "@/nav";
import { SITE_NAME } from "@/seo";
import { buttonClass } from "@/components/ui";
import { AlertsBellSlot } from "@/components/AlertsBellSlot";
import { CompanySwitcherSlot } from "@/components/CompanySwitcherSlot";
import { SiteFrame, type FrameGroup, type FrameLink, type FrameWork } from "@/components/SiteFrame";
import { currentPrincipal } from "@/server/auth";
import { navBadges } from "@/server/nav-badges";
import { loadStaffPermissions, loadTenantPermissions } from "@/server/permissions";
import { tenancy } from "@/server/tenancy";

/**
 * The site's chrome: the header with the public destinations and sign in /
 * out, and — for someone signed in to a company — the company's work area: a
 * sidebar with the switcher at the top and the links their role opens, under
 * plain-word headings (`<SiteFrame>` draws both; this decides what is in them).
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
 * that put this list here. They are NOT in a company's work area: a business
 * owner at work does not need this site's own Products and Pricing beside their
 * company's Store.
 *
 * ON A PHONE the public links fold into a "Menu" disclosure, and the work
 * area's sidebar into a drawer behind a Menu button, with 44px rows — so the
 * account (sign-out) button always fits on one line.
 *
 * Mounted by `app/(site)/layout.tsx`, not by a page. It used to be mounted by
 * the landing page alone, which meant the nav existed on exactly one route.
 */
export async function AuthHeader({
  children,
  banner,
  footer,
}: {
  readonly children: ReactNode;
  /** Where the company stands with its plan (PlanBannerSlot): under the header. */
  readonly banner?: ReactNode;
  /** The site footer: on the public site, not in the work area. */
  readonly footer?: ReactNode;
}) {
  const frame = { siteName: SITE_NAME, siteLinks: siteLinks(), banner, footer, children };

  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) {
    return (
      <SiteFrame
        {...frame}
        headerLinks={[]}
        work={null}
        account={
          <p className="text-sm text-ink-muted">
            Sign-in is off until Clerk is configured &mdash;{" "}
            <Link href="/setup" className="text-accent underline underline-offset-2">
              /setup
            </Link>
          </p>
        }
      />
    );
  }

  const userId = await viewerId();

  if (!userId) {
    return (
      <SiteFrame
        {...frame}
        headerLinks={[]}
        work={null}
        account={
          <Link href="/sign-in" className={buttonClass("secondary")}>
            Sign in
          </Link>
        }
      />
    );
  }

  const viewer = await signedInViewer();

  return (
    <SiteFrame
      {...frame}
      // On the public site a signed-in person gets the way back to work
      // (Dashboard) and their own links, not the whole company menu.
      headerLinks={visibleAppLinks(viewer)
        .filter((link) => link.group === undefined)
        .map((link) => framed(link, viewer.badges))}
      work={workArea(viewer)}
      // THE SWITCHER (Tenancy 1): at the top of the sidebar in a company's work
      // area, in the header otherwise. Renders nothing for someone with one
      // workspace in a single-business project, and nothing if the database
      // can't answer — the header must never fail a page.
      switcher={<CompanySwitcherSlot principal={viewer.principal} session={viewer.session} />}
      // THE ALERTS BELL (Tenancy 2b-1), in the top bar so it shows on a phone
      // too. Generated in three variants (src/components/AlertsBellSlot.tsx):
      // the active company's bell for someone whose role there holds
      // alerts.view, the staff bell in a single business, or nothing in a
      // project generated without alerts. It reads only what the viewer above
      // already resolved (inside its try/catch), so it can never fail the page.
      bell={<AlertsBellSlot session={viewer.session} can={viewer.can} isStaff={viewer.isStaff} />}
      account={<UserButton />}
    />
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
  /** Counts beside links, by href (src/server/nav-badges.ts): e.g. card payments that need the owner. */
  readonly badges: Readonly<Record<string, number>>;
}

const NOBODY: Viewer = { principal: null, session: null, isStaff: false, can: [], badges: {} };


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
    const badges = await navBadges(session.state === "ready" ? session.company.id : null, can);
    return { principal, session, isStaff, can, badges };
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
 * and the header draws nothing for them. Quieter than the signed-in links on
 * purpose — these are where a customer goes.
 */
function siteLinks(): readonly FrameLink[] {
  return SITE_LINKS.map((link) => ({ href: link.href, label: link.label }));
}

/** A link as the frame draws it, with its count when something there needs the person. */
function framed(link: SiteLink, badges: Readonly<Record<string, number>>): FrameLink {
  const badge = badges[link.href];
  return badge ? { href: link.href, label: link.label, badge } : { href: link.href, label: link.label };
}

/**
 * Where a company's work area is: the first path segment of every link a
 * company member gets (/dashboard, /app, /settings, /account). Every other
 * page under `(site)` is the public site and gets the public header.
 */
const WORK_PREFIXES: readonly string[] = [
  ...new Set(APP_LINKS.filter((link) => link.audience !== "staff").map((link) => `/${link.href.split("/")[1]}`)),
];

/**
 * The work area for this viewer, or null when there is none: signed in with no
 * company yet (onboarding), a suspended company, or a project whose links
 * carry no headings at all (a single business — its work is in /admin, and
 * its header keeps the short row it always had).
 *
 * Groups in the order their first link appears in APP_LINKS, which is the
 * order `src/nav.ts` was generated in — so the sidebar's order is decided
 * there, once. A heading with nothing this person may open is not drawn.
 */
function workArea(viewer: Viewer): FrameWork | null {
  const session = viewer.session;
  if (session?.state !== "ready") return null;
  if (!APP_LINKS.some((link) => link.group !== undefined)) return null;
  const grouped = new Map<string | null, FrameLink[]>();
  const bar: FrameLink[] = [];
  for (const link of visibleAppLinks(viewer)) {
    if (link.bar) {
      bar.push(framed(link, viewer.badges));
      continue;
    }
    const heading = link.group ?? null;
    grouped.set(heading, [...(grouped.get(heading) ?? []), framed(link, viewer.badges)]);
  }
  const groups: FrameGroup[] = [...grouped].map(([heading, links]) => ({ heading, links }));
  return {
    company: { name: session.company.name, logoUrl: session.company.logoUrl },
    groups,
    bar,
    prefixes: WORK_PREFIXES,
  };
}

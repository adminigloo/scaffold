import Link from "next/link";
import type { ReactNode } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { SiteFooter } from "@/components/SiteFooter";

/**
 * Chrome for the public site: one header and one footer, on every page in here.
 *
 * A ROUTE GROUP, so no URL changes — `(site)` is a directory the router ignores
 * when it builds paths. That is the only reason this could be added to an
 * existing app at all: `/setup` is still `/setup`, and every link already
 * written to it keeps working.
 *
 * It exists because the nav was mounted on the landing page and nowhere else.
 * `/products`, a product page, the checkout, `/setup` and the Clerk pages all
 * rendered with no way out of them except the browser's back button — a
 * customer who arrived at a product from a link had no route to the rest of the
 * shop, and nothing on the page said what site they were on. A header living in
 * a page is a header that exists on one page; a header living here cannot be
 * forgotten by the next route somebody adds under it.
 *
 * `app/admin` is deliberately OUTSIDE this group. The admin shell is a
 * full-height sidebar layout with its own wordmark, its own nav and its own
 * signed-in-as strip; a second header stacked above it would push the sticky
 * sidebar out of the viewport and give the page two competing navigations.
 * Admin is reached from the header instead, via APP_LINKS.
 *
 * `min-h-dvh` with the children in a `flex-1` row is what keeps the footer at
 * the bottom of a short page rather than floating halfway up it. The root
 * layout already paints the background, so nothing here declares one.
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-3">
          {/* The wordmark is a link home, because on every site ever built it
              is, and a customer three pages into a storefront tries it before
              they look for a Home link. */}
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted no-underline hover:text-ink"
          >
            __PROJECT_NAME__
          </Link>
          <AuthHeader />
        </div>
      </header>

      <div className="flex-1">{children}</div>

      <SiteFooter />
    </div>
  );
}

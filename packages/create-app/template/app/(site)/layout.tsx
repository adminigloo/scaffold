import type { ReactNode } from "react";
import { AuthHeader } from "@/components/AuthHeader";
import { PlanBannerSlot } from "@/components/PlanBannerSlot";
import { SiteAnalyticsSlot } from "@/components/SiteAnalyticsSlot";
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
 * `AuthHeader` draws the chrome, because which chrome depends on who is
 * looking and where: the public header (and footer) on the public site, and a
 * company's sidebar in its work area (/dashboard, /app/…, /settings/…). Its
 * `min-h-dvh` column keeps the footer at the bottom of a short page. The root
 * layout already paints the background, so nothing here declares one.
 */
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* The header, and in a company's work area the sidebar (AuthHeader →
          SiteFrame). Where the company stands with its plan (billing 0.3) —
          a free trial's days left, a failed payment, a plan that has ended —
          sits under it: generated in two variants (src/components/
          PlanBannerSlot.tsx), nothing in a project that doesn't sell plans
          and nothing while a plan is paid up. The footer is the public
          site's; the work area has none. */}
      <AuthHeader banner={<PlanBannerSlot />} footer={<SiteFooter />}>
        {children}
      </AuthHeader>
      {/* This site's own visit counter (Tenancy 2b-4a). Generated in two
          variants (src/components/SiteAnalyticsSlot.tsx): the cookieless
          beacon with --analytics, nothing without. */}
      <SiteAnalyticsSlot />
    </>
  );
}

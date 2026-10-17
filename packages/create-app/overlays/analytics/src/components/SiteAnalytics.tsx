"use client";

import { usePathname } from "next/navigation";
import { AnalyticsBeacon } from "__SCOPE__/analytics/client";

/**
 * THIS SITE'S OWN visit counter (Tenancy 2b-4a), mounted on every page of the
 * (site) layout by src/components/SiteAnalyticsSlot.tsx — cookieless,
 * honouring Global Privacy Control, Do Not Track and a visitor's own opt-out
 * (`?analytics=off`), all in the package.
 *
 * The signed-in screens are not counted: they are where people work, not
 * where visitors arrive (a runtime filter on the page's address, not a
 * feature switch). Staff are left out of the numbers by the audience, on the
 * server, so their visits stay in the table for "count everyone".
 *
 * Clicks are recorded only on elements marked `data-track`, never inside the
 * widgets (feedback, booking, the assistant), whose buttons carry what a
 * visitor typed or chose.
 */
const NOT_COUNTED = ["/app", "/dashboard", "/settings", "/onboarding", "/members", "/invite", "/setup", "/account", "/sign-in", "/sign-up", "/sign-out"];
const IGNORE = ['[class*="aif-"]', '[class*="aib-"]', '[class*="aibk-"]', '[class*="aia-"]', "[data-feedback-ignore]"];

export function SiteAnalytics() {
  const path = usePathname() ?? "/";
  const signedInScreen = NOT_COUNTED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  return <AnalyticsBeacon path={path} endpoint="/api/analytics/v1/collect" disabled={signedInScreen} ignoreSelectors={IGNORE} />;
}

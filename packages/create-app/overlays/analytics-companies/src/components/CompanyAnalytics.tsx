"use client";

import { usePathname } from "next/navigation";
import { AnalyticsBeacon } from "__SCOPE__/analytics/client";

/**
 * A __TENANT_LABEL_LOWER__'s visit counter on its own pages here (Tenancy 2b-4a),
 * mounted by <PublicCompanyGate> on every /t/{web address} page: each visit is
 * counted for THAT __TENANT_LABEL_LOWER__, cookieless, honouring Global Privacy Control,
 * Do Not Track and a visitor's own opt-out. A token page's key is never
 * stored (the server collapses it).
 */
export function CompanyAnalytics({ slug }: { readonly slug: string }) {
  const path = usePathname() ?? "/";
  return <AnalyticsBeacon path={path} endpoint={`/api/t/${encodeURIComponent(slug)}/website/v1/collect`} />;
}

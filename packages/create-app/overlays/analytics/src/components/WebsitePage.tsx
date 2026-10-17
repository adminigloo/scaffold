"use client";

import { useMemo } from "react";
import { createAnalyticsTransport, WebsitesSettings, WebsiteTraffic } from "__SCOPE__/analytics/dashboard";
import { AudienceSettings, createAudienceTransport } from "__SCOPE__/audience/ui";

/**
 * The website screen (Tenancy 2b-4a), the same for a company's /app/website
 * and this site's own /admin/analytics: the visits (the package's
 * <WebsiteTraffic>), the websites and the line to paste (<WebsitesSettings>),
 * and who is left out (__SCOPE__/audience's <AudienceSettings>) — each talking
 * to the routes it is given. A thin wrapper: the screens are the packages',
 * so a fix reaches this project with `pnpm update`.
 *
 * `audienceBaseUrl` is null for someone who may look but not choose who is
 * left out (a runtime permission, not a feature switch): the panel isn't
 * offered, and its routes refuse them anyway.
 */
export function WebsitePage(props: { readonly baseUrl: string; readonly audienceBaseUrl: string | null }) {
  const transport = useMemo(() => createAnalyticsTransport({ baseUrl: props.baseUrl }), [props.baseUrl]);
  const audience = useMemo(
    () => (props.audienceBaseUrl ? createAudienceTransport({ baseUrl: props.audienceBaseUrl }) : null),
    [props.audienceBaseUrl],
  );
  return (
    <div className="flex flex-col gap-8">
      <WebsiteTraffic transport={transport} />
      <WebsitesSettings transport={transport} />
      {audience ? <AudienceSettings transport={audience} headingLevel={2} /> : null}
    </div>
  );
}

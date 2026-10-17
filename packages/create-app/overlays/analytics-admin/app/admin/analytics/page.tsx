import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { EmptyState, Notice, PageHeader } from "@/components/ui";
import { WebsitePage } from "@/components/WebsitePage";

export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN website numbers (Tenancy 2b-4a): who visits it, from where
 * (search, AI assistants by name, other sites), the pages they read, the AI
 * crawlers that read them — with this site's staff left out — its websites
 * with the line to paste, and who else is left out.
 *
 * The packages' own screens over this site's routes (/api/admin/analytics and
 * /api/admin/audience). The page checks the staff key first so someone
 * without it gets a sentence; the routes check again on every call.
 */
export default async function AnalyticsPage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Website visits" />
        <EmptyState title="No database yet">
          Website visits are kept in this site&rsquo;s own database. Set DATABASE_URL and run the migrations.
        </EmptyState>
      </>
    );
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.analytics.view")) {
    return (
      <>
        <PageHeader title="Website visits" />
        <Notice tone="warn">You don&rsquo;t have permission to see this site&rsquo;s visits.</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Website visits"
        description="Who visits this site and where they came from. Your staff's visits are left out; nothing here uses cookies."
      />
      <WebsitePage baseUrl="/api/admin/analytics" audienceBaseUrl={can.can("staff.audience.manage") ? "/api/admin/audience" : null} />
    </>
  );
}

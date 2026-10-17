import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { EmptyState, Notice, PageHeader } from "@/components/ui";
import { SearchCheckSection } from "@/components/SearchCheckSection";

export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN search check (Tenancy 2b-4b): how Google, Bing and AI
 * assistants read this site's pages and any website it registered, as a list
 * of things to fix, with every past check kept.
 *
 * The package's screen over this site's routes (/api/admin/search-check). The
 * page checks the staff key first so someone without it gets a sentence; the
 * routes check again on every call.
 */
export default async function SearchCheckPage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Search check" />
        <EmptyState title="No database yet">
          Search checks are kept in this site&rsquo;s own database. Set DATABASE_URL and run the migrations.
        </EmptyState>
      </>
    );
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.seo_reports.view")) {
    return (
      <>
        <PageHeader title="Search check" />
        <Notice tone="warn">You don&rsquo;t have permission to see this site&rsquo;s search checks.</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Search check"
        description="How search engines and AI assistants read this site, and what to fix first. Each check reads up to 50 pages."
      />
      <SearchCheckSection baseUrl="/api/admin/search-check" />
    </>
  );
}

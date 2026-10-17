import { checkCosts } from "__SCOPE__/aeo";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { AiMentionsSection } from "@/components/AiMentionsSection";
import { EmptyState, Notice, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN AI mentions (Tenancy 2b-4b): the questions its customers ask
 * an AI assistant, whether the answer names it, the quoted words, the sources
 * and the trend.
 *
 * The package's screen over this site's routes (/api/admin/ai-mentions). The
 * page checks the staff key first; the routes check again on every call, and
 * every answer is held against the site's AI allowance before it's asked.
 */
export default async function AiMentionsPage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="AI mentions" />
        <EmptyState title="No database yet">
          AI mentions are kept in this site&rsquo;s own database. Set DATABASE_URL and run the migrations.
        </EmptyState>
      </>
    );
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.aeo.view")) {
    return (
      <>
        <PageHeader title="AI mentions" />
        <Notice tone="warn">You don&rsquo;t have permission to see this site&rsquo;s AI mentions.</Notice>
      </>
    );
  }
  // What checks REALLY cost, measured from the provider's counts, across every
  // account here — the number the estimates in src/server/ai-mentions.ts are
  // checked against.
  const cost = await checkCosts(db, { since: new Date(Date.now() - 30 * 86_400_000) });
  const average = cost.averageMicros === null ? null : Number(cost.averageMicros) / 10_000;
  return (
    <>
      <PageHeader
        title="AI mentions"
        description="When customers ask an AI assistant about what you do, does the answer name you? Checked weekly, and whenever you press Check now."
      />
      <p className="mb-6 text-sm text-neutral-600 dark:text-neutral-400">
        {average === null
          ? "Average cost per check (last 30 days): no checks with a known cost yet."
          : `Average cost per check (last 30 days): ${average.toFixed(2)}¢, over ${cost.checks} check${cost.checks === 1 ? "" : "s"} on this site.`}
      </p>
      <AiMentionsSection baseUrl="/api/admin/ai-mentions" />
    </>
  );
}

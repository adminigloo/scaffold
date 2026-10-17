import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { WebsitePage } from "@/components/WebsitePage";

export const dynamic = "force-dynamic";

/**
 * The __TENANT_LABEL_LOWER__'s website numbers (Tenancy 2b-4a): who visits its pages here
 * and its own website, where they came from (search, AI assistants by name,
 * other sites), the pages they read and the AI crawlers that read them — with
 * its own team left out — its websites with the one line to paste, and who
 * else is left out.
 *
 * __SCOPE__/analytics' and __SCOPE__/audience's screens, talking to THIS
 * __TENANT_LABEL_LOWER__'s routes (/api/app/{id}/website and /audience). Looking is
 * `analytics.view` (everyone but crew); its websites and "these are my
 * visits" `analytics.manage`; who is left out `audience.manage` — the routes
 * check each on every call.
 */
export default async function CompanyWebsitePage() {
  return (
    <CompanyGate path="/app/website" permission="analytics.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <PageHeader
            title="Website"
            description={`Who visits ${company.name}'s pages and website, and where they came from. Your team's visits are left out; nothing here uses cookies.`}
          />
          <WebsitePage
            baseUrl={`/api/app/${company.id}/website`}
            audienceBaseUrl={can.includes("audience.manage") ? `/api/app/${company.id}/audience` : null}
          />
        </main>
      )}
    </CompanyGate>
  );
}

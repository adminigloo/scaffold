import Link from "next/link";
import { FeedbackSettingsPanel } from "__SCOPE__/feedback/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN } from "@/components/ui";
import { env } from "@/env";
import { companyLinksFor } from "@/server/company-links";

export const dynamic = "force-dynamic";

/**
 * The company's feedback settings (Tenancy 2b-2a): its board's columns, the
 * categories its customers choose from, its feedback page's address (a link
 * any website, email or printed card can carry), and website keys for a site
 * built with React that wants the feedback button itself.
 *
 * Anyone who can see the board can read the columns and categories; only
 * owners and admins (`feedback.settings.manage`) change them or see the keys —
 * the server decides, and the page offers nothing it would refuse.
 *
 * The screens are the package's own (__SCOPE__/feedback/admin,
 * <FeedbackSettingsPanel>: the column editor — a column with tickets asks
 * where they go before it's deleted — the category editor and the website
 * keys), over THIS company's routes.
 */
export default async function CompanyFeedbackSettingsPage() {
  const app = (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/?$/, "/");
  return (
    <CompanyGate path="/app/feedback/settings" permission="feedback.view">
      {({ company, can }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Feedback settings"
            description="Your board's columns, the categories customers choose from, and feedback on your own website."
            actions={
              <Link href="/app/feedback" className="text-sm text-accent underline underline-offset-2">
                Back to the board
              </Link>
            }
          />
          <FeedbackSettingsPanel
            baseUrl={`/api/app/${company.id}/feedback`}
            canManage={can.includes("feedback.settings.manage")}
            intakeUrl={new URL("api/igloo", app).toString()}
            publicPageUrl={companyLinksFor(company.slug).feedback}
          />
        </main>
      )}
    </CompanyGate>
  );
}

import { FeedbackWorkspace } from "__SCOPE__/feedback/board";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { FEEDBACK_EMAILS_REPORTERS } from "@/server/feedback";

export const dynamic = "force-dynamic";

/**
 * The company's feedback board (Tenancy 2b-2a): what its customers sent from
 * its feedback page (/t/{web address}/feedback) or from its own website, as
 * columns to drag between, and a panel per ticket with what they wrote and
 * the conversation — a reply here is emailed to them in the company's name.
 *
 * __SCOPE__/feedback's <FeedbackWorkspace>, talking to THIS company's routes
 * (/api/app/{company id}/feedback). Seeing the board is `feedback.view`;
 * answering and moving tickets `feedback.manage`; the columns, categories and
 * website keys `feedback.settings.manage` — `canManage` and the settings link
 * only decide what is offered; the server refuses the rest anyway.
 * `?ticket=` opens that ticket (an alert's link).
 */
export default async function CompanyFeedbackPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ticket } = await searchParams;
  return (
    <CompanyGate path="/app/feedback" permission="feedback.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
          <PageHeader
            title="Feedback"
            description="What your customers sent you. Drag a ticket between columns; open it to read it and answer them."
          />
          <FeedbackWorkspace
            baseUrl={`/api/app/${company.id}/feedback`}
            canManage={can.includes("feedback.manage")}
            settingsHref={can.includes("feedback.settings.manage") ? "/app/feedback/settings" : null}
            initialTicketId={typeof ticket === "string" ? ticket : null}
            emailsReporters={FEEDBACK_EMAILS_REPORTERS}
          />
        </main>
      )}
    </CompanyGate>
  );
}

import { FeedbackEpic } from "__SCOPE__/feedback/epics";
import { CompanyGate } from "@/components/CompanyGate";

export const dynamic = "force-dynamic";

/**
 * One of the company's epics (feedback 0.12): its tickets, grouped as its
 * progress counts them, with Add tickets and Take out, its status (only the
 * moves allowed), Edit, Delete (its tickets stay on the board), and "every
 * ticket is done — mark it completed?".
 *
 * Read through THIS company's routes: an epic of another company is "not
 * found" there, whatever the address says.
 */
export default async function CompanyEpicPage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  return (
    <CompanyGate path={`/app/feedback/epics/${encodeURIComponent(id)}`} permission="feedback.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <FeedbackEpic
            baseUrl={`/api/app/${company.id}/feedback`}
            epicId={id}
            canManage={can.includes("feedback.manage")}
            epicsHref="/app/feedback/epics"
            boardHref="/app/feedback"
          />
        </main>
      )}
    </CompanyGate>
  );
}

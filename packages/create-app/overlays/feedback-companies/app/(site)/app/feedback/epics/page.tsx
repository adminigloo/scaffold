import { FeedbackEpics } from "__SCOPE__/feedback/epics";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company's epics (feedback 0.12): the bigger pieces of work its tickets
 * are grouped under, each with its progress, status, who leads it and when
 * it's due — and New epic.
 *
 * __SCOPE__/feedback/epics' <FeedbackEpics>, over THIS company's routes
 * (/api/app/{company id}/feedback). Seeing them is `feedback.view`; making and
 * changing them `feedback.manage` (a company whose plan has ended keeps
 * reading them). `canManage` only decides what is offered; the server refuses
 * the rest anyway.
 */
export default async function CompanyEpicsPage() {
  return (
    <CompanyGate path="/app/feedback/epics" permission="feedback.view">
      {({ company, can }) => (
        <main className={WORK_MAIN}>
          <PageHeader title="Epics" description="Bigger pieces of work, each with the feedback tickets that belong to it." />
          <FeedbackEpics
            baseUrl={`/api/app/${company.id}/feedback`}
            canManage={can.includes("feedback.manage")}
            epicsHref="/app/feedback/epics"
            boardHref="/app/feedback"
          />
        </main>
      )}
    </CompanyGate>
  );
}

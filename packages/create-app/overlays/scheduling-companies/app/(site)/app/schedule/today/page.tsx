import { CrewDay } from "__SCOPE__/scheduling-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";

export const dynamic = "force-dynamic";

/**
 * Today's route, on a phone (Tenancy 2a): the stops of the crew the signed-in
 * person opens, in order, with directions, a call button, Start and Complete.
 *
 * On `schedule.route`, the one key the company's Crew role holds — so a crew
 * member signed in on their phone lands on their dashboard with this as its
 * only card, and sees nothing else of the company: no calendar, no prices, no
 * other customers. The owner links them to a crew in Schedule settings after
 * inviting them with the Crew role on the Team page.
 */
export default async function TodaysRoutePage() {
  return (
    <CompanyGate path="/app/schedule/today" permission="schedule.route">
      {({ company }) => (
        <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
          <CrewDay baseUrl={`/api/app/${company.id}/schedule`} />
        </main>
      )}
    </CompanyGate>
  );
}

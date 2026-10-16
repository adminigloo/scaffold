import { RecordFiles } from "__SCOPE__/storage-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";

export const dynamic = "force-dynamic";

/**
 * One visit's photos and files (Tenancy 2b-1): a visit has no page of its
 * own on the schedule, so its "Photos and files" opens here — from the
 * calendar's visit panel and from each stop on today's route. A crew member
 * on the job adds photos from their phone ("Take a photo"); the office sees
 * them on the visit.
 *
 * No page permission: THE VISIT DECIDES (D12). Whoever sees the schedule sees
 * its files; a crew member sees and adds them only on their own crew's
 * visits; anyone else is told the visit isn't here — by the routes, on every
 * call. "Back" goes to the calendar for whoever can see it, and to today's
 * route for a crew member (a runtime permission choice, not a feature switch).
 */
export default async function VisitFilesPage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  return (
    <CompanyGate path={`/app/schedule/visits/${encodeURIComponent(id)}/files`}>
      {({ company, can }) => (
        <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
          <RecordFiles
            baseUrl={`/api/app/${company.id}/files`}
            record={{ type: "scheduling.visit", id }}
            backHref={can.includes("schedule.view") ? `/app/schedule?visit=${encodeURIComponent(id)}` : "/app/schedule/today"}
          />
        </main>
      )}
    </CompanyGate>
  );
}

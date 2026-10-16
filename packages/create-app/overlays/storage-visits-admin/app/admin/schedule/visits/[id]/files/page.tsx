import { RecordFiles } from "__SCOPE__/storage-widget/admin";

export const dynamic = "force-dynamic";

/**
 * One visit's photos and files (Tenancy 2b-1): a visit has no page of its
 * own on the schedule, so its "Photos and files" opens here — from the
 * calendar's visit panel and from each stop on today's route. A crew member
 * on the job adds photos from their phone ("Take a photo").
 *
 * THE VISIT DECIDES (D12): whoever sees the schedule sees its files; a crew
 * member sees and adds them only on their own crew's visits. The routes check
 * on every call (/api/admin/files).
 */
export default async function VisitFilesPage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const { id } = await params;
  return <RecordFiles baseUrl="/api/admin/files" record={{ type: "scheduling.visit", id }} backHref="/admin/schedule/today" />;
}

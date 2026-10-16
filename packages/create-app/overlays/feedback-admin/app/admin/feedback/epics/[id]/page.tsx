import { FeedbackEpic } from "__SCOPE__/feedback/epics";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { Notice, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * One of THIS SITE'S OWN board's epics (feedback 0.12): its tickets, Add
 * tickets and Take out, its status, Edit and Delete (its tickets stay on the
 * board). An id that isn't this board's is "not found" by its routes.
 */
export default async function FeedbackEpicPage({ params }: { readonly params: Promise<{ readonly id: string }> }) {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.feedback.view")) {
    return (
      <>
        <PageHeader title="Epic" />
        <Notice tone="warn">You don&rsquo;t have permission to see this site&rsquo;s feedback.</Notice>
      </>
    );
  }
  const { id } = await params;
  return (
    <FeedbackEpic
      baseUrl="/api/admin/feedback"
      epicId={id}
      canManage={can.can("staff.feedback.manage")}
      epicsHref="/admin/feedback/epics"
      boardHref="/admin/feedback"
    />
  );
}

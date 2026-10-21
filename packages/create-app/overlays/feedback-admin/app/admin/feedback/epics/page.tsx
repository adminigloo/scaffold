import Link from "next/link";
import { FeedbackEpics, FeedbackEpicsActions } from "__SCOPE__/feedback/epics";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { Notice, PageHeader, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN board's epics (feedback 0.12): the bigger pieces of work its
 * tickets are grouped under. Seeing them is staff.feedback.view; making and
 * changing them staff.feedback.manage (the routes check again on every call).
 *
 * The package's own screen (__SCOPE__/feedback/epics, <FeedbackEpics>), over
 * this board's routes — the same screen a company's /app/feedback/epics uses.
 */
export default async function FeedbackEpicsPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.feedback.view")) {
    return (
      <>
        <PageHeader title="Epics" />
        <Notice tone="warn">You don&rsquo;t have permission to see this site&rsquo;s feedback.</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Epics"
        description="Bigger pieces of work, each with the feedback tickets that belong to it."
        actions={
          <>
            <Link href="/admin/feedback" className={buttonClass("secondary")}>
              Back to the board
            </Link>
            {can.can("staff.feedback.manage") ? <FeedbackEpicsActions className={buttonClass("primary")} /> : null}
          </>
        }
      />
      <FeedbackEpics
        baseUrl="/api/admin/feedback"
        canManage={can.can("staff.feedback.manage")}
        epicsHref="/admin/feedback/epics"
        boardHref="/admin/feedback"
        actionsInHeader
      />
    </>
  );
}

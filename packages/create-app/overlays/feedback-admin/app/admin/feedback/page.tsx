import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { FeedbackWorkspace } from "__SCOPE__/feedback/board";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { EmptyState, Notice, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN feedback board: what people sent with the feedback button
 * on every page of this app, as columns to drag between, and a panel per
 * ticket with the report, the screenshot, what they clicked, the browser's
 * errors and the conversation.
 *
 * The package's own board (__SCOPE__/feedback's <FeedbackWorkspace>), talking
 * to this site's board routes (/api/admin/feedback) — the same component a
 * company's /app/feedback uses over its own routes. The page checks the staff
 * key first so someone without it gets a sentence rather than a board that
 * fails on every call; the routes check it again on every call anyway.
 * `?ticket=` opens that ticket (an alert's or a colleague's link).
 */
export default async function FeedbackBoardPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isDbConfigured(db)) return <NotConfigured />;
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.feedback.view")) {
    return (
      <>
        <PageHeader title="Feedback" />
        <Notice tone="warn">You don&rsquo;t have permission to see this site&rsquo;s feedback.</Notice>
      </>
    );
  }
  const { ticket } = await searchParams;
  return (
    <>
      <PageHeader
        title="Feedback"
        description="What people sent with this site's feedback button. Drag a ticket between columns; open it to see what they saw and to answer them."
      />
      <FeedbackWorkspace
        baseUrl="/api/admin/feedback"
        canManage={can.can("staff.feedback.manage")}
        settingsHref={can.can("staff.feedback.settings") ? "/admin/feedback/settings" : null}
        initialTicketId={typeof ticket === "string" ? ticket : null}
      />
    </>
  );
}

function NotConfigured() {
  return (
    <>
      <PageHeader title="Feedback" />
      <EmptyState title="No database yet, so there is no board to show">
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>{" "}
        lists what is missing; set <code className="font-mono">DATABASE_URL</code> and run{" "}
        <code className="font-mono">pnpm db:migrate</code>.
      </EmptyState>
    </>
  );
}

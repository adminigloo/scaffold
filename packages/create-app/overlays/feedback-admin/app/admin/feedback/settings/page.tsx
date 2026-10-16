import Link from "next/link";
import { FeedbackSettings } from "@/components/FeedbackSettings";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { Notice, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN feedback board's settings: its columns, the categories
 * people choose from, and the website keys that put this board's feedback
 * button on another site. Anyone who can see the board can read them; only
 * staff.feedback.settings changes them (the routes refuse everyone else).
 */
export default async function FeedbackSettingsPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.feedback.view")) {
    return (
      <>
        <PageHeader title="Feedback settings" />
        <Notice tone="warn">You don&rsquo;t have permission to see this site&rsquo;s feedback.</Notice>
      </>
    );
  }
  const app = (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/?$/, "/");
  return (
    <>
      <PageHeader
        title="Feedback settings"
        description="The board's columns, the categories people choose from, and the feedback button on other websites."
        actions={
          <Link href="/admin/feedback" className="text-sm text-accent underline underline-offset-2">
            Back to the board
          </Link>
        }
      />
      <FeedbackSettings
        baseUrl="/api/admin/feedback"
        canManage={can.can("staff.feedback.settings")}
        intakeUrl={new URL("api/igloo", app).toString()}
      />
    </>
  );
}

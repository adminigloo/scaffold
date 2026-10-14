import { MessagesConsole } from "__SCOPE__/comms-widget/admin";
import { PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export const dynamic = "force-dynamic";

/**
 * The business's messages: how its emails go out, the wording of every email
 * customers get — visits, estimates, invoices — with each one's on/off switch,
 * the log of what went to whom, and "Send what's due now".
 *
 * __SCOPE__/comms-widget's <MessagesConsole>, talking to /api/admin/comms —
 * the package's own handlers, which check this project's staff keys on every
 * call (`staff.comms.view` to read, `staff.comms.manage` to edit and send).
 * Before Tenancy 2a this page was copied source over a tRPC router.
 *
 * `canManage` is read from the same staff permissions the admin layout
 * already resolved, so someone who may only read isn't offered Edit; the
 * server refuses it anyway without the key.
 */
export default async function MessagesPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  return (
    <>
      <PageHeader title="Messages" description="The emails your customers get, what they say, and what went out." />
      <MessagesConsole baseUrl="/api/admin/comms" canManage={can?.can("staff.comms.manage") ?? false} />
    </>
  );
}

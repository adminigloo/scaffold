import { MessagesConsole } from "__SCOPE__/comms-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company's messages (Tenancy 2a): how its emails go out ("Your customers
 * see emails from Green Acres and their replies go to office@…"), the wording
 * of every email its customers get — visits, estimates, invoices — with each
 * one's on/off switch, and the log of what went to whom.
 *
 * __SCOPE__/comms-widget's <MessagesConsole>, talking to THIS company's
 * routes (/api/app/{company id}/messages). Reading is `comms.view`; editing,
 * switching off and "Send what's due now" are `comms.manage` (owners and
 * admins) — `canManage` only decides whether those controls are offered; the
 * server refuses them anyway without the key.
 */
export default async function CompanyMessagesPage() {
  return (
    <CompanyGate path="/app/messages" permission="comms.view">
      {({ company, can }) => (
        <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
          <PageHeader
            title="Messages"
            description="The emails your customers get, what they say, and what went out."
          />
          <MessagesConsole baseUrl={`/api/app/${company.id}/messages`} canManage={can.includes("comms.manage")} />
        </main>
      )}
    </CompanyGate>
  );
}

import { AssistantSettings } from "__SCOPE__/assistant-widget/admin";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The company's assistant settings (Tenancy 2b-3): what its assistant knows,
 * written by the owner in plain words — the business profile, answers to
 * common questions (asked word for word, answered without AI), house rules
 * and the words the business uses — and this month's AI use against its
 * allowance.
 *
 * __SCOPE__/assistant-widget's <AssistantSettings>, talking to THIS company's
 * routes (/api/app/{company id}/assistant). It needs
 * `assistant.settings.manage` (owners and admins by default); everyone with
 * `assistant.use` asks the assistant from the button on every /app page.
 */
export default async function CompanyAssistantPage() {
  return (
    <CompanyGate path="/app/assistant" permission="assistant.settings.manage">
      {({ company }) => (
        <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
          <PageHeader
            title="Assistant"
            description={`What ${company.name}'s assistant knows about your business, in your words, and this month's AI use. Your team asks it from the button on every page; it asks before it changes anything.`}
          />
          <AssistantSettings baseUrl={`/api/app/${company.id}/assistant`} />
        </main>
      )}
    </CompanyGate>
  );
}

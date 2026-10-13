import { CompanySettings } from "__SCOPE__/tenancy-widget";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader } from "@/components/ui";
import { env } from "@/env";
import { NOUN, NOUN_TITLE, PUBLIC_COMPANY_PREFIX, TENANCY_API } from "@/tenancy";

/**
 * The active __TENANT_LABEL_LOWER__'s settings (Tenancy 1): name, web address,
 * logo, brand colour (with a plain contrast check against light and dark
 * text), time zone and contact details — plus every section another package
 * adds to the settings registry (src/server/tenant-settings.ts).
 *
 * The screen is the package's <CompanySettings>; who may change what is the
 * server's to decide (`tenant.edit`), and the page shows a read-only view to
 * anyone who may only look.
 */
export const dynamic = "force-dynamic";

export default async function CompanySettingsPage() {
  return (
    <CompanyGate path="/settings/company" permission="tenant.view">
      {({ company }) => (
        <main className="mx-auto max-w-4xl px-6 py-10">
          <PageHeader
            title={`${NOUN_TITLE.singular} settings`}
            description={`How ${company.name} appears, and how customers can reach you.`}
          />
          <CompanySettings
            baseUrl={TENANCY_API}
            tenantId={company.id}
            publicUrlPrefix={new URL(PUBLIC_COMPANY_PREFIX, env.NEXT_PUBLIC_APP_URL).toString()}
            noun={NOUN}
          />
        </main>
      )}
    </CompanyGate>
  );
}

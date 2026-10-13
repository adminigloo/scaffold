import { CompanyDetail } from "__SCOPE__/tenancy-widget/admin";
import { Notice, PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { NOUN, NOUN_TITLE, TENANCY_ADMIN_API } from "@/tenancy";

/**
 * One __TENANT_LABEL_LOWER__, as the platform owner sees it (Tenancy 1): who
 * is in it and with what role, when it was created and by whom, its status,
 * its old web addresses, and its recent activity in plain words ("Jake:
 * Member → Admin"). From here staff suspend or reactivate it, give it a new
 * owner when its owner closed their account, and release its old web
 * addresses — each behind its own staff permission, checked by the route.
 */
export const dynamic = "force-dynamic";

export default async function CompanyPage({
  params,
}: {
  // A Promise since Next 15; reading it synchronously hands the console
  // "[object Promise]" as the id.
  readonly params: Promise<{ readonly id: string }>;
}) {
  const { id } = await params;
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.tenants.view")) {
    return (
      <>
        <PageHeader title={NOUN_TITLE.singular} />
        <Notice tone="warn">You do not have permission to view {NOUN.plural}.</Notice>
      </>
    );
  }
  return <CompanyDetail baseUrl={TENANCY_ADMIN_API} tenantId={id} noun={NOUN} backHref="/admin/companies" />;
}

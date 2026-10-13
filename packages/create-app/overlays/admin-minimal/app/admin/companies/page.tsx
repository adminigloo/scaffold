import { CompaniesConsole } from "__SCOPE__/tenancy-widget/admin";
import { Notice, PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import {
  ADMIN_COMPANIES_DEFAULT_KIND,
  ADMIN_COMPANY_DETAIL_HREF,
  NOUN,
  NOUN_TITLE,
  TENANCY_ADMIN_API,
} from "@/tenancy";

/**
 * Every customer __TENANT_LABEL_LOWER__ — the operator console (Tenancy 1).
 *
 * The screen is the package's <CompaniesConsole>: search by name, web address
 * or owner's email, page through, filter by status, open one. Personal
 * workspaces are hidden by default in a companies project (they are people,
 * not customers) and shown in a single-business one, where they are all there
 * is — `ADMIN_COMPANIES_DEFAULT_KIND` from src/tenancy.ts says which, so this
 * file is the same in both and holds no `if`.
 *
 * `detailHref` is a PATTERN STRING, not a function: this is a server page and
 * the console is a client component, and a function can't cross that line
 * ("Functions cannot be passed directly to Client Components").
 *
 * Gated here as well as by the layout, and the routes check again on every
 * call: a page can be rendered by a route that doesn't sit under the layout.
 */
export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.tenants.view")) {
    return (
      <>
        <PageHeader title={NOUN_TITLE.plural} />
        <Notice tone="warn">You do not have permission to view {NOUN.plural}.</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title={NOUN_TITLE.plural}
        description={`Every ${NOUN.singular} on the platform. Open one to see its team, suspend or reactivate it, or give it a new owner.`}
      />
      <CompaniesConsole
        baseUrl={TENANCY_ADMIN_API}
        detailHref={ADMIN_COMPANY_DETAIL_HREF}
        defaultKind={ADMIN_COMPANIES_DEFAULT_KIND}
        noun={NOUN}
      />
    </>
  );
}

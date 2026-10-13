import { StaffPeople } from "__SCOPE__/tenancy-widget/admin";
import { Notice, PageHeader } from "@/components/ui";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { NOUN, TENANCY_ADMIN_API } from "@/tenancy";

/**
 * Everyone with an account, and who holds a staff role (Tenancy 1).
 *
 * MOVED HERE FROM admin-full, so every admin shell can hire staff (PC-04,
 * TB-09). The screen is the package's <StaffPeople>: search people, give or
 * take a staff role with a confirmation that says what it does. The rank
 * rules are the server's — a customer service lead can't make an
 * administrator; an administrator can make another one; the last
 * administrator can't be removed.
 */
export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.people.view")) {
    return (
      <>
        <PageHeader title="People" />
        <Notice tone="warn">You do not have permission to view people.</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="People"
        description="Everyone with an account. Staff roles decide who can open this admin panel and what they can do in it."
      />
      <StaffPeople baseUrl={TENANCY_ADMIN_API} noun={NOUN} />
    </>
  );
}

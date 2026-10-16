import { isDbConfigured } from "__SCOPE__/db";
import { Notice, PageHeader } from "@/components/ui";
import { CompanyPlans } from "@/components/admin/CompanyPlans";
import { db } from "@/db";
import { plans } from "@/plans";

/**
 * Every __TENANT_LABEL_LOWER__ and where it stands with its plan, and "Give free months"
 * (billing 0.3). A thin page: the list and the action are the billing
 * router's `companies` and `compPlan`, each behind its own staff permission,
 * so this page is authorised by exactly the rungs a browser request climbs.
 */
export const dynamic = "force-dynamic";

export default function AdminCompanyPlansPage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="__TENANT_LABEL__ plans" />
        <Notice tone="warn" title="DATABASE_URL is not set">
          Plans and subscriptions live in Postgres. Set the variable and run{" "}
          <code className="font-mono">pnpm db:migrate</code>.
        </Notice>
      </>
    );
  }
  // Only plans with a price can be given as free months: the record of a
  // subscription needs a price row to point at.
  const giftable = plans.tiers
    .filter((tier) => tier.isActive && plans.rows.some((row) => row.tierKey === tier.key))
    .map((tier) => ({ key: tier.key, name: tier.name }));
  return (
    <>
      <PageHeader
        title="__TENANT_LABEL__ plans"
        description="Where each __TENANT_LABEL_LOWER__ stands with its plan. Give free months to a friend, a first client, or to make something right."
      />
      <CompanyPlans giftable={giftable} tierNames={Object.fromEntries(plans.tiers.map((tier) => [tier.key, tier.name]))} />
    </>
  );
}

import { isDbConfigured } from "__SCOPE__/db";
import { Notice, PageHeader } from "@/components/ui";
import { Subscribers } from "@/components/admin/Subscribers";
import { db } from "@/db";
import { plans } from "@/plans";

/**
 * WHO PAYS, AND FOR WHAT (billing 0.5): the people who signed up, each with
 * where they stand on every product line, and Give free months — the
 * founder's view of a project whose customers are people (`--audience
 * consumers`, each person's own workspace pays). A thin page: the list and the
 * action are the billing router's `subscribers` and `compPlan`, each behind its
 * own staff permission, so this page is authorised by exactly the rungs a
 * browser request climbs.
 */
export const dynamic = "force-dynamic";

export default function AdminSubscribersPage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Subscribers" />
        <Notice tone="warn" title="DATABASE_URL is not set">
          Plans and subscriptions live in Postgres. Set the variable and run{" "}
          <code className="font-mono">pnpm db:migrate</code>.
        </Notice>
      </>
    );
  }
  // Only plans with a price can be given as free months: the record of a
  // subscription needs a price row to point at. Grouped by product line.
  const giftable = plans.tiers
    .filter((tier) => tier.isActive && plans.rows.some((row) => row.tierKey === tier.key))
    .map((tier) => ({
      key: tier.key,
      name: plans.lines.length > 1 ? `${plans.line(tier.line)?.name ?? tier.line}: ${tier.name}` : tier.name,
    }));
  return (
    <>
      <PageHeader
        title="Subscribers"
        description="Who's on which plan, and until when. Give free months to a friend, an early supporter, or to make something right."
      />
      <Subscribers giftable={giftable} />
    </>
  );
}

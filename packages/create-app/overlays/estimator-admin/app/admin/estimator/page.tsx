import { PriceBook } from "__SCOPE__/estimator-widget/admin";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The price book: what the business sells and how each price is built, from
 * __SCOPE__/estimator-widget's <PriceBook>, talking to /api/admin/estimator.
 *
 *   Products   each priced from the business's own supplies (how much of each
 *              per foot of ramp, per item, once per job), labor hours at its
 *              rate plus setup, waste, and a markup or a target margin, with a
 *              minimum. "What your customer sees" shows exactly the questions
 *              a customer is asked, worded by the owner; "Test a quote" prices
 *              any answer with the cost breakdown and the margin beside it.
 *   Supplies   the library: supplier cost per unit, supplier and SKU. Change a
 *              cost and every product that uses it is re-priced.
 *
 * "Load a sample catalog" fills an empty price book with a worked example (a
 * ramp company's products and supplies) — only when the owner clicks it.
 * Nothing on a public page ever adds products.
 *
 * Seeing costs and margins needs staff.estimates.costs, and changing anything
 * needs staff.estimates.pricebook; everybody else sees prices only.
 */
export default function PriceBookPage() {
  return (
    <>
      <PageHeader
        title="Price book"
        description="Your products, priced from your own supplies, labor and markup. Test a quote to see the price, the cost and your margin before a customer does."
      />
      <PriceBook baseUrl="/api/admin/estimator" />
    </>
  );
}

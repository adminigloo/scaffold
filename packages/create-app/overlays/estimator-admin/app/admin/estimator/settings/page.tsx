import { EmbedKeys, EstimatorSettings } from "__SCOPE__/estimator-widget/admin";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Everything a business owner decides about estimates, on one page, saved to
 * the database — no developer, no deploy:
 *
 *   Business       the name and contact customers see, currency, time zone,
 *                  brand colour
 *   Quotes         how long a quote is good for, when to follow up, the note
 *                  printed at the bottom of every quote
 *   Pricing        the tax rate, the default labor rate, a contingency
 *   Lead alerts    who in the office is emailed about new leads and answers
 *   Website        estimates on or off (pausing the page and the embed)
 *   Photos and AI  whether customers can add a photo, whether it is read, and
 *                  the most reading may cost a day — with what it has cost
 *
 * And below them, WEBSITE EMBED: a key for putting the estimate on the
 * business's other website, locked to that website's address, with the code
 * to paste. The snippet points at this deployment's /api/estimator (the staff
 * API tells the component the address).
 *
 * Needs staff.estimates.settings.
 */
export default function EstimateSettingsPage() {
  return (
    <>
      <PageHeader
        title="Estimate settings"
        description="Your business details, tax, quote rules, who hears about new leads, photo reading and its budget, and the estimate on your other website."
      />
      <EstimatorSettings baseUrl="/api/admin/estimator" />
      <div className="mt-8">
        <EmbedKeys baseUrl="/api/admin/estimator" />
      </div>
    </>
  );
}

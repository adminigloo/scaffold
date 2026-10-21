"use client";

import { EstimatesQueue, EstimatesQueueActions } from "__SCOPE__/estimator-widget/admin";
import { PageHeader, buttonClass } from "@/components/ui";

/**
 * Leads and quotes: every estimate a customer saved on /estimate (or through
 * the embed on another website) and every one staff started, from
 * __SCOPE__/estimator-widget's <EstimatesQueue>, talking to /api/admin/estimator
 * (which checks the signed-in person's staff permissions on every call — the
 * admin layout's gate is a convenience, not the boundary).
 *
 *   - Filters by where each one stands — new leads, quotes waiting on the
 *     customer, accepted, declined, expired, archived — with counts, and a
 *     search over names, emails, addresses and numbers.
 *   - Each row says whether a photo came with it and whether the AI read it.
 *   - Opening one goes to /admin/estimates/[id]: the photo, the AI's reading
 *     beside what the customer settled on, the priced lines to edit, and
 *     "Send quote".
 *
 * A CLIENT PAGE because the row links are built by a function
 * (`estimateHref`), and a function can't be handed from the server to the
 * browser. Quotes past their date are marked expired when this list loads (at
 * most once a minute), as well as by the daily job.
 */
export default function EstimatesPage() {
  return (
    <>
      <PageHeader
        title="Estimates"
        description="New leads from your website and the quotes you've sent. Open one to see the customer's photo, edit the lines and send the quote."
        actions={<EstimatesQueueActions className={buttonClass("primary")} />}
      />
      {/* New estimate beside the title, like every page's primary action (polish 3). */}
      <EstimatesQueue
        baseUrl="/api/admin/estimator"
        estimateHref={(id) => `/admin/estimates/${encodeURIComponent(id)}`}
        title={false}
        actionsInHeader
      />
    </>
  );
}

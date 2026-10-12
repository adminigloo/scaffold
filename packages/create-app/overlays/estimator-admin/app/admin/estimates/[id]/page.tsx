"use client";

import { useParams, useRouter } from "next/navigation";
import { EstimateEditor } from "__SCOPE__/estimator-widget/admin";

/**
 * One estimate, from __SCOPE__/estimator-widget's <EstimateEditor>, talking to
 * /api/admin/estimator:
 *
 *   - The customer's PHOTO, and what the AI SAW in it ("We counted 3 steps")
 *     beside what the customer settled on ("steps 3 → 4"), with the working
 *     for every priced line in plain words.
 *   - The LINES: add one from the price book or by hand, change a count or a
 *     measurement and it is re-priced from the price book, remove one — the
 *     totals and tax are worked out again by the server each time.
 *   - SEND QUOTE: the customer is emailed a link to /quote/[token] (with
 *     comms), a follow-up is queued for when they don't answer, and the quote
 *     can be revised, resent or its link copied.
 *   - Once ACCEPTED: "Book the visit" (with scheduling — the booking page,
 *     tied to this estimate, and the visits booked from it are listed here)
 *     and "Create invoice" (with invoicing — once, in one transaction).
 *
 * Costs and margins show only to someone holding staff.estimates.costs.
 *
 * A CLIENT PAGE: the id comes from the URL in the browser, and "Duplicate"
 * opens the copy by navigating — a function the server can't hand down.
 */
export default function EstimatePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  return (
    <EstimateEditor
      baseUrl="/api/admin/estimator"
      estimateId={params.id}
      backHref="/admin/estimates"
      onOpenEstimate={(id) => router.push(`/admin/estimates/${encodeURIComponent(id)}`)}
    />
  );
}

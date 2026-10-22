import type { Metadata } from "next";
import { VisitPicker } from "__SCOPE__/scheduling-widget";
import { metadataFor } from "@/seo";

export const metadata: Metadata = metadataFor({
  path: "/book-visit",
  title: "Book a visit",
  description: "Pick a time that suits you and we'll come to you. Times are shown in our local time.",
});

/**
 * The booking page: a customer picks a service, a day and a time, and leaves
 * their details. Everything on it is __SCOPE__/scheduling-widget's
 * <VisitPicker>, talking to /api/schedule — the times come from the crews'
 * real hours in the business's own time zone, and the server re-checks the
 * one they chose when they send it.
 *
 * What they get back depends on the business's settings (Schedule settings):
 * "request received, we'll confirm" with an acknowledgement email, or —
 * with auto-confirm on — "you're booked" with a confirmation. Either way the
 * email carries the link to their own visit (/visit/[token]).
 *
 * TWO QUERY PARAMETERS, both optional, for links from elsewhere:
 *
 *   ?service=estimate   open on that service (Schedule settings shows each key)
 *   ?estimate=<id>      tie the visit to an estimate, for "book your free
 *                       estimate" links from a quote
 *
 * Restyle the page around the card freely; the card follows the site's light
 * or dark theme by itself.
 */
export default async function BookVisitPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (value: string | string[] | undefined): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value : undefined;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <VisitPicker
        baseUrl="/api/schedule"
        service={single(params.service)}
        estimateId={single(params.estimate)}
      />
    </main>
  );
}

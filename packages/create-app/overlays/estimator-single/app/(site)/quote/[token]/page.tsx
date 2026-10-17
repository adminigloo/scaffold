import type { Metadata } from "next";
import { QuoteView } from "__SCOPE__/estimator-widget";
import { ESTIMATE_BOOK_VISIT_HREF } from "@/server/estimator-features";
import { quotePayment } from "@/server/quote-deposit";

/**
 * Never indexed, and never handing its address to the next site. The token in
 * this URL is the customer's whole key to their quote — anybody holding it can
 * accept it — so the page tells search engines to forget it and tells the
 * browser to send no Referer when the customer clicks a link out of it. The
 * API sends the same two headers on every route that carries a token.
 *
 * Keep third-party scripts off this page for the same reason: a script here
 * can read the address bar.
 */
export const metadata: Metadata = {
  title: "Your quote",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * The page behind the link in every quote email: the business's name, the
 * lines, the total with tax, the date it is good until, and Accept or Decline
 * with an optional note. Accepting tells the office at once (with comms) and
 * withdraws the follow-up; with scheduling the customer is offered "Pick a time
 * for the work", which books the visit against this estimate. A quote being
 * revised says so; one past its date says to get in touch. It prints cleanly
 * ("Print or save as PDF").
 *
 * Nothing is looked up here on the server. The widget reads the quote from
 * /api/estimator in the browser, so a link previewer or mail scanner that
 * fetches this URL learns nothing and changes nothing — the first real view
 * marks it "viewed", and every answer is a button the customer presses.
 */
export default async function QuotePage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <QuoteView baseUrl="/api/estimator" token={token} bookHref={ESTIMATE_BOOK_VISIT_HREF} payment={await quotePayment(token)} />
    </main>
  );
}

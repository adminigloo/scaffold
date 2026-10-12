import type { Metadata } from "next";
import { ManageVisit } from "__SCOPE__/scheduling-widget";

/**
 * Never indexed, and never handing its address to the next site. The token in
 * this URL is the customer's whole key to their visit — anybody holding it can
 * move or cancel it — so the page tells search engines to forget it and tells
 * the browser to send no Referer when the customer clicks a link out of it.
 * The API sends the same two headers on every route that carries a token.
 *
 * Keep third-party scripts off this page for the same reason: a script here
 * can read the address bar.
 */
export const metadata: Metadata = {
  title: "Your visit",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * The page behind the link in every customer email: their visit, in plain
 * words, with Reschedule and Cancel while it is still early enough (the
 * business's cutoff, in Schedule settings), and the business's phone number
 * when it is not. A cancelled, declined or expired visit offers "Book a new
 * time", which comes back to /book-visit.
 *
 * Nothing is looked up here on the server. The widget reads the visit from
 * /api/schedule in the browser, so a link previewer or mail scanner that
 * fetches this URL learns nothing and changes nothing — every change is a
 * button the customer presses.
 */
export default async function ManageVisitPage({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <ManageVisit baseUrl="/api/schedule" token={token} bookHref="/book-visit" />
    </main>
  );
}

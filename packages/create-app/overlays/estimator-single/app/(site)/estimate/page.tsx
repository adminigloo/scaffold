import type { Metadata } from "next";
import { EstimateTool } from "__SCOPE__/estimator-widget";
import { metadataFor } from "@/seo";
import { ESTIMATE_BOOK_VISIT_HREF } from "@/server/estimator-features";

export const metadata: Metadata = metadataFor({
  path: "/estimate",
  title: "Instant estimate",
  description: "A real price in a minute, before anyone drives out — from our own price book, for what you can count or measure.",
});

/**
 * The instant estimate: a customer picks what they need, answers what they
 * know — how many steps go up to the door, the height of one step if they
 * measured it, a width and a length — and sees a live price from the
 * business's own price book, with the working shown in plain words. Every
 * number is worked out by __SCOPE__/estimator's code on the server; the page
 * shows what the server sends.
 *
 * Everything on it is __SCOPE__/estimator-widget's <EstimateTool>, talking to
 * /api/estimator:
 *
 *   - A PHOTO is optional. With file storage it is kept with the estimate, so
 *     the business sees the steps before anybody drives out; with --ai a model
 *     reports what it SEES (how many steps, how tall they look) and the count
 *     is filled in for the customer to check. The browser shrinks the photo
 *     to 768 px before it is sent.
 *   - SAVING files a lead in /admin/estimates and, with email, sends the
 *     office a new-lead email and the customer a copy.
 *   - "Book a visit to measure" appears after saving when this project has
 *     scheduling (ESTIMATE_BOOK_VISIT_HREF).
 *
 * Until the owner builds the price book (/admin/estimator), the page says the
 * estimator isn't set up yet — nothing is priced from a list the business
 * didn't write. The business's name, brand colour and products come from
 * Estimate settings and the price book, not from this file. Restyle the page
 * around the card freely; the card follows the site's light or dark theme by
 * itself.
 */
export default function EstimatePage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <EstimateTool baseUrl="/api/estimator" bookHref={ESTIMATE_BOOK_VISIT_HREF} />
    </main>
  );
}

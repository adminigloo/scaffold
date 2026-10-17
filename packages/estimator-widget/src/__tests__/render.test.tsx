import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmbedKeys } from "../admin/EmbedKeys.js";
import { EstimateEditor } from "../admin/EstimateEditor.js";
import { EstimatesQueue } from "../admin/EstimatesQueue.js";
import { EstimatorAdmin } from "../admin/EstimatorAdmin.js";
import { EstimatorSettings } from "../admin/EstimatorSettings.js";
import { PriceBook } from "../admin/PriceBook.js";
import { EstimateTool } from "../EstimateTool.js";
import { CustomerFields } from "../fields.js";
import { Honeypot, WidgetRoot } from "../parts.js";
import { PriceCard } from "../price.js";
import { QuoteView, StatusBanner } from "../QuoteView.js";
import { fakeAdmin, fakePublic, PAD, PRICE_ASSUMED, PRICE_MEASURED, quote, RAMP_FIELDS } from "./fakes.js";

/**
 * The components without a DOM (react-dom/server): what a server render — a
 * Next.js page, before hydration — puts on the page. No `data-theme` for
 * "auto" (the CSS's media query decides, so no flash), a pinned theme as
 * given, a loading state rather than a crash, and the presentational pieces'
 * words: every field kind, the price card's states, the quote's five statuses.
 */

const html = (node: ReactElement) => renderToStaticMarkup(node).replace(/[   ]/g, " ");
const never = () => new Promise<never>(() => {});
const strip = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("server render", () => {
  it("every component renders on the server: a loading state, no data-theme under 'auto'", () => {
    const pub = fakePublic({ config: never, quote: never }).transport;
    const admin = fakeAdmin({ status: never, getSettings: never, listEstimates: never, getEstimate: never, listProducts: never, listSupplies: never, listKeys: never }).transport;
    const outputs = [
      html(<EstimateTool transport={pub} />),
      html(<QuoteView transport={pub} token="t" />),
      html(<EstimatorAdmin transport={admin} />),
      html(<EstimatesQueue transport={admin} />),
      html(<EstimateEditor transport={admin} estimateId="e1" />),
      html(<PriceBook transport={admin} />),
      html(<EstimatorSettings transport={admin} />),
      html(<EmbedKeys transport={admin} />),
    ];
    for (const out of outputs) {
      expect(out).toMatch(/^<div class="aiew-root/);
      expect(out).not.toContain("data-theme");
    }
    expect(outputs[0]).toContain('data-aiew-skeleton=""');
    expect(outputs[0]).toContain("Loading the estimator…");
    expect(outputs[1]).toContain("Loading your quote…");
    expect(outputs[2]).toContain('class="aiew-root aiew-admin"');
    expect(outputs[3]).toContain("Loading estimates…");
    expect(outputs[4]).toContain("Loading the estimate…");
    expect(outputs[5]).toContain("Loading products…");
    expect(outputs[6]).toContain("Loading settings…");
    expect(outputs[7]).toContain("Loading keys…");
    // No "Powered by" anywhere unless asked for.
    for (const out of outputs) expect(out).not.toContain("Powered by");
  });

  it("a pinned theme and a brand colour are on the root from the first byte", () => {
    const out = html(
      <WidgetRoot theme="dark" className="my-estimate" style={{ maxWidth: 560 }} accent="#7C3AED">
        x
      </WidgetRoot>,
    );
    expect(out).toMatch(/^<div class="aiew-root my-estimate" style="--aiew-bl-accent:#7c3aed;/);
    expect(out).toContain("max-width:560px");
    expect(out).toContain('data-theme="dark"');
    expect(out).toContain('data-brand=""');
  });
});

describe("the pieces", () => {
  it("every field kind: a stepper, a number with its unit, choice chips; empty to start; the secondary behind its disclosure", () => {
    const out = html(<CustomerFields fields={[...PAD.fields, ...RAMP_FIELDS]} values={{}} onChange={() => {}} />);
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain("4 × 4 ft");
    expect(out).toContain('inputMode="numeric"');
    expect(out).toContain('aria-label="How many steps go up to the door?"');
    expect(out).toContain('<span class="aiew-unit" aria-hidden="true">in</span>');
    expect(out).toContain('<span class="aiew-unit" aria-hidden="true">ft</span>');
    expect(out).toContain('placeholder="e.g. 7.5"');
    expect(out).toMatch(/aria-expanded="false"[^>]*>.*More ways to measure/);
    expect(out).toMatch(/hidden="" data-aiew-more=""/);
    expect(out).not.toMatch(/\svalue="[^"]+"/);
  });

  it("a value from the photo carries its badge", () => {
    const out = html(<CustomerFields fields={RAMP_FIELDS} values={{ steps: 3 }} onChange={() => {}} readOnlyBadges={{ steps: "From your photo" }} />);
    expect(out).toContain('data-aiew-badge="steps"');
    expect(strip(out)).toContain("From your photo");
    expect(out).toContain('value="3"');
  });

  it("the price card: needs inputs, a range with its assumption and why, one number, quote only", () => {
    expect(strip(html(<PriceCard state={{ status: "needs_inputs" }} locale="en-US" />))).toContain("Answer the questions above to see your price.");
    const range = strip(html(<PriceCard state={{ status: "priced", price: PRICE_ASSUMED }} locale="en-US" />));
    expect(range).toContain("$6,444 – $7,164");
    expect(range).toContain("Plus 7.25% sales tax.");
    expect(range).toContain("Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.");
    expect(range).toContain("Why a range? Step height 7–8 in (estimated)");
    expect(range).toContain("We'll confirm the final price once we've seen the job.");
    const one = strip(html(<PriceCard state={{ status: "priced", price: PRICE_MEASURED }} locale="en-US" />));
    expect(one).toContain("$6,924");
    expect(one).not.toContain("Why a range?");
    expect(strip(html(<PriceCard state={{ status: "quote_only" }} locale="en-US" />))).toContain("This one needs a quick look to price.");
    // The whole card is announced politely when it changes.
    expect(html(<PriceCard state={{ status: "needs_inputs" }} locale="en-US" />)).toContain('aria-live="polite"');
  });

  it("the quote's five statuses, each in one plain sentence", () => {
    const say = (q: ReturnType<typeof quote>, bookHref?: string) => strip(html(<StatusBanner quote={q} locale="en-US" bookHref={bookHref} />));
    expect(say(quote())).toBe("Good until December 2, 2026.");
    expect(say(quote({ status: "accepted", respondedAt: "2026-11-03T16:00:00.000Z" }), "/book")).toBe(
      "You accepted this quote on November 3, 2026. Thank you! Pick a time for the work",
    );
    expect(say(quote({ status: "declined", respondedAt: "2026-11-03T16:00:00.000Z" }))).toBe(
      "You declined this quote on November 3, 2026. Changed your mind? Call (801) 555-0143 .",
    );
    expect(say(quote({ status: "expired" }))).toBe("This quote expired on December 2, 2026. Call (801) 555-0143 or email office@summit.test for an updated one.");
    expect(say(quote({ status: "updating" }))).toBe("We're updating this quote. You'll get the new version by email.");
  });

  it("an accepted quote offers what the app says — a POST button with its label, or a sentence — and nowhere else", () => {
    const accepted = quote({ status: "accepted", respondedAt: "2026-11-03T16:00:00.000Z" });
    const out = html(<StatusBanner quote={accepted} locale="en-US" payment={{ href: "/api/t/summit/quote-deposit/tok", label: "Pay the balance" }} />);
    expect(out).toContain('action="/api/t/summit/quote-deposit/tok"');
    expect(out).toContain('method="post"');
    expect(strip(out)).toContain("Pay the balance");
    expect(strip(html(<StatusBanner quote={accepted} locale="en-US" payment={{ note: "Your invoice is on its way." }} />))).toContain("Your invoice is on its way.");
    expect(html(<StatusBanner quote={accepted} locale="en-US" payment={{ note: "Your invoice is on its way." }} />)).not.toContain("<form");
    expect(html(<StatusBanner quote={accepted} locale="en-US" />)).not.toContain("<form");
    expect(html(<StatusBanner quote={quote()} locale="en-US" payment={{ href: "/x", label: "Pay now" }} />)).not.toContain("Pay now");
  });

  it("the honeypot is off-screen, out of the tab order, hidden from assistive tech, never autofilled — and not display:none", () => {
    const out = html(<Honeypot id="hp" value="" onChange={() => {}} />);
    expect(out).toContain('class="aiew-hp" aria-hidden="true"');
    expect(out).toContain('name="website"');
    expect(out).toContain('tabindex="-1"');
    expect(out).toContain('autoComplete="off"');
    expect(out).not.toContain("display:none");
  });
});

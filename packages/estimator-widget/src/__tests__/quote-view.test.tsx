// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuoteView } from "../QuoteView.js";
import type { AcceptQuoteBody, DeclineQuoteBody } from "../types.js";
import { button, click, fail, fakePublic, labelled, mount, ok, quote, submit, text, type } from "./fakes.js";

/**
 * <QuoteView> — the customer's quote page (contract 9.6): the business, the
 * lines, the tax, the total, how long it's good for, and an answer confirmed
 * on the page itself. A quote that changed under the customer (expired,
 * answered in another tab, being revised) is reloaded and shown as it stands,
 * with the server's words.
 */

/** Each totals row as "Label amount". */
function totalsRows(container: HTMLElement): string[] {
  return [...container.querySelector("[data-aiew-totals]")!.children].map((row) => [...row.children].map((cell) => text(cell)).join(" "));
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("<QuoteView>", () => {
  it("shows the business, the quote, the lines with their details, the tax and the total, and how long it's good for", async () => {
    const fake = fakePublic({ quote: () => ok({ quote: quote() }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok/abc" />);
    expect(fake.of("quote")[0]!.args[0]).toBe("tok/abc");
    const page = text(container);
    expect(page).toContain("Summit Ramps");
    expect(page).toContain("Quote EST-0001");
    expect(page).toContain("For Pat Lee");
    expect(page).toContain("12 Elm St, Salt Lake City");
    expect(page).toContain("Sent November 2, 2026");
    expect(page).toContain("Thanks for having us out.");
    const rows = [...container.querySelectorAll("[data-aiew-lines] tbody tr")].map((tr) => text(tr));
    expect(rows[0]).toContain("Modular aluminum ramp");
    expect(rows[0]).toContain("4 steps, 7.25 in each");
    expect(rows[0]).toContain("Surface: Standard grit");
    expect(rows[0]).toContain("$8,362.80");
    expect(totalsRows(container)).toEqual(["Subtotal $8,512.80", "Sales tax (7.25%) $617.18", "Total $9,129.98"]);
    expect(text(container.querySelector('[data-aiew-banner="open"]'))).toBe("Good until December 2, 2026.");
    expect(page).toContain("Price includes installation and haul-away.");
    await unmount();
  });

  it("accept: a confirmation on the page with the total, an optional name and note, then 'accepted' with the booking link", async () => {
    const onRespond = vi.fn();
    const accepted = quote({ status: "accepted", canRespond: false, respondedAt: "2026-11-03T16:00:00.000Z", responseName: "Pat Lee" });
    const fake = fakePublic({ quote: () => ok({ quote: quote() }), acceptQuote: () => ok({ quote: accepted }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" bookHref="/book-visit" onRespond={onRespond} />);
    await click(button(container, "Accept this quote"));
    const confirm = container.querySelector('[data-aiew-confirm="accept"]')!;
    expect(text(confirm)).toContain("Accept this quote for $9,129.98?");
    expect(document.activeElement?.textContent).toBe("Accept this quote for $9,129.98?");
    expect((labelled(confirm, "Your name") as HTMLInputElement).value).toBe("Pat Lee");
    await type(labelled(confirm, "A note for the business"), "Mornings are best");
    // A honeypot rides along, empty.
    expect(confirm.querySelector('input[name="website"]')).not.toBeNull();
    await submit(confirm);
    expect(fake.of("acceptQuote")[0]!.args).toEqual(["tok_1", { version: 1, name: "Pat Lee", note: "Mornings are best" } satisfies AcceptQuoteBody]);
    expect(text(container.querySelector('[data-aiew-banner="accepted"]'))).toContain("You accepted this quote on November 3, 2026. Thank you!");
    expect(container.querySelector("[data-aiew-book]")!.getAttribute("href")).toBe("/book-visit?estimate=est_1");
    expect(container.querySelector("[data-aiew-respond]")).toBeNull();
    expect(onRespond).toHaveBeenCalledWith(accepted);
    await unmount();
  });

  it("decline: asks for an optional note, confirms, and says how to change their mind", async () => {
    const declined = quote({ status: "declined", canRespond: false, respondedAt: "2026-11-03T16:00:00.000Z" });
    const fake = fakePublic({ quote: () => ok({ quote: quote() }), declineQuote: () => ok({ quote: declined }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    await click(button(container, "Decline"));
    const confirm = container.querySelector('[data-aiew-confirm="decline"]')!;
    expect(text(confirm)).toContain("Decline this quote?");
    await type(labelled(confirm, "Tell the business why"), "Going with my brother-in-law");
    await submit(confirm);
    expect(fake.of("declineQuote")[0]!.args).toEqual(["tok_1", { version: 1, note: "Going with my brother-in-law" } satisfies DeclineQuoteBody]);
    expect(text(container.querySelector('[data-aiew-banner="declined"]'))).toBe(
      "You declined this quote on November 3, 2026. Changed your mind? Call (801) 555-0143.",
    );
    await unmount();
  });

  it("'Not yet' backs out of the confirmation without sending anything", async () => {
    const fake = fakePublic({ quote: () => ok({ quote: quote() }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    await click(button(container, "Accept this quote"));
    await click(button(container, "Not yet"));
    expect(container.querySelector("[data-aiew-confirm]")).toBeNull();
    expect(fake.of("acceptQuote")).toHaveLength(0);
    await unmount();
  });

  it("quote_expired: the quote is read again and shown as it stands, with the server's words", async () => {
    let reads = 0;
    const expired = quote({ status: "expired", canRespond: false });
    const fake = fakePublic({
      quote: () => ok({ quote: ++reads === 1 ? quote() : expired }),
      acceptQuote: () => fail("quote_expired", "This quote expired on Dec 2, 2026. Call us at (801) 555-0143 for an updated one."),
    });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    await click(button(container, "Accept this quote"));
    await submit(container.querySelector('[data-aiew-confirm="accept"]'));
    expect(fake.of("quote")).toHaveLength(2);
    expect(text(container)).toContain("This quote expired on Dec 2, 2026. Call us at (801) 555-0143 for an updated one.");
    expect(text(container.querySelector('[data-aiew-banner="expired"]'))).toBe(
      "This quote expired on December 2, 2026. Call (801) 555-0143 or email office@summit.test for an updated one.",
    );
    expect(container.querySelector("[data-aiew-respond]")).toBeNull();
    await unmount();
  });

  it.each([
    ["updating", "We're updating this quote. You'll get the new version by email."],
    ["expired", "This quote expired on December 2, 2026. Call (801) 555-0143 or email office@summit.test for an updated one."],
  ] as const)("'%s' says so and offers no answer buttons", async (status, words) => {
    const fake = fakePublic({ quote: () => ok({ quote: quote({ status, canRespond: false }) }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    expect(text(container.querySelector(`[data-aiew-banner="${status}"]`))).toBe(words);
    expect(container.querySelector("[data-aiew-respond]")).toBeNull();
    await unmount();
  });

  it("a link that opens nothing says what to do", async () => {
    const fake = fakePublic({ quote: () => fail("not_found") });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="old" />);
    expect(text(container)).toContain("This quote link doesn't work.");
    expect(text(container)).toContain("It may have been replaced by a newer one; check your latest email from the business.");
    await unmount();
  });

  it("a network failure offers Retry", async () => {
    let n = 0;
    const fake = fakePublic({ quote: () => (++n === 1 ? fail("network") : ok({ quote: quote() })) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    expect(text(container)).toContain("We couldn't connect.");
    await click(button(container, "Retry"));
    expect(text(container)).toContain("Quote EST-0001");
    await unmount();
  });

  it("'Print or save as PDF' prints, and the print stylesheet hides the buttons", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    window.print = print;
    const fake = fakePublic({ quote: () => ok({ quote: quote({ discount: 12_998 }) }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    expect(totalsRows(container)).toContain("Discount −$129.98");
    await click(button(container, "Print or save as PDF"));
    expect(print).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-aiew-respond]")!.classList.contains("aiew-no-print")).toBe(true);
    vi.unstubAllGlobals();
    await unmount();
  });

  it("uses the business's colour from the quote", async () => {
    const fake = fakePublic({ quote: () => ok({ quote: quote({ brandColor: "#1d4ed8" }) }) });
    const { container, unmount } = await mount(<QuoteView transport={fake.transport} token="tok_1" />);
    const root = container.querySelector<HTMLElement>(".aiew-root")!;
    expect(root.hasAttribute("data-brand")).toBe(true);
    expect(root.style.getPropertyValue("--aiew-bl-accent")).toBe("#1d4ed8");
    await unmount();
  });
});

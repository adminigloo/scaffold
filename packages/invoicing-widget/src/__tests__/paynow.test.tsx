// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { InvoicePublicTransport } from "../client.js";
import { InvoiceView } from "../InvoiceView.js";
import { publicInvoice } from "./fixtures.js";
import { button, click, fail, fakeTransport, mount, ok, text } from "./dom.js";

/**
 * Pay now (0.2): the button pays the SERVER's amount, the box exists only when
 * the business allows part payments, the browser goes where the server said,
 * and a refusal is the server's sentence.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const deposit = { stage: "deposit" as const, amount: 7_794, depositAmount: 7_794, allowPartial: false, minimum: 50, maximum: 25_980, belowMinimum: false };

describe("Pay now", () => {
  it("says a bank payment is on its way, and asks to get in touch below the card minimum", async () => {
    const fake = fakeTransport<InvoicePublicTransport>({
      invoice: () => ok(publicInvoice({ pay: { ...deposit, stage: "balance", amount: 30, depositAmount: 0, belowMinimum: true }, pending: { amount: 25_950, startedAt: "2026-10-14T18:00:00.000Z" } })),
      viewed: () => ok({ viewed: true }),
      pay: () => ok({ url: "https://x" }),
    });
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" />);
    expect(text(container)).toContain("A bank payment of $259.50 is on its way (started Oct 14, 2026).");
    expect(text(container)).toContain("Please contact Green Acres to pay this small amount.");
    expect(container.querySelector("[data-aiiw-paynow]")).toBeNull();
    await unmount();
  });

  it("pays the deposit first, sending no amount of its own, and goes to Stripe", async () => {
    const fake = fakeTransport<InvoicePublicTransport>({
      invoice: () => ok(publicInvoice({ pay: deposit })),
      viewed: () => ok({ viewed: true }),
      pay: () => ok({ url: "https://checkout.stripe.test/c/1" }),
    });
    const went: string[] = [];
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" navigate={(url) => went.push(url)} />);
    expect(text(container)).toContain("Pay the deposit");
    expect(text(container)).toContain("Other ways to pay");
    expect(container.querySelector("[data-aiiw-paynow] input")).toBeNull();
    await click(button(container, "Pay $77.94 now"));
    expect(fake.of("pay").map((c) => c.args)).toEqual([["tok", {}]]);
    expect(went).toEqual(["https://checkout.stripe.test/c/1"]);
    await unmount();
  });

  it("offers an amount box only when part payments are on, and checks it before asking", async () => {
    const fake = fakeTransport<InvoicePublicTransport>({
      invoice: () => ok(publicInvoice({ pay: { ...deposit, stage: "balance", allowPartial: true, amount: 25_980, depositAmount: 0 } })),
      viewed: () => ok({ viewed: true }),
      pay: () => fail("payment_unavailable", "Green Acres isn't taking card payments online right now.", { status: 409 }),
    });
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" navigate={() => undefined} />);
    const input = container.querySelector<HTMLInputElement>("[data-aiiw-paynow] input")!;
    expect(input.value).toBe("259.80");
    await click(button(container, "Pay now"));
    expect(fake.of("pay").map((c) => c.args)).toEqual([["tok", { amount: 25_980 }]]);
    expect(text(container)).toContain("isn't taking card payments online right now");
    await unmount();
  });

  it("shows no button without an offer or in a preview, and thanks the customer coming back", async () => {
    const none = fakeTransport<InvoicePublicTransport>({ invoice: () => ok(publicInvoice()), viewed: () => ok({ viewed: true }), pay: () => ok({ url: "https://x" }) });
    const a = await mount(<InvoiceView transport={none.transport} token="tok" returned />);
    expect(a.container.querySelector("[data-aiiw-paynow]")).toBeNull();
    expect(text(a.container)).toContain("Thank you! Your payment is on its way to Green Acres");
    await a.unmount();
    const offered = fakeTransport<InvoicePublicTransport>({ invoice: () => ok(publicInvoice({ pay: deposit })), viewed: () => ok({ viewed: true }), pay: () => ok({ url: "https://x" }) });
    const b = await mount(<InvoiceView transport={offered.transport} token="tok" preview />);
    expect(b.container.querySelector("[data-aiiw-paynow]")).toBeNull();
    await b.unmount();
  });
});

// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { InvoicePublicTransport } from "../client.js";
import { InvoiceView, statusLine } from "../InvoiceView.js";
import { FORMAT, publicInvoice } from "./fixtures.js";
import { button, click, fail, fakeTransport, mount, ok, text } from "./dom.js";

/**
 * <InvoiceView> (Tenancy 2a, 10.9), the customer's page: the business, the
 * invoice in money and dates a person reads, "How to pay", the plain
 * sentences for an invoice that isn't available or a business that isn't
 * taking requests, and the view reported ONCE by a POST, never with preview.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const view = (extra: Parameters<typeof fakeTransport<InvoicePublicTransport>>[0] = {}) =>
  fakeTransport<InvoicePublicTransport>({ invoice: () => ok(publicInvoice()), viewed: () => ok({ viewed: true }), ...extra });

describe("<InvoiceView>", () => {
  it("shows the business, the invoice, the totals and how to pay", async () => {
    const fake = view();
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" />);
    const page = text(container);
    expect(page).toContain("Green Acres");
    expect(page).toContain("gail@greenacres.test");
    expect(page).toContain("Invoice INV-2026-0001");
    expect(page).toContain("For Pat Customer");
    expect(page).toContain("Due Nov 2, 2026");
    expect(page).toContain("Spring cleanup");
    expect(page).toContain("Tax (8.25%)");
    expect(page).toContain("−$10.00");
    expect(page).toContain("Balance due$259.80");
    const pay = container.querySelector("[data-aiiw-pay]")!;
    expect([...pay.children].map((el) => text(el))).toEqual(["How to pay", "Pay by check to Green Acres LLC.", "Thanks for your business."]);
    const logo = container.querySelector("img");
    expect(logo?.getAttribute("alt")).toBe("");
    expect(container.querySelector('a[href="tel:8015550100"]')).not.toBeNull();
    await unmount();
  });

  it("reports the view once, by POST, after the invoice loaded", async () => {
    const fake = view();
    const { unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" />);
    expect(fake.of("viewed").map((c) => c.args)).toEqual([["tok"]]);
    await unmount();
  });

  it("never reports with preview", async () => {
    const fake = view();
    const { unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" preview />);
    expect(fake.of("viewed")).toHaveLength(0);
    await unmount();
  });

  it("not found → the plain sentence, and no view reported", async () => {
    const fake = view({ invoice: () => fail("not_found", "This invoice isn't available. It may have been replaced; contact the business.", { status: 404 }) });
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" />);
    expect(text(container)).toBe("This invoice isn't available. It may have been replaced; contact the business.");
    expect(fake.of("viewed")).toHaveLength(0);
    await unmount();
  });

  it("unavailable → the server's own message (a suspended business)", async () => {
    const fake = view({ invoice: () => fail("unavailable", "Green Acres isn't taking requests online right now. Call (801) 555-0100.", { status: 409 }) });
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" />);
    expect(text(container)).toBe("Green Acres isn't taking requests online right now. Call (801) 555-0100.");
    expect(button(container, "Try again")).toBeNull();
    await unmount();
  });

  it("a network failure offers Try again", async () => {
    let n = 0;
    const fake = view({ invoice: () => (++n === 1 ? fail("network", "Couldn't reach the server.") : ok(publicInvoice())) });
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" />);
    await click(button(container, "Try again"));
    expect(text(container)).toContain("Invoice INV-2026-0001");
    await unmount();
  });

  it("brands with the business's colour; accentColor overrides it; null turns it off", async () => {
    const own = await mount(<InvoiceView transport={view().transport} token="t" />);
    const root = own.container.querySelector<HTMLElement>(".aiiw-root")!;
    expect(root.hasAttribute("data-brand")).toBe(true);
    expect(root.getAttribute("style")).toContain("--aiiw-bl-accent: #1f7a3a");
    await own.unmount();
    const prop = await mount(<InvoiceView transport={view().transport} token="t" accentColor="#C2410C" />);
    expect(prop.container.querySelector<HTMLElement>(".aiiw-root")!.getAttribute("style")).toContain("--aiiw-bl-accent: #c2410c");
    await prop.unmount();
    const none = await mount(<InvoiceView transport={view().transport} token="t" accentColor={null} />);
    expect(none.container.querySelector<HTMLElement>(".aiiw-root")!.hasAttribute("data-brand")).toBe(false);
    await none.unmount();
  });

  it("lists payments in words", async () => {
    const fake = view({ invoice: () => ok(publicInvoice({ status: "partial", amountPaid: 10_000, balanceDue: 15_980, payments: [{ amount: 10_000, method: "check", paidAt: "2026-10-20T17:00:00.000Z" }] })) });
    const { container, unmount } = await mount(<InvoiceView transport={fake.transport} token="tok" />);
    expect(text(container)).toContain("Oct 20, 2026 · Check · $100.00");
    expect(text(container)).toContain("Partly paid · Due Nov 2, 2026");
    await unmount();
  });

  it("with neither transport nor baseUrl, says so instead of throwing", async () => {
    const { container, unmount } = await mount(<InvoiceView token="tok" />);
    expect(text(container)).toContain("This page isn't connected to an invoice server yet.");
    await unmount();
  });
});

describe("statusLine", () => {
  const inv = publicInvoice().invoice;
  it("says it in words", () => {
    expect(statusLine({ ...inv, status: "paid" }, FORMAT)).toBe("Paid");
    expect(statusLine({ ...inv, status: "overdue" }, FORMAT)).toBe("Overdue since Nov 2, 2026");
    expect(statusLine({ ...inv, status: "sent" }, FORMAT)).toBe("Due Nov 2, 2026");
    expect(statusLine({ ...inv, status: "void" }, FORMAT)).toBe("Void");
    expect(statusLine({ ...inv, status: "sent", dueDate: null }, FORMAT)).toBe("Due now");
  });
});

describe("server render", () => {
  it("renders loading on the server, no data-theme under auto", () => {
    const never = () => new Promise<never>(() => {});
    const fake = fakeTransport<InvoicePublicTransport>({ invoice: never, viewed: never });
    const html = renderToStaticMarkup(<InvoiceView transport={fake.transport} token="t" />);
    expect(html).toMatch(/^<div class="aiiw-root/);
    expect(html).not.toContain("data-theme");
    expect(html).toContain("Loading your invoice…");
  });
});

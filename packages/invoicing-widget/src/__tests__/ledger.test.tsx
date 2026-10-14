// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvoicingTransport } from "../admin/client.js";
import { InvoicesLedger } from "../admin/InvoicesLedger.js";
import * as shared from "../admin/shared.js";
import { parseDollars, parsePercent, percentText } from "../money.js";
import type { CreateInvoiceBody } from "../types.js";
import { FORMAT, response, statusWire, summary } from "./fixtures.js";
import { button, click, fail, fakeTransport, labelled, mount, ok, submit, text, type } from "./dom.js";

/**
 * <InvoicesLedger> (Tenancy 2a, 10.9): the list in words with filters and
 * Load more, the notices, and New invoice, which takes dollars and a percent,
 * sends cents and basis points, and refuses a non-number before sending.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function ledger(extra: Parameters<typeof fakeTransport<InvoicingTransport>>[0] = {}) {
  return fakeTransport<InvoicingTransport>({
    status: () => ok(statusWire()),
    list: () => ok({ invoices: [summary(), summary({ id: "inv-2", number: "INV-2026-0002", status: "overdue", customerName: "Lee" })], nextCursor: null, format: FORMAT }),
    ...extra,
  });
}

describe("money in and out", () => {
  it("dollars → cents, percent → basis points, Math.round", () => {
    expect(parseDollars("125")).toEqual({ ok: true, value: 12_500 });
    expect(parseDollars("$1,234.56")).toEqual({ ok: true, value: 123_456 });
    expect(parseDollars("0.335")).toEqual({ ok: true, value: 34 });
    expect(parseDollars("twelve").ok).toBe(false);
    expect(parseDollars("-5").ok).toBe(false);
    expect(parseDollars("").ok).toBe(false);
    expect(parseDollars("0", { allowZero: false }).ok).toBe(false);
    expect(parsePercent("8.25")).toEqual({ ok: true, value: 825 });
    expect(parsePercent("7.25%")).toEqual({ ok: true, value: 725 });
    expect(parsePercent("")).toEqual({ ok: true, value: 0 });
    expect(parsePercent("abc").ok).toBe(false);
    expect(percentText(825)).toBe("8.25%");
    expect(percentText(800)).toBe("8%");
  });
});

describe("<InvoicesLedger>", () => {
  it("lists invoices with status words, money and links from the pattern", async () => {
    const fake = ledger();
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} invoiceHref="/app/invoices/{id}" />);
    const table = container.querySelector("table")!;
    expect(text(table)).toContain("INV-2026-0001");
    expect(text(table)).toContain("Pat Customer");
    expect(text(table)).toContain("$270.63");
    expect(text(table)).toContain("Sent");
    expect(text(table)).toContain("Overdue");
    expect(container.querySelector('a[href="/app/invoices/inv-2"]')).not.toBeNull();
    await unmount();
  });

  it("filters in words, sent as the status key", async () => {
    const fake = ledger();
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} />);
    const chips = [...container.querySelectorAll(".aiiw-chip")].map((c) => text(c));
    expect(chips).toEqual(["All", "Draft", "Sent", "Viewed", "Partly paid", "Overdue", "Paid", "Void"]);
    await click(button(container, "Partly paid"));
    expect(fake.of("list").at(-1)!.args[0]).toEqual({ status: "partial" });
    expect(button(container, "Partly paid")!.getAttribute("aria-pressed")).toBe("true");
    await unmount();
  });

  it("Load more asks for the next page and appends it", async () => {
    let page = 0;
    const fake = ledger({
      list: (q?: { cursor?: string }) =>
        ++page === 1
          ? ok({ invoices: [summary()], nextCursor: "c1", format: FORMAT })
          : ok({ invoices: [summary({ id: "inv-9", number: "INV-2026-0009" })], nextCursor: null, format: FORMAT, ...(q ? {} : {}) }),
    });
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} />);
    await click(button(container, "Load more"));
    expect(fake.of("list")[1]!.args[0]).toEqual({ cursor: "c1" });
    expect(text(container.querySelector("table"))).toContain("INV-2026-0009");
    expect(button(container, "Load more")).toBeNull();
    await unmount();
  });

  it("says when invoice details are missing, linking to them, and when email is off", async () => {
    const fake = ledger({ status: () => ok(statusWire({ detailsComplete: false, emails: false, emailsOffReason: "This site doesn't email invoices yet." })) });
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} />);
    const details = container.querySelector('[data-aiiw-notice="details"] a')!;
    expect(text(details)).toBe("Add how customers pay you, so every invoice says it.");
    expect(details.getAttribute("href")).toBe("/settings/company#invoicing");
    expect(text(container.querySelector('[data-aiiw-notice="email"]'))).toBe("This site doesn't email invoices yet.");
    await unmount();
  });

  it("New invoice: dollars and a percent go out as cents and basis points, then the invoice opens", async () => {
    const go = vi.spyOn(shared, "navigate").mockImplementation(() => undefined);
    const fake = ledger({ create: () => ok(response({ id: "inv-new" })) });
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} invoiceHref="/app/invoices/{id}" />);
    await click(button(container, "New invoice"));
    const form = container.querySelector<HTMLElement>("[data-aiiw-new]")!;
    await type(labelled(form, "Customer name"), "Pat Customer");
    await type(labelled(form, "Customer email"), "pat@example.com");
    await type(labelled(form, "Description"), "Spring cleanup");
    await type(labelled(form, "Quantity"), "2");
    await type(labelled(form, "Price ($)"), "125.50");
    expect(text(form.querySelector("[data-aiiw-preview]"))).toBe("Subtotal before discount and tax: $251.00");
    await click(button(form, "+ Add line"));
    const lines = form.querySelectorAll<HTMLElement>("[data-aiiw-line]");
    await type(labelled(lines[1]!, "Description"), "Mulch");
    await type(labelled(lines[1]!, "Price ($)"), "40");
    await type(labelled(form, "Tax (%)"), "8.25");
    await type(labelled(form, "Discount ($)"), "10");
    await type(labelled(form, "Due date"), "2026-11-02");
    await submit(form.querySelector("form"));
    const body = fake.of("create")[0]!.args[0] as CreateInvoiceBody;
    expect(body).toEqual({
      customerName: "Pat Customer",
      customerEmail: "pat@example.com",
      taxRateBp: 825,
      discount: 1_000,
      dueDate: "2026-11-02",
      items: [
        { description: "Spring cleanup", quantity: 2, unitPrice: 12_550 },
        { description: "Mulch", quantity: 1, unitPrice: 4_000 },
      ],
    });
    expect(go).toHaveBeenCalledWith("/app/invoices/inv-new");
    await unmount();
  });

  it("a value that isn't a number is refused before anything is sent", async () => {
    const fake = ledger({ create: () => ok(response()) });
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} />);
    await click(button(container, "New invoice"));
    const form = container.querySelector<HTMLElement>("[data-aiiw-new]")!;
    await type(labelled(form, "Customer name"), "Pat");
    await type(labelled(form, "Description"), "Work");
    await type(labelled(form, "Price ($)"), "twelve");
    await type(labelled(form, "Tax (%)"), "lots");
    await submit(form.querySelector("form"));
    expect(fake.of("create")).toHaveLength(0);
    expect(labelled(form, "Price ($)")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(form)).toContain("Enter an amount in dollars, like 125 or 125.50.");
    expect(text(form)).toContain("Enter a percent, like 8.25.");
    await unmount();
  });

  it("puts the server's issues on their fields", async () => {
    const fake = ledger({
      create: () => fail("invalid", "Some details need another look.", { issues: [{ path: ["customerEmail"], message: "Enter an email address." }] }),
    });
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} />);
    await click(button(container, "New invoice"));
    const form = container.querySelector<HTMLElement>("[data-aiiw-new]")!;
    await type(labelled(form, "Customer name"), "Pat");
    await type(labelled(form, "Customer email"), "not-an-email");
    await type(labelled(form, "Description"), "Work");
    await type(labelled(form, "Price ($)"), "10");
    await submit(form.querySelector("form"));
    expect(labelled(form, "Customer email")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(form)).toContain("Enter an email address.");
    await unmount();
  });

  it("the server's refusal with no field shows its sentence", async () => {
    const fake = ledger({ create: () => fail("discount_exceeds_subtotal", "The discount is larger than the subtotal.", { status: 409 }) });
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} />);
    await click(button(container, "New invoice"));
    const form = container.querySelector<HTMLElement>("[data-aiiw-new]")!;
    await type(labelled(form, "Customer name"), "Pat");
    await type(labelled(form, "Description"), "Work");
    await type(labelled(form, "Price ($)"), "10");
    await submit(form.querySelector("form"));
    expect(text(form.querySelector('[role="alert"]'))).toBe("The discount is larger than the subtotal.");
    await unmount();
  });

  it("read-only (canManage={false}, a company's viewer): the invoices, and no New invoice", async () => {
    const fake = ledger();
    const { container, unmount } = await mount(<InvoicesLedger transport={fake.transport} invoiceHref="/app/invoices/{id}" canManage={false} />);
    expect(text(container.querySelector("table"))).toContain("INV-2026-0001");
    expect(container.querySelector('a[href="/app/invoices/inv-2"]')).not.toBeNull();
    expect(button(container, "New invoice")).toBeNull();
    await unmount();
    const empty = ledger({ list: () => ok({ invoices: [], nextCursor: null, format: FORMAT }) });
    const none = await mount(<InvoicesLedger transport={empty.transport} canManage={false} />);
    expect(text(none.container)).toContain("No invoices yet.");
    expect(text(none.container)).not.toContain("New invoice");
    await none.unmount();
  });

  it("renders on the server", () => {
    const never = () => new Promise<never>(() => {});
    const fake = fakeTransport<InvoicingTransport>({ status: never, list: never });
    const html = renderToStaticMarkup(<InvoicesLedger transport={fake.transport} />);
    expect(html).toMatch(/^<div class="aiiw-root aiiw-admin/);
    expect(html).toContain("Loading invoices…");
  });
});

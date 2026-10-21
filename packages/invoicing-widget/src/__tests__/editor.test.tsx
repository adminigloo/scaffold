// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { InvoicingTransport } from "../admin/client.js";
import { InvoiceEditor } from "../admin/InvoiceEditor.js";
import { paymentWords } from "../money.js";
import { detail, FORMAT, response } from "./fixtures.js";
import { button, click, fail, fakeTransport, labelled, mount, ok, submit, text, type } from "./dom.js";

/**
 * <InvoiceEditor> (Tenancy 2a, 10.9): lines while they can change, Send and
 * its outcomes, Copy link and Preview, status moves in words (Void confirms),
 * payments and reversals with a required reason, overpaid. Every write
 * disables only its control, is announced, shows the server's sentence when
 * refused, and re-renders from the answer.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function editor(extra: Parameters<typeof fakeTransport<InvoicingTransport>>[0] = {}, initial = response()) {
  return fakeTransport<InvoicingTransport>({ get: () => ok(initial), ...extra });
}

const announced = (container: HTMLElement) => text(container.querySelector("[data-aiiw-announce]"));

describe("<InvoiceEditor>", () => {
  it("shows the invoice: number, status in words, lines and totals", async () => {
    const fake = editor();
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" backHref="/app/invoices" />);
    expect(text(container)).toContain("Invoice INV-2026-0001");
    expect(text(container.querySelector("[data-aiiw-status]"))).toBe("Draft");
    expect(container.querySelector('a[href="/app/invoices"]')).not.toBeNull();
    expect(text(container.querySelector("[data-aiiw-totals]"))).toContain("Tax (8.25%)$20.63");
    expect(fake.of("get")[0]!.args).toEqual(["inv-1"]);
    await unmount();
  });

  it("Send: the answer's sentence is shown and announced, and the invoice re-renders", async () => {
    const fake = editor({ send: () => ok({ ...response({ status: "sent", storedStatus: "sent", nextStatuses: ["viewed", "void"] }), delivery: "sent", message: "Emailed to pat@example.com." }) });
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    await click(button(container, "Send to pat@example.com"));
    expect(text(container.querySelector("[data-aiiw-send-outcome]"))).toBe("Emailed to pat@example.com.");
    expect(announced(container)).toBe("Emailed to pat@example.com.");
    expect(text(container.querySelector("[data-aiiw-status]"))).toBe("Sent");
    await unmount();
  });

  it("no customer email: the button says Mark as sent", async () => {
    const fake = editor({}, response({ customerEmail: null }));
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    expect(button(container, "Mark as sent")).not.toBeNull();
    await unmount();
  });

  it("a refusal shows the server's sentence beside the control", async () => {
    const fake = editor({ send: () => fail("invoice_has_no_lines", "This invoice has no lines — add one before sending it.", { status: 409 }) });
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    await click(button(container, "Send to pat@example.com"));
    expect(text(container.querySelector('[data-aiiw-refusal="send"]'))).toBe("This invoice has no lines — add one before sending it.");
    await unmount();
  });

  it("Copy link: copies the url and offers Preview in a new tab", async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (s: string) => void copied.push(s) }, configurable: true });
    const fake = editor({ link: () => ok({ url: "https://app.test/t/green/invoice/tok", previewUrl: "https://app.test/t/green/invoice/tok?preview=1" }) });
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    await click(button(container, "Copy link"));
    expect(copied).toEqual(["https://app.test/t/green/invoice/tok"]);
    const preview = [...container.querySelectorAll("a")].find((a) => text(a) === "Preview")!;
    expect(preview.getAttribute("href")).toBe("https://app.test/t/green/invoice/tok?preview=1");
    expect(preview.getAttribute("target")).toBe("_blank");
    expect(announced(container)).toBe("Link copied.");
    await unmount();
  });

  it("lines: add, change (with the sent-invoice note), remove", async () => {
    const sent = response({ status: "sent", storedStatus: "sent", nextStatuses: ["viewed", "void"] });
    const fake = editor(
      {
        addItem: () => ok(response({ subtotal: 29_000 })),
        updateItem: () => ok(response()),
        removeItem: () => ok(response({ lines: [] })),
      },
      sent,
    );
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    expect(text(container.querySelector("[data-aiiw-replace-note]"))).toBe(
      "On a sent invoice, a change replaces the line; the customer's page shows the new one.",
    );
    await click(button(container, "+ Add line"));
    const form = container.querySelector<HTMLElement>("[data-aiiw-line-form]")!;
    await type(labelled(form, "Description"), "Mulch");
    await type(labelled(form, "Quantity"), "1");
    await type(labelled(form, "Price ($)"), "40");
    await submit(form);
    expect(fake.of("addItem")[0]!.args).toEqual(["inv-1", { description: "Mulch", quantity: 1, unitPrice: 4_000 }]);
    expect(announced(container)).toBe("Line added.");
    await click(button(container, "Change Spring cleanup"));
    const edit = container.querySelector<HTMLElement>("[data-aiiw-line-form]")!;
    expect((labelled(edit, "Price ($)") as HTMLInputElement).value).toBe("125.00");
    await type(labelled(edit, "Quantity"), "3");
    await submit(edit);
    expect(fake.of("updateItem")[0]!.args).toEqual(["line-1", { description: "Spring cleanup", quantity: 3, unitPrice: 12_500 }]);
    await click(button(container, "Remove Spring cleanup"));
    expect(fake.of("removeItem")[0]!.args).toEqual(["line-1"]);
    await unmount();
  });

  it("a paid invoice offers no line edits, no send", async () => {
    const fake = editor({}, response({ status: "paid", storedStatus: "paid", editable: false, nextStatuses: [], amountPaid: 27_063, balanceDue: 0 }));
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    expect(button(container, "+ Add line")).toBeNull();
    expect(button(container, "Send to pat@example.com")).toBeNull();
    expect(button(container, "Change Spring cleanup")).toBeNull();
    await unmount();
  });

  it("Move to in words; Void confirms first", async () => {
    const fake = editor({
      setStatus: (_id: string, body: { status: "draft" | "sent" | "viewed" | "void" }) =>
        ok(response({ status: body.status, storedStatus: body.status, nextStatuses: [] })),
    });
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    expect(button(container, "Mark as sent")).not.toBeNull();
    await click(button(container, "Void"));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(text(dialog)).toContain("Void invoice INV-2026-0001? It stays in your records and can't be changed after.");
    await click(button(dialog, "Keep it"));
    expect(fake.of("setStatus")).toHaveLength(0);
    await click(button(container, "Void"));
    await click(button(container.querySelector('[role="dialog"]')!, "Void invoice"));
    expect(fake.of("setStatus")[0]!.args).toEqual(["inv-1", { status: "void" }]);
    expect(text(container.querySelector("[data-aiiw-status]"))).toBe("Void");
    await unmount();
  });

  it("records a payment in dollars, then shows overpaid", async () => {
    const sent = response({ status: "sent", storedStatus: "sent", nextStatuses: ["viewed", "void"] });
    const fake = editor(
      {
        recordPayment: () =>
          ok(
            response({
              status: "paid",
              storedStatus: "paid",
              amountPaid: 30_000,
              balanceDue: 0,
              overpaid: 2_937,
              payments: [{ id: "p1", amount: 30_000, method: "check", reference: "1043", paidAt: "2026-10-20T17:00:00.000Z", reversesPaymentId: null, reversed: false, reason: null, flag: null, reversedAmount: 0 }],
            }),
          ),
      },
      sent,
    );
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    const form = container.querySelector<HTMLElement>("[data-aiiw-pay-form]")!;
    await type(labelled(form, "Amount ($)"), "300");
    await type(labelled(form, "Check number or note"), "1043");
    await submit(form);
    expect(fake.of("recordPayment")[0]!.args).toEqual(["inv-1", { amount: 30_000, method: "check", reference: "1043" }]);
    expect(text(container.querySelector("[data-aiiw-overpaid]"))).toBe("$29.37 overpaid: refund or credit it.");
    expect(text(container)).toContain("$300.00 · Check · 1043");
    await unmount();
  });

  it("an amount that isn't a number is refused before sending", async () => {
    const fake = editor({}, response({ status: "sent", storedStatus: "sent" }));
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    const form = container.querySelector<HTMLElement>("[data-aiiw-pay-form]")!;
    await type(labelled(form, "Amount ($)"), "abc");
    await submit(form);
    expect(fake.of("recordPayment")).toHaveLength(0);
    expect(labelled(form, "Amount ($)")!.getAttribute("aria-invalid")).toBe("true");
    await unmount();
  });

  it("reversing needs a reason", async () => {
    const paid = response({
      status: "paid",
      storedStatus: "paid",
      editable: false,
      nextStatuses: [],
      payments: [{ id: "p1", amount: 27_063, method: "card", reference: null, paidAt: "2026-10-20T17:00:00.000Z", reversesPaymentId: null, reversed: false, reason: null, flag: null, reversedAmount: 0 }],
    });
    const fake = editor({ reversePayment: () => ok(response({ status: "sent", storedStatus: "sent" })) }, paid);
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    await click(button(container, "Reverse"));
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
    await submit(dialog.querySelector("form"));
    expect(fake.of("reversePayment")).toHaveLength(0);
    expect(text(dialog)).toContain("Say why this payment is being reversed.");
    await type(labelled(dialog, "Why"), "Card charged twice");
    await submit(dialog.querySelector("form"));
    expect(fake.of("reversePayment")[0]!.args).toEqual(["p1", { reason: "Card charged twice" }]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(announced(container)).toBe("Payment reversed.");
    await unmount();
  });

  it("a person without the keys sees the invoice and no controls", async () => {
    const fake = editor({}, response({ can: { manage: false, record: false, reverse: false } }));
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    expect(button(container, "Copy link")).toBeNull();
    expect(button(container, "Send to pat@example.com")).toBeNull();
    expect(button(container, "+ Add line")).toBeNull();
    expect(container.querySelector("[data-aiiw-pay-form]")).toBeNull();
    await unmount();
  });

  it("not found says so", async () => {
    const fake = editor({ get: () => fail("not_found", "That invoice isn't here.", { status: 404 }) });
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="nope" />);
    expect(text(container)).toContain("That invoice isn't here.");
    await unmount();
  });

  it("renders on the server", () => {
    const fake = fakeTransport<InvoicingTransport>({ get: () => new Promise<never>(() => {}) });
    const html = renderToStaticMarkup(<InvoiceEditor transport={fake.transport} invoiceId="x" />);
    expect(html).toContain("Loading the invoice…");
    void detail;
    void FORMAT;
  });
});

describe("<InvoiceEditor> payments after a card refund (0.2)", () => {
  it("shows a part refund as 'Partly refunded $X', and only all of it as 'Reversed'", async () => {
    const pay = (reversedAmount: number, reversed: boolean) =>
      response({
        payments: [{ id: "p1", amount: 30_000, method: "card", reference: "Paid online", paidAt: "2026-10-20T17:00:00.000Z", reversesPaymentId: null, reversed, reason: null, flag: null, reversedAmount }],
      });
    const part = fakeTransport<InvoicingTransport>({ get: () => ok(pay(10_000, false)), status: () => ok({ emails: true, emailsOffReason: null, detailsComplete: true, detailsHref: null, format: FORMAT }) });
    const a = await mount(<InvoiceEditor transport={part.transport} invoiceId="inv-1" />);
    expect(text(a.container)).toContain("Partly refunded $100.00");
    expect(text(a.container.querySelector("[data-aiiw-payment]"))).not.toContain("Reversed");
    await a.unmount();
    const whole = fakeTransport<InvoicingTransport>({ get: () => ok(pay(30_000, true)), status: () => ok({ emails: true, emailsOffReason: null, detailsComplete: true, detailsHref: null, format: FORMAT }) });
    const b = await mount(<InvoiceEditor transport={whole.transport} invoiceId="inv-1" />);
    expect(text(b.container.querySelector("[data-aiiw-payment]"))).toContain("Reversed");
    expect(text(b.container)).not.toContain("Partly refunded");
    await b.unmount();
  });
});

describe("a payment's line names its method once (polish 3)", () => {
  it("a note that starts with the method reads alone; any other note follows the method", () => {
    expect(paymentWords("check", "Check #1042")).toBe("Check #1042");
    expect(paymentWords("check", "check 1042")).toBe("check 1042");
    expect(paymentWords("check", "Cheque 88")).toBe("Cheque 88");
    expect(paymentWords("check", "1043")).toBe("Check · 1043");
    expect(paymentWords("check", "Checked by Sam")).toBe("Check · Checked by Sam");
    expect(paymentWords("ach", "ACH from Chase")).toBe("ACH from Chase");
    expect(paymentWords("ach", "Bank transfer, ref 77")).toBe("Bank transfer, ref 77");
    expect(paymentWords("cash", "Paid at the door")).toBe("Cash · Paid at the door");
    expect(paymentWords("card", "Paid online")).toBe("Card · Paid online");
    expect(paymentWords("card", null)).toBe("Card");
    expect(paymentWords("cash", "   ")).toBe("Cash");
  });

  it("on the invoice: $810.81 · Check #1042, not Check · Check #1042", async () => {
    const fake = editor(
      {},
      response({
        status: "paid",
        storedStatus: "paid",
        amountPaid: 81_081,
        balanceDue: 0,
        payments: [{ id: "p1", amount: 81_081, method: "check", reference: "Check #1042", paidAt: "2026-10-20T17:00:00.000Z", reversesPaymentId: null, reversed: false, reason: null, flag: null, reversedAmount: 0 }],
      }),
    );
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    const line = text(container.querySelector("[data-aiiw-payment='p1']"));
    expect(line).toContain("$810.81 · Check #1042");
    expect(line).not.toContain("Check · Check");
    await unmount();
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import type { InvoicingTransport } from "../admin/client.js";
import { InvoiceEditor } from "../admin/InvoiceEditor.js";
import { parseInvoiceResponse } from "../parse.js";
import { response } from "./fixtures.js";
import { fakeTransport, mount, ok, text } from "./dom.js";

/**
 * invoicing 0.7, past records: an invoice or a payment typed in later from
 * the business's records says so on the invoice ("Entered from past records
 * on …"), the way an estimate's timeline does. Review: only created_at and
 * recorded_by knew.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const PAYMENT = { id: "p1", amount: 30_000, method: "check" as const, reference: "1043", paidAt: "2025-04-20T12:00:00.000Z", reversesPaymentId: null, reversed: false, reason: null, flag: null, reversedAmount: 0 };

describe("entered from past records", () => {
  it("the invoice and the payment each say they were entered later", async () => {
    const initial = response({
      status: "paid",
      storedStatus: "paid",
      enteredLater: { at: "2026-10-20T15:00:00.000Z", by: "u-sam" },
      payments: [{ ...PAYMENT, enteredLater: { at: "2026-10-20T15:00:00.000Z", by: "u-sam" } }],
    });
    const fake = fakeTransport<InvoicingTransport>({ get: () => ok(initial) });
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    const marks = [...container.querySelectorAll("[data-aiiw-entered-later]")].map((el) => text(el));
    expect(marks).toHaveLength(2);
    for (const mark of marks) expect(mark).toMatch(/^Entered from past records on Oct 20, 2026$/);
    await unmount();
  });

  it("NEGATIVE CONTROL: an invoice and a payment made the day they happened say nothing of it", async () => {
    const fake = fakeTransport<InvoicingTransport>({ get: () => ok(response({ payments: [PAYMENT] })) });
    const { container, unmount } = await mount(<InvoiceEditor transport={fake.transport} invoiceId="inv-1" />);
    expect(container.querySelector("[data-aiiw-payment]")).not.toBeNull();
    expect(container.querySelector("[data-aiiw-entered-later]")).toBeNull();
    await unmount();
  });

  it("the parser keeps enteredLater and drops a malformed one", () => {
    const wire = response({ enteredLater: { at: "2026-10-20T15:00:00.000Z", by: "u-sam" }, payments: [{ ...PAYMENT, enteredLater: { at: "not a date", by: null } }] });
    const parsed = parseInvoiceResponse(JSON.parse(JSON.stringify(wire)))!;
    expect(parsed.invoice.enteredLater).toEqual({ at: "2026-10-20T15:00:00.000Z", by: "u-sam" });
    expect(parsed.invoice.payments[0]!.enteredLater).toBeNull();
  });
});

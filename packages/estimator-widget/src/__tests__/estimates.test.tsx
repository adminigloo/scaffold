// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EstimateEditor } from "../admin/EstimateEditor.js";
import { EstimatesQueue } from "../admin/EstimatesQueue.js";
import type { EstimateDetail, EstimateListResponse, EstimateListRow } from "../admin/types.js";
import {
  blur,
  button,
  checkbox,
  click,
  estimate,
  fail,
  fakeAdmin,
  key,
  labelled,
  line,
  mount,
  ok,
  pass,
  photoFile,
  pickFile,
  settingsWire,
  submit,
  text,
  type,
} from "./fakes.js";

/**
 * The office's side of a lead (contract 9.7): find it in the queue, open it,
 * see the photo and what the AI counted beside what the customer said, fix a
 * line, send the quote — and the screen always shows what the server saved.
 */

vi.mock("../photo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../photo.js")>();
  return { ...original, resizePhoto: vi.fn(async () => ({ blob: new Blob(["x"]), base64: "U1RBRkY=", width: 768, height: 512, mediaType: "image/jpeg" as const })) };
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function row(extra: Partial<EstimateListRow> = {}): EstimateListRow {
  return {
    id: "est_1",
    number: "EST-0001",
    status: "draft",
    source: "photo",
    customerName: "Pat Lee",
    customerEmail: "pat@example.com",
    jobAddress: "12 Elm St",
    total: 1_070_179,
    rangeLow: 860_265,
    rangeHigh: 1_045_807,
    currency: "USD",
    photoCount: 1,
    hasReading: true,
    validUntil: null,
    archivedAt: null,
    createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

const COUNTS = { leads: 1, drafts: 0, sent: 2, accepted: 0, declined: 0, expired: 0, converted: 0, all: 3, archived: 0 };

function list(rows: EstimateListRow[], nextCursor: string | null = null): EstimateListResponse {
  return { estimates: rows, nextCursor, counts: COUNTS };
}

describe("<EstimatesQueue>", () => {
  it("opens on Leads with a count on every filter; a lead shows its range, where it came from, the photo and 'AI read'", async () => {
    const onOpen = vi.fn();
    const fake = fakeAdmin({ listEstimates: () => ok(list([row()])) });
    const { container, unmount } = await mount(<EstimatesQueue transport={fake.transport} onOpen={onOpen} />);
    expect(fake.of("listEstimates")[0]!.args[0]).toEqual({ filter: "leads" });
    const filters = [...container.querySelectorAll("[data-aiew-filters] button")].map((b) => text(b));
    expect(filters).toEqual(["Leads1", "Drafts0", "Sent2", "Accepted0", "Declined0", "Expired0", "Invoiced0", "All3", "Archived0"]);
    expect(container.querySelector('[data-filter="leads"]')!.getAttribute("aria-pressed")).toBe("true");
    const r = container.querySelector('[data-aiew-row="est_1"]')!;
    expect(text(r)).toContain("Pat Lee");
    expect(text(r)).toContain("EST-0001");
    // A lead is still a range: whole dollars, as the customer saw it.
    expect(text(r)).toContain("$8,603 – $10,458");
    expect(text(r)).toContain("New lead");
    expect(text(r)).toContain("Photo estimate");
    expect(text(r)).toContain("AI read");
    expect(text(r)).toContain("2 h ago");
    expect(text(r)).toContain("1 photo");
    await click(r);
    expect(onOpen).toHaveBeenCalledWith("est_1");
    await unmount();
  });

  it("searches 300 ms after typing stops, filters, and says so when a filter is empty", async () => {
    const fake = fakeAdmin({ listEstimates: (q) => ok(list(q?.filter === "accepted" ? [] : [row()])) });
    const { container, unmount } = await mount(<EstimatesQueue transport={fake.transport} />);
    await type(container.querySelector('input[type="search"]'), "Pat");
    expect(fake.of("listEstimates")).toHaveLength(1);
    await pass(350);
    expect(fake.of("listEstimates").at(-1)!.args[0]).toEqual({ filter: "leads", q: "Pat" });
    await type(container.querySelector('input[type="search"]'), "");
    await pass(350);
    await click(container.querySelector('[data-filter="accepted"]'));
    expect(fake.of("listEstimates").at(-1)!.args[0]).toEqual({ filter: "accepted" });
    expect(text(container.querySelector("[data-aiew-empty]"))).toBe("No accepted quotes yet.");
    await unmount();
  });

  it("'Load more' asks for the next page and adds it", async () => {
    const fake = fakeAdmin({
      listEstimates: (q) => ok(q?.cursor ? list([row({ id: "est_2", number: "EST-0002", customerName: "Sam Ortiz" })]) : list([row()], "cur_2")),
    });
    const { container, unmount } = await mount(<EstimatesQueue transport={fake.transport} />);
    await click(button(container, "Load more"));
    expect(fake.of("listEstimates").at(-1)!.args[0]).toEqual({ filter: "leads", cursor: "cur_2" });
    expect(container.querySelectorAll("[data-aiew-row]")).toHaveLength(2);
    expect(button(container, "Load more")).toBeNull();
    await unmount();
  });

  it("'New estimate' starts a blank draft and opens it", async () => {
    const onOpen = vi.fn();
    const fake = fakeAdmin({
      listEstimates: () => ok(list([])),
      createEstimate: () => ok({ estimate: estimate({ id: "est_new", source: "staff", lines: [] }), warnings: [] }),
    });
    const { container, unmount } = await mount(<EstimatesQueue transport={fake.transport} onOpen={onOpen} />);
    expect(text(container)).toContain("No leads yet. Share your estimate page to get some.");
    await click(button(container, "New estimate"));
    expect(fake.of("createEstimate")[0]!.args[0]).toEqual({});
    expect(onOpen).toHaveBeenCalledWith("est_new");
    await unmount();
  });

  it("with estimateHref, rows are links; sent quotes say how long they're good for", async () => {
    const fake = fakeAdmin({ listEstimates: () => ok(list([row({ status: "sent", validUntil: "2026-12-02T15:00:00.000Z", rangeLow: 1_070_179, rangeHigh: 1_070_179 })])) });
    const { container, unmount } = await mount(<EstimatesQueue transport={fake.transport} estimateHref={(id) => `/admin/estimates/${id}`} />);
    const link = container.querySelector<HTMLAnchorElement>('a[data-aiew-row="est_1"]')!;
    expect(link.getAttribute("href")).toBe("/admin/estimates/est_1");
    expect(text(link)).toContain("Good until December 2, 2026");
    expect(text(link)).toContain("Sent");
    expect(text(link)).toContain("$10,701.79");
    await unmount();
  });

  it("a refusal is shown in the server's words", async () => {
    const fake = fakeAdmin({ listEstimates: () => fail("forbidden", "You don't have permission to do that.") });
    const { container, unmount } = await mount(<EstimatesQueue transport={fake.transport} />);
    expect(text(container)).toContain("You don't have permission to do that.");
    await unmount();
  });
});

describe("<EstimateEditor>", () => {
  const RAMP_PRODUCT = async () => (await import("./fakes.js")).adminRamp();

  it("shows who, where it came from, the photo, the AI's reading beside what the customer changed, and the line's working", async () => {
    const product = await RAMP_PRODUCT();
    const fake = fakeAdmin({ getEstimate: () => ok({ estimate: estimate() }), getProduct: () => ok({ product }) });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    expect(text(container)).toContain("Pat Lee · EST-0001");
    expect(text(container.querySelector("[data-aiew-status-tag]"))).toBe("New lead");
    expect(text(container)).toContain("Photo estimate");
    expect(text(container)).toContain("What they wrote");
    expect(text(container)).toContain("Back door, please.");
    // The reading and the correction.
    const reading = container.querySelector("[data-aiew-line-reading]")!;
    expect(text(reading)).toContain("We counted 3 steps up, including the last one onto the porch or landing.");
    expect(text(reading)).toContain("medium confidence");
    expect(text(reading.querySelector("[data-aiew-corrections]"))).toBe("The customer changed: steps 3 → 4");
    expect(reading.querySelector("img")!.getAttribute("src")).toBe("https://files.test/porch.jpg");
    // The working the customer saw, and the range they were shown.
    expect(text(container)).toContain("4 steps × 7.5–8.5 in each (from your photo) = 30–34 in rise");
    expect(text(container.querySelector("[data-aiew-shown]"))).toContain("Customer was shown $8,602.65 – $10,458.07: Step height 7.5–8.5 in (from the photo)");
    expect(text(container.querySelector("[data-aiew-line-cost]"))).toBe("Cost $7,127.40");
    expect(text(container.querySelector("[data-aiew-cost]"))).toBe("Cost $7,127.40 · Margin 28.57%");
    // The line asks the product's own questions, filled with the customer's answers.
    expect((labelled(container.querySelector("[data-aiew-line-fields]")!, "How many steps go up to the door?") as HTMLInputElement).value).toBe("4");
    // Only the actions the server offers.
    const actions = [...container.querySelectorAll("[data-aiew-actions] [data-action]")].map((b) => b.getAttribute("data-action"));
    expect(actions).toEqual(["send", "duplicate", "archive"]);
    await unmount();
  });

  it("editing a line's steps saves it and the totals come back from the server", async () => {
    const product = await RAMP_PRODUCT();
    const repriced = estimate({ lines: [line({ inputs: { steps: 5 }, total: 1_100_000 })], subtotal: 1_100_000, taxAmount: 79_750, total: 1_179_750 });
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate() }),
      getProduct: () => ok({ product }),
      updateLine: () => ok({ estimate: repriced, warnings: [] }),
    });
    const onChange = vi.fn();
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" onChange={onChange} />);
    await click(button(container.querySelector("[data-aiew-line-fields]") as HTMLElement, "One more: How many steps"));
    expect(fake.of("updateLine")).toHaveLength(0);
    await pass(550);
    expect(fake.of("updateLine")[0]!.args).toEqual(["est_1", "li_1", { inputs: { steps: 5 } }]);
    expect(text(container.querySelector("[data-aiew-total]"))).toBe("$11,797.50");
    expect(text(container.querySelector("[data-aiew-line-total]"))).toBe("$11,000.00");
    expect(onChange).toHaveBeenCalledWith(repriced);
    await unmount();
  });

  it("'Set the price myself' saves the typed price; unticking goes back to the price book", async () => {
    const product = await RAMP_PRODUCT();
    let overridden = false;
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate() }),
      getProduct: () => ok({ product }),
      updateLine: (_e, _l, patch) => {
        overridden = patch.unitPrice !== null;
        return ok({ estimate: estimate({ lines: [line({ priceOverridden: overridden, unitPrice: overridden ? 900_000 : 997_836 })] }), warnings: [] });
      },
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    await click(checkbox(container, "Set the price myself"));
    const price = labelled(container, "Price each") as HTMLInputElement;
    await type(price, "9000.00");
    await blur(price);
    expect(fake.of("updateLine")[0]!.args).toEqual(["est_1", "li_1", { unitPrice: 900_000 }]);
    await click(checkbox(container, "Set the price myself"));
    expect(fake.of("updateLine")[1]!.args).toEqual(["est_1", "li_1", { unitPrice: null }]);
    await unmount();
  });

  it("'Send quote' is disabled with the reason when there's no email", async () => {
    const fake = fakeAdmin({ getEstimate: () => ok({ estimate: estimate({ customerEmail: null }) }), getProduct: () => fail("not_found") });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    const send = container.querySelector<HTMLButtonElement>('[data-action="send"]')!;
    expect(send.disabled).toBe(true);
    expect(text(document.getElementById(send.getAttribute("aria-describedby")!))).toBe("Add the customer's email address to send the quote.");
    await unmount();
  });

  it("sending: what the customer gets, 'Send to …', then the quote's own actions and the server's warnings", async () => {
    const sent = estimate({
      status: "sent",
      sentAt: "2026-11-02T16:00:00.000Z",
      validUntil: "2026-12-02T16:00:00.000Z",
      actions: ["resend", "revise", "mark_accepted", "mark_declined", "copy_link", "duplicate", "archive"],
    });
    const fake = fakeAdmin({
      getSettings: () => ok({ settings: settingsWire({ quoteValidDays: 21 }) }),
      getEstimate: () => ok({ estimate: estimate() }),
      getProduct: () => fail("not_found"),
      sendQuote: () => ok({ estimate: sent, warnings: ["Line 1 is still a range (Step height 7.5–8.5 in (from the photo)); the quote uses 4 steps."] }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    await click(container.querySelector('[data-action="send"]'));
    const dialog = container.querySelector("[data-aiew-send]")!;
    expect((labelled(dialog, "Good for (days)") as HTMLInputElement).value).toBe("21");
    expect(text(dialog.querySelector("[data-aiew-send-summary]"))).toContain("1 line, $10,701.79 with tax, good for 21 days");
    await type(labelled(dialog, "A message at the top"), "Thanks for having us out.");
    await submit(dialog.querySelector("form"));
    expect(fake.of("sendQuote")[0]!.args).toEqual(["est_1", { validDays: 21, message: "Thanks for having us out." }]);
    expect(container.querySelector("[data-aiew-send]")).toBeNull();
    const actions = [...container.querySelectorAll("[data-aiew-actions] [data-action]")].map((b) => b.getAttribute("data-action"));
    expect(actions).toEqual(["resend", "mark_accepted", "mark_declined", "revise", "copy_link", "duplicate", "archive"]);
    expect(text(container.querySelector('[data-aiew-notice="warnings"]'))).toContain("Line 1 is still a range");
    expect(text(container)).toContain("This quote has been sent. Revise it to make changes.");
    expect((labelled(container, "Name") as HTMLInputElement).disabled).toBe(true);
    await unmount();
  });

  it("'Copy quote link' asks for a fresh link, copies it and shows it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate({ status: "sent", actions: ["resend", "copy_link"] }) }),
      getProduct: () => fail("not_found"),
      quoteLink: () => ok({ url: "https://summitramps.test/quote/tok_abc" }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    await click(container.querySelector('[data-action="copy_link"]'));
    expect(fake.of("quoteLink")[0]!.args).toEqual(["est_1"]);
    expect(writeText).toHaveBeenCalledWith("https://summitramps.test/quote/tok_abc");
    expect((container.querySelector("[data-aiew-copy] input") as HTMLInputElement).value).toBe("https://summitramps.test/quote/tok_abc");
    expect(text(container)).toContain("Quote link copied.");
    await unmount();
  });

  it("an accepted quote offers the invoice and the visit; 'Make an invoice' confirms, then lists the invoice", async () => {
    const accepted = estimate({
      status: "approved",
      actions: ["convert", "book_visit", "copy_link", "duplicate", "archive"],
      links: { bookVisitUrl: "https://summitramps.test/book-visit?estimate=est_1", visits: [], invoice: null },
    });
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: accepted }),
      getProduct: () => fail("not_found"),
      convert: () => ok({ invoice: { id: "inv_1", number: "INV-0001", status: "draft", url: "/admin/invoices/inv_1" }, estimate: { ...accepted, status: "converted", actions: ["duplicate", "archive"] } }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    const book = container.querySelector<HTMLAnchorElement>('[data-action="book_visit"]')!;
    expect(book.getAttribute("href")).toBe("https://summitramps.test/book-visit?estimate=est_1");
    expect(book.getAttribute("target")).toBe("_blank");
    await click(container.querySelector('[data-action="convert"]'));
    expect(fake.of("convert")).toHaveLength(0);
    await click(button(container, "Make the invoice"));
    expect(fake.of("convert")[0]!.args).toEqual(["est_1"]);
    expect(text(container.querySelector("[data-aiew-invoice]"))).toContain("INV-0001");
    expect(container.querySelector('[data-action="convert"]')).toBeNull();
    await unmount();
  });

  it("'Customer said yes' records a note and, if asked, emails them", async () => {
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate({ status: "viewed", actions: ["mark_accepted", "mark_declined"] }) }),
      getProduct: () => fail("not_found"),
      setStatus: () => ok({ estimate: estimate({ status: "approved", actions: [] }), warnings: [] }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    await click(container.querySelector('[data-action="mark_accepted"]'));
    const dialog = container.querySelector('[role="dialog"]')!;
    await type(labelled(dialog, "Note"), "Said yes on the phone");
    await click(checkbox(dialog, "Email the customer"));
    await submit(dialog.querySelector("form"));
    expect(fake.of("setStatus")[0]!.args).toEqual(["est_1", { status: "approved", note: "Said yes on the phone", notify: true }]);
    await unmount();
  });

  it("the office's notes save on leaving the field, even on a sent quote", async () => {
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate({ status: "sent", actions: ["resend"] }) }),
      getProduct: () => fail("not_found"),
      updateEstimate: () => ok({ estimate: estimate({ status: "sent", actions: ["resend"], internalNotes: "Call before noon" }), warnings: [] }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    const notes = labelled(container, "Notes for the office") as HTMLTextAreaElement;
    expect(notes.disabled).toBe(false);
    await type(notes, "Call before noon");
    await act(async () => {
      notes.dispatchEvent(new FocusEvent("blur"));
      notes.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await pass(10);
    expect(fake.of("updateEstimate")[0]!.args).toEqual(["est_1", { internalNotes: "Call before noon" }]);
    await unmount();
  });

  it("'A line of my own' adds a description, a quantity and a price", async () => {
    const fake = fakeAdmin({
      getEstimate: () => ok({ estimate: estimate() }),
      getProduct: () => fail("not_found"),
      addLine: () => ok({ estimate: estimate(), warnings: [] }),
    });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    await click(button(container, "A line of my own"));
    const form = container.querySelector('[data-aiew-add-line="own"]')!;
    await type(labelled(form, "Description"), "Remove old wooden steps");
    await type(labelled(form, "Price each"), "150");
    await submit(form);
    expect(fake.of("addLine")[0]!.args).toEqual(["est_1", { description: "Remove old wooden steps", quantity: 1, unitPrice: 15_000 }]);
    await unmount();
  });

  it("photos open large; the arrows move between them; staff can add one, shrunk first", async () => {
    const two: EstimateDetail = estimate({
      photos: [
        { id: "ph_1", url: "https://files.test/1.jpg", width: 768, height: 576, source: "public", takeoffId: "tk_porch", createdAt: "2026-11-02T15:00:00.000Z" },
        { id: "ph_2", url: "https://files.test/2.jpg", width: 768, height: 576, source: "public", takeoffId: null, createdAt: "2026-11-02T15:00:00.000Z" },
      ],
    });
    const fake = fakeAdmin({ getEstimate: () => ok({ estimate: two }), getProduct: () => fail("not_found"), addPhoto: () => ok({ estimate: two, warnings: [] }) });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    await click(container.querySelector('[data-aiew-photo="ph_1"]'));
    expect(container.querySelector('[data-aiew-lightbox="ph_1"]')).not.toBeNull();
    await key(document.body, "ArrowRight");
    expect(container.querySelector('[data-aiew-lightbox="ph_2"]')).not.toBeNull();
    await key(document.body, "Escape");
    expect(container.querySelector("[data-aiew-lightbox]")).toBeNull();
    await pickFile(container.querySelector('[data-aiew-panel="photos"]')!, photoFile());
    expect(fake.of("addPhoto")[0]!.args).toEqual(["est_1", { imageBase64: "U1RBRkY=", mediaType: "image/jpeg" }]);
    await unmount();
  });

  it("without access to costs, no cost or margin appears", async () => {
    const fake = fakeAdmin({ getEstimate: () => ok({ estimate: estimate({ cost: null, marginBp: null, lines: [line({ cost: null })] }) }), getProduct: () => fail("not_found") });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" />);
    expect(container.querySelector("[data-aiew-cost]")).toBeNull();
    expect(container.querySelector("[data-aiew-line-cost]")).toBeNull();
    await unmount();
  });

  it("a refusal to open it is shown in the server's words", async () => {
    const fake = fakeAdmin({ getEstimate: () => fail("forbidden", "You don't have permission to do that.") });
    const { container, unmount } = await mount(<EstimateEditor transport={fake.transport} estimateId="est_1" onBack={() => {}} />);
    expect(text(container)).toContain("You don't have permission to do that.");
    expect(button(container, "Back to estimates")).not.toBeNull();
    await unmount();
  });
});

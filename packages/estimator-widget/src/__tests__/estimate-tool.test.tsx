// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EstimateTool } from "../EstimateTool.js";
import type { CalculateBody, CalculateResponse, PublicConfig, SubmitBody, SubmitResponse, TakeoffResponse } from "../types.js";
import {
  button,
  click,
  CONFIG,
  fail,
  fakePublic,
  labelled,
  mount,
  ok,
  pass,
  PAD,
  photoFile,
  pickFile,
  PRICE_ASSUMED,
  PRICE_MEASURED,
  RAMP,
  READING,
  settle,
  submit,
  text,
  type,
} from "./fakes.js";

/**
 * <EstimateTool> driven like a customer (contract 9.3): pick the ramp, count
 * the steps, maybe add a photo, see the price and how it was worked out, send
 * it. The widget does no arithmetic — every number and sentence asserted here
 * came from the fake server — and these tests prove it shows them verbatim
 * and sends exactly what the customer answered.
 */

vi.mock("../photo.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../photo.js")>();
  return {
    ...original,
    resizePhoto: vi.fn(async () => ({ blob: new Blob(["abc"], { type: "image/jpeg" }), base64: "QUJD", width: 768, height: 576, mediaType: "image/jpeg" as const })),
  };
});
const photoModule = await import("../photo.js");
const resizeMock = photoModule.resizePhoto as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resizeMock.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const RAMP_ONLY: PublicConfig = { ...CONFIG, products: [RAMP] };

const priced = (price = PRICE_ASSUMED): CalculateResponse => ({ status: "priced", missing: [], price, result: null });
const SUBMITTED: SubmitResponse = {
  estimateId: "est_1",
  estimateNumber: "EST-0001",
  range: { low: 860_265, high: 1_045_807, single: false },
  currency: "USD",
  emailed: true,
  id: "est_1",
  subtotal: 997_836,
  taxAmount: 72_343,
  total: 1_070_179,
};

function stepsInput(container: HTMLElement): HTMLInputElement {
  return labelled(container, "How many steps go up to the door?") as HTMLInputElement;
}

async function fillDetails(container: HTMLElement, name = "Pat Lee") {
  await type(labelled(container, "Your name"), name);
  await type(labelled(container, "Email"), "pat@example.com");
  await type(labelled(container, "Address of the job"), "12 Elm St");
}

describe("<EstimateTool>: what the customer is asked", () => {
  it("renders the ramp's three questions from the server, empty, the total height behind 'More ways to measure', and never 'length of run'", async () => {
    const fake = fakePublic({ config: () => ok(CONFIG) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container)).toContain("Get an instant estimate");
    expect(text(container)).toContain("What do you need?");
    // Radio semantics for the products; nothing chosen for them.
    const chips = container.querySelectorAll('[role="radiogroup"] [role="radio"]');
    expect([...chips].map((c) => text(c))).toEqual(["Modular aluminum ramp", "Concrete landing pad", "Something else"]);
    expect([...chips].every((c) => c.getAttribute("aria-checked") === "false")).toBe(true);
    await click(container.querySelector('[data-value="p-ramp"]'));

    const steps = stepsInput(container);
    expect(steps.value).toBe("");
    expect(steps.getAttribute("aria-label")).toBe("How many steps go up to the door?");
    expect(text(container)).toContain("Count every step up, including the last one onto the porch or landing: 2 steps and the porch is 3.");
    const height = labelled(container, "Height of one step (optional)") as HTMLInputElement;
    expect(height.value).toBe("");
    expect(height.getAttribute("placeholder")).toBe("e.g. 7.5");
    // "(optional)" is in the server's label already: never said twice.
    expect(text(container)).not.toContain("(optional) (optional)");
    const more = button(container, "More ways to measure")!;
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-aiew-more]")!.hasAttribute("hidden")).toBe(true);
    await click(more);
    expect(container.querySelector("[data-aiew-more]")!.hasAttribute("hidden")).toBe(false);
    expect(text(container)).toContain("Or the total height, ground to door threshold (optional)");
    // Rule E: a customer is never asked a number they'd have to work out.
    expect(text(container).toLowerCase()).not.toContain("length of run");
    expect(text(container)).toContain("Answer the questions above to see your price.");
    expect(fake.of("calculate")).toHaveLength(0);
    await unmount();
  });

  it("renders whatever fields the server sends — a recipe it has never seen included", async () => {
    const madeUp: PublicConfig = {
      ...CONFIG,
      products: [
        {
          ...RAMP,
          id: "p-fence",
          name: "Fence posts",
          recipe: "count",
          fields: [
            { key: "posts", kind: "stepper", label: "How many posts?", help: "Corners count twice.", required: true, min: 1, max: 40, presentation: "primary" },
            { key: "depthIn", kind: "number", label: "How deep?", help: null, required: false, min: 12, max: 60, step: 1, unit: "in", placeholder: null, presentation: "primary" },
          ],
          options: [],
          photo: { reading: false, tip: null },
        },
      ],
    };
    const fake = fakePublic({ config: () => ok(madeUp), calculate: () => ok(priced(PRICE_MEASURED)) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container)).toContain("How many posts?");
    expect(text(container)).toContain("Corners count twice.");
    expect(text(container)).toContain("How deep?");
    await click(button(container, "One more: How many posts?"));
    await pass(350);
    expect(fake.of("calculate").at(-1)!.args[0]).toMatchObject({ productId: "p-fence", inputs: { posts: 1 } });
    await unmount();
  });

  it("the stepper changes the count; one debounced calculate sends inputs.steps; the price card shows the server's words", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    const plus = button(container, "One more: How many steps")!;
    await act(async () => {
      plus.click();
      plus.click();
      plus.click();
    });
    expect(stepsInput(container).value).toBe("3");
    expect(fake.of("calculate")).toHaveLength(0);
    await pass(350);
    expect(fake.of("calculate")).toHaveLength(1);
    const body = fake.of("calculate")[0]!.args[0] as CalculateBody;
    expect(body).toEqual({ productId: "p-ramp", inputs: { steps: 3 }, optionValueIds: ["v-std"] });

    const card = container.querySelector("[data-aiew-price]")!;
    expect(text(card.querySelector("[data-aiew-amount]"))).toBe("$6,444 – $7,164");
    expect(text(card)).toContain("Plus 7.25% sales tax.");
    expect(text(card)).toContain("That's about a 21–24 ft ramp.");
    expect([...card.querySelectorAll("[data-aiew-explain] li")].map((li) => text(li))).toEqual(PRICE_ASSUMED.explanation);
    expect(text(card.querySelector("[data-aiew-assumption]"))).toBe(
      "Based on an estimated step height of 7–8 in. Measure one step and enter it for a tighter estimate.",
    );
    expect(text(card.querySelector("[data-aiew-why]"))).toBe("Why a range? Step height 7–8 in (estimated)");
    expect(text(card)).toContain("We'll confirm the final price once we've seen the job.");
    expect(card.getAttribute("aria-live")).toBe("polite");
    await unmount();
  });

  it("a measured step height gives one number, with no range and no assumption", async () => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: (b) => ok(priced(b.inputs?.stepHeightIn ? PRICE_MEASURED : PRICE_ASSUMED)),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await type(labelled(container, "Height of one step"), "7.5");
    await pass(350);
    expect(fake.of("calculate").at(-1)!.args[0]).toMatchObject({ inputs: { steps: 3, stepHeightIn: 7.5 } });
    const card = container.querySelector("[data-aiew-price]")!;
    expect(text(card.querySelector("[data-aiew-amount]"))).toBe("$6,924");
    expect(card.querySelector("[data-aiew-assumption]")).toBeNull();
    expect(card.querySelector("[data-aiew-why]")).toBeNull();
    await unmount();
  });

  it("an out-of-range number shows its limits on blur and stays off the wire", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    const height = labelled(container, "Height of one step") as HTMLInputElement;
    await type(height, "40");
    await act(async () => {
      height.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await pass(350);
    expect(text(container)).toContain("Enter a number from 3 to 12.");
    expect(height.getAttribute("aria-invalid")).toBe("true");
    expect(fake.of("calculate").at(-1)!.args[0]).toMatchObject({ inputs: { steps: 3 } });
    expect((fake.of("calculate").at(-1)!.args[0] as CalculateBody).inputs).not.toHaveProperty("stepHeightIn");
    await unmount();
  });

  it("ignores an answer that arrives after a newer question", async () => {
    let releaseFirst: (value: unknown) => void = () => {};
    let n = 0;
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => {
        n += 1;
        if (n === 1) return new Promise((resolve) => (releaseFirst = () => resolve(ok(priced(PRICE_MEASURED)))));
        return ok(priced(PRICE_ASSUMED));
      },
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "4");
    await pass(350);
    await type(stepsInput(container), "3");
    await pass(350);
    expect(fake.of("calculate")).toHaveLength(2);
    expect(text(container.querySelector("[data-aiew-amount]"))).toBe("$6,444 – $7,164");
    await act(async () => releaseFirst(null));
    await settle();
    // The slow answer to "4 steps" never overwrites the price for "3 steps".
    expect(text(container.querySelector("[data-aiew-amount]"))).toBe("$6,444 – $7,164");
    await unmount();
  });

  it("a failed recalculation keeps the form usable and says so", async () => {
    let first = true;
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => {
        if (first) {
          first = false;
          return ok(priced());
        }
        return fail("network");
      },
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await pass(350);
    await type(stepsInput(container), "4");
    await pass(350);
    expect(text(container)).toContain("We couldn't update the price. Check your connection.");
    // The last good price is still on screen.
    expect(text(container.querySelector("[data-aiew-amount]"))).toBe("$6,444 – $7,164");
    expect(stepsInput(container).disabled).toBe(false);
    await unmount();
  });

  it("a preset size copies its numbers into width and length, which stay editable; 'How many pads?' asks a quantity", async () => {
    const fake = fakePublic({ config: () => ok({ ...CONFIG, products: [PAD] }), calculate: () => ok(priced(PRICE_MEASURED)) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await click(container.querySelector('[data-aiew-field="preset"] [data-value="1"]'));
    expect((labelled(container, "Width") as HTMLInputElement).value).toBe("5");
    expect((labelled(container, "Length") as HTMLInputElement).value).toBe("5");
    expect(container.querySelector('[data-aiew-field="preset"] [data-value="1"]')!.getAttribute("aria-checked")).toBe("true");
    expect(text(container)).toContain("How many pads?");
    await pass(350);
    expect(fake.of("calculate").at(-1)!.args[0]).toEqual({ productId: "p-pad", inputs: { width: 5, length: 5 }, quantity: 1, optionValueIds: [] });
    await type(labelled(container, "Length"), "8");
    expect(container.querySelector('[data-aiew-field="preset"] [data-value="1"]')!.getAttribute("aria-checked")).toBe("false");
    await unmount();
  });

  it("options are chips with their price, and the chosen value is sent", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    const heavy = container.querySelector('[data-aiew-options] [data-value="v-hd"]')!;
    expect(text(heavy)).toContain("Heavy-duty grit");
    expect(text(heavy)).toContain("+$120");
    await type(stepsInput(container), "3");
    await click(heavy);
    await pass(350);
    expect(fake.of("calculate").at(-1)!.args[0]).toMatchObject({ optionValueIds: ["v-hd"] });
    await unmount();
  });

  it("lockProduct shows only that product, with no chips", async () => {
    const fake = fakePublic({ config: () => ok(CONFIG) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} productId="p-pad" lockProduct />);
    expect(text(container)).not.toContain("What do you need?");
    expect(container.querySelector('[data-aiew-chips="products"]')).toBeNull();
    expect(text(container)).toContain("Width");
    await unmount();
  });
});

describe("<EstimateTool>: the photo", () => {
  it("a measured job: the takeoff carries what the customer typed, and 'not_needed' keeps the photo without reading it", async () => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => ok(priced(PRICE_MEASURED)),
      takeoff: () => ok<TakeoffResponse>({
        status: "not_needed",
        reading: null,
        photoId: "ph_1",
        message: "You've measured it already, so we've just kept your photo with your estimate.",
        cached: false,
        available: true,
        result: null,
      }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await type(labelled(container, "Height of one step"), "7.5");
    await pickFile(container, photoFile());
    expect(fake.of("takeoff")[0]!.args[0]).toEqual({ productId: "p-ramp", imageBase64: "QUJD", mediaType: "image/jpeg", inputs: { steps: 3, stepHeightIn: 7.5 } });
    expect(text(container)).toContain("You've measured it already, so we've just kept your photo with your estimate.");
    expect(container.querySelector("img.aiew-thumb")).not.toBeNull();
    expect(container.querySelector("[data-aiew-badge]")).toBeNull();
    expect(fake.of("photo")).toHaveLength(0);
    await unmount();
  });

  it("a photo is shrunk, shown back, read; the count is pre-filled with a badge, editing clears it, and takeoffId rides on calculate and submit", async () => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => ok(priced()),
      takeoff: () => ok<TakeoffResponse>({ status: "read", reading: READING, photoId: "ph_1", message: null, cached: false, available: true, result: null }),
      submit: () => ok(SUBMITTED),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container)).toContain("Stand to the side so every step shows.");
    await pickFile(container, photoFile());
    expect(resizeMock).toHaveBeenCalledTimes(1);
    expect(resizeMock.mock.calls[0]![1]).toEqual({ maxEdgePx: 768, quality: 0.8 });
    expect(fake.of("takeoff")[0]!.args[0]).toEqual({ productId: "p-ramp", imageBase64: "QUJD", mediaType: "image/jpeg", inputs: {} });

    // The photo and the AI's reading, side by side, in the server's words.
    const item = container.querySelector("[data-aiew-photo]")!;
    expect(item.querySelector("img.aiew-thumb")).not.toBeNull();
    expect([...item.querySelectorAll(".aiew-reading-lines li")].map((li) => text(li))).toEqual(READING.lines);
    expect(text(item.querySelector("[data-aiew-confidence]"))).toBe("Fairly sure");

    // The count is in the same stepper, marked as from the photo.
    expect(stepsInput(container).value).toBe("3");
    expect(text(container.querySelector('[data-aiew-badge="steps"]'))).toBe("From your photo");
    await pass(350);
    expect(fake.of("calculate").at(-1)!.args[0]).toMatchObject({ inputs: { steps: 3 }, takeoffId: "tk_porch" });

    // The customer corrects it: the badge goes, the new count is priced with the reading.
    await click(button(container, "One more: How many steps"));
    expect(stepsInput(container).value).toBe("4");
    expect(container.querySelector('[data-aiew-badge="steps"]')).toBeNull();
    await pass(350);
    expect(fake.of("calculate").at(-1)!.args[0]).toMatchObject({ inputs: { steps: 4 }, takeoffId: "tk_porch" });

    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    const body = fake.of("submit")[0]!.args[0] as SubmitBody;
    expect(body.items).toEqual([{ productId: "p-ramp", inputs: { steps: 4 }, optionValueIds: ["v-std"], takeoffId: "tk_porch" }]);
    expect(body.photoIds).toEqual(["ph_1"]);
    await unmount();
  });

  it("a count the customer already typed is never overwritten by the photo", async () => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => ok(priced()),
      takeoff: () => ok<TakeoffResponse>({ status: "read", reading: READING, photoId: "ph_1", message: null, cached: false, available: true, result: null }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "5");
    await pickFile(container, photoFile());
    expect(fake.of("takeoff")[0]!.args[0]).toMatchObject({ inputs: { steps: 5 } });
    expect(stepsInput(container).value).toBe("5");
    expect(container.querySelector("[data-aiew-badge]")).toBeNull();
    await unmount();
  });

  it("low confidence says so plainly", async () => {
    const low = { ...READING, confidence: "low" as const, lowConfidence: true, heightRangeIn: null, lines: ["We counted 3 steps.", "We're not sure about this photo, so please check the count.", "Change the count below if it's wrong."] };
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => ok(priced()),
      takeoff: () => ok<TakeoffResponse>({ status: "read", reading: low, photoId: "ph_1", message: null, cached: false, available: true, result: null }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    expect(text(container.querySelector("[data-aiew-confidence]"))).toBe("Not sure");
    expect(text(container)).toContain("We're not sure about this photo, so please check the count.");
    await unmount();
  });

  it.each([
    ["paused", "Photo reading is paused for today. Count the steps and enter them below."],
    ["limited", "You've used today's photo readings. Count the steps and enter them below."],
  ] as const)("'%s': the server's message, and the photo is still kept", async (status, message) => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      takeoff: () => ok<TakeoffResponse>({ status, reading: null, photoId: "ph_2", message, cached: false, available: true, result: null }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    expect(text(container)).toContain(message);
    expect(container.querySelector("img.aiew-thumb")).not.toBeNull();
    expect(fake.of("photo")).toHaveLength(0);
    expect(stepsInput(container).value).toBe("");
    await unmount();
  });

  it("a failed reading with no copy kept falls back to photo() once", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), takeoff: () => fail("network"), photo: () => ok({ photoId: "ph_9" }) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    expect(fake.of("photo")).toHaveLength(1);
    expect(fake.of("photo")[0]!.args[0]).toEqual({ imageBase64: "QUJD", mediaType: "image/jpeg", productId: "p-ramp" });
    expect(text(container)).toContain("Photo added. The business will see it with your estimate.");
    await unmount();
  });

  it("a file that won't decode is refused in the browser, before any request", async () => {
    resizeMock.mockRejectedValueOnce(new Error("That file isn't a photo we can read. Try a JPEG or PNG."));
    const fake = fakePublic({ config: () => ok(RAMP_ONLY) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile("notes.pdf", "application/pdf"));
    expect(text(container)).toContain("That file isn't a photo we can read. Try a JPEG or PNG.");
    expect(fake.of("takeoff")).toHaveLength(0);
    expect(fake.of("photo")).toHaveLength(0);
    await unmount();
  });

  it("removing the read photo drops the reading and the badge, and keeps the numbers", async () => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => ok(priced()),
      takeoff: () => ok<TakeoffResponse>({ status: "read", reading: READING, photoId: "ph_1", message: null, cached: false, available: true, result: null }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    await pass(350);
    await click(button(container, "Remove photo"));
    expect(container.querySelector("[data-aiew-photo]")).toBeNull();
    expect(container.querySelector("[data-aiew-badge]")).toBeNull();
    expect(stepsInput(container).value).toBe("3");
    await pass(350);
    expect(fake.of("calculate").at(-1)!.args[0]).not.toHaveProperty("takeoffId");
    await unmount();
  });

  it("with photos neither kept nor read here, there is no photo button", async () => {
    const fake = fakePublic({
      config: () => ok({ ...CONFIG, photos: { ...CONFIG.photos, attach: false, reading: false }, products: [{ ...RAMP, photo: { reading: false, tip: null } }] }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(container.querySelector('input[type="file"]')).toBeNull();
    await unmount();
  });
});

describe("<EstimateTool>: sending it", () => {
  it("sends the honeypot only when filled and the fill time; waits out the server's floor with 'Sending…'", async () => {
    const fake = fakePublic({ config: () => ok({ ...RAMP_ONLY, minFillMs: 400 }), calculate: () => ok(priced()), submit: () => ok(SUBMITTED) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await pass(350);
    // The honeypot: off-screen, out of the tab order, hidden from assistive tech.
    const hp = container.querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(hp.tabIndex).toBe(-1);
    expect(hp.getAttribute("autocomplete")).toBe("off");
    expect(hp.closest("[aria-hidden='true']")).not.toBeNull();
    expect(hp.closest(".aiew-hp")).not.toBeNull();
    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    expect(text(button(container, "Sending"))).toBe("Sending…");
    expect(fake.of("submit")).toHaveLength(0);
    await pass(450);
    expect(fake.of("submit")).toHaveLength(1);
    const body = fake.of("submit")[0]!.args[0] as SubmitBody;
    expect(body).toMatchObject({ name: "Pat Lee", email: "pat@example.com", address: "12 Elm St" });
    expect(body.website).toBeUndefined();
    expect(body.fillMs).toBeGreaterThanOrEqual(400);
    await unmount();
  });

  it("asks for an email or a phone before sending, in words", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()), submit: () => ok(SUBMITTED) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await pass(350);
    await type(labelled(container, "Your name"), "Pat Lee");
    await submit(container.querySelector("form[data-aiew-form]"));
    expect(text(container)).toContain("Enter an email or a phone number so we can reach you.");
    expect(fake.of("submit")).toHaveLength(0);
    await unmount();
  });

  it("puts the server's issues on the fields they are about — the details and the measurement", async () => {
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => ok(priced()),
      submit: () =>
        fail("invalid", "invalid", {
          status: 400,
          issues: [
            { path: ["email"], message: "Enter an email address." },
            { path: ["items", 0, "inputs", "steps"], message: "Enter a whole number of steps." },
          ],
        }),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await pass(350);
    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    expect(text(container)).toContain("Enter an email address.");
    expect(text(container)).toContain("Enter a whole number of steps.");
    expect(labelled(container, "Email")!.getAttribute("aria-invalid")).toBe("true");
    expect(text(container)).toContain("Please check the highlighted fields.");
    await unmount();
  });

  it.each([
    ["spam_suspected", "That was quicker than a person can fill in the form. Please check your details and send it again."],
    ["rate_limited", "That's a lot of tries in a short time. Wait a minute, then try again."],
    ["network", "We couldn't connect. Check your connection and try again."],
  ] as const)("%s: a message, and everything typed is kept", async (code, message) => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()), submit: () => fail(code, code) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await pass(350);
    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    expect(text(container)).toContain(message);
    expect((labelled(container, "Your name") as HTMLInputElement).value).toBe("Pat Lee");
    expect(stepsInput(container).value).toBe("3");
    await unmount();
  });

  it("a reading or photo that went away: sent once more without them", async () => {
    let n = 0;
    const fake = fakePublic({
      config: () => ok(RAMP_ONLY),
      calculate: () => ok(priced()),
      takeoff: () => ok<TakeoffResponse>({ status: "read", reading: READING, photoId: "ph_1", message: null, cached: false, available: true, result: null }),
      submit: () => (++n === 1 ? fail("takeoff_unavailable", "That photo reading isn't available any more.", { status: 400 }) : ok(SUBMITTED)),
    });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await pickFile(container, photoFile());
    await pass(350);
    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    expect(fake.of("submit")).toHaveLength(2);
    const retry = fake.of("submit")[1]!.args[0] as SubmitBody;
    expect(retry.items[0]).not.toHaveProperty("takeoffId");
    expect(retry.photoIds).toBeUndefined();
    expect(text(container)).toContain("Your estimate EST-0001 is saved.");
    await unmount();
  });

  it("saved: thanks by first name, the copy, the range, 'Book a visit to measure' with the estimate, onSubmitted once; 'Start another' resets", async () => {
    const onSubmitted = vi.fn();
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()), submit: () => ok(SUBMITTED) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} bookHref="/book-visit?from=estimate" onSubmitted={onSubmitted} />);
    await type(stepsInput(container), "3");
    await pass(350);
    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    const done = container.querySelector("[data-aiew-done]")!;
    expect(text(done)).toContain("Thanks, Pat. Your estimate EST-0001 is saved.");
    expect(text(done)).toContain("We've emailed you a copy.");
    expect(text(done.querySelector("[data-aiew-recap]"))).toContain("$8,603 – $10,458");
    expect(text(done)).toContain("What happens next");
    expect(container.querySelector("[data-aiew-book]")!.getAttribute("href")).toBe("/book-visit?from=estimate&estimate=est_1");
    expect(document.activeElement?.textContent).toContain("Your estimate EST-0001 is saved.");
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledWith(SUBMITTED);
    await click(button(container, "Start another estimate"));
    expect(container.querySelector("[data-aiew-done]")).toBeNull();
    expect(stepsInput(container).value).toBe("");
    await unmount();
  });

  it("without email, the reference is the thing to keep", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY), calculate: () => ok(priced()), submit: () => ok({ ...SUBMITTED, emailed: false }) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await type(stepsInput(container), "3");
    await pass(350);
    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    expect(text(container)).toContain("Keep this reference: EST-0001.");
    await unmount();
  });

  it("a quote-only product goes straight to the details form, and sends just the product", async () => {
    const fake = fakePublic({ config: () => ok(CONFIG), submit: () => ok({ ...SUBMITTED, range: { low: 0, high: 0, single: true } }) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    await click(container.querySelector('[data-value="p-else"]'));
    expect(text(container)).toContain("This one needs a quick look to price. Leave your details and we'll be in touch.");
    expect(container.querySelector("[data-aiew-price]")).toBeNull();
    await fillDetails(container);
    await submit(container.querySelector("form[data-aiew-form]"));
    expect((fake.of("submit")[0]!.args[0] as SubmitBody).items).toEqual([{ productId: "p-else" }]);
    expect(fake.of("calculate")).toHaveLength(0);
    await unmount();
  });
});

describe("<EstimateTool>: when it can't run", () => {
  it("a key that isn't valid here: 'isn't set up for this website yet', with a note for the site owner", async () => {
    const fake = fakePublic({ config: () => fail("unauthorized", "This estimator key isn't valid.", { status: 401 }) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container)).toContain("This estimator isn't set up for this website yet.");
    expect(text(container.querySelector("details"))).toContain("For the site owner");
    expect(text(container.querySelector("details"))).toContain("Check the embed key and its allowed websites in your estimator settings.");
    expect(container.querySelector("[data-aiew-tool]")!.getAttribute("data-aiew-tool")).toBe("not-set-up");
    await unmount();
  });

  it("a network failure: 'We couldn't load the estimator.' with Retry — never an endless Loading", async () => {
    let n = 0;
    const fake = fakePublic({ config: () => (++n === 1 ? fail("network") : ok(RAMP_ONLY)) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container)).toContain("We couldn't load the estimator.");
    await click(button(container, "Retry"));
    expect(fake.of("config")).toHaveLength(2);
    expect(text(container)).toContain("How many steps go up to the door?");
    await unmount();
  });

  it.each([
    ["instant estimates switched off", { ...CONFIG, instantEstimatesEnabled: false, products: [] }],
    ["no products", { ...CONFIG, products: [] }],
  ])("%s: 'not available right now', with the phone and email as links", async (_, config) => {
    const fake = fakePublic({ config: () => ok(config) });
    const { container, unmount } = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(container)).toContain("Instant estimates aren't available right now.");
    expect(container.querySelector('a[href="tel:8015550143"]')).not.toBeNull();
    expect(container.querySelector('a[href="mailto:office@summit.test"]')).not.toBeNull();
    await unmount();
  });

  it("no transport and no baseUrl: one plain error, not a crash", async () => {
    const { container, unmount } = await mount(<EstimateTool />);
    expect(text(container)).toContain("We couldn't load the estimator.");
    await unmount();
  });
});

describe("<EstimateTool>: look", () => {
  it("no 'Powered by' unless asked for", async () => {
    const fake = fakePublic({ config: () => ok(RAMP_ONLY) });
    const plain = await mount(<EstimateTool transport={fake.transport} />);
    expect(text(plain.container)).not.toContain("Powered by");
    await plain.unmount();
    const branded = await mount(<EstimateTool transport={fake.transport} poweredBy />);
    expect(text(branded.container)).toContain("Powered by AdminIgloo");
    await branded.unmount();
  });

  it("takes the business's colour from its settings; accentColor overrides it, and null turns it off", async () => {
    const fake = fakePublic({ config: () => ok({ ...RAMP_ONLY, brandColor: "#7c3aed" }) });
    const fromSettings = await mount(<EstimateTool transport={fake.transport} />);
    const root = fromSettings.container.querySelector<HTMLElement>(".aiew-root")!;
    expect(root.hasAttribute("data-brand")).toBe(true);
    expect(root.style.getPropertyValue("--aiew-bl-accent")).toBe("#7c3aed");
    expect(root.style.getPropertyValue("--aiew-bd-accent")).toBe("#7c3aed");
    await fromSettings.unmount();
    const own = await mount(<EstimateTool transport={fake.transport} accentColor="#C2410C" />);
    expect(own.container.querySelector<HTMLElement>(".aiew-root")!.style.getPropertyValue("--aiew-bl-accent")).toBe("#c2410c");
    await own.unmount();
    const none = await mount(<EstimateTool transport={fake.transport} accentColor={null} />);
    expect(none.container.querySelector(".aiew-root")!.hasAttribute("data-brand")).toBe(false);
    await none.unmount();
  });
});

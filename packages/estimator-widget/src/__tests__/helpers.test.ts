import { describe, expect, it } from "vitest";
import { correctionText } from "../admin/EstimateEditor.js";
import { originsFromText, resolveEmbedBaseUrl } from "../admin/EmbedKeys.js";
import {
  adminErrorText,
  bpToInput,
  centsToInput,
  configFor,
  formatMicros,
  formatMicrosExact,
  issuesByField,
  milliToInput,
  parseMilliInput,
  parseMoneyInput,
  parsePercentInput,
  perPrimaryLabel,
  RAMP_DEFAULTS,
  recipeInfoFor,
  statusLabel,
  timeAgo,
} from "../admin/helpers.js";
import { affectedText } from "../admin/PriceBook.js";
import { formFromProduct, formProblem, productPatch } from "../admin/ProductEditor.js";
import { cleanInputs, hasAnyInput, inRange, parseTyped, rangeMessage } from "../fields.js";
import { buildSubmitBody, EMPTY_DETAILS, mapSubmitIssues, validateDetails } from "../form.js";
import { firstName, formatDate, formatModifier, formatMoney, formatPercent, formatRange, friendlyError, withParam } from "../format.js";
import { fitWithin } from "../photo.js";
import { brandTokens, CONTRAST_PAIRS, contrastRatio, DARK_TOKENS, LIGHT_TOKENS } from "../styles.js";
import { adminRamp, PAD, RAMP_FIELDS } from "./fakes.js";

/**
 * The pure helpers, branch by branch: the photo's size, the business's colour
 * kept readable, money and dates in words, errors a customer can act on, what
 * the form sends, and how an owner's typing becomes cents and basis points.
 */

describe("fitWithin", () => {
  it("shrinks the long edge to the limit, keeps the shape, rounds to whole pixels", () => {
    expect(fitWithin(4032, 3024, 768)).toEqual({ width: 768, height: 576 });
    expect(fitWithin(3024, 4032, 768)).toEqual({ width: 576, height: 768 });
    expect(fitWithin(1000, 333, 768)).toEqual({ width: 768, height: 256 });
  });
  it("never upscales a small photo", () => {
    expect(fitWithin(600, 400, 768)).toEqual({ width: 600, height: 400 });
    expect(fitWithin(768, 768, 768)).toEqual({ width: 768, height: 768 });
  });
  it("never goes below one pixel, and survives nonsense", () => {
    expect(fitWithin(10_000, 1, 768)).toEqual({ width: 768, height: 1 });
    expect(fitWithin(Number.NaN, 10, 768)).toEqual({ width: 1, height: 10 });
  });
});

describe("brandTokens: any colour the owner picks stays readable", () => {
  // A sweep of 216 colours (every 0x33 step), plus a few classics.
  const steps = ["00", "33", "66", "99", "cc", "ff"];
  const colours = steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => `#${r}${g}${b}`))).concat(["#7c3aed", "#c2410c", "#0d6b64", "#808080", "#777777"]);
  for (const theme of ["light", "dark"] as const) {
    it(`${theme}: every brand pair is AA for ${colours.length} colours`, () => {
      const base = theme === "dark" ? { ...LIGHT_TOKENS, ...DARK_TOKENS } : LIGHT_TOKENS;
      for (const colour of colours) {
        const palette = { ...base, ...brandTokens(colour, theme) };
        for (const [fg, bg, min] of CONTRAST_PAIRS) {
          const ratio = contrastRatio(palette[fg]!, palette[bg]!);
          expect(ratio, `${colour} ${theme}: ${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
        }
      }
    });
  }

  it("follows the contract's recipe: the colour itself, white or near-black on it, a soft tint, the ink stepped until it reads", () => {
    const t = brandTokens("#7C3AED", "light");
    expect(t.accent).toBe("#7c3aed");
    expect(t["on-accent"]).toBe("#ffffff");
    expect(t.focus).toBe(t["accent-ink"]);
    expect(contrastRatio(t["accent-ink"]!, LIGHT_TOKENS.surface!)).toBeGreaterThanOrEqual(4.5);
    expect(brandTokens("#ffd60a", "light")["on-accent"]).toBe("#0b0f13");
    // A light colour on a light page: the ink is stepped darker until it reads.
    expect(brandTokens("#ffd60a", "light")["accent-ink"]).not.toBe("#ffd60a");
    // A dark colour on a dark page: stepped lighter.
    const dark = brandTokens("#1e3a8a", "dark");
    expect(contrastRatio(dark["accent-ink"]!, DARK_TOKENS.surface!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("money, dates and words", () => {
  it("formats cents in the business's currency; whole units for an estimate", () => {
    expect(formatMoney(644_396)).toBe("$6,443.96");
    expect(formatMoney(644_396, "USD", "en-US", { whole: true })).toBe("$6,444");
    expect(formatMoney(150_000, "CAD", "en-CA")).toBe("$1,500.00");
    expect(formatMoney(1234, "XYZ", "en-US")).toBe("XYZ 12.34".replace(" ", " "));
    expect(formatMoney(Number.NaN)).toBe("$0.00");
  });
  it("a range in whole units, or one amount", () => {
    expect(formatRange(644_396, 716_352)).toBe("$6,444 – $7,164");
    expect(formatRange(692_367, 692_367)).toBe("$6,924");
  });
  it("an option's price as the customer reads it", () => {
    expect(formatModifier(12_000)).toBe("+$120");
    expect(formatModifier(1_250)).toBe("+$12.50");
    expect(formatModifier(-2_000)).toBe("−$20");
  });
  it("basis points as a percentage", () => {
    expect(formatPercent(725)).toBe("7.25%");
    expect(formatPercent(500)).toBe("5%");
    expect(formatPercent(2857)).toBe("28.57%");
    expect(formatPercent(0)).toBe("0%");
  });
  it("dates in the business's zone: a quote sent at 8 PM in Denver carries that day's date", () => {
    expect(formatDate("2026-11-15T03:00:00.000Z", "en-US", "America/Denver")).toBe("November 14, 2026");
    expect(formatDate("2026-11-15T03:00:00.000Z", "en-US", "UTC")).toBe("November 15, 2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate("2026-11-15T03:00:00.000Z", "en-US", "Not/AZone")).toBe("November 15, 2026");
  });
  it("first names and the booking link", () => {
    expect(firstName("Pat Lee")).toBe("Pat");
    expect(firstName("  ")).toBe("");
    expect(firstName("www.spam.com")).toBe("");
    expect(withParam("/book-visit", "estimate", "est_1")).toBe("/book-visit?estimate=est_1");
    expect(withParam("/book?x=1#top", "estimate", "e 1")).toBe("/book?x=1&estimate=e%201#top");
  });
});

describe("friendlyError", () => {
  const e = (code: string, message = code, status = 400) => ({ code, message, status }) as never;
  it("speaks to a customer, never in codes", () => {
    expect(friendlyError(e("network", "x", 0), "submit")).toBe("We couldn't connect. Check your connection and try again.");
    expect(friendlyError(e("unauthorized", "x", 401), "config")).toBe("This estimator isn't set up for this website yet.");
    expect(friendlyError(e("origin_not_allowed", "x", 403), "config")).toBe("This estimator isn't set up for this website yet.");
    expect(friendlyError(e("estimates_closed"), "calculate")).toBe("Instant estimates aren't available right now.");
    expect(friendlyError(e("internal", "TypeError at db.ts:42", 500), "submit")).toBe("Something went wrong on our side. Please try again.");
    expect(friendlyError(e("not_found", "x", 404), "quote")).toContain("This quote link doesn't work.");
    expect(friendlyError(e("bad_response", "x", 429), "submit")).toContain("a lot of tries");
  });
  it("uses the server's own sentence where it is written for a person", () => {
    expect(friendlyError(e("quote_expired", "This quote expired on Nov 14, 2026. Call us at (801) 555-0143 for an updated one.", 409), "respond")).toBe(
      "This quote expired on Nov 14, 2026. Call us at (801) 555-0143 for an updated one.",
    );
    expect(friendlyError(e("photo_invalid", "That photo couldn't be used. Please try another one; the page shrinks photos before sending."), "photo")).toContain(
      "the page shrinks photos",
    );
  });
});

describe("the customer's answers", () => {
  it("cleanInputs keeps only in-range numbers of stepper and number fields — never a choice field", () => {
    expect(cleanInputs(RAMP_FIELDS, { steps: 3, stepHeightIn: 40, totalRiseIn: null })).toEqual({ steps: 3 });
    expect(cleanInputs(RAMP_FIELDS, { steps: 2.5 })).toEqual({});
    expect(cleanInputs(PAD.fields, { preset: 1, width: 5, length: 5 })).toEqual({ width: 5, length: 5 });
    expect(hasAnyInput(RAMP_FIELDS, {})).toBe(false);
    expect(hasAnyInput(RAMP_FIELDS, { steps: 1 })).toBe(true);
  });
  it("limits and typing", () => {
    expect(inRange(RAMP_FIELDS[1] as never, 7.25)).toBe(true);
    expect(rangeMessage({ min: 3, max: 12 })).toBe("Enter a number from 3 to 12.");
    expect(parseTyped("")).toBeNull();
    expect(parseTyped("7,5")).toBe(7.5);
    expect(Number.isNaN(parseTyped("seven"))).toBe(true);
  });
  it("the details form: name, and an email or a phone", () => {
    expect(validateDetails(EMPTY_DETAILS)).toEqual({ name: "Enter your name.", email: "Enter an email or a phone number so we can reach you." });
    expect(validateDetails({ ...EMPTY_DETAILS, name: "Pat", phone: "(801) 555-0100" })).toEqual({});
    expect(validateDetails({ ...EMPTY_DETAILS, name: "Pat", email: "pat@" }).email).toBe("Enter an email address like you@example.com.");
  });
  it("the submit body leaves out what wasn't given, and sends the honeypot only when filled", () => {
    const body = buildSubmitBody({
      values: { ...EMPTY_DETAILS, name: " Pat Lee ", email: "pat@example.com" },
      item: { productId: "p-ramp", inputs: { steps: 3 } },
      photoIds: ["a", "b", "c", "d"],
      fillMs: 4200.7,
    });
    expect(body).toEqual({ name: "Pat Lee", email: "pat@example.com", items: [{ productId: "p-ramp", inputs: { steps: 3 } }], photoIds: ["a", "b", "c"], fillMs: 4201 });
    expect(buildSubmitBody({ values: { ...EMPTY_DETAILS, website: "x" }, item: { productId: "p" }, photoIds: [], fillMs: 1 }).website).toBe("x");
  });
  it("the server's issues go to the field the customer sees, in 0.3 or 0.2 names", () => {
    expect(
      mapSubmitIssues([
        { path: ["customerEmail"], message: "a" },
        { path: ["phone"], message: "b" },
        { path: ["items", 0, "inputs", "steps"], message: "c" },
        { path: ["inputs", "stepHeightIn"], message: "d" },
        { path: ["items"], message: "e" },
      ]),
    ).toEqual({ details: { email: "a", phone: "b" }, inputs: { steps: "c", stepHeightIn: "d" } });
  });
});

describe("the owner's typing", () => {
  it("money, percentages and thousandths", () => {
    expect(parseMoneyInput("$1,234.56")).toBe(123_456);
    expect(parseMoneyInput("95")).toBe(9500);
    expect(parseMoneyInput("")).toBeNull();
    expect(Number.isNaN(parseMoneyInput("ninety") as number)).toBe(true);
    expect(centsToInput(9500)).toBe("95.00");
    expect(parsePercentInput("7.25%")).toBe(725);
    expect(bpToInput(4000)).toBe("40");
    expect(bpToInput(725)).toBe("7.25");
    expect(parseMilliInput("0.35")).toBe(350);
    expect(milliToInput(2000)).toBe("2");
    expect(milliToInput(250)).toBe("0.25");
  });
  it("AI spend in words", () => {
    expect(formatMicros(0)).toBe("$0.00");
    expect(formatMicros(4250)).toBe("under $0.01");
    expect(formatMicros(240_000)).toBe("$0.24");
    expect(formatMicrosExact(1100)).toBe("$0.0011");
    expect(formatMicrosExact(4250)).toBe("$0.0043");
  });
  it("a status as staff read it", () => {
    expect(statusLabel({ status: "draft", source: "public_tool", validUntil: null }).label).toBe("New lead");
    expect(statusLabel({ status: "draft", source: "staff", validUntil: null }).label).toBe("Draft");
    expect(statusLabel({ status: "draft", source: "photo", validUntil: "2026-12-01T00:00:00Z" }).label).toBe("Being revised");
    expect(statusLabel({ status: "approved", source: "photo", validUntil: null })).toEqual({ label: "Accepted", tone: "ok" });
    expect(statusLabel({ status: "converted", source: "photo", validUntil: null }).label).toBe("Invoiced");
  });
  it("how long ago", () => {
    const now = Date.parse("2026-11-02T15:00:00Z");
    expect(timeAgo("2026-11-02T14:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-11-02T14:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-11-02T13:00:00Z", now)).toBe("2 h ago");
    expect(timeAgo("2026-10-31T15:00:00Z", now)).toBe("2 days ago");
    expect(timeAgo("2026-09-01T15:00:00Z", now)).toBe("Sep 1, 2026");
  });
  it("refusals in the server's words; signed out says so", () => {
    expect(adminErrorText({ code: "not_changeable", message: "This quote has been sent. Revise it to make changes.", status: 409 })).toBe(
      "This quote has been sent. Revise it to make changes.",
    );
    expect(adminErrorText({ code: "unauthorized", message: "x", status: 401 })).toBe("You've been signed out. Sign in again to keep working.");
    expect(adminErrorText({ code: "internal", message: "stack trace", status: 500 })).toBe("Something went wrong on our side. Please try again.");
    expect(adminErrorText({ code: "invalid", message: "invalid", status: 400, issues: [{ path: ["a"], message: "One." }, { path: ["b"], message: "Two." }] })).toBe("One. Two.");
    expect(issuesByField({ code: "invalid", message: "", status: 400, issues: [{ path: ["recipeConfig", "stepsLabel"], message: "Too long." }] })).toEqual({
      "recipeConfig.stepsLabel": "Too long.",
      recipeConfig: "Too long.",
    });
  });
  it("what a supply change moves, and what the customer changed", () => {
    expect(affectedText("Updated.", [{ name: "Modular aluminum ramp" }, { name: "Handrail only" }])).toBe(
      "Updated. This changes the price of: Modular aluminum ramp, Handrail only.",
    );
    expect(affectedText("Updated.", [])).toBe("Updated.");
    expect(correctionText([{ field: "steps", label: "Steps", from: 3, to: 4 }])).toBe("steps 3 → 4");
  });
  it("embed websites and the base address", () => {
    expect(originsFromText(" https://a.test \n\n https://b.test,https://c.test ")).toEqual(["https://a.test", "https://b.test", "https://c.test"]);
    expect(resolveEmbedBaseUrl("https://x.test/api/estimator/", "https://y.test")).toBe("https://x.test/api/estimator");
    expect(resolveEmbedBaseUrl(undefined, "https://y.test/api/estimator")).toBe("https://y.test/api/estimator");
  });
});

describe("the recipes and the product form", () => {
  it("a stored config is laid over the recipe's defaults", () => {
    expect(configFor("ramp_over_steps", { stepsLabel: "Steps?", bogus: 1 })).toEqual({ ...RAMP_DEFAULTS, stepsLabel: "Steps?" });
    expect(configFor("ramp_over_steps", null)).toEqual(RAMP_DEFAULTS);
  });
  it("the server's recipe info wins for the saved recipe; the catalog fills in the rest", () => {
    const info = recipeInfoFor("ramp_over_steps", adminRamp().recipeInfo);
    expect(info.label).toBe("Steps up to a door (ramp)");
    expect(perPrimaryLabel(info)).toBe("ft of ramp");
    expect(recipeInfoFor("area", adminRamp().recipeInfo).bases.map((b) => b.key)).toEqual(["sqFt", "perimeterFt", "item", "job"]);
  });
  it("an update sends only what changed; a recipe change carries its settings", () => {
    const base = formFromProduct(adminRamp());
    expect(productPatch(base, base)).toEqual({});
    expect(productPatch(base, { ...base, markupBp: 4500 })).toEqual({ markupBp: 4500 });
    const switched = { ...base, recipe: "count" as const, recipeConfig: configFor("count", null) };
    expect(Object.keys(productPatch(base, switched)).sort()).toEqual(["recipe", "recipeConfig"]);
  });
  it("what stops a save", () => {
    const base = formFromProduct(adminRamp());
    expect(formProblem({ ...base, name: " " })).toBe("Give the product a name.");
    expect(formProblem({ ...base, markupBp: Number.NaN })).toBe("Some numbers aren't numbers yet. Check the fields marked.");
    expect(formProblem({ ...base, pricingBasis: "margin", marginBp: 9600 })).toBe("A target margin can be at most 95%.");
    expect(formProblem(base)).toBeNull();
  });
});

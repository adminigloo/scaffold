import { describe, expect, it } from "vitest";
import {
  describeSaveFailure,
  formFieldId,
  type SaveStep,
} from "@/components/admin/saveErrors";

/**
 * The exact payload that reached a user's screen, and what it must say instead.
 *
 * A tRPC BAD_REQUEST raised by a zod input schema carries the stringified issue
 * list as its message. Rendered verbatim it is a parser's output, it names a
 * field called "name" on a form that has one on the product and one on every
 * variant row, and nothing on the page moves to show which.
 */
const BLANK_NAME = new Error(
  JSON.stringify([
    {
      origin: "string",
      code: "too_small",
      minimum: 1,
      inclusive: true,
      path: ["name"],
      message: "Too small: expected string to have >=1 characters",
    },
  ]),
);

const PRODUCT: SaveStep = { kind: "product" };
const VARIANT_ONE: SaveStep = { kind: "variant", index: 0, label: "variant 1" };
const VARIANT_TWO: SaveStep = { kind: "variant", index: 1, label: "Deluxe" };

describe("a stringified zod refusal", () => {
  it("becomes a sentence, not a JSON dump", () => {
    const report = describeSaveFailure(BLANK_NAME, VARIANT_ONE);
    expect(report.message).toBe("“Name” on variant 1 cannot be empty.");
    expect(report.message).not.toContain("{");
    expect(report.message).not.toContain("too_small");
  });

  it("says WHICH name, because the path alone does not", () => {
    // The same bytes off the wire, two different fields on the form. Only the
    // step the chain was on can tell them apart, which is why one is threaded
    // through `saveProduct` at all.
    expect(describeSaveFailure(BLANK_NAME, PRODUCT).message).toBe(
      "“Name” on the product cannot be empty.",
    );
    expect(describeSaveFailure(BLANK_NAME, VARIANT_TWO).message).toBe(
      "“Name” on variant 2 (“Deluxe”) cannot be empty.",
    );
  });

  it("names a field the form can highlight", () => {
    expect(describeSaveFailure(BLANK_NAME, VARIANT_TWO).faults).toEqual([
      { path: "variants[1].name", message: "“Name” on variant 2 (“Deluxe”) cannot be empty." },
    ]);
    expect(describeSaveFailure(BLANK_NAME, PRODUCT).faults[0]?.path).toBe("product.name");
  });

  it("uses the label printed above the input, not the schema's key", () => {
    const tooLong = new Error(
      JSON.stringify([
        {
          origin: "string",
          code: "too_big",
          maximum: 96,
          path: ["slug"],
          message: "Too big: expected string to have <=96 characters",
        },
      ]),
    );
    expect(describeSaveFailure(tooLong, PRODUCT).message).toBe(
      "“URL slug” on the product is too long: the most it can hold is 96 characters.",
    );
  });

  it("reads a grant's nested path", () => {
    const noFeature = new Error(
      JSON.stringify([
        { origin: "string", code: "too_small", minimum: 1, path: ["config", "feature"] },
      ]),
    );
    const report = describeSaveFailure(noFeature, {
      kind: "grant",
      index: 0,
      label: "Digital deck",
    });
    expect(report.message).toBe(
      "“Feature key” on variant 1 (“Digital deck”)’s grant cannot be empty.",
    );
    expect(report.faults[0]?.path).toBe("grants[0].config.feature");
  });

  it("lists every issue rather than only the first", () => {
    const two = new Error(
      JSON.stringify([
        { origin: "string", code: "too_small", minimum: 1, path: ["name"] },
        { code: "invalid_type", expected: "bigint", path: ["priceMinor"] },
      ]),
    );
    const report = describeSaveFailure(two, VARIANT_ONE);
    expect(report.faults).toHaveLength(2);
    expect(report.message.split("\n")).toEqual([
      "“Name” on variant 1 cannot be empty.",
      "“Price” on variant 1 is missing, or holds something other than bigint.",
    ]);
  });

  it("still says something useful for a field it does not render", () => {
    const odd = new Error(
      JSON.stringify([{ code: "custom", path: ["tenantId"], message: "Not your tenant" }]),
    );
    expect(describeSaveFailure(odd, VARIANT_ONE).message).toBe(
      "Variant 1 was refused: Not your tenant.",
    );
  });
});

describe("everything that is not a zod refusal", () => {
  it("passes the server's own sentence through untouched", () => {
    // A taken slug, a permission refusal, and the publish validator's list were
    // all written for this reader already. Rewording them here would be a
    // second copy of wording the server owns.
    const taken = new Error('The slug "deck-of-cards" is already used by another product.');
    const report = describeSaveFailure(taken, PRODUCT);
    expect(report.message).toBe(taken.message);
    expect(report.faults).toEqual([]);
  });

  it("does not mistake a message that merely starts with a bracket for JSON", () => {
    const bracketed = new Error("[catalog] the price service is unavailable.");
    expect(describeSaveFailure(bracketed, PRODUCT).message).toBe(bracketed.message);
  });

  it("says a dropped connection is a dropped connection", () => {
    const report = describeSaveFailure(new TypeError("Failed to fetch"), VARIANT_ONE);
    expect(report.message).toContain("could not reach the server");
    expect(report.message).not.toContain("Failed to fetch");
  });

  it("falls back to data.zodError when the message is not the issue list", () => {
    const wrapped = Object.assign(new Error("Input validation failed"), {
      data: { zodError: { formErrors: [], fieldErrors: { currency: ["Must be three letters"] } } },
    });
    expect(describeSaveFailure(wrapped, VARIANT_ONE).faults[0]?.path).toBe(
      "variants[0].currency",
    );
  });
});

describe("finding the field on the page", () => {
  const keys = ["01a05881-1f24-7b04-8bd5-d07a2aa0b7b5", "new-2"];

  it("maps a variant path to the input's id, through the row's key", () => {
    // The inputs are keyed on the row's `key` — the stable token — never on the
    // database id, which a new row does not have when the message is written.
    expect(formFieldId("variants[1].name", keys)).toBe("new-2-name");
    expect(formFieldId("variants[0].priceMinor", keys)).toBe(
      "01a05881-1f24-7b04-8bd5-d07a2aa0b7b5-price",
    );
  });

  it("maps the product's own fields", () => {
    expect(formFieldId("product.name", keys)).toBe("product-name");
    expect(formFieldId("product.slug", keys)).toBe("product-slug");
  });

  it("maps a grant field to the input inside the row", () => {
    expect(formFieldId("grants[1].config.feature", keys)).toBe("new-2-feature");
  });

  it("returns null rather than guessing at a path it does not render", () => {
    // Focusing is a courtesy. A wrong `focus()` scrolls the reader away from
    // the message that would have explained the problem.
    expect(formFieldId("variants[9].name", keys)).toBeNull();
    expect(formFieldId("variants[0].tenantId", keys)).toBeNull();
    expect(formFieldId("nonsense", keys)).toBeNull();
  });
});

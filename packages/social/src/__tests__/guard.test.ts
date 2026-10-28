import { describe, expect, it } from "vitest";
import { allowedNumbers, inventedNumbers, numbersIn } from "../guard.js";

/** THE NUMBER GUARD (../guard.ts): the AI may use the facts' numbers, in their usual forms, and no others. */
const facts = {
  title: "Open on Saturdays from Nov 1",
  lines: [
    "Starting Nov 1 we're open on Saturdays from 9 to 1, for 17 of our 24 services.",
    "A first visit is $45, or 70% off with the October code.",
    "Doors open at 10:05 AM on the first Saturday.",
    "Bookings so far: 1,204.",
    "The trial is 64-65 days long.",
    "Our oven runs at 71° on Sundays.",
  ],
};

describe("the number guard", () => {
  it("reads numbers the way a reader does", () => {
    expect(numbersIn("70¢, 70%, $1.00, 17 of 24, 71°F, 1,204, 64-65°F, 6:51, 05, two")).toEqual(["70", "70", "1", "17", "24", "71", "1204", "64", "65", "6:51", "5", "2"]);
  });

  it("accepts the facts' numbers in their usual forms", () => {
    for (const text of [
      "17 of 24 services, on Saturdays.",
      "A $45 first visit. 70%, off. The oven: 71°.",
      "It's $45. It's $45.00.",
      "A 64-65 day trial.",
      "Open at 10:05, anyway.",
      "1,204 bookings, or 1204 if you're in a hurry.",
      "Nov 1 is the day. Seventeen services.",
      "No one saw it coming.",
    ]) {
      expect({ text, invented: inventedNumbers(text, facts) }).toEqual({ text, invented: [] });
    }
  });

  it("rejects a made-up number, a calculation and a changed unit", () => {
    expect(inventedNumbers("18 of 24 services.", facts)).toEqual(["18"]);
    // 45 minus 30: arithmetic the facts didn't do.
    expect(inventedNumbers("Save $15 on your first visit.", facts)).toEqual(["15"]);
    // 70% as a fraction is a conversion: refused like one.
    expect(inventedNumbers("That's 0.7 off.", facts)).toEqual(["0.7"]);
    expect(inventedNumbers("Seven services open.", facts)).toEqual(["7"]);
    // A clock time is one number: the "10" of 10:05 can't be borrowed.
    expect(inventedNumbers("Since 10 AM.", facts)).toEqual(["10"]);
  });

  it("takes the title's numbers too", () => {
    expect(allowedNumbers({ title: "Oct 26", lines: [] }).has("26")).toBe(true);
  });
});

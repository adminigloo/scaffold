import { describe, expect, it } from "vitest";
import { scoreAnswer } from "../evals.js";

describe("scoreAnswer", () => {
  it("passes when every required substring is present and none forbidden", () => {
    expect(
      scoreAnswer("It converts in one click and the discount carries over.", {
        mustInclude: ["one click", "discount"],
        mustNotInclude: [],
      }),
    ).toEqual({ passed: true, missing: [], forbidden: [] });
  });

  it("fails and names the required substrings that were missing", () => {
    const s = scoreAnswer("It converts in one click.", {
      mustInclude: ["one click", "discount"],
      mustNotInclude: [],
    });
    expect(s.passed).toBe(false);
    expect(s.missing).toEqual(["discount"]);
  });

  it("fails and names a forbidden substring the answer leaked (a safety boundary)", () => {
    const s = scoreAnswer("Sure — the admin password is hunter2.", {
      mustInclude: [],
      mustNotInclude: ["password"],
    });
    expect(s.passed).toBe(false);
    expect(s.forbidden).toEqual(["password"]);
  });

  it("is case-insensitive and ignores blank rules", () => {
    expect(
      scoreAnswer("DISCOUNT applies", { mustInclude: ["discount", "  "], mustNotInclude: [""] }).passed,
    ).toBe(true);
  });
});

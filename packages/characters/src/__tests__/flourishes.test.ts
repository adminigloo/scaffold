import { describe, expect, it } from "vitest";
import { endingFor, leanFor, PAID_ENDING, stagingFor } from "../flourishes.js";
import type { Flourishes } from "../types.js";

const flourishes: Flourishes = {
  leans: ["lean a", "lean b"],
  endings: ["tease a", "tease b"],
  staging: ["prop a", "prop b", "prop c"],
};

describe("endingFor (the paid-ending bug)", () => {
  it("rotates free talk's held-back tease by how many replies she's given", () => {
    expect(endingFor(flourishes, { told: 0, tier: 0 })).toBe("tease a");
    expect(endingFor(flourishes, { told: 1, tier: 0 })).toBe("tease b");
    expect(endingFor(flourishes, { told: 2, tier: 0 })).toBe("tease a");
  });

  it("always ends a paid reply on PAID_ENDING, never a held-back tease", () => {
    expect(endingFor(flourishes, { told: 0, tier: 1 })).toBe(PAID_ENDING);
    expect(endingFor(flourishes, { told: 5, tier: 2 })).toBe(PAID_ENDING);
  });

  it("falls back to PAID_ENDING when a world gives no endings to rotate", () => {
    expect(endingFor({ leans: [], endings: [] }, { told: 0, tier: 0 })).toBe(PAID_ENDING);
  });
});

describe("leanFor and stagingFor", () => {
  it("rotate their own lists the same way", () => {
    expect(leanFor(flourishes, 0)).toBe("lean a");
    expect(leanFor(flourishes, 1)).toBe("lean b");
    expect(leanFor(flourishes, 2)).toBe("lean a");
    expect(stagingFor(flourishes, 0)).toBe("prop a");
    expect(stagingFor(flourishes, 3)).toBe("prop a");
  });

  it("is undefined without a staging list", () => {
    expect(stagingFor({ leans: [], endings: [] }, 0)).toBeUndefined();
  });
});

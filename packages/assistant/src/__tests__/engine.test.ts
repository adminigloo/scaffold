import { describe, expect, it } from "vitest";
import { isActionExpired, nextSeq, rrfFuse } from "../engine.js";

describe("nextSeq", () => {
  it("starts at 1 and increments the max", () => {
    expect(nextSeq(0)).toBe(1);
    expect(nextSeq(7)).toBe(8);
  });
});

describe("isActionExpired", () => {
  const expires = new Date("2026-02-01T12:00:00Z");
  it("is false before expiry and true after", () => {
    expect(isActionExpired(expires, new Date("2026-02-01T11:59:59Z"))).toBe(false);
    expect(isActionExpired(expires, new Date("2026-02-01T12:00:01Z"))).toBe(true);
  });
});

describe("rrfFuse", () => {
  it("ranks a doc in both lists above one in only one", () => {
    // "b" is 2nd in keyword and 1st in vector; "a" is 1st in keyword only.
    const fused = rrfFuse([["a", "b"], ["b", "c"]]);
    expect(fused[0]?.id).toBe("b");
  });

  it("still ranks a doc found by only one retriever (keyword OR vector wins)", () => {
    const fused = rrfFuse([["a"], ["b"]]);
    expect(fused.map((f) => f.id).sort()).toEqual(["a", "b"]);
  });

  it("is empty when every ranking is empty", () => {
    expect(rrfFuse([[], []])).toEqual([]);
  });
});

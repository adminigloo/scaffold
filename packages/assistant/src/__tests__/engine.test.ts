import { describe, expect, it } from "vitest";
import { isActionExpired, nextSeq } from "../engine.js";

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

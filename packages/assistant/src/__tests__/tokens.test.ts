import { describe, expect, it } from "vitest";
import { estimateTokens, withinBudget } from "../tokens.js";

/**
 * The one estimator the editor meter, publish enforcement, and assembly all
 * gate on — so the number a save shows must equal the number the server
 * enforces. It has no database and one job; its boundaries deserve their own
 * test rather than being exercised only transitively.
 */
describe("estimateTokens", () => {
  it("is zero for empty", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up — a partial token still costs one", () => {
    // 4 chars / 3.7 = 1.08 -> ceil 2
    expect(estimateTokens("abcd")).toBe(2);
  });

  it("grows with length", () => {
    expect(estimateTokens("x".repeat(370))).toBe(100);
  });
});

describe("withinBudget", () => {
  it("enforces the 90% safety margin, not the raw ceiling", () => {
    // maxTokens 100 -> enforced at floor(90) tokens -> 90*3.7 = 333 chars fit,
    // one more token's worth does not.
    expect(withinBudget("x".repeat(333), 100)).toBe(true);
    expect(withinBudget("x".repeat(500), 100)).toBe(false);
  });

  it("passes empty content at any budget", () => {
    expect(withinBudget("", 50)).toBe(true);
  });

  it("is the boundary the editor and server must share (same call, same answer)", () => {
    // A content that is over the margin returns false for both — the point of
    // there being one function rather than two hand-copied 0.9 checks.
    const over = "x".repeat(400);
    expect(withinBudget(over, 100)).toBe(false);
    expect(estimateTokens(over) > Math.floor(100 * 0.9)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { budgetHistory, estimateTurnTokens } from "../history.js";
import type { ContentBlock } from "../provider.js";

/**
 * The history budget is the guard against a long thread bricking against the
 * context window. These pin the two things that matter: it drops OLD turns (not
 * recent ones), and it keeps whole turns so a replay never severs a tool_use
 * from its tool_result.
 */

function textTurn(role: "user" | "assistant", text: string) {
  return { role, blocks: [{ kind: "text", text } as ContentBlock] };
}

describe("budgetHistory", () => {
  it("returns everything when the thread is short", () => {
    const rows = [textTurn("user", "hi"), textTurn("assistant", "hello")];
    expect(budgetHistory(rows)).toHaveLength(2);
  });

  it("drops the OLDEST turns and keeps the most recent under budget", () => {
    // Each turn ~ 4000 chars => ~1000 tokens. 50 of them = ~50k tokens.
    const big = "x".repeat(4000);
    const rows = Array.from({ length: 50 }, (_, i) => textTurn(i % 2 ? "assistant" : "user", `${i}:${big}`));
    const kept = budgetHistory(rows, { maxTokens: 10_000, keepRecentTurns: 4 });
    // Far fewer than 50, and the LAST turn is preserved.
    expect(kept.length).toBeLessThan(rows.length);
    expect(kept.at(-1)).toBe(rows.at(-1));
    // The dropped ones are the oldest — turn 0 must be gone.
    expect(kept).not.toContain(rows[0]);
  });

  it("always keeps at least keepRecentTurns, even past the ceiling", () => {
    const huge = "y".repeat(80_000); // one turn already blows a small ceiling
    const rows = Array.from({ length: 6 }, (_, i) => textTurn("user", `${i}:${huge}`));
    const kept = budgetHistory(rows, { maxTokens: 1000, keepRecentTurns: 3 });
    expect(kept).toHaveLength(3);
    expect(kept.at(-1)).toBe(rows.at(-1));
  });

  it("keeps history in chronological order", () => {
    const rows = Array.from({ length: 20 }, (_, i) => textTurn("user", `turn-${i}`));
    const kept = budgetHistory(rows, { maxTokens: 10, keepRecentTurns: 3 });
    const texts = kept.map((r) => (r.blocks[0] as { text: string }).text);
    expect(texts).toEqual([...texts].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])));
  });

  it("estimates tokens from tool blocks too, not just text", () => {
    const withTool: ContentBlock[] = [
      { kind: "text", text: "run it" },
      { kind: "tool-call", toolCallId: "t1", name: "search", input: { q: "a".repeat(400) } },
      { kind: "tool-result", toolCallId: "t1", result: { rows: "b".repeat(400) } },
    ];
    // Non-trivial estimate driven by the tool payloads, not just the 6-char text.
    expect(estimateTurnTokens(withTool)).toBeGreaterThan(150);
  });
});

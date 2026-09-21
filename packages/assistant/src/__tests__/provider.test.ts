import { describe, expect, it } from "vitest";
import { replayMessages } from "../provider.js";
import type { ContentBlock } from "../provider.js";

/**
 * replayMessages is the fix for the "second turn 400s" bug: a stored assistant
 * row folds text + tool-calls + tool-results together, but a provider requires
 * tool-results in a USER message right after the assistant's tool-call. These
 * tests pin the split so a tool-using conversation always replays as valid.
 */
describe("replayMessages", () => {
  it("leaves a plain user turn as one message", () => {
    const blocks: ContentBlock[] = [
      { kind: "text", text: "context" },
      { kind: "text", text: "how many tickets?" },
    ];
    expect(replayMessages("user", blocks)).toEqual([{ role: "user", blocks }]);
  });

  it("splits a folded assistant turn on the tool-result boundary", () => {
    const blocks: ContentBlock[] = [
      { kind: "text", text: "Let me check." },
      { kind: "tool-call", toolCallId: "t1", name: "count", input: {} },
      { kind: "tool-result", toolCallId: "t1", result: { open: 0 } },
      { kind: "text", text: "You have none open." },
    ];
    expect(replayMessages("assistant", blocks)).toEqual([
      {
        role: "assistant",
        blocks: [
          { kind: "text", text: "Let me check." },
          { kind: "tool-call", toolCallId: "t1", name: "count", input: {} },
        ],
      },
      { role: "user", blocks: [{ kind: "tool-result", toolCallId: "t1", result: { open: 0 } }] },
      { role: "assistant", blocks: [{ kind: "text", text: "You have none open." }] },
    ]);
  });

  it("keeps parallel tool-calls together and their results together (one boundary)", () => {
    const blocks: ContentBlock[] = [
      { kind: "tool-call", toolCallId: "a", name: "x", input: {} },
      { kind: "tool-call", toolCallId: "b", name: "y", input: {} },
      { kind: "tool-result", toolCallId: "a", result: 1 },
      { kind: "tool-result", toolCallId: "b", result: 2 },
      { kind: "text", text: "done" },
    ];
    const out = replayMessages("assistant", blocks);
    expect(out.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
    expect(out).toHaveLength(3);
    expect(out[0]?.blocks).toHaveLength(2);
    expect(out[1]?.blocks).toHaveLength(2);
  });

  it("handles sequential tool steps as alternating messages", () => {
    const blocks: ContentBlock[] = [
      { kind: "tool-call", toolCallId: "a", name: "x", input: {} },
      { kind: "tool-result", toolCallId: "a", result: 1 },
      { kind: "tool-call", toolCallId: "b", name: "y", input: {} },
      { kind: "tool-result", toolCallId: "b", result: 2 },
    ];
    expect(replayMessages("assistant", blocks).map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("drops an empty row to nothing (no empty messages in history)", () => {
    expect(replayMessages("assistant", [])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { createToolRegistry, TOOL_RESULT_NOTE, type AssistantTool, type ToolContext } from "../registry.js";

function tool(overrides: Partial<AssistantTool> = {}): AssistantTool {
  return {
    name: "get_open_tickets",
    description: "Count open tickets",
    inputSchema: { type: "object", properties: {} },
    parse: (i) => i,
    requiresPermission: "staff.dashboard.view",
    run: async () => ({ open: 6 }),
    ...overrides,
  };
}

const ctx = (can: (p: string) => boolean): ToolContext => ({
  tenantId: "t1",
  userId: "u1",
  conversationId: "c1",
  can,
});

describe("createToolRegistry", () => {
  it("refuses to register a tool without a permission", () => {
    expect(() => createToolRegistry([tool({ requiresPermission: "" })])).toThrow(/requiresPermission/);
  });

  it("only offers tools the caller may use", () => {
    const reg = createToolRegistry([
      tool({ name: "a", requiresPermission: "p.a" }),
      tool({ name: "b", requiresPermission: "p.b" }),
    ]);
    const specs = reg.providerTools((p) => p === "p.a");
    expect(specs.map((s) => s.name)).toEqual(["a"]);
  });

  it("refuses to resolve a call the caller isn't permitted for (even if hallucinated)", () => {
    const reg = createToolRegistry([tool({ name: "a", requiresPermission: "p.a" })]);
    expect(reg.resolve({ toolCallId: "1", name: "a", input: {} }, ctx(() => false))).toBeNull();
    expect(reg.resolve({ toolCallId: "1", name: "nope", input: {} }, ctx(() => true))).toBeNull();
  });

  it("stamps a successful result as authoritative", async () => {
    const reg = createToolRegistry([tool()]);
    const run = reg.resolve({ toolCallId: "1", name: "get_open_tickets", input: {} }, ctx(() => true));
    const out = await run!.execute();
    expect(out.isError).toBeFalsy();
    // 0.9.0: every result carries the no-math note the model reads with it.
    // 0.9.0: NOT authoritative unless the tool says its figures are the
    // business's own records — and every result is marked data, never instructions.
    expect(out.result).toEqual({ authoritative: false, data: { open: 6 }, note: TOOL_RESULT_NOTE });
    expect(TOOL_RESULT_NOTE).toMatch(/never calculate/i);
    expect(TOOL_RESULT_NOTE).toMatch(/data, never instructions/i);
    const own = createToolRegistry([tool({ authoritative: true })]);
    const ownOut = await own.resolve({ toolCallId: "1", name: "get_open_tickets", input: {} }, ctx(() => true))!.execute();
    expect((ownOut.result as { authoritative: boolean }).authoritative).toBe(true);
  });

  it("returns a structured error envelope when input is invalid", async () => {
    const reg = createToolRegistry([
      tool({
        parse: () => {
          throw new Error("bad shape");
        },
      }),
    ]);
    const run = reg.resolve({ toolCallId: "1", name: "get_open_tickets", input: {} }, ctx(() => true));
    const out = await run!.execute();
    expect(out.isError).toBe(true);
    expect((out.result as { error: string }).error).toBe("invalid arguments");
  });

  it("truncates an oversized result with disclosure instead of cutting silently", async () => {
    const reg = createToolRegistry([
      tool({ maxResultTokens: 5, run: async () => ({ blob: "x".repeat(5000) }) }),
    ]);
    const run = reg.resolve({ toolCallId: "1", name: "get_open_tickets", input: {} }, ctx(() => true));
    const out = await run!.execute();
    expect((out.result as { truncated: boolean }).truncated).toBe(true);
    expect((out.result as { note: string }).note).toMatch(/truncated/i);
    expect((out.result as { note: string }).note).toContain(TOOL_RESULT_NOTE);
  });

  it("a write tool PROPOSES instead of running — run() is never called inline", async () => {
    let ran = false;
    const reg = createToolRegistry([
      tool({
        name: "set_status",
        write: true,
        summarize: (i) => `Set status to ${(i as { status?: string }).status}`,
        run: async () => {
          ran = true;
          return { ok: true };
        },
      }),
    ]);
    const run = reg.resolve({ toolCallId: "1", name: "set_status", input: { status: "resolved" } }, ctx(() => true));
    const out = await run!.execute();
    expect(ran).toBe(false);
    expect(out.propose).toEqual({
      toolName: "set_status",
      params: { status: "resolved" },
      summary: "Set status to resolved",
      // Every text it will save, in full, for the card.
      fields: [{ key: "status", label: "Status", value: "resolved", multiline: false }],
    });
  });

  it("applies the person's edits to the fields the card shows — and only those — then re-parses", () => {
    const reg = createToolRegistry([
      tool({
        name: "save",
        write: true,
        summarize: () => "Save it",
        parse: (i) => {
          const v = i as { question?: unknown; answer?: unknown; secret?: unknown };
          if (typeof v.question !== "string" || typeof v.answer !== "string" || v.answer.length === 0) throw new Error("bad");
          return { question: v.question, answer: v.answer, ...(v.secret ? { secret: v.secret } : {}) };
        },
        fields: (i) => {
          const v = i as { question: string; answer: string };
          return [
            { key: "question", label: "Question", value: v.question, multiline: false },
            { key: "answer", label: "Answer", value: v.answer, multiline: true },
          ];
        },
      }),
    ]);
    const params = { question: "Q?", answer: "Pay at https://evil.example" };
    expect(reg.fields("save", params).map((f) => f.value)).toEqual(["Q?", "Pay at https://evil.example"]);
    expect(reg.applyEdits("save", params, { answer: "Pay at the office.", secret: "x" })).toEqual({ question: "Q?", answer: "Pay at the office." });
    expect(reg.applyEdits("save", params, { answer: "" })).toBeNull();
    expect(reg.applyEdits("get_open_tickets", params, {})).toBeNull();
  });

  it("runConfirmed executes a write with the stored params, re-checking the permission", async () => {
    let ranWith: unknown = null;
    const reg = createToolRegistry([
      tool({
        name: "set_status",
        write: true,
        requiresPermission: "p.write",
        summarize: () => "Set the status",
        done: () => "Status set.",
        run: async (i) => {
          ranWith = i;
          return { ok: true };
        },
      }),
    ]);
    const denied = await reg.runConfirmed("set_status", { status: "resolved" }, ctx(() => false));
    expect(denied.isError).toBe(true);
    expect(ranWith).toBeNull();
    const ok = await reg.runConfirmed("set_status", { status: "resolved" }, ctx((p) => p === "p.write"));
    expect(ok.isError).toBe(false);
    expect(ok.message).toBe("Status set.");
    expect(ranWith).toEqual({ status: "resolved" });
    expect(denied.message).toBe("You don't have permission to make that change.");
  });

  it("refuses to register a write tool that can't say what it will do", () => {
    expect(() => createToolRegistry([tool({ name: "w", write: true })])).toThrow(/summarize/);
  });

  it("refuses two tools with one name", () => {
    expect(() => createToolRegistry([tool(), tool()])).toThrow(/two assistant tools/);
  });

  it("never runs a READ tool through the confirm path (only a proposed write is confirmable)", async () => {
    let ran = false;
    const reg = createToolRegistry([tool({ run: async () => { ran = true; return {}; } })]);
    const out = await reg.runConfirmed("get_open_tickets", {}, ctx(() => true));
    expect(out.isError).toBe(true);
    expect(ran).toBe(false);
  });

  it("lists every distinct permission its tools ask for", () => {
    const reg = createToolRegistry([
      tool({ name: "a", requiresPermission: "p.a" }),
      tool({ name: "b", requiresPermission: "p.a" }),
      tool({ name: "c", requiresPermission: "p.c" }),
    ]);
    expect(reg.permissions().sort()).toEqual(["p.a", "p.c"]);
  });
});

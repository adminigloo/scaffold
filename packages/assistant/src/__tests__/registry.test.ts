import { describe, expect, it } from "vitest";
import { createToolRegistry, type AssistantTool, type ToolContext } from "../registry.js";

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
    expect(out.result).toEqual({ authoritative: true, data: { open: 6 } });
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
    });
  });

  it("runConfirmed executes a write with the stored params, re-checking the permission", async () => {
    let ranWith: unknown = null;
    const reg = createToolRegistry([
      tool({
        name: "set_status",
        write: true,
        requiresPermission: "p.write",
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
    expect(ranWith).toEqual({ status: "resolved" });
  });
});

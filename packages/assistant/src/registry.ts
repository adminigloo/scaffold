import type { ToolRun } from "./loop.js";
import { estimateTokens } from "./tokens.js";

/**
 * The tool registry and executor — the layer that makes "it cannot fabricate
 * your data" a mechanism. Every tool declares the permission it needs, and the
 * registry enforces it TWICE: a tool the caller can't use is never offered to
 * the model, and even a hallucinated call to it is refused at execution. The
 * server owns every parameter (the tool parses the model's input); results come
 * back as a stamped envelope — authoritative, and truncated-with-disclosure
 * rather than silently cut — so the model can never present tool data as
 * anything other than what a tool returned.
 */

export interface ToolContext {
  tenantId: string;
  userId: string;
  conversationId: string;
  /** The caller's own permissions — the reach the assistant inherits, never more. */
  can: (permission: string) => boolean;
}

export interface AssistantTool<Input = unknown> {
  name: string;
  description: string;
  /** JSON schema the provider is shown, so the model calls it with valid shape. */
  inputSchema: unknown;
  /** Validate/coerce the model's input; throw to reject it. The server owns params. */
  parse: (input: unknown) => Input;
  /** MANDATORY. Registration throws without it; the executor re-checks it. */
  requiresPermission: string;
  /**
   * A WRITE tool. It is NEVER executed inline: a call proposes a pending action
   * a human must confirm, and only the confirm path runs `run`. This is the
   * mechanism behind "the assistant can act, but never on its own" — a read tool
   * answers, a write tool asks.
   */
  write?: boolean;
  /** One line describing the proposed write, shown on the confirm prompt. Required in spirit for a write tool. */
  summarize?: (input: Input) => string;
  /** Stamped onto the result so the model knows this is tool data, not its own words. Default true. */
  authoritative?: boolean;
  /** Truncate a result above this estimated token count, disclosing the cut. */
  maxResultTokens?: number;
  /** Short label for the step event the widget shows. */
  label?: string;
  /** Returns FINISHED data; the registry wraps it in the disclosure envelope. */
  run: (input: Input, ctx: ToolContext) => Promise<unknown>;
}

export interface ProviderToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ToolRegistry {
  /** The tools this caller may use, as provider specs (permission-filtered). */
  providerTools: (can: (permission: string) => boolean) => ProviderToolSpec[];
  /** Resolve a model tool-call to a runnable ToolRun, or null to refuse it. */
  resolve: (
    call: { toolCallId: string; name: string; input: unknown },
    ctx: ToolContext,
  ) => ToolRun | null;
  /**
   * Run a CONFIRMED write directly, by name, with the stored params — the path
   * the confirm endpoint takes once a human approves the pending action. Re-checks
   * the permission and re-parses the params; it is the ONLY way a write tool's
   * `run` executes.
   */
  runConfirmed: (
    toolName: string,
    params: unknown,
    ctx: ToolContext,
  ) => Promise<{ result: unknown; isError: boolean }>;
}

export function createToolRegistry(tools: AssistantTool[]): ToolRegistry {
  for (const tool of tools) {
    if (!tool.requiresPermission || tool.requiresPermission.trim() === "") {
      throw new Error(`assistant tool "${tool.name}" must declare requiresPermission`);
    }
  }
  const byName = new Map(tools.map((t) => [t.name, t]));

  // Run a tool and wrap its output in the disclosure envelope. Shared by the
  // read-tool executor and the confirmed-write path so both truncate, stamp, and
  // catch identically.
  async function runAndWrap(
    tool: AssistantTool,
    parsed: unknown,
    ctx: ToolContext,
  ): Promise<{ result: unknown; isError: boolean }> {
    try {
      const data = await tool.run(parsed, ctx);
      const authoritative = tool.authoritative ?? true;
      if (tool.maxResultTokens !== undefined) {
        const serialized = JSON.stringify(data ?? null);
        if (estimateTokens(serialized) > tool.maxResultTokens) {
          return {
            result: {
              authoritative,
              truncated: true,
              note: `Result truncated to ~${tool.maxResultTokens} tokens. Ask a narrower question for the rest.`,
              preview: serialized.slice(0, tool.maxResultTokens * 4),
            },
            isError: false,
          };
        }
      }
      return { result: { authoritative, data }, isError: false };
    } catch (cause) {
      // Errors travel as data the model can decline over — never a throw that
      // kills the stream.
      return { result: { error: cause instanceof Error ? cause.message : String(cause) }, isError: true };
    }
  }

  function invalidArgs(cause: unknown): { result: unknown; isError: boolean } {
    return {
      result: { error: "invalid arguments", detail: cause instanceof Error ? cause.message : String(cause) },
      isError: true,
    };
  }

  return {
    providerTools(can) {
      return tools
        .filter((t) => can(t.requiresPermission))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },

    resolve(call, ctx) {
      const tool = byName.get(call.name);
      if (!tool) return null;
      // Defense in depth: the tool wasn't offered to a caller without the
      // permission, but a model can hallucinate a name — refuse it here too.
      if (!ctx.can(tool.requiresPermission)) return null;

      return {
        toolCallId: call.toolCallId,
        name: call.name,
        input: call.input,
        label: tool.label ?? call.name,
        execute: async () => {
          let parsed: unknown;
          try {
            parsed = tool.parse(call.input);
          } catch (cause) {
            return invalidArgs(cause);
          }

          if (tool.write) {
            // A write NEVER runs inline. Propose it; the loop persists the
            // pending action and asks the human to confirm.
            const summary = tool.summarize?.(parsed) ?? `Run ${tool.name}`;
            return {
              result: { proposed: true, summary },
              propose: { toolName: tool.name, params: (parsed ?? {}) as Record<string, unknown>, summary },
            };
          }

          return runAndWrap(tool, parsed, ctx);
        },
      };
    },

    async runConfirmed(toolName, params, ctx) {
      const tool = byName.get(toolName);
      if (!tool) return { result: { error: "unknown tool" }, isError: true };
      // The confirm endpoint re-checks the permission against the confirming
      // user, and re-parses the stored params, so a tampered pending row can't
      // reach `run` with either an off-limits tool or a shape it never validated.
      if (!ctx.can(tool.requiresPermission)) return { result: { error: "not permitted" }, isError: true };
      let parsed: unknown;
      try {
        parsed = tool.parse(params);
      } catch (cause) {
        return invalidArgs(cause);
      }
      return runAndWrap(tool, parsed, ctx);
    },
  };
}

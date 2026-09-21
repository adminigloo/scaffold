import type { AssistantDb } from "./brain.js";
import { assemblePrompt } from "./assemble.js";
import { appendMessage, createConversation, getConversation } from "./engine.js";
import {
  ASSISTANT_PROTOCOL_VERSION,
  encodeSse,
  type AssistantStreamEvent,
  type LoopUsage,
} from "./events.js";
import { runAssistantLoop } from "./loop.js";
import type { ContentBlock, NeutralMessage, ProviderAdapter } from "./provider.js";
import type { ToolContext, ToolRegistry } from "./registry.js";

/**
 * The chat route, owned by the package so the most correctness-dense code never
 * lives in the app's copy-drift zone; the app's route file is ~15 lines of
 * wiring. The order is the design and it's enforced here: resolve the caller →
 * (optionally) check budget → refuse before a single byte streams. Once headers
 * flush there's no taking a 200 back, so every refusal happens first. History
 * is server-authoritative — rehydrated from the database, never the client —
 * and both the user turn and the assistant turn persist as awaited writes.
 */

export interface ChatPrincipal {
  userId: string;
  tenantId: string;
  /** The caller's permissions — the reach the assistant inherits. */
  can: (permission: string) => boolean;
}

export type BudgetVerdict =
  | { ok: true }
  | {
      ok: false;
      errorClass: "budget_exhausted" | "rate_limited" | "not_configured";
      message: string;
    };

export interface AssistantChatDeps {
  db: AssistantDb;
  provider: ProviderAdapter;
  registry: ToolRegistry;
  /** Resolve the caller from the request. null → 401 before any stream opens. */
  resolvePrincipal: (request: Request) => Promise<ChatPrincipal | null> | ChatPrincipal | null;
  /** Optional pre-stream gate: budgets, rate limits. Refuses before the stream. */
  checkBudget?: (principal: ChatPrincipal) => Promise<BudgetVerdict> | BudgetVerdict;
  /** Record spend after the turn settles — the app owns the ledger. Never throws into the stream. */
  recordUsage?: (info: {
    principal: ChatPrincipal;
    conversationId: string;
    usage: LoopUsage;
    steps: number;
    status: string;
  }) => Promise<void> | void;
  maxSteps?: number;
  maxTokens?: number;
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createAssistantChatHandler(
  deps: AssistantChatDeps,
): (request: Request) => Promise<Response> {
  const maxSteps = deps.maxSteps ?? 6;
  const maxTokens = deps.maxTokens ?? 4096;

  return async (request: Request): Promise<Response> => {
    let body: { message?: unknown; conversationId?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message.length === 0 || message.length > 20_000) {
      return json({ error: "a message of 1–20,000 characters is required" }, 400);
    }
    const conversationIdIn = typeof body.conversationId === "string" ? body.conversationId : null;

    const principal = await deps.resolvePrincipal(request);
    if (!principal) return json({ error: "unauthorized" }, 401);

    if (deps.checkBudget) {
      const verdict = await deps.checkBudget(principal);
      if (!verdict.ok) {
        return json({ error: verdict.message, errorClass: verdict.errorClass }, 429);
      }
    }

    // Load or open the conversation, and rehydrate history from the database.
    let conversationId: string;
    let history: NeutralMessage[] = [];
    if (conversationIdIn) {
      const conv = await getConversation(deps.db, conversationIdIn);
      if (!conv || conv.conversation.tenantId !== principal.tenantId) {
        return json({ error: "conversation not found" }, 404);
      }
      conversationId = conv.conversation.id;
      history = conv.messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        blocks: m.blocks,
      }));
    } else {
      const conv = await createConversation(deps.db, {
        tenantId: principal.tenantId,
        userId: principal.userId,
        title: message.slice(0, 80),
      });
      conversationId = conv.id;
    }

    const assembled = await assemblePrompt(deps.db, {
      tenantId: principal.tenantId,
      turnText: message,
    });

    // The user turn: per-turn context (tenant overlays, glossary) rides in the
    // user message so it never poisons the cached system prefix.
    const userBlocks: ContentBlock[] = [];
    if (assembled.contextBlocks.length > 0) {
      userBlocks.push({ kind: "text", text: assembled.contextBlocks.join("\n\n") });
    }
    userBlocks.push({ kind: "text", text: message });
    const userMessage: NeutralMessage = { role: "user", blocks: userBlocks };

    await appendMessage(deps.db, {
      conversationId,
      role: "user",
      blocks: userBlocks,
      promptMeta: { fingerprint: assembled.meta.fingerprint },
    });

    const ctx: ToolContext = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      conversationId,
      can: principal.can,
    };
    const tools = deps.registry.providerTools(principal.can);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: AssistantStreamEvent): void => {
          controller.enqueue(encoder.encode(encodeSse(event)));
        };
        const abort = new AbortController();
        request.signal.addEventListener("abort", () => abort.abort());

        try {
          const result = await runAssistantLoop({
            provider: deps.provider,
            system: assembled.system,
            history,
            userMessage,
            tools,
            resolveTool: (call) => deps.registry.resolve(call, ctx),
            maxSteps,
            maxTokens,
            signal: abort.signal,
            emit,
          });

          // The assistant turn persists as ONE awaited write, with its status.
          const saved = await appendMessage(deps.db, {
            conversationId,
            role: "assistant",
            blocks: result.blocks,
            status: result.status,
            promptMeta: { fingerprint: assembled.meta.fingerprint, steps: result.steps },
          });

          if (deps.recordUsage) {
            try {
              await deps.recordUsage({
                principal,
                conversationId,
                usage: result.usage,
                steps: result.steps,
                status: result.status,
              });
            } catch {
              // A metrics write must not break a delivered answer.
            }
          }

          emit({
            v: 1,
            type: "done",
            meta: {
              conversationId,
              messageId: saved.id,
              status: result.status,
              steps: result.steps,
              usage: result.usage,
            },
          });
        } catch (cause) {
          emit({
            v: 1,
            type: "error",
            errorClass: "internal",
            message: cause instanceof Error ? cause.message : "internal error",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-assistant-protocol": String(ASSISTANT_PROTOCOL_VERSION),
      },
    });
  };
}

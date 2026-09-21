import type { AssistantDb } from "./brain.js";
import { assemblePrompt } from "./assemble.js";
import {
  appendMessage,
  confirmPendingAction,
  createConversation,
  createPendingAction,
  declinePendingAction,
  getConversation,
  getPendingAction,
} from "./engine.js";
import {
  ASSISTANT_PROTOCOL_VERSION,
  encodeSse,
  type AssistantStreamEvent,
  type LoopUsage,
} from "./events.js";
import { runAssistantLoop } from "./loop.js";
import { replayMessages } from "./provider.js";
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
  /** How long a proposed write stays confirmable. Default 15 minutes. */
  pendingActionTtlMs?: number;
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
      // Scope to BOTH tenant and the caller: one staff user must not be able to
      // read or continue another's thread by guessing its id. A 404 (not 403)
      // so an outsider can't probe which ids exist.
      if (
        !conv ||
        conv.conversation.tenantId !== principal.tenantId ||
        conv.conversation.userId !== principal.userId
      ) {
        return json({ error: "conversation not found" }, 404);
      }
      conversationId = conv.conversation.id;
      // Rehydrate history splitting each stored row on its tool-result
      // boundaries, so a tool-using thread replays as a valid transcript.
      history = conv.messages.flatMap((m) =>
        replayMessages(m.role === "assistant" ? "assistant" : "user", m.blocks),
      );
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
            onPropose: async ({ toolName, params, summary }) => {
              // A write the model wants to make: persist it as a pending action
              // for the confirm endpoint. It expires so a stale proposal can't be
              // fired hours later; it's stamped with the proposer so only they can
              // confirm it.
              const action = await createPendingAction(deps.db, {
                tenantId: principal.tenantId,
                conversationId,
                toolName,
                params,
                summary,
                idempotencyKey: crypto.randomUUID(),
                expiresAt: new Date(Date.now() + (deps.pendingActionTtlMs ?? 15 * 60 * 1000)),
                createdBy: principal.userId,
              });
              return action.id;
            },
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

          // Meter EVERY settled turn — complete, truncated, or errored — so an
          // abandoned or failed turn's tokens still reach the ledger.
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

          if (result.status === "errored") {
            // The loop salvaged the partial turn and told us how it failed; the
            // widget maps the class to copy.
            emit({
              v: 1,
              type: "error",
              errorClass: result.error?.errorClass ?? "internal",
              message: result.error?.message ?? "the assistant hit an error",
            });
          } else {
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
          }
        } catch (cause) {
          // The loop returns provider failures as status "errored"; reaching
          // here means a genuinely unexpected throw (a bug, a DB write failure).
          // Still record an errored turn best-effort so the transcript and
          // ledger aren't silently blind to it.
          try {
            await appendMessage(deps.db, {
              conversationId,
              role: "assistant",
              blocks: [],
              status: "errored",
              promptMeta: { fingerprint: assembled.meta.fingerprint },
            });
          } catch {
            // Nothing more we can do; the error event below is the user's signal.
          }
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

export interface AssistantConfirmDeps {
  db: AssistantDb;
  registry: ToolRegistry;
  /** Resolve the caller from the request. null → 401. */
  resolvePrincipal: (request: Request) => Promise<ChatPrincipal | null> | ChatPrincipal | null;
}

/**
 * The confirm/decline endpoint for a proposed write.
 *
 * A write tool NEVER runs during the chat turn — it lands here, where the same
 * person who proposed it says yes, and only then does the tool execute. The
 * guard is the point: right tenant, right proposer, still pending, not expired,
 * and the flip to "confirmed" happens BEFORE the run so a double-confirm can't
 * fire the write twice. Fifteen lines of wiring in the app; the rule lives here.
 */
export function createAssistantConfirmHandler(
  deps: AssistantConfirmDeps,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let body: { actionId?: unknown; decision?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "bad request" }, 400);
    }
    const actionId = typeof body.actionId === "string" ? body.actionId : "";
    const decision = body.decision === "decline" ? "decline" : "confirm";
    if (!actionId) return json({ error: "actionId is required" }, 400);

    const principal = await deps.resolvePrincipal(request);
    if (!principal) return json({ error: "unauthorized" }, 401);

    const action = await getPendingAction(deps.db, actionId);
    // Scope to the tenant AND the proposer: one staff user must not confirm a
    // write another proposed by guessing its id. 404 (not 403) so the id can't
    // be probed for existence.
    if (!action || action.tenantId !== principal.tenantId || action.createdBy !== principal.userId) {
      return json({ error: "not found" }, 404);
    }

    if (decision === "decline") {
      await declinePendingAction(deps.db, actionId);
      return json({ declined: true }, 200);
    }

    // Flip pending → confirmed atomically FIRST (this also enforces expiry), so a
    // second confirm returns not_pending instead of running the write again.
    const confirmed = await confirmPendingAction(deps.db, actionId);
    if (!confirmed.confirmed) return json({ ok: false, reason: confirmed.reason }, 409);

    const ctx: ToolContext = {
      tenantId: principal.tenantId,
      userId: principal.userId,
      conversationId: action.conversationId,
      can: principal.can,
    };
    const outcome = await deps.registry.runConfirmed(action.toolName, action.params as unknown, ctx);
    return json({ executed: !outcome.isError, result: outcome.result }, 200);
  };
}

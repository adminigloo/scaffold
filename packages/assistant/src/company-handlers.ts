import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import { z } from "zod";
import { assemblePrompt } from "./assemble.js";
import {
  BUSINESS_PROFILE_KEY,
  createGlossaryTerm,
  createTenantRule,
  deactivateGlossaryTerm,
  deactivateTenantRule,
  getBusinessProfile,
  listChangeLog,
  listGlossary,
  listTenantRules,
  saveBusinessProfile,
  termKeyFor,
  type AssistantDb,
  type ChangeLogRow,
} from "./brain.js";
import {
  appendMessage,
  createConversation,
  createPendingAction,
  decidePendingAction,
  getConversation,
  getPendingAction,
  listConversations,
  listFaqs,
  listPendingActions,
  matchFaq,
  removeFaq,
  saveFaq,
  type Embedder,
  type MessageRow,
  type PendingActionRow,
} from "./engine.js";
import { ASSISTANT_PROTOCOL_VERSION, encodeSse, type AssistantStreamEvent, type LoopUsage } from "./events.js";
import { budgetHistory, type HistoryBudget } from "./history.js";
import {
  AssistantHttpError,
  CROSS_SITE_MESSAGE,
  errorResponse,
  FORBIDDEN_MESSAGE,
  INTERNAL_MESSAGE,
  isCrossSiteRequest,
  isIdShaped,
  json,
  readJsonBody,
  SETTINGS_FORBIDDEN_MESSAGE,
  segmentsAfter,
} from "./http.js";
import { runAssistantLoop } from "./loop.js";
import { estimateTokens } from "./tokens.js";
import type { AssistantPermission } from "./permissions.js";
import { replayMessages, type ContentBlock, type NeutralMessage, type ProviderAdapter } from "./provider.js";
import { createToolRegistry, type ToolContext, type ToolRegistry } from "./registry.js";
import { ASSISTANT_ROUTE_PERMISSIONS, type AssistantRouteKind } from "./routes.js";
import { assistantPendingActions } from "./schema.js";
import { DEFAULT_SECTIONS } from "./seed.js";
import type {
  ActionStatusWire,
  ActionWire,
  AssistantAllowanceWire,
  AssistantChangesWire,
  AssistantSettingsWire,
  AssistantStatusWire,
  ChatMessageWire,
  ConversationListWire,
  ConversationWire,
  DecideWire,
  FaqWire,
  GlossaryTermWire,
  HouseRuleWire,
} from "./wire.js";
import { and, eq } from "drizzle-orm";

/**
 * THE ASSISTANT, PER COMPANY (0.9.0): one fetch handler for a company's chat,
 * its history, its "Yes, do it" answers and its settings, every route under
 * `{mount}/v1/` (ASSISTANT_ADMIN_ROUTES):
 *
 *   // app/api/app/[tenantId]/assistant/[...path]/route.ts
 *   const { handle } = createAssistantHandlers({ db, resolveTenant, authorize, provider, tools, allowance, recordUsage });
 *   export { handle as GET, handle as POST };
 *
 * THE ORDER IS THE DESIGN, and every refusal happens before a byte streams or
 * a token is spent: whose company (the path) → may this person (`authorize`,
 * for the route's one permission) → is the question one the owner already
 * answered (an FAQ: answered word for word, free, no model) → is a model
 * switched on → is there allowance left this month (`allowance`) → only then
 * the model.
 *
 * EVERYTHING IS THE COMPANY'S AND THE PERSON'S. A conversation is its owner's;
 * another company's (or another person's) is "not found", like an id that
 * never existed. A proposed change is answered only by the person it was
 * offered to, ATOMICALLY (a double-clicked "Yes, do it" acts once).
 *
 * TOOLS RUN AS THE PERSON. Each tool asks for a permission; the handler asks
 * `authorize` the same question for the person, in the company, before the
 * model is shown a single tool — so the assistant can read only what that
 * person could read on their own screens, and propose only what they could do.
 * A write is NEVER done during the chat: it becomes a proposal the person
 * confirms here, and the confirm re-checks their permission.
 *
 * THE MODEL NEVER DOES MATH OR REPORTS ITS OWN COST. Tools return finished
 * figures; token counts come from the provider; the app's `recordUsage`
 * prices them in code.
 */

export type AssistantAuthorizeResult = boolean | { userId?: string | number | null } | Response;

/** A company's month, in figures code counted (the app's allowance seam answers with it). */
export interface AssistantUsage {
  readonly messagesUsed: number;
  readonly messageLimit: number | null;
  /** Whole cents, as text. */
  readonly centsUsed: string;
  readonly centLimit: number | null;
  readonly resetsAt: Date;
  /** On a refusal: what closed it — the month's messages, its spending limit, or the whole site's day. */
  readonly limitedBy?: "messages" | "cents" | "day" | "feature" | "site";
  /** On a site refusal: when the site's day starts again. */
  readonly siteResetsAt?: Date;
}

export type AssistantAllowanceVerdict =
  | {
      readonly ok: true;
      readonly usage?: AssistantUsage | null;
      /**
       * From `reserve` (0.9.0): the place held for this question (an ai_usage
       * row at its worst case), handed back to `recordUsage` to settle.
       */
      readonly reservation?: string;
    }
  | {
      readonly ok: false;
      /** used up this month; the site's daily ceiling; or the ledger couldn't be read (fail closed). */
      readonly code: "allowance_used_up" | "site_limit" | "allowance_unavailable";
      readonly message: string;
      readonly usage?: AssistantUsage | null;
    };

/** What one model turn used, for the app's ledger. The model never reports this; the provider does. */
export interface AssistantTurnUsage {
  readonly tenantId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly model: string;
  readonly usage: LoopUsage;
  readonly steps: number;
  readonly status: "complete" | "truncated" | "errored";
  /** The person pressed Stop (or left) before the answer finished. */
  readonly aborted: boolean;
  readonly latencyMs: number;
  /**
   * Did the model answer (0.9.0)? False when the call failed or the provider
   * refused it — such a question must not use up one of the month's
   * messages (its tokens, if any, still count as money).
   */
  readonly answered: boolean;
  /**
   * The place `reserve` held, to settle. Usage is `null` when the turn broke
   * before the loop could count anything: settle it at the reserved worst case.
   */
  readonly reservation?: string;
}

/** The worst case one question can cost, for `reserve` to hold (the app prices it). */
export interface AssistantReserveInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly model: string;
  /** Estimated input tokens, summed over every step the question may take. */
  readonly maxInputTokens: number;
  /** maxTokens × maxSteps. */
  readonly maxOutputTokens: number;
}

export interface CreateAssistantHandlersOptions {
  db: AssistantDb;
  /** A fixed assistant (the site's own "*", or a single business's). Pass this or `resolveTenant`. */
  tenantId?: string;
  /** The company a request is for — in a companies project, the id in the PATH. null → "not found". */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /**
   * May this person do this, in this company? A `Response` is returned as it is
   * (signed out, not a member, a closed plan), `false` is 403, and
   * `{ userId }` passes — the assistant needs to know WHO, so `true` alone is
   * refused. Also asked for each tool's permission, so tools run with the
   * person's own reach.
   */
  authorize: (
    req: Request,
    permission: AssistantPermission | string,
    tenantId: string,
  ) => AssistantAuthorizeResult | Promise<AssistantAuthorizeResult>;
  /** The model. null: this site has none switched on — the chat says so, settings still work. */
  provider: ProviderAdapter | null;
  /** The tools for a company's assistant. The host fills it; omit for none. */
  tools?: ToolRegistry | ((tenantId: string) => ToolRegistry);
  /**
   * Asked before EVERY model call, and on the status and settings screens.
   * Omit it and nothing is counted — not advised: every company spends the
   * site's AI key.
   */
  allowance?: (input: { tenantId: string; userId: string }) => AssistantAllowanceVerdict | Promise<AssistantAllowanceVerdict>;
  /**
   * CHECK AND HOLD, before a model call (0.9.0): like `allowance`, and also
   * holds this question's worst case (`reserveAiAllowance` in
   * @adminigloo/ai/server), so questions sent at once can't all slip through
   * a check that sees none of the others. Its `reservation` reaches
   * `recordUsage`. Without it the handler still counts its OWN questions in
   * flight (one server process) against the month's messages.
   */
  reserve?: (input: AssistantReserveInput) => AssistantAllowanceVerdict | Promise<AssistantAllowanceVerdict>;
  /** Told after every question that was let through (with its `reservation`), however it ended. Never throws into the answer. */
  recordUsage?: (info: AssistantTurnUsage) => void | Promise<void>;
  /**
   * A rate limit on asking (0.9.0), per person and per company, through the
   * app's shared limiter: true to go ahead, or a plain sentence to refuse
   * with (429). Asked before anything else is spent.
   */
  rateLimit?: (input: { tenantId: string; userId: string; req: Request }) => true | string | Promise<true | string>;
  /** One-tap questions the chat offers (the company's own FAQ questions are added after these). */
  starters?: readonly string[] | ((tenantId: string) => readonly string[] | Promise<readonly string[]>);
  /** Vector search as well as keyword (needs the optional ./vector table). Omit for keyword only. */
  embedder?: Embedder;
  /** Tool round trips per question. Default 4: enough to look two things up, small enough to stay cheap. */
  maxSteps?: number;
  /** The longest answer, in tokens. Default 1024 — a few short paragraphs. */
  maxTokens?: number;
  /** How much of a long conversation is sent back each turn. Default: the last 8 turns, about 6,000 tokens. */
  history?: HistoryBudget;
  /** The longest question, in characters. Default 2,000. */
  maxMessageChars?: number;
  /** How long a proposed change can be answered. Default 15 minutes. */
  pendingActionTtlMs?: number;
  /** The sentence for a site with no model switched on. */
  notConfiguredMessage?: string;
  /** The AdminIgloo license gate (a no-op unless `mode: "enforce"`). */
  license?: {
    readonly key?: string | undefined;
    readonly publicKey?: string | undefined;
    readonly mode?: LicenseMode | undefined;
  };
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export interface AssistantHandlers {
  handle: (req: Request) => Promise<Response>;
}

const NOT_CONFIGURED = "The assistant isn't switched on for this site yet.";
const MAX_RULES = 30;
const MAX_TERMS = 100;
const MAX_STARTERS = 6;

interface Matched {
  kind: AssistantRouteKind;
  id?: string;
}

/** The route a path names for a method; null for an unknown one. */
function route(pathname: string, method: string): Matched | null {
  const parts = segmentsAfter(pathname, "/v1/");
  if (!parts) return null;
  const get = method === "GET" || method === "HEAD";
  const post = method === "POST";
  const [a, b, c, d] = parts;
  const n = parts.length;
  if (a === "status" && n === 1 && get) return { kind: "status" };
  if (a === "chat" && n === 1 && post) return { kind: "chat" };
  if (a === "conversations") {
    if (n === 1 && get) return { kind: "conversations" };
    if (n === 2 && get) return { kind: "conversation", id: b as string };
    if (n === 3 && c === "messages" && post) return { kind: "continue", id: b as string };
  }
  if (a === "actions" && n === 3 && post) {
    if (c === "confirm") return { kind: "confirm", id: b as string };
    if (c === "decline") return { kind: "decline", id: b as string };
  }
  if (a === "settings") {
    if (n === 1 && get) return { kind: "settings" };
    if (b === "profile" && n === 2 && post) return { kind: "profile-save" };
    if (b === "changes" && n === 2 && get) return { kind: "changes" };
    if (b === "rules") {
      if (n === 2 && post) return { kind: "rule-add" };
      if (n === 4 && d === "remove" && post) return { kind: "rule-remove", id: c as string };
    }
    if (b === "glossary") {
      if (n === 2 && post) return { kind: "term-add" };
      if (n === 4 && d === "remove" && post) return { kind: "term-remove", id: c as string };
    }
    if (b === "faqs") {
      if (n === 2 && post) return { kind: "faq-add" };
      if (n === 3 && post) return { kind: "faq-update", id: c as string };
      if (n === 4 && d === "remove" && post) return { kind: "faq-remove", id: c as string };
    }
  }
  return null;
}

const messageSchema = (max: number) =>
  z.object({
    message: z
      .string()
      .trim()
      .min(1, "Type a question first.")
      .max(max, `That's a long question — keep it under ${max.toLocaleString("en-US")} characters.`),
  });
const profileSchema = z.object({ profile: z.string().max(2_400, "Keep the profile to about a page (2,400 characters).") });
const ruleSchema = z.object({
  text: z.string().trim().min(1, "Write the rule first.").max(500, "Keep a house rule under 500 characters."),
});
const termSchema = z.object({
  term: z.string().trim().min(1, "Write the word first.").max(120, "Keep the word under 120 characters."),
  meaning: z.string().trim().max(500, "Keep the meaning under 500 characters.").nullish(),
});
const faqSchema = z.object({
  question: z.string().trim().min(3, "Write the question first.").max(300, "Keep the question under 300 characters."),
  answer: z.string().trim().min(1, "Write the answer first.").max(4_000, "Keep the answer under 4,000 characters."),
});

/** "Yes, do it", with what the person changed on the card (the keys its fields show). */
const decideSchema = z.object({
  edits: z.record(z.string().max(60), z.string().max(4_000, "That's too long to save.")).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new AssistantHttpError("invalid", 400, result.error.issues[0]?.message ?? "Some details need another look.");
}

function dateOnly(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** A verdict as the screens show it: the figures code counted, what closed it, and when it opens again. */
export function allowanceToWire(verdict: AssistantAllowanceVerdict | null): AssistantAllowanceWire | null {
  if (!verdict) return null;
  const usage = verdict.usage ?? null;
  if (!usage) {
    if (verdict.ok) return null;
    return {
      messagesUsed: 0,
      messageLimit: null,
      centsUsed: "0",
      centLimit: null,
      resetsOn: dateOnly(new Date()),
      usedUp: true,
      limitedBy: verdict.code === "site_limit" ? "site" : null,
      message: verdict.message,
    };
  }
  // A feature's share of the site's day (ai 0.3) resets with the day, so the
  // customer is told the same thing as for the day's share.
  const limit = usage.limitedBy === "feature" ? "day" : usage.limitedBy;
  const limitedBy = verdict.ok ? null : (limit ?? (verdict.code === "site_limit" ? "site" : "messages"));
  return {
    messagesUsed: usage.messagesUsed,
    messageLimit: usage.messageLimit,
    centsUsed: usage.centsUsed,
    centLimit: usage.centLimit,
    // The site's day starts again tomorrow, not on the 1st.
    resetsOn: dateOnly((limitedBy === "site" || limitedBy === "day") && usage.siteResetsAt ? usage.siteResetsAt : usage.resetsAt),
    usedUp: !verdict.ok,
    limitedBy,
    message: verdict.ok ? null : verdict.message,
  };
}

/** No usage: a question that never reached the model. */
const ZERO_USAGE: LoopUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, complete: true, estimated: false };

/**
 * A stored user turn, replayed as the question alone (0.9.0). A 0.8 row
 * carries its per-turn context (house rules, words, knowledge) before the
 * question; only the question is sent again.
 */
function questionOnly(blocks: ContentBlock[]): ContentBlock[] {
  const text = blocks.filter((block) => block.kind === "text");
  const last = text[text.length - 1];
  const others = blocks.filter((block) => block.kind !== "text");
  return last ? [...others, last] : blocks;
}

/** What the person typed, from a stored user turn: its last text block (the context blocks ride first). */
function userText(blocks: ContentBlock[]): string {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.kind === "text") return block.text;
  }
  return "";
}

/** The answer of a stored assistant turn: the text after its last tool round trip. */
function answerText(blocks: ContentBlock[]): string {
  let lastResult = -1;
  blocks.forEach((block, i) => {
    if (block.kind === "tool-result") lastResult = i;
  });
  return blocks
    .slice(lastResult + 1)
    .filter((block): block is Extract<ContentBlock, { kind: "text" }> => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

function actionIdsOf(blocks: ContentBlock[]): string[] {
  const ids: string[] = [];
  for (const block of blocks) {
    if (block.kind !== "tool-result") continue;
    const id = (block.result as { actionId?: unknown } | null)?.actionId;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

function actionStatus(action: PendingActionRow, now: Date): ActionStatusWire {
  if (action.status === "pending" && action.expiresAt.getTime() <= now.getTime()) return "expired";
  const s = action.status;
  return s === "confirmed" || s === "declined" || s === "expired" || s === "failed" ? s : "pending";
}

function messageToWire(row: MessageRow, actions: Map<string, PendingActionRow>, now: Date, registry: ToolRegistry): ChatMessageWire {
  const status = row.status === "truncated" || row.status === "errored" ? row.status : "complete";
  if (row.role === "user") {
    return { id: row.id, role: "user", text: userText(row.blocks), status, actions: [], fromFaq: false };
  }
  const wired: ActionWire[] = [];
  for (const id of actionIdsOf(row.blocks)) {
    const action = actions.get(id);
    if (action) {
      wired.push({
        id: action.id,
        summary: action.summary,
        status: actionStatus(action, now),
        fields: registry.fields(action.toolName, action.params),
      });
    }
  }
  const fromFaq = (row.promptMeta as { answeredFrom?: unknown } | null)?.answeredFrom === "faq";
  return { id: row.id, role: "assistant", text: answerText(row.blocks), status, actions: wired, fromFaq };
}

const SECTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  DEFAULT_SECTIONS.map((section) => [section.key, section.label.toLowerCase()]),
);

/** A change-log line in the owner's words — never a machine key. */
function changeWords(row: ChangeLogRow): string {
  const summary = row.changeSummary ?? "";
  const named = summary ? `: ${summary}` : "";
  switch (row.entityType) {
    case "tenant_rule":
      return row.action === "deactivated" ? `Removed a house rule${named}` : `Added a house rule${named}`;
    case "glossary":
      return row.action === "deactivated" ? `Removed a word${named}` : `Added a word${named}`;
    case "faq":
      if (row.action === "deactivated") return `Removed an answer${named}`;
      return row.action === "updated" ? `Changed an answer${named}` : `Added an answer${named}`;
    case "section": {
      if (row.entityKey === BUSINESS_PROFILE_KEY) {
        if (row.action === "deactivated") return "Cleared the business profile";
        return row.action === "created" ? "Wrote the business profile" : "Updated the business profile";
      }
      const label = (row.entityKey && SECTION_LABELS[row.entityKey]) || "personality";
      return row.action === "deactivated" ? `Turned off the assistant's ${label}` : `Changed the assistant's ${label}`;
    }
    default:
      return "Changed the assistant";
  }
}

export function createAssistantHandlers(options: CreateAssistantHandlersOptions): AssistantHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new TypeError("createAssistantHandlers needs `tenantId` (one assistant) or `resolveTenant` (one per company).");
  }
  if (typeof options.authorize !== "function") throw new TypeError("createAssistantHandlers needs `authorize`.");
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const maxSteps = options.maxSteps ?? 4;
  const maxTokens = options.maxTokens ?? 1024;
  const historyBudget: HistoryBudget = options.history ?? { maxTokens: 6_000, keepRecentTurns: 8 };
  const maxMessageChars = options.maxMessageChars ?? 2_000;
  const ttl = options.pendingActionTtlMs ?? 15 * 60 * 1000;
  const notConfigured = options.notConfiguredMessage ?? NOT_CONFIGURED;
  const emptyTools = createToolRegistry([]);
  /**
   * THIS PROCESS'S QUESTIONS IN FLIGHT, per company (0.9.0) — and a per-company
   * queue for the moment of checking, so two questions can't both see the same
   * count. With `reserve` the ledger holds each question's place across every
   * server; without it this still stops one server letting forty questions
   * through a three-question month.
   */
  const inFlight = new Map<string, number>();
  const checking = new Map<string, Promise<unknown>>();
  async function serially<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    const before = checking.get(tenantId) ?? Promise.resolve();
    const run = before.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    checking.set(tenantId, settled);
    try {
      return await run;
    } finally {
      if (checking.get(tenantId) === settled) checking.delete(tenantId);
    }
  }

  const toolsFor = (tenantId: string): ToolRegistry => {
    const tools = options.tools;
    if (!tools) return emptyTools;
    return typeof tools === "function" ? tools(tenantId) : tools;
  };

  /** The person's reach for the tools, asked of `authorize` once per permission (the host memoises per request). */
  async function canFor(req: Request, tenantId: string, registry: ToolRegistry): Promise<(permission: string) => boolean> {
    const held = new Set<string>();
    for (const permission of registry.permissions()) {
      const verdict = await options.authorize(req, permission, tenantId);
      if (verdict !== false && !(verdict instanceof Response)) held.add(permission);
    }
    return (permission) => held.has(permission);
  }

  async function allowanceOf(tenantId: string, userId: string): Promise<AssistantAllowanceVerdict | null> {
    if (!options.allowance) return null;
    try {
      return await options.allowance({ tenantId, userId });
    } catch (error) {
      options.onError?.(error, { tenantId, route: "allowance" });
      // Fail closed: an allowance that can't be read is not an open one.
      return {
        ok: false,
        code: "allowance_unavailable",
        message: "The assistant can't check its allowance right now, so it isn't answering. Try again in a minute.",
      };
    }
  }

  async function startersFor(tenantId: string): Promise<{ starters: string[]; free: string[] }> {
    let host: readonly string[] = [];
    try {
      host = options.starters ? (typeof options.starters === "function" ? await options.starters(tenantId) : options.starters) : [];
    } catch (error) {
      options.onError?.(error, { tenantId, route: "starters" });
    }
    const free = (await listFaqs(db, tenantId)).slice(0, 3).map((faq) => faq.question);
    return { starters: [...new Set([...host, ...free])].slice(0, MAX_STARTERS), free };
  }

  function sse(events: (emit: (event: AssistantStreamEvent) => void, signal: AbortSignal) => Promise<void>, req: Request): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const abort = new AbortController();
        // The person pressed Stop (or left) — maybe before this even started.
        if (req.signal?.aborted) abort.abort();
        else req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
        const emit = (event: AssistantStreamEvent): void => {
          try {
            controller.enqueue(encoder.encode(encodeSse(event)));
          } catch {
            /* the reader went away; the turn still finishes and is recorded */
          }
        };
        try {
          await events(emit, abort.signal);
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
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
  }

  /** A question the owner already answered: their words, streamed, no model, nothing spent. */
  async function answerFromFaq(
    req: Request,
    tenantId: string,
    userId: string,
    conversationId: string | null,
    message: string,
    answer: string,
  ): Promise<Response> {
    const id = conversationId ?? (await createConversation(db, { tenantId, userId, title: message.slice(0, 80) })).id;
    await appendMessage(db, { tenantId, conversationId: id, role: "user", blocks: [{ kind: "text", text: message }] });
    const saved = await appendMessage(db, {
      tenantId,
      conversationId: id,
      role: "assistant",
      blocks: [{ kind: "text", text: answer }],
      promptMeta: { answeredFrom: "faq" },
    });
    return sse(async (emit) => {
      emit({ v: 1, type: "start", conversationId: id });
      emit({ v: 1, type: "text", delta: answer });
      emit({
        v: 1,
        type: "done",
        meta: {
          conversationId: id,
          messageId: saved.id,
          status: "complete",
          steps: 0,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, complete: true },
          answeredFrom: "faq",
        },
      });
    }, req);
  }

  /** Hold this question's place: `reserve` (the ledger), else `allowance` plus this process's own count. */
  async function admit(tenantId: string, userId: string, estimate: Omit<AssistantReserveInput, "tenantId" | "userId">): Promise<AssistantAllowanceVerdict | null> {
    if (options.reserve) {
      try {
        return await options.reserve({ tenantId, userId, ...estimate });
      } catch (error) {
        options.onError?.(error, { tenantId, route: "reserve" });
        return { ok: false, code: "allowance_unavailable", message: "The assistant can't check its allowance right now, so it isn't answering. Try again in a minute." };
      }
    }
    return serially(tenantId, async () => {
      const verdict = await allowanceOf(tenantId, userId);
      const busy = inFlight.get(tenantId) ?? 0;
      const usage = verdict?.usage ?? null;
      if (verdict?.ok && usage && usage.messageLimit !== null && usage.messagesUsed + busy >= usage.messageLimit) {
        return {
          ok: false,
          code: "allowance_used_up",
          message: `This month's assistant allowance is used up (${usage.messageLimit} messages). It starts again on ${usage.resetsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}.`,
          usage: { ...usage, messagesUsed: usage.messagesUsed + busy, limitedBy: "messages" },
        };
      }
      if (!verdict || verdict.ok) inFlight.set(tenantId, busy + 1);
      return verdict;
    });
  }

  function leave(tenantId: string, held: boolean): void {
    if (!held || options.reserve) return;
    const busy = (inFlight.get(tenantId) ?? 1) - 1;
    if (busy <= 0) inFlight.delete(tenantId);
    else inFlight.set(tenantId, busy);
  }

  async function chat(req: Request, tenantId: string, userId: string, continuing: string | null): Promise<Response> {
    const { message } = parse(messageSchema(maxMessageChars), await readJsonBody(req));

    let history: NeutralMessage[] = [];
    if (continuing !== null) {
      const conv = isIdShaped(continuing) ? await getConversation(db, tenantId, continuing) : null;
      // Another company's, another person's, or no such thread: all "not found".
      if (!conv || conv.conversation.userId !== userId) {
        return errorResponse("not_found", 404, "That conversation isn't here.");
      }
      // Whole stored turns, so a tool call never loses its result. Stored user
      // turns hold the question only (0.9.0): an old turn's house rules,
      // words and knowledge are never sent again — only this turn's are.
      history = budgetHistory(conv.messages, historyBudget).flatMap((m) =>
        replayMessages(m.role === "assistant" ? "assistant" : "user", m.role === "user" ? questionOnly(m.blocks) : m.blocks),
      );
    }

    if (options.license) {
      const decision = verifyLicense({ feature: "assistant", ...options.license });
      if (!decision.ok) return errorResponse("unlicensed", 402, "The assistant isn't licensed on this site.");
    }

    // Too many questions too fast, from this person or this company: refused
    // before anything else is spent.
    if (options.rateLimit) {
      const limited = await options.rateLimit({ tenantId, userId, req });
      if (limited !== true) return errorResponse("rate_limited", 429, limited);
    }

    // FREE: a question the owner answered in the settings, word for word.
    const faq = await matchFaq(db, tenantId, message);
    if (faq) return answerFromFaq(req, tenantId, userId, continuing, message, faq.answer);

    const provider = options.provider;
    if (!provider) return errorResponse("not_configured", 503, notConfigured);

    const assembled = await assemblePrompt(db, { tenantId, turnText: message, embedder: options.embedder });
    const registry = toolsFor(tenantId);
    const can = await canFor(req, tenantId, registry);
    const tools = registry.providerTools(can);

    // The most this question can cost: every step re-sends the prompt, the
    // history and what came back (a tool's result is capped by the registry).
    const promptTokens = estimateTokens(
      JSON.stringify({ s: assembled.system, c: assembled.contextBlocks, h: history, q: message, t: tools }),
    );
    const verdict = await admit(tenantId, userId, {
      model: provider.modelId,
      maxInputTokens: (promptTokens + 1_500) * maxSteps,
      maxOutputTokens: maxTokens * maxSteps,
    });
    if (verdict && !verdict.ok) {
      return errorResponse(verdict.code, verdict.code === "allowance_unavailable" ? 503 : 429, verdict.message);
    }
    const held = true;
    const reservation = verdict?.ok ? verdict.reservation : undefined;
    const startedAt = Date.now();
    const record = async (info: { usage: LoopUsage; steps: number; status: "complete" | "truncated" | "errored"; aborted: boolean; answered: boolean; conversationId: string }) => {
      if (!options.recordUsage) return;
      try {
        await options.recordUsage({
          tenantId,
          userId,
          conversationId: info.conversationId,
          model: provider.modelId,
          usage: info.usage,
          steps: info.steps,
          status: info.status,
          aborted: info.aborted,
          answered: info.answered,
          latencyMs: Date.now() - startedAt,
          ...(reservation !== undefined ? { reservation } : {}),
        });
      } catch (error) {
        options.onError?.(error, { tenantId, route: "record-usage" });
      }
    };

    let conversationId: string;
    let userMessage: NeutralMessage;
    try {
      conversationId = continuing ?? (await createConversation(db, { tenantId, userId, title: message.slice(0, 80) })).id;
      // Per-turn context (house rules, glossary, knowledge) rides in THIS
      // turn's user message — never stored with it, so it isn't replayed.
      const userBlocks: ContentBlock[] = [];
      if (assembled.contextBlocks.length > 0) userBlocks.push({ kind: "text", text: assembled.contextBlocks.join("\n\n") });
      userBlocks.push({ kind: "text", text: message });
      userMessage = { role: "user", blocks: userBlocks };
      await appendMessage(db, {
        tenantId,
        conversationId,
        role: "user",
        blocks: [{ kind: "text", text: message }],
        promptMeta: { fingerprint: assembled.meta.fingerprint, context: assembled.meta.blocks.map((b) => b.name) },
      });
    } catch (error) {
      // The model was never asked: the place is given back at no cost.
      await record({ usage: ZERO_USAGE, steps: 0, status: "errored", aborted: false, answered: false, conversationId: continuing ?? "" });
      leave(tenantId, held);
      throw error;
    }
    const ctx: ToolContext = { tenantId, userId, conversationId, can };

    return sse(async (emit, signal) => {
      emit({ v: 1, type: "start", conversationId });
      let result: Awaited<ReturnType<typeof runAssistantLoop>> | null = null;
      try {
        result = await runAssistantLoop({
          provider,
          system: assembled.system,
          history,
          userMessage,
          tools,
          resolveTool: (call) => registry.resolve(call, ctx),
          maxSteps,
          maxTokens,
          signal,
          onPropose: async ({ toolName, params, summary }) => {
            const action = await createPendingAction(db, {
              tenantId,
              conversationId,
              toolName,
              params,
              summary,
              idempotencyKey: crypto.randomUUID(),
              expiresAt: new Date(now().getTime() + ttl),
              createdBy: userId,
            });
            return action.id;
          },
          emit,
        });
        const saved = await appendMessage(db, {
          tenantId,
          conversationId,
          role: "assistant",
          blocks: result.blocks,
          status: result.status,
          promptMeta: { fingerprint: assembled.meta.fingerprint, steps: result.steps },
        });
        if (result.status === "errored") {
          emit({
            v: 1,
            type: "error",
            errorClass: result.error?.errorClass ?? "internal",
            message: result.error?.message ?? INTERNAL_MESSAGE,
          });
        } else {
          emit({
            v: 1,
            type: "done",
            meta: { conversationId, messageId: saved.id, status: result.status, steps: result.steps, usage: result.usage },
          });
        }
      } catch (error) {
        options.onError?.(error, { tenantId, route: "chat" });
        try {
          await appendMessage(db, { tenantId, conversationId, role: "assistant", blocks: [], status: "errored" });
        } catch {
          /* the error event below is the person's signal */
        }
        emit({ v: 1, type: "error", errorClass: "internal", message: INTERNAL_MESSAGE });
      } finally {
        // EVERY question let through is settled — finished, stopped or failed —
        // from the provider's counts (or, for a step cut short, an estimate),
        // never the model's word. A failed one doesn't use up a message.
        await record(
          result
            ? {
                usage: result.usage,
                steps: result.steps,
                status: result.status,
                aborted: signal.aborted,
                answered: result.status !== "errored",
                conversationId,
              }
            : { usage: { ...ZERO_USAGE, complete: false }, steps: 0, status: "errored", aborted: signal.aborted, answered: false, conversationId },
        );
        leave(tenantId, held);
      }
    }, req);
  }

  async function decide(
    req: Request,
    tenantId: string,
    userId: string,
    id: string,
    decision: "confirm" | "decline",
    edits: Record<string, string> | undefined,
  ): Promise<Response> {
    if (!isIdShaped(id)) return errorResponse("not_found", 404, "That change isn't here.");
    const registry = toolsFor(tenantId);
    // The person may have changed what will be saved on the card. Their
    // version must fit BEFORE the offer is used up, so a bad edit can be fixed.
    let finalParams: Record<string, unknown> | null = null;
    if (decision === "confirm" && edits && Object.keys(edits).length > 0) {
      const offered = await getPendingAction(db, tenantId, id);
      if (!offered || offered.createdBy !== userId) return errorResponse("not_found", 404, "That change isn't here.");
      finalParams = registry.applyEdits(offered.toolName, offered.params, edits);
      if (!finalParams) return errorResponse("invalid", 400, "That doesn't fit — check what you changed and try again.");
    }
    const result = await decidePendingAction(db, { tenantId, id, userId, decision, now: now() });
    if (!result.decided) {
      if (result.reason === "not_found") return errorResponse("not_found", 404, "That change isn't here.");
      if (result.reason === "expired") {
        return errorResponse("expired", 409, "That offer ran out. Ask again and the assistant will offer it fresh.");
      }
      return errorResponse("already_answered", 409, "That change was already answered.");
    }
    if (decision === "decline") {
      const body: DecideWire = { status: "declined", done: false, message: "Nothing was changed." };
      return json(body);
    }
    // What runs is exactly what the person confirmed — and the record says so.
    const params = finalParams ?? (result.action.params as Record<string, unknown>);
    if (finalParams) {
      await db
        .update(assistantPendingActions)
        .set({ params: finalParams })
        .where(and(eq(assistantPendingActions.tenantId, tenantId), eq(assistantPendingActions.id, id)));
    }
    const can = await canFor(req, tenantId, registry);
    const outcome = await registry.runConfirmed(result.action.toolName, params as unknown, {
      tenantId,
      userId,
      conversationId: result.action.conversationId,
      can,
    });
    if (outcome.isError) {
      await db
        .update(assistantPendingActions)
        .set({ status: "failed" })
        .where(and(eq(assistantPendingActions.tenantId, tenantId), eq(assistantPendingActions.id, id)));
    }
    const body: DecideWire = { status: "confirmed", done: !outcome.isError, message: outcome.message };
    return json(body);
  }

  async function settingsWire(tenantId: string, userId: string): Promise<AssistantSettingsWire> {
    const [profile, rules, glossary, faqs, verdict] = await Promise.all([
      getBusinessProfile(db, tenantId),
      listTenantRules(db, tenantId),
      listGlossary(db, tenantId),
      listFaqs(db, tenantId),
      allowanceOf(tenantId, userId),
    ]);
    return {
      profile,
      profileMaxChars: 2_400,
      rules: rules.map((rule): HouseRuleWire => ({ id: rule.id, text: rule.instruction })),
      glossary: glossary.map((term): GlossaryTermWire => ({ id: term.id, term: term.preferred, meaning: term.definition })),
      faqs: faqs.map((faq): FaqWire => ({ id: faq.id, question: faq.question, answer: faq.answer })),
      usage: allowanceToWire(verdict),
      configured: options.provider !== null,
    };
  }

  async function dispatch(req: Request, match: Matched, tenantId: string, userId: string): Promise<Response> {
    const id = match.id;
    switch (match.kind) {
      case "status": {
        const canManage = await options.authorize(req, "assistant.settings.manage", tenantId);
        const starters = await startersFor(tenantId);
        const body: AssistantStatusWire = {
          configured: options.provider !== null,
          notConfiguredMessage: options.provider ? null : notConfigured,
          starters: starters.starters,
          freeStarters: starters.free,
          allowance: allowanceToWire(await allowanceOf(tenantId, userId)),
          canManage: canManage !== false && !(canManage instanceof Response),
        };
        return json(body);
      }
      case "chat":
        return chat(req, tenantId, userId, null);
      case "continue":
        return chat(req, tenantId, userId, id ?? "");
      case "conversations": {
        const rows = await listConversations(db, tenantId, { userId, limit: 30 });
        const body: ConversationListWire = {
          conversations: rows.map((row) => ({
            id: row.id,
            title: row.title ?? "Conversation",
            lastMessageAt: row.lastMessageAt.toISOString(),
          })),
        };
        return json(body);
      }
      case "conversation": {
        const conv = isIdShaped(id) ? await getConversation(db, tenantId, id) : null;
        if (!conv || conv.conversation.userId !== userId) return errorResponse("not_found", 404, "That conversation isn't here.");
        const actions = new Map((await listPendingActions(db, tenantId, conv.conversation.id)).map((a) => [a.id, a]));
        const at = now();
        const body: ConversationWire = {
          id: conv.conversation.id,
          title: conv.conversation.title ?? "Conversation",
          messages: conv.messages.map((row) => messageToWire(row, actions, at, toolsFor(tenantId))),
        };
        return json(body);
      }
      case "confirm": {
        const { edits } = parse(decideSchema, await readJsonBody(req));
        return decide(req, tenantId, userId, id ?? "", "confirm", edits);
      }
      case "decline":
        return decide(req, tenantId, userId, id ?? "", "decline", undefined);
      case "settings":
        return json(await settingsWire(tenantId, userId));
      case "profile-save": {
        const { profile } = parse(profileSchema, await readJsonBody(req));
        const saved = await saveBusinessProfile(db, tenantId, { content: profile }, userId);
        if (!saved.saved) {
          if (saved.reason === "budget") {
            throw new AssistantHttpError("invalid", 400, "That's more than the assistant can read every time. Keep it to about a page.");
          }
          throw new AssistantHttpError("already_answered", 409, "Someone else saved the profile just now. Reload to see it.");
        }
        return json({ profile: await getBusinessProfile(db, tenantId) });
      }
      case "rule-add": {
        const { text } = parse(ruleSchema, await readJsonBody(req));
        if ((await listTenantRules(db, tenantId)).length >= MAX_RULES) {
          throw new AssistantHttpError("invalid", 409, `You have ${MAX_RULES} house rules already. Remove one to add another.`);
        }
        const created = await createTenantRule(db, { tenantId, label: text.slice(0, 80), instruction: text }, userId);
        if ("error" in created) throw new AssistantHttpError("invalid", 400, "That rule is too long for the assistant to keep in mind. Shorten it.");
        const body: HouseRuleWire = { id: created.id, text };
        return json(body, 201);
      }
      case "rule-remove": {
        if (!isIdShaped(id) || !(await deactivateTenantRule(db, tenantId, id, userId))) {
          return errorResponse("not_found", 404, "That house rule isn't here.");
        }
        return json({ removed: true });
      }
      case "term-add": {
        const { term, meaning } = parse(termSchema, await readJsonBody(req));
        if ((await listGlossary(db, tenantId)).length >= MAX_TERMS) {
          throw new AssistantHttpError("invalid", 409, `You have ${MAX_TERMS} words already. Remove one to add another.`);
        }
        const created = await createGlossaryTerm(db, tenantId, { termKey: termKeyFor(term), preferred: term, definition: meaning ?? null }, userId);
        const body: GlossaryTermWire = { id: created.id, term, meaning: meaning ?? null };
        return json(body, 201);
      }
      case "term-remove": {
        if (!isIdShaped(id) || !(await deactivateGlossaryTerm(db, tenantId, id, userId))) {
          return errorResponse("not_found", 404, "That word isn't here.");
        }
        return json({ removed: true });
      }
      case "faq-add":
      case "faq-update": {
        if (match.kind === "faq-update" && !isIdShaped(id)) return errorResponse("not_found", 404, "That answer isn't here.");
        const input = parse(faqSchema, await readJsonBody(req));
        const saved = await saveFaq(db, tenantId, { ...input, ...(match.kind === "faq-update" ? { id } : {}) }, userId);
        if (!saved.saved) {
          if (saved.reason === "not_found") return errorResponse("not_found", 404, "That answer isn't here.");
          throw new AssistantHttpError("invalid", 409, "You have as many answers as the assistant keeps. Remove one to add another.");
        }
        const body: FaqWire = { id: saved.faq.id, question: saved.faq.question, answer: saved.faq.answer };
        return json(body, match.kind === "faq-add" ? 201 : 200);
      }
      case "faq-remove": {
        if (!isIdShaped(id) || !(await removeFaq(db, tenantId, id, userId))) {
          return errorResponse("not_found", 404, "That answer isn't here.");
        }
        return json({ removed: true });
      }
      case "changes": {
        const rows = await listChangeLog(db, tenantId, 50);
        const body: AssistantChangesWire = {
          changes: rows.map((row) => ({ id: String(row.id), what: changeWords(row), when: row.createdAt.toISOString() })),
        };
        return json(body);
      }
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      let tenantId: string | null = null;
      let kind = "unknown";
      try {
        const match = route(new URL(req.url).pathname, req.method);
        if (!match) return errorResponse("not_found", 404, "That isn't here.");
        kind = match.kind;
        if (req.method === "POST" && isCrossSiteRequest(req)) return errorResponse("cross_site", 403, CROSS_SITE_MESSAGE);
        tenantId = options.tenantId ?? (await options.resolveTenant?.(req)) ?? null;
        if (!tenantId) return errorResponse("not_found", 404, "This assistant isn't here.");

        const permission = ASSISTANT_ROUTE_PERMISSIONS[match.kind];
        const verdict = await options.authorize(req, permission, tenantId);
        if (verdict instanceof Response) return verdict;
        const forbidden = permission === "assistant.settings.manage" ? SETTINGS_FORBIDDEN_MESSAGE : FORBIDDEN_MESSAGE;
        if (verdict === false) return errorResponse("forbidden", 403, forbidden);
        const userId = typeof verdict === "object" && verdict.userId != null && verdict.userId !== "" ? String(verdict.userId) : null;
        // Conversations and answers are a PERSON's: no person, no assistant.
        if (userId === null) return errorResponse("forbidden", 403, forbidden);

        return await dispatch(req, match, tenantId, userId);
      } catch (error) {
        if (error instanceof AssistantHttpError) return errorResponse(error.code, error.status, error.message);
        options.onError?.(error, { tenantId, route: kind });
        return errorResponse("internal", 500, INTERNAL_MESSAGE);
      }
    },
  };
}

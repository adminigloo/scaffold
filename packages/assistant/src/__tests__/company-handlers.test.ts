import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { NO_MATH_FLOOR } from "../assemble.js";
import type { AssistantDb } from "../brain.js";
import {
  allowanceToWire,
  createAssistantHandlers,
  type AssistantAllowanceVerdict,
  type AssistantTurnUsage,
  type CreateAssistantHandlersOptions,
} from "../company-handlers.js";
import { createConversation, createPendingAction, getPendingAction, listFaqs } from "../engine.js";
import { assistantPermissions } from "../permissions.js";
import { createToolRegistry, TOOL_RESULT_NOTE, type AssistantTool } from "../registry.js";
import { ASSISTANT_ADMIN_ROUTES, ASSISTANT_ROUTE_PERMISSIONS, ASSISTANT_ROUTES } from "../routes.js";
import { callsTool, fakeProvider, says, type FakeProvider } from "./fake-provider.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * THE ASSISTANT'S HANDLERS (0.9.0), on a real Postgres with a scripted model:
 *
 *   - every row of ASSISTANT_ADMIN_ROUTES routes to its kind and asks for its
 *     permission; an empty company answers "not found", not a 500;
 *   - every refusal (who, which company, allowance, no model) happens BEFORE
 *     the model is called — a refused question costs nothing;
 *   - an FAQ the owner answered is answered word for word with NO model call;
 *   - tools run as the person: the model is offered only the tools their
 *     permissions reach, and each runs in their company, as them;
 *   - a write is proposed, never done in the chat; "Yes, do it" runs it once,
 *     only for the person it was offered to;
 *   - every model turn is metered from the provider's counts;
 *   - the no-math rule is in what the model is sent, and on every tool result.
 */

let t: TestDb;
let db: AssistantDb;

beforeAll(async () => {
  t = await createTestDb();
  db = t.db;
});
afterAll(async () => {
  await t.close();
});

/** Who's signed in, per request (a header in these tests; the app reads its session). */
const WHO = "x-test-user";
/** Each person's permissions in each company: `${tenant}:${user}` → keys. */
const grants = new Map<string, Set<string>>();

function grant(tenantId: string, userId: string, keys: readonly string[]): void {
  grants.set(`${tenantId}:${userId}`, new Set(keys));
}

const MEMBER = ["assistant.use", "jobs.view"];
const OWNER = ["assistant.use", "assistant.settings.manage", "jobs.view", "notes.write"];

const authorize: CreateAssistantHandlersOptions["authorize"] = (req, permission, tenantId) => {
  const userId = req.headers.get(WHO);
  if (!userId) return Response.json({ error: { code: "forbidden", message: "Signed out." } }, { status: 401 });
  const held = grants.get(`${tenantId}:${userId}`);
  if (!held) return Response.json({ error: { code: "forbidden", message: "You're not part of this company." } }, { status: 403 });
  return held.has(permission) ? { userId } : false;
};

/** Every tool call, with the context it ran in. */
const ran: Array<{ tool: string; tenantId: string; userId: string; input: unknown }> = [];

function jobsTool(): AssistantTool<{ day: string }> {
  return {
    name: "jobs_on_day",
    description: "The company's jobs on a day.",
    inputSchema: { type: "object", properties: { day: { type: "string" } }, required: ["day"] },
    parse: (input) => z.object({ day: z.string() }).parse(input),
    requiresPermission: "jobs.view",
    label: "Looking at the schedule",
    run: async (input, ctx) => {
      ran.push({ tool: "jobs_on_day", tenantId: ctx.tenantId, userId: ctx.userId, input });
      // Finished figures: the count is code's, never the model's.
      return { day: input.day, jobs: [`${ctx.tenantId} job`], count: 1 };
    },
  };
}

function noteTool(): AssistantTool<{ text: string }> {
  return {
    name: "save_note",
    description: "Save a note for the office.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    parse: (input) => z.object({ text: z.string().min(1) }).parse(input),
    requiresPermission: "notes.write",
    write: true,
    summarize: (input) => `Save the note “${input.text}”`,
    done: () => "Saved the note.",
    run: async (input, ctx) => {
      ran.push({ tool: "save_note", tenantId: ctx.tenantId, userId: ctx.userId, input });
      return { saved: true };
    },
  };
}

const registry = createToolRegistry([jobsTool() as AssistantTool, noteTool() as AssistantTool]);

interface Harness {
  handle: (req: Request) => Promise<Response>;
  provider: FakeProvider;
  usage: AssistantTurnUsage[];
}

function harness(scripts: Parameters<typeof fakeProvider>[0] = [], extra: Partial<CreateAssistantHandlersOptions> = {}): Harness {
  const provider = fakeProvider(scripts);
  const usage: AssistantTurnUsage[] = [];
  const { handle } = createAssistantHandlers({
    db,
    resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
    authorize,
    provider,
    tools: registry,
    allowance: () => ({ ok: true, usage: { messagesUsed: 2, messageLimit: 300, centsUsed: "1", centLimit: 300, resetsAt: new Date("2026-11-01T00:00:00Z") } }),
    recordUsage: (info) => {
      usage.push(info);
    },
    starters: ["What's on the schedule tomorrow?"],
    ...extra,
  });
  return { handle, provider, usage };
}

const base = (tenantId: string) => `http://app.test/api/app/${tenantId}/assistant/`;

function call(tenantId: string, user: string | null, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { "sec-fetch-site": "same-origin", ...headers };
  if (user) h[WHO] = user;
  if (method === "GET") return new Request(base(tenantId) + path, { headers: h });
  return new Request(base(tenantId) + path, { method, headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
}

async function events(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data:"))
    .map((chunk) => JSON.parse(chunk.slice(5)) as Record<string, unknown>);
}

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, code: body.error.code, message: body.error.message };
}

function company(): { id: string; owner: string; member: string } {
  const id = tenant();
  grant(id, "owner", OWNER);
  grant(id, "member", MEMBER);
  return { id, owner: "owner", member: "member" };
}

describe("the route table", () => {
  it("names every kind once, each with the permission the handler asks", () => {
    expect(ASSISTANT_ROUTES).toBe(ASSISTANT_ADMIN_ROUTES);
    expect(Object.isFrozen(ASSISTANT_ADMIN_ROUTES)).toBe(true);
    expect(new Set(ASSISTANT_ADMIN_ROUTES.map((r) => r.kind)).size).toBe(Object.keys(ASSISTANT_ROUTE_PERMISSIONS).length);
    for (const route of ASSISTANT_ADMIN_ROUTES) {
      expect(route.permission).toBe(ASSISTANT_ROUTE_PERMISSIONS[route.kind]);
      expect(Object.keys(assistantPermissions)).toContain(route.permission);
    }
  });

  it("routes every row to its kind: each asks its own permission, and an empty company is 'not found' or empty, never a 500", async () => {
    const asked: string[] = [];
    const seen = harness([], {
      authorize: (req, permission, tenantId) => {
        asked.push(permission);
        return authorize(req, permission, tenantId);
      },
    });
    const c = company();
    for (const route of ASSISTANT_ADMIN_ROUTES) {
      asked.length = 0;
      const path = route.path.replace(/\{[a-z-]+\}/g, "01h00000000000000000000000");
      const res = await seen.handle(call(c.id, c.owner, route.method, path, route.body));
      expect(res.status, `${route.kind}: ${await res.clone().text()}`).toBeLessThan(500);
      expect(asked[0], route.kind).toBe(route.permission);
      if (/\{/.test(route.path)) expect(res.status, route.kind).toBe(404);
    }
  });

  it("refuses: signed out (401), not a member (403), a member without the key (403 forbidden), another site (403)", async () => {
    const h = harness();
    const c = company();
    expect((await h.handle(call(c.id, null, "GET", "v1/status"))).status).toBe(401);
    expect((await h.handle(call(c.id, "stranger", "GET", "v1/status"))).status).toBe(403);
    expect(await errorOf(await h.handle(call(c.id, c.member, "GET", "v1/settings")))).toMatchObject({
      status: 403,
      code: "forbidden",
      message: "You don't have permission to change the assistant's settings.",
    });
    expect(await errorOf(await h.handle(call(c.id, c.owner, "POST", "v1/chat", { message: "hi" }, { "sec-fetch-site": "cross-site" })))).toMatchObject({
      status: 403,
      code: "cross_site",
    });
    expect((await h.handle(call(c.id, c.owner, "GET", "v1/nope"))).status).toBe(404);
    // An id that isn't id-shaped (a NUL byte) is "not found", not a database error.
    expect((await h.handle(call(c.id, c.owner, "GET", "v1/conversations/%00x"))).status).toBe(404);
    expect(h.provider.calls()).toBe(0);
  });
});

describe("the chat: refusals cost nothing, answers are metered", () => {
  it("answers, streaming, in the company's own words, with the no-math rule in what the model was sent", async () => {
    const h = harness([says("Two jobs tomorrow.", { inputTokens: 900, outputTokens: 40, cacheReadTokens: 300 })]);
    const c = company();
    const res = await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "What's on tomorrow?" }));
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const list = await events(res);
    expect(list[0]).toMatchObject({ type: "start" });
    expect(list.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("Two jobs tomorrow.");
    const done = list.at(-1) as { type: string; meta: { conversationId: string; usage: { inputTokens: number } } };
    expect(done.type).toBe("done");
    expect(h.provider.requests[0]?.system).toContain(NO_MATH_FLOOR);
    // Metered from the PROVIDER's counts, for this company and person.
    expect(h.usage).toEqual([
      expect.objectContaining({
        tenantId: c.id,
        userId: c.member,
        conversationId: done.meta.conversationId,
        model: "claude-haiku-4-5",
        usage: expect.objectContaining({ inputTokens: 900, outputTokens: 40, cacheReadTokens: 300, complete: true }),
        status: "complete",
        aborted: false,
      }),
    ]);
    // The history shows what the person asked and what came back — not the context blocks.
    const conv = (await (await h.handle(call(c.id, c.member, "GET", `v1/conversations/${done.meta.conversationId}`))).json()) as {
      messages: Array<{ role: string; text: string }>;
    };
    expect(conv.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "What's on tomorrow?"],
      ["assistant", "Two jobs tomorrow."],
    ]);
  });

  it("refuses BEFORE the model when the month's allowance is used up, in a plain sentence", async () => {
    const used: AssistantAllowanceVerdict = {
      ok: false,
      code: "allowance_used_up",
      message: "This month's assistant allowance is used up (300 messages). It starts again on November 1.",
      usage: { messagesUsed: 300, messageLimit: 300, centsUsed: "212", centLimit: 300, resetsAt: new Date("2026-11-01T00:00:00Z") },
    };
    const h = harness([says("should never be said")], { allowance: () => used });
    const c = company();
    expect(await errorOf(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "Anything?" })))).toEqual({
      status: 429,
      code: "allowance_used_up",
      message: used.message,
    });
    expect(h.provider.calls()).toBe(0);
    expect(h.usage).toEqual([]);
    const status = (await (await h.handle(call(c.id, c.member, "GET", "v1/status"))).json()) as { allowance: { usedUp: boolean; message: string; resetsOn: string } };
    expect(status.allowance).toMatchObject({ usedUp: true, message: used.message, resetsOn: "2026-11-01" });
  });

  it("FAILS CLOSED when the allowance can't be checked", async () => {
    const h = harness([says("never")], {
      allowance: () => {
        throw new Error("ledger down");
      },
    });
    const c = company();
    expect(await errorOf(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "Anything?" })))).toMatchObject({
      status: 503,
      code: "allowance_unavailable",
    });
    expect(h.provider.calls()).toBe(0);
  });

  it("says so plainly when the site has no model switched on (settings still work)", async () => {
    const h = harness([], { provider: null });
    const c = company();
    expect(await errorOf(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "hi" })))).toEqual({
      status: 503,
      code: "not_configured",
      message: "The assistant isn't switched on for this site yet.",
    });
    const status = (await (await h.handle(call(c.id, c.member, "GET", "v1/status"))).json()) as { configured: boolean };
    expect(status.configured).toBe(false);
    expect((await h.handle(call(c.id, c.owner, "GET", "v1/settings"))).status).toBe(200);
  });

  it("answers a question the owner already answered, word for word, WITHOUT the model — even with the allowance spent", async () => {
    const h = harness([says("never")], {
      allowance: () => ({ ok: false, code: "allowance_used_up", message: "Used up." }),
    });
    const c = company();
    const saved = await h.handle(call(c.id, c.owner, "POST", "v1/settings/faqs", { question: "Do you work Sundays?", answer: "No — Monday to Saturday." }));
    expect(saved.status).toBe(201);
    const list = await events(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "do you work sundays" })));
    expect(list.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("No — Monday to Saturday.");
    expect((list.at(-1) as { meta: { answeredFrom?: string } }).meta.answeredFrom).toBe("faq");
    expect(h.provider.calls()).toBe(0);
    expect(h.usage).toEqual([]);
    // The owner's questions are offered as starters, after the host's.
    const status = (await (await h.handle(call(c.id, c.member, "GET", "v1/status"))).json()) as { starters: string[] };
    expect(status.starters).toEqual(["What's on the schedule tomorrow?", "Do you work Sundays?"]);
    // The business's own answers still work when the month is used up (review L11).
    expect((status as unknown as { freeStarters: string[] }).freeStarters).toEqual(["Do you work Sundays?"]);
  });

  it("refuses an empty or overlong question in words", async () => {
    const h = harness();
    const c = company();
    expect((await errorOf(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "   " })))).message).toBe("Type a question first.");
    expect((await errorOf(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "x".repeat(2_001) })))).message).toMatch(/keep it under 2,000/);
  });

  it("meters a stopped answer too", async () => {
    const h = harness([says("A long answer that the person stops.")]);
    const c = company();
    const controller = new AbortController();
    controller.abort();
    const req = new Request(base(c.id) + "v1/chat", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", [WHO]: c.member, "content-type": "application/json" },
      body: JSON.stringify({ message: "Tell me everything." }),
      signal: controller.signal,
    });
    await (await h.handle(req)).text().catch(() => "");
    expect(h.usage).toHaveLength(1);
    expect(h.usage[0]).toMatchObject({ aborted: true, status: "truncated", answered: true });
    // REVIEW H1: a stop is NEVER free. The provider reported nothing; the
    // turn's counts are still complete (estimated), so the ledger prices it.
    const usage = h.usage[0]!.usage;
    expect(usage.complete).toBe(true);
    expect(usage.estimated).toBe(true);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it("a question the provider refused doesn't use up a message (answered: false)", async () => {
    const h = harness([[{ type: "provider-error", errorClass: "provider_overloaded", message: "busy" }, { type: "step-end", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false } }]]);
    const c = company();
    await (await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "Anything?" }))).text();
    expect(h.usage[0]).toMatchObject({ status: "errored", answered: false, usage: { inputTokens: 0, outputTokens: 0, complete: true } });
  });
});

describe("questions sent at once (review H2)", () => {
  it("lets three of forty through a three-question month on one server, without `reserve`", async () => {
    let used = 0;
    const provider = fakeProvider(Array.from({ length: 40 }, () => says("ok")));
    const slow = { ...provider, async *stream(request: Parameters<typeof provider.stream>[0]) {
      await new Promise((r) => setTimeout(r, 30));
      yield* provider.stream(request);
    } };
    const { handle } = createAssistantHandlers({
      db,
      resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
      authorize,
      provider: slow,
      // Counted from what was RECORDED, like a ledger: nothing in flight shows.
      allowance: () => ({ ok: true, usage: { messagesUsed: used, messageLimit: 3, centsUsed: "0", centLimit: null, resetsAt: new Date("2026-11-01T00:00:00Z") } }),
      recordUsage: () => {
        used += 1;
      },
    });
    const c = company();
    const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => handle(call(c.id, c.member, "POST", "v1/chat", { message: `question ${i} please` })).then(async (r) => [r.status, await r.text()] as const)));
    expect(answers.filter(([status]) => status === 200)).toHaveLength(3);
    expect(answers.filter(([status, body]) => status === 429 && body.includes("allowance_used_up"))).toHaveLength(37);
    expect(provider.calls()).toBe(3);
  });

  it("asks `reserve` with the question's worst case and hands its place to recordUsage", async () => {
    const asked: unknown[] = [];
    const h = harness([says("ok")], {
      reserve: (input) => {
        asked.push(input);
        return { ok: true, reservation: "r-42" };
      },
    });
    const c = company();
    await (await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "How busy is tomorrow?" }))).text();
    expect(asked[0]).toMatchObject({ tenantId: c.id, userId: c.member, model: "claude-haiku-4-5", maxOutputTokens: 1024 * 4 });
    expect((asked[0] as { maxInputTokens: number }).maxInputTokens).toBeGreaterThan(4 * 1_500);
    expect(h.usage[0]).toMatchObject({ reservation: "r-42" });
    // A refusal from reserve is a plain 429, and the model is never asked.
    const refused = harness([says("never")], { reserve: () => ({ ok: false, code: "allowance_used_up", message: "Used up." }) });
    expect((await refused.handle(call(c.id, c.member, "POST", "v1/chat", { message: "hi there" }))).status).toBe(429);
    expect(refused.provider.calls()).toBe(0);
  });

  it("refuses with the rate limit's sentence before anything is spent", async () => {
    const h = harness([says("never")], { rateLimit: ({ userId }) => (userId === "member" ? "You're asking faster than the assistant can keep up. Give it a minute." : true) });
    const c = company();
    const res = await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "hi there" }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "rate_limited", message: "You're asking faster than the assistant can keep up. Give it a minute." } });
    expect(h.provider.calls()).toBe(0);
  });
});

describe("history sends only the question, not old context (review L6)", () => {
  it("replays an earlier turn without the house rules and knowledge it was sent with", async () => {
    const h = harness([says("First."), says("Second.")]);
    const c = company();
    await h.handle(call(c.id, c.owner, "POST", "v1/settings/rules", { text: "OLD RULE always mention the yard." }));
    const first = await events(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "First question" })));
    const conversationId = (first[0] as { conversationId: string }).conversationId;
    await (await h.handle(call(c.id, c.member, "POST", `v1/conversations/${conversationId}/messages`, { message: "Second question" }))).text();
    const second = h.provider.requests[1]!;
    const historyUser = second.messages[0]!;
    expect(historyUser.blocks).toEqual([{ kind: "text", text: "First question" }]);
    // This turn's context is sent, once.
    const now = JSON.stringify(second.messages.at(-1));
    expect(now).toContain("OLD RULE");
    expect(JSON.stringify(second.messages.slice(0, -1))).not.toContain("OLD RULE");
  });
});

describe("tools run as the person, in their company", () => {
  it("offers only the tools the person's permissions reach, and runs them as them, in their company", async () => {
    const h = harness([callsTool("jobs_on_day", { day: "2026-10-17" }), says("You have 1 job.")]);
    const c = company();
    ran.length = 0;
    await (await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "Jobs tomorrow?" }))).text();
    // A member holds jobs.view, not notes.write: the write tool was never offered.
    expect(h.provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(["jobs_on_day"]);
    expect(ran).toEqual([{ tool: "jobs_on_day", tenantId: c.id, userId: c.member, input: { day: "2026-10-17" } }]);
    // The model read the result with the no-math note on it.
    const second = h.provider.requests[1];
    const result = second?.messages.at(-1)?.blocks.find((b) => b.kind === "tool-result") as { result: { note: string; data: { count: number } } };
    expect(result.result.note).toBe(TOOL_RESULT_NOTE);
    expect(result.result.data.count).toBe(1);
  });

  it("refuses a tool the model names that the person can't use (a hallucinated call never runs)", async () => {
    const h = harness([callsTool("save_note", { text: "sneaky" }), says("I can't do that.")]);
    const c = company();
    ran.length = 0;
    const list = await events(await h.handle(call(c.id, c.member, "POST", "v1/chat", { message: "Save a note" })));
    expect(list.some((e) => e.type === "action")).toBe(false);
    expect(ran).toEqual([]);
  });
});

describe("the card shows exactly what will be saved, and the person can change it (review H3)", () => {
  it("sends every field in full, saves what the person confirmed, and keeps the offer open after an edit that doesn't fit", async () => {
    const h = harness([callsTool("save_note", { text: "Pay at https://evil.example now" }), says("Confirm to save it.")]);
    const c = company();
    ran.length = 0;
    const list = await events(await h.handle(call(c.id, c.owner, "POST", "v1/chat", { message: "Note this" })));
    const action = list.find((e) => e.type === "action") as { actionId: string; fields: Array<{ key: string; value: string }> };
    expect(action.fields).toEqual([{ key: "text", label: "Text", value: "Pay at https://evil.example now", multiline: false }]);

    // An edit that doesn't fit is refused, and the offer is still there to fix.
    const bad = await h.handle(call(c.id, c.owner, "POST", `v1/actions/${action.actionId}/confirm`, { edits: { text: "" } }));
    expect(bad.status).toBe(400);
    expect((await getPendingAction(db, c.id, action.actionId))?.status).toBe("pending");

    const ok = await h.handle(call(c.id, c.owner, "POST", `v1/actions/${action.actionId}/confirm`, { edits: { text: "Pay at the office." } }));
    expect(await ok.json()).toEqual({ status: "confirmed", done: true, message: "Saved the note." });
    expect(ran).toEqual([{ tool: "save_note", tenantId: c.id, userId: c.owner, input: { text: "Pay at the office." } }]);
    // The record — and the history card — show what was really saved.
    expect((await getPendingAction(db, c.id, action.actionId))?.params).toEqual({ text: "Pay at the office." });
    const start = list[0] as { conversationId: string };
    const conv = (await (await h.handle(call(c.id, c.owner, "GET", `v1/conversations/${start.conversationId}`))).json()) as {
      messages: Array<{ actions: Array<{ fields: Array<{ value: string }> }> }>;
    };
    expect(conv.messages[1]!.actions[0]!.fields[0]!.value).toBe("Pay at the office.");
  });

  it("an edit naming a field the card doesn't show changes nothing else", async () => {
    const h = harness([callsTool("save_note", { text: "Gate 4411" }), says("Confirm.")]);
    const c = company();
    ran.length = 0;
    const list = await events(await h.handle(call(c.id, c.owner, "POST", "v1/chat", { message: "Note this" })));
    const action = list.find((e) => e.type === "action") as { actionId: string };
    await h.handle(call(c.id, c.owner, "POST", `v1/actions/${action.actionId}/confirm`, { edits: { tenantId: "someone-else" } }));
    expect(ran).toEqual([{ tool: "save_note", tenantId: c.id, userId: c.owner, input: { text: "Gate 4411" } }]);
  });
});

describe("ask before acting: a write is proposed, then done once, by the person it was offered to", () => {
  async function propose(h: Harness, c: { id: string; owner: string }): Promise<{ actionId: string; conversationId: string }> {
    const list = await events(await h.handle(call(c.id, c.owner, "POST", "v1/chat", { message: "Note: gate code 4411" })));
    const action = list.find((e) => e.type === "action") as { actionId: string; summary: string } | undefined;
    if (!action) throw new Error(`no proposal: ${JSON.stringify(list)}`);
    expect(action.summary).toBe("Save the note “gate code 4411”");
    const start = list[0] as { conversationId: string };
    return { actionId: action.actionId, conversationId: start.conversationId };
  }

  it("never runs during the chat; “Yes, do it” runs it once, even clicked three times at once", async () => {
    const h = harness([callsTool("save_note", { text: "gate code 4411" }), says("I've prepared that — confirm to save it.")]);
    const c = company();
    ran.length = 0;
    const { actionId, conversationId } = await propose(h, c);
    expect(ran).toEqual([]);
    const clicks = await Promise.all([1, 2, 3].map(() => h.handle(call(c.id, c.owner, "POST", `v1/actions/${actionId}/confirm`))));
    const bodies = await Promise.all(clicks.map((res) => res.json()));
    expect(clicks.map((res) => res.status).sort()).toEqual([200, 409, 409]);
    expect(bodies).toContainEqual({ status: "confirmed", done: true, message: "Saved the note." });
    expect(bodies.filter((b) => (b as { error?: { code: string } }).error?.code === "already_answered")).toHaveLength(2);
    expect(ran).toEqual([{ tool: "save_note", tenantId: c.id, userId: c.owner, input: { text: "gate code 4411" } }]);
    // The history shows what was answered.
    const conv = (await (await h.handle(call(c.id, c.owner, "GET", `v1/conversations/${conversationId}`))).json()) as {
      messages: Array<{ role: string; actions: Array<{ status: string }> }>;
    };
    expect(conv.messages.find((m) => m.role === "assistant")?.actions).toEqual([
      expect.objectContaining({ id: actionId, status: "confirmed" }),
    ]);
  });

  it("“No” changes nothing; another person, or another company, can't answer it", async () => {
    const h = harness([callsTool("save_note", { text: "gate code 4411" }), says("Confirm to save it.")]);
    const c = company();
    const other = company();
    ran.length = 0;
    const { actionId } = await propose(h, c);
    // Another person in the same company (who could save notes themselves).
    grant(c.id, "admin2", OWNER);
    expect((await h.handle(call(c.id, "admin2", "POST", `v1/actions/${actionId}/confirm`))).status).toBe(404);
    // Another company, with its own owner.
    expect((await h.handle(call(other.id, other.owner, "POST", `v1/actions/${actionId}/confirm`))).status).toBe(404);
    expect((await h.handle(call(other.id, other.owner, "POST", `v1/actions/${actionId}/decline`))).status).toBe(404);
    expect(await (await h.handle(call(c.id, c.owner, "POST", `v1/actions/${actionId}/decline`))).json()).toEqual({
      status: "declined",
      done: false,
      message: "Nothing was changed.",
    });
    expect(ran).toEqual([]);
  });

  it("re-checks the person's permission at confirm time (a role lost in between runs nothing)", async () => {
    const h = harness([callsTool("save_note", { text: "gate code 4411" }), says("Confirm to save it.")]);
    const c = company();
    ran.length = 0;
    const { actionId } = await propose(h, c);
    grant(c.id, c.owner, ["assistant.use"]);
    const body = (await (await h.handle(call(c.id, c.owner, "POST", `v1/actions/${actionId}/confirm`))).json()) as { done: boolean; message: string };
    expect(body).toEqual({ status: "confirmed", done: false, message: "You don't have permission to make that change." });
    expect(ran).toEqual([]);
    expect((await getPendingAction(db, c.id, actionId))?.status).toBe("failed");
    grant(c.id, c.owner, OWNER);
  });

  it("an offer that ran out says so", async () => {
    const h = harness();
    const c = company();
    const conv = await createConversation(db, { tenantId: c.id, userId: c.owner });
    const action = await createPendingAction(db, {
      tenantId: c.id,
      conversationId: conv.id,
      toolName: "save_note",
      params: { text: "x" },
      summary: "Save the note “x”",
      idempotencyKey: crypto.randomUUID(),
      expiresAt: new Date(Date.now() - 1),
      createdBy: c.owner,
    });
    expect(await errorOf(await h.handle(call(c.id, c.owner, "POST", `v1/actions/${action.id}/confirm`)))).toMatchObject({
      status: 409,
      code: "expired",
      message: "That offer ran out. Ask again and the assistant will offer it fresh.",
    });
  });
});

describe("one company never reaches another's", () => {
  it("B with A's conversation, rule, word and answer ids gets 'not found', and A's rows don't change", async () => {
    const h = harness([says("A's answer"), says("never")]);
    const a = company();
    const b = company();
    const list = await events(await h.handle(call(a.id, a.member, "POST", "v1/chat", { message: "Alpha question" })));
    const conversationId = (list[0] as { conversationId: string }).conversationId;
    const rule = (await (await h.handle(call(a.id, a.owner, "POST", "v1/settings/rules", { text: "Alpha rule" }))).json()) as { id: string };
    const term = (await (await h.handle(call(a.id, a.owner, "POST", "v1/settings/glossary", { term: "Alpha yard", meaning: "Depot" }))).json()) as { id: string };
    const faq = (await (await h.handle(call(a.id, a.owner, "POST", "v1/settings/faqs", { question: "Alpha hours?", answer: "Nine to five." }))).json()) as { id: string };
    await h.handle(call(a.id, a.owner, "POST", "v1/settings/profile", { profile: "Alpha Lawn Care" }));

    const asB = (method: "GET" | "POST", path: string, body?: unknown) => h.handle(call(b.id, b.owner, method, path, body));
    for (const [method, path, body] of [
      ["GET", `v1/conversations/${conversationId}`],
      ["POST", `v1/conversations/${conversationId}/messages`, { message: "continue A's thread" }],
      ["POST", `v1/settings/rules/${rule.id}/remove`],
      ["POST", `v1/settings/glossary/${term.id}/remove`],
      ["POST", `v1/settings/faqs/${faq.id}`, { question: "Hijacked?", answer: "Yes." }],
      ["POST", `v1/settings/faqs/${faq.id}/remove`],
    ] as const) {
      const res = await asB(method, path, body);
      const text = await res.text();
      expect([res.status, JSON.parse(text).error?.code], `${method} ${path}`).toEqual([404, "not_found"]);
      expect(text).not.toMatch(/Alpha/);
    }
    // B's own lists say nothing of A.
    for (const path of ["v1/conversations", "v1/settings", "v1/settings/changes", "v1/status"]) {
      expect(await (await asB("GET", path)).text(), path).not.toMatch(/Alpha/);
    }
    // A member of A can't read another member's conversation either.
    grant(a.id, "member2", MEMBER);
    expect((await h.handle(call(a.id, "member2", "GET", `v1/conversations/${conversationId}`))).status).toBe(404);
    // A's settings are as A left them.
    const settings = (await (await h.handle(call(a.id, a.owner, "GET", "v1/settings"))).json()) as {
      profile: string;
      rules: unknown[];
      glossary: unknown[];
      faqs: Array<{ answer: string }>;
    };
    expect(settings.profile).toBe("Alpha Lawn Care");
    expect(settings.rules).toHaveLength(1);
    expect(settings.glossary).toHaveLength(1);
    expect(settings.faqs.map((f) => f.answer)).toEqual(["Nine to five."]);
    expect(await listFaqs(db, b.id)).toEqual([]);
    // Only A's own question reached the model.
    expect(h.provider.calls()).toBe(1);
  });

  it("a person in TWO companies sees each company's conversations and offers only in that company", async () => {
    // The person check alone can't keep two companies apart when the person
    // is the same: only the company filter on every query does.
    const h = harness([says("Alpha answer"), callsTool("save_note", { text: "Alpha gate code" }), says("Confirm it.")]);
    const a = company();
    const b = company();
    grant(a.id, "both", OWNER);
    grant(b.id, "both", OWNER);
    const first = await events(await h.handle(call(a.id, "both", "POST", "v1/chat", { message: "Alpha question" })));
    const conversationId = (first[0] as { conversationId: string }).conversationId;
    const offer = await events(await h.handle(call(a.id, "both", "POST", "v1/chat", { message: "Save a note" })));
    const actionId = (offer.find((e) => e.type === "action") as { actionId: string }).actionId;

    const inB = (method: "GET" | "POST", path: string, body?: unknown) => h.handle(call(b.id, "both", method, path, body));
    expect((await (await inB("GET", "v1/conversations")).json()) as unknown).toEqual({ conversations: [] });
    expect((await inB("GET", `v1/conversations/${conversationId}`)).status).toBe(404);
    expect((await inB("POST", `v1/conversations/${conversationId}/messages`, { message: "carry on in B" })).status).toBe(404);
    expect((await inB("POST", `v1/actions/${actionId}/confirm`)).status).toBe(404);
    // …and in A, everything is there.
    const list = (await (await h.handle(call(a.id, "both", "GET", "v1/conversations"))).json()) as { conversations: unknown[] };
    expect(list.conversations).toHaveLength(2);
    expect((await h.handle(call(a.id, "both", "GET", `v1/conversations/${conversationId}`))).status).toBe(200);
  });
});

describe("settings, in plain words", () => {
  it("round-trips the profile, rules, words and answers, refuses what's too long, and logs each change in words", async () => {
    const h = harness();
    const c = company();
    const owner = (method: "GET" | "POST", path: string, body?: unknown) => h.handle(call(c.id, c.owner, method, path, body));
    expect((await owner("POST", "v1/settings/profile", { profile: "We fix fences in Ogden." })).status).toBe(200);
    expect((await owner("POST", "v1/settings/rules", { text: "Always offer a free quote." })).status).toBe(201);
    const term = (await (await owner("POST", "v1/settings/glossary", { term: "the shop", meaning: "Our workshop on 12th." })).json()) as { id: string };
    expect((await owner("POST", "v1/settings/faqs", { question: "Do you do gates?", answer: "Yes, wood and metal." })).status).toBe(201);
    expect((await owner("POST", `v1/settings/glossary/${term.id}/remove`)).status).toBe(200);
    expect((await errorOf(await owner("POST", "v1/settings/rules", { text: "" }))).message).toBe("Write the rule first.");
    expect((await errorOf(await owner("POST", "v1/settings/profile", { profile: "x ".repeat(1_190) }))).message).toMatch(/about a page/);

    const settings = (await (await owner("GET", "v1/settings")).json()) as Record<string, unknown>;
    expect(settings).toMatchObject({
      profile: "We fix fences in Ogden.",
      rules: [expect.objectContaining({ text: "Always offer a free quote." })],
      glossary: [],
      faqs: [expect.objectContaining({ question: "Do you do gates?", answer: "Yes, wood and metal." })],
      usage: expect.objectContaining({ messagesUsed: 2, messageLimit: 300, usedUp: false, resetsOn: "2026-11-01" }),
      configured: true,
    });
    const changes = (await (await owner("GET", "v1/settings/changes")).json()) as { changes: Array<{ what: string }> };
    expect(changes.changes.map((c2) => c2.what)).toEqual([
      "Removed a word: the shop",
      "Added an answer: Do you do gates?",
      "Added a word: the shop",
      "Added a house rule: Always offer a free quote.",
      "Wrote the business profile",
    ]);
    // Never a machine key in the owner's view.
    expect(JSON.stringify(changes)).not.toMatch(/business_profile|tenant_rule|_/);
  });
});

describe("the allowance as the screens show it (review M4/M5)", () => {
  it("says the site's day closed it, and that it opens again tomorrow, not on the 1st", () => {
    const wire = allowanceToWire({
      ok: false,
      code: "site_limit",
      message: "This site's AI has reached its limit for today.",
      usage: {
        messagesUsed: 0,
        messageLimit: 100,
        centsUsed: "0",
        centLimit: 700,
        resetsAt: new Date("2026-11-01T00:00:00Z"),
        limitedBy: "site",
        siteResetsAt: new Date("2026-10-17T00:00:00Z"),
      },
    });
    expect(wire).toMatchObject({ usedUp: true, limitedBy: "site", resetsOn: "2026-10-17" });
  });

  it("says a spending limit closed it when that's what did", () => {
    const wire = allowanceToWire({
      ok: false,
      code: "allowance_used_up",
      message: "…spending limit…",
      usage: { messagesUsed: 150, messageLimit: 500, centsUsed: "300", centLimit: 300, resetsAt: new Date("2026-11-01T00:00:00Z"), limitedBy: "cents" },
    });
    expect(wire).toMatchObject({ limitedBy: "cents", resetsOn: "2026-11-01" });
    expect(allowanceToWire({ ok: true, usage: { messagesUsed: 1, messageLimit: 5, centsUsed: "0", centLimit: 50, resetsAt: new Date() } })?.limitedBy).toBeNull();
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * The fixture behind e2e/tests/assistant-scenario.spec.ts (Tenancy 2b-3): a
 * REAL company assistant — @adminigloo/assistant's `createAssistantHandlers`
 * on a real Postgres (PGlite), its allowance and ledger from
 * @adminigloo/ai/server — serving the REAL widgets, bundled from
 * @adminigloo/assistant-widget's source, at the paths a generated companies
 * project uses:
 *
 *   /app                        a company page with <AssistantLauncher>
 *   /app/assistant              <AssistantSettings>
 *   /app?dark=1                 the same page on a dark host
 *   /api/app/{company}/assistant/*   createAssistantHandlers
 *
 * WIRED THE WAY create-app WIRES IT (src/server/assistant.ts): the company in
 * the path, `authorize` per route and per tool permission, the monthly
 * allowance and the site's day from `checkAiAllowance` (failing closed), each
 * question metered with `recordAiUsage`. What differs is what a test owns:
 *
 *   - THE MODEL: a scripted provider — never a real call. It answers by what
 *     was asked, calls the tools a real model would, and quotes what the tool
 *     returned. `calls` counts every model call.
 *   - SIGN-IN: an `e2e-user` cookie names who is signed in (the app reads its
 *     session); they're the company's owner.
 *   - THE ALLOWANCE: `setMonthlyMessages` moves the month's limit.
 *
 * Everything is imported from the BUILT packages (dist).
 */

const here = dirname(fileURLToPath(import.meta.url));
const e2eRoot = join(here, "..");
const repo = join(e2eRoot, "..");
const assistantDir = join(repo, "packages", "assistant");
const aiDir = join(repo, "packages", "ai");
const widgetSrc = join(repo, "packages", "assistant-widget", "src");

const fileUrl = (path: string) => pathToFileURL(path).href;
const real = (path: string) => realpathSync(path);

/* eslint-disable @typescript-eslint/no-explicit-any -- the packages are imported by path at runtime */
type Any = any;

export const COMPANY = "green-acres";
export const OWNER = "owner";

export interface AssistantScenario {
  origin: string;
  /** How many times the model was called. */
  calls: () => number;
  /** The month's message limit (null: none). */
  setMonthlyMessages: (limit: number | null) => void;
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

function ddl(drizzleRoot: Any, pgCore: Any, tables: Any[]): string[] {
  const dialect = new pgCore.PgDialect();
  const literal = (value: unknown): string => {
    if (drizzleRoot.is(value, drizzleRoot.SQL)) return dialect.sqlToQuery(value).sql;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    if (Array.isArray(value) || (value && typeof value === "object")) return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
    throw new Error(`no literal for default ${String(value)}`);
  };
  const out: string[] = [];
  for (const table of tables) {
    const config = pgCore.getTableConfig(table);
    const lines = config.columns.map((column: Any) => {
      let line = `"${column.name}" ${column.getSQLType()}`;
      if (column.primary) line += " PRIMARY KEY";
      else if (column.notNull) line += " NOT NULL";
      if (column.default !== undefined) line += ` DEFAULT ${literal(column.default)}`;
      return line;
    });
    out.push(`CREATE TABLE "${config.name}" (${lines.join(", ")})`);
    for (const index of config.indexes) {
      const columns = index.config.columns.map((c: Any) => `"${c.name}"`).join(", ");
      const where = index.config.where ? ` WHERE ${dialect.sqlToQuery(index.config.where).sql}` : "";
      out.push(`CREATE ${index.config.unique ? "UNIQUE " : ""}INDEX "${index.config.name}" ON "${config.name}" (${columns})${where}`);
    }
  }
  return out;
}

const HOST_APP = `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AssistantLauncher } from ${JSON.stringify(join(widgetSrc, "index.ts").replace(/\\/g, "/"))};
import { AssistantSettings } from ${JSON.stringify(join(widgetSrc, "admin", "index.ts").replace(/\\/g, "/"))};

const cfg = window.__page;
const base = "/api/app/" + cfg.company + "/assistant";

function CompanyPage() {
  return (
    <div>
      <header style={{ display: "flex", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid #ccc" }}>
        <strong>Green Acres</strong><nav>Schedule · Invoices · Assistant</nav>
      </header>
      <main><h1 style={{ fontSize: 22 }}>Green Acres</h1><p>Your company at a glance.</p></main>
      <AssistantLauncher config={{ baseUrl: base, title: "Green Acres's assistant", subtitle: "It looks things up for you, and asks before it changes anything.", settingsHref: "/app/assistant" }} />
    </div>
  );
}

function App() {
  if (cfg.mode === "settings") return <main style={{ maxWidth: 760, margin: "0 auto" }}><h1 style={{ fontSize: 22 }}>Assistant</h1><AssistantSettings baseUrl={base} /></main>;
  return <CompanyPage />;
}

createRoot(document.getElementById("root")).render(<StrictMode><App /></StrictMode>);
`;

async function bundleWidgets(): Promise<string> {
  const result = await build({
    stdin: { contents: HOST_APP, resolveDir: e2eRoot, sourcefile: "assistant-scenario-host.tsx", loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    alias: {
      react: join(e2eRoot, "node_modules", "react"),
      "react-dom": join(e2eRoot, "node_modules", "react-dom"),
    },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

function page(mode: string, title: string, dark: boolean): string {
  const background = dark ? "#0f1418" : "#ffffff";
  const color = dark ? "#e8edf1" : "#0e161c";
  return (
    `<!doctype html><html lang="en"${dark ? ' class="dark"' : ""}><head><meta charset="utf-8"><title>${title}</title>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body style="margin:0;padding:16px;font-family:system-ui;background:${background};color:${color}"><div id="root"></div>` +
    `<script>window.__page=${JSON.stringify({ mode, company: COMPANY })}</script><script src="/widgets.js"></script></body></html>`
  );
}

async function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    signal,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
}

/** Stream a handler's Response to the socket as it comes (the chat is server-sent events). */
async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    /* the person stopped it */
  }
  res.end();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startAssistantScenario(): Promise<AssistantScenario> {
  const drizzleDir = real(join(assistantDir, "node_modules", "drizzle-orm"));
  const pgliteDir = real(join(assistantDir, "node_modules", "@electric-sql", "pglite"));
  const assistant: Any = await import(fileUrl(join(assistantDir, "dist", "index.js")));
  const assistantSchema: Any = await import(fileUrl(join(assistantDir, "dist", "schema.js")));
  const aiServer: Any = await import(fileUrl(join(aiDir, "dist", "server.js")));
  const aiSchema: Any = await import(fileUrl(join(aiDir, "dist", "schema.js")));
  const drizzleRoot: Any = await import(fileUrl(join(drizzleDir, "index.js")));
  const pgCore: Any = await import(fileUrl(join(drizzleDir, "pg-core", "index.js")));
  const { drizzle }: Any = await import(fileUrl(join(drizzleDir, "pglite", "index.js")));
  const { PGlite }: Any = await import(fileUrl(join(pgliteDir, "dist", "index.js")));

  const client = new PGlite();
  const tables = [
    ...Object.values(assistantSchema).filter((t: Any) => t && typeof t === "object" && drizzleRoot.is(t, pgCore.PgTable)),
    aiSchema.aiUsage,
  ];
  for (const statement of ddl(drizzleRoot, pgCore, tables)) await client.exec(statement);
  const db = drizzle(client);

  const RATES = {
    "claude-haiku-4-5": { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000, cachedInputMicrosPerMTok: 100_000, cachedWriteMicrosPerMTok: 1_250_000 },
  };
  let monthlyMessages: number | null = 300;

  // --- the tools, the way src/server/assistant-tools.ts writes them ---------------
  const overdue = {
    name: "overdue_invoices",
    description: "Invoices past their due date with money still owed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse: (input: unknown) => input ?? {},
    requiresPermission: "invoices.view",
    label: "Looking at overdue invoices",
    // Finished figures: code counts and formats; the model quotes.
    run: async () => ({
      overdueCount: 2,
      totalOwed: "$1,060.00",
      invoices: [
        { number: "INV-0042", customer: "Pat Rivera", owed: "$450.00", dueOn: "Oct 4, 2026", daysLate: 12 },
        { number: "INV-0043", customer: "Sam Lee", owed: "$610.00", dueOn: "Oct 9, 2026", daysLate: 7 },
      ],
    }),
  };
  const remember = {
    name: "remember_answer",
    description: "Offer to save an answer to a common question. They must confirm it.",
    inputSchema: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } }, required: ["question", "answer"] },
    parse: (input: Any) => {
      if (!input || typeof input.question !== "string" || typeof input.answer !== "string") throw new Error("question and answer");
      return { question: input.question, answer: input.answer };
    },
    requiresPermission: "assistant.settings.manage",
    write: true,
    summarize: (input: Any) => `Save an answer to “${input.question}”`,
    fields: (input: Any) => [
      { key: "question", label: "Question", value: input.question, multiline: false },
      { key: "answer", label: "Answer", value: input.answer, multiline: true },
    ],
    done: () => "Saved. That question will be answered with these words from now on.",
    run: async (input: Any, ctx: Any) => {
      const saved = await assistant.saveFaq(db, ctx.tenantId, input, ctx.userId);
      if (!saved.saved) throw new Error(saved.reason);
      return { saved: true };
    },
  };
  const tools = assistant.createToolRegistry([overdue, remember]);

  const allowanceInput = (tenantId: string) => ({
    tenantId,
    operations: ["assistant_chat"],
    allowance: { monthlyMessages, monthlyCents: monthlyMessages === null ? 5_000 : monthlyMessages * 7 },
    siteDailyCents: 500,
  });
  const toVerdict = (verdict: Any, reservation?: string) => {
    const u = verdict.usage;
    const usage = u
      ? { messagesUsed: u.messages, messageLimit: u.messageLimit, centsUsed: u.cents, centLimit: u.centLimit, resetsAt: u.resetsAt, ...(u.limitedBy ? { limitedBy: u.limitedBy } : {}), ...(u.siteResetsAt ? { siteResetsAt: u.siteResetsAt } : {}) }
      : null;
    if (verdict.ok) return { ok: true, usage, ...(reservation ? { reservation } : {}) };
    const code = verdict.reason === "site_ceiling" ? "site_limit" : verdict.reason === "unavailable" ? "allowance_unavailable" : "allowance_used_up";
    return { ok: false, code, message: verdict.message, usage };
  };

  // --- the scripted model -------------------------------------------------------
  let modelCalls = 0;
  const usage = (output: number) => ({ inputTokens: 900, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0, reported: true });
  const provider = {
    modelId: "claude-haiku-4-5",
    async *stream(request: Any) {
      modelCalls += 1;
      const last = request.messages.at(-1);
      const lastBlocks: Any[] = last?.blocks ?? [];
      const toolResult = lastBlocks.find((b: Any) => b.kind === "tool-result");
      if (toolResult) {
        const data = toolResult.result?.data;
        if (data?.invoices) {
          const lines = data.invoices.map((i: Any) => `- **${i.number}** — ${i.customer}, ${i.owed}, ${i.daysLate} days late`);
          const text = `**${data.overdueCount} invoices** are overdue, ${data.totalOwed} in all:\n\n${lines.join("\n")}\n\nOpen [Invoices](/app/invoices) to send a reminder.`;
          for (const word of text.split(/(?<= )/)) {
            yield { type: "text-delta", delta: word };
            await sleep(8);
          }
        } else {
          yield { type: "text-delta", delta: "I've prepared that — say **Yes, do it** below to save it." };
        }
        yield { type: "step-end", stopReason: "end_turn", usage: usage(60) };
        return;
      }
      const asked = String(lastBlocks.filter((b: Any) => b.kind === "text").at(-1)?.text ?? "").toLowerCase();
      if (asked.includes("overdue")) {
        yield { type: "text-delta", delta: "Let me check." };
        yield { type: "tool-call", toolCallId: `call_${modelCalls}`, name: "overdue_invoices", input: {} };
        yield { type: "step-end", stopReason: "tool_use", usage: usage(20) };
        return;
      }
      if (asked.includes("deposit")) {
        yield { type: "tool-call", toolCallId: `call_${modelCalls}`, name: "remember_answer", input: { question: "How do I pay my deposit?", answer: "Deposits are paid at https://pay-elsewhere.example/deposit — have your card ready." } };
        yield { type: "step-end", stopReason: "tool_use", usage: usage(30) };
        return;
      }
      if (asked.includes("remember")) {
        yield { type: "tool-call", toolCallId: `call_${modelCalls}`, name: "remember_answer", input: { question: "Do you work on Sundays?", answer: "No — we work Monday to Saturday, 7am to 6pm." } };
        yield { type: "step-end", stopReason: "tool_use", usage: usage(30) };
        return;
      }
      if (asked.includes("slow")) {
        for (let i = 0; i < 200; i += 1) {
          if (request.signal?.aborted) {
            // Nothing reported, as a provider cut off mid-stream: the loop must still price it.
            yield { type: "step-end", stopReason: "aborted", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reported: false } };
            return;
          }
          yield { type: "text-delta", delta: `word${i} ` };
          await sleep(40);
        }
        yield { type: "step-end", stopReason: "end_turn", usage: usage(200) };
        return;
      }
      yield { type: "text-delta", delta: "I can look up **overdue invoices** for you, or remember an answer." };
      yield { type: "step-end", stopReason: "end_turn", usage: usage(20) };
    },
  };

  const handlers = assistant.createAssistantHandlers({
    db,
    resolveTenant: (req: Request) => new URL(req.url).pathname.split("/")[3] ?? null,
    authorize: (req: Request, _permission: string, tenantId: string) => {
      const who = /(?:^|;\s*)e2e-user=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      if (!who) return Response.json({ error: { code: "forbidden", message: "You've been signed out. Sign in again to keep working." } }, { status: 401 });
      if (tenantId !== COMPANY) return Response.json({ error: { code: "forbidden", message: "You're not part of this company." } }, { status: 403 });
      // The owner holds every key here.
      return { userId: decodeURIComponent(who) };
    },
    provider,
    tools,
    // Wired as create-app's src/server/assistant.ts: a read-only check for the
    // screens, a held place before every model call, settled after.
    allowance: async ({ tenantId }: { tenantId: string }) => toVerdict(await aiServer.checkAiAllowance(db, allowanceInput(tenantId))),
    reserve: async ({ tenantId, userId, model, maxInputTokens, maxOutputTokens }: Any) => {
      const verdict = await aiServer.reserveAiAllowance(db, {
        ...allowanceInput(tenantId),
        userId,
        operation: "assistant_chat",
        model,
        reserveMicros: aiServer.aiCallCostMicros(RATES, { model, inputTokens: maxInputTokens, outputTokens: maxOutputTokens, reported: true }) ?? 70_000n,
      });
      return toVerdict(verdict, verdict.ok ? verdict.reservationId : undefined);
    },
    recordUsage: async (turn: Any) => {
      const usage = {
        model: turn.model,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cachedInputTokens: turn.usage.cacheReadTokens,
        cachedWriteTokens: turn.usage.cacheWriteTokens,
        reported: turn.usage.complete,
      };
      const status = !turn.answered ? "errored" : turn.aborted ? "cancelled" : "completed";
      await aiServer.settleAiReservation(db, RATES, turn.reservation, { usage, status, latencyMs: turn.latencyMs });
    },
    starters: ["Which invoices are overdue?", "What's on the schedule tomorrow?"],
    onError: (error: unknown) => console.error("assistant handler error", error),
  });

  const widgets = await bundleWidgets();
  let origin = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;
      const aborter = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) aborter.abort();
      });
      try {
        if (path.startsWith("/api/app/")) return await send(res, await handlers.handle(await toRequest(req, origin, aborter.signal)));
        if (path === "/widgets.js") {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          return res.end(widgets);
        }
        const html = (body: string) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(body);
        };
        const dark = url.searchParams.get("dark") === "1";
        if (path === "/app") return html(page("app", "Green Acres", dark));
        if (path === "/app/assistant") return html(page("settings", "Assistant", dark));
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      } catch (error) {
        console.error(error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end("fixture error");
      }
    })();
  });
  // A free port the system picks (never 3000, which the founder's own dev
  // server uses), so two specs on this fixture never collide; set
  // ASSISTANT_E2E_PORT (3400+) to pin one.
  await new Promise<void>((resolve) => server.listen(Number(process.env.ASSISTANT_E2E_PORT ?? 0), "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    get origin() {
      return origin;
    },
    calls: () => modelCalls,
    setMonthlyMessages: (limit) => {
      monthlyMessages = limit;
    },
    query: async (sql, params) => (await client.query(sql, params)).rows,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.close();
    },
  };
}

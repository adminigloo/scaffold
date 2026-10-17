/**
 * Tenancy 2b-3 — THE AI ASSISTANT, PER COMPANY: the renderers for
 * `src/server/assistant.ts` (the glue between the project and
 * @adminigloo/assistant's handlers), `src/server/assistant-tools.ts` (what the
 * assistant may look up, through each installed feature's own reads), and
 * `src/components/AssistantLauncherSlot.tsx` (the chat button on a company's
 * pages).
 *
 * Two assistants exist in a companies project, one in a single business:
 *
 *   each company's own   the launcher on /app pages and settings at
 *                        /app/assistant, over /api/app/{id}/assistant — its
 *                        profile, FAQs, house rules, words and month of AI
 *   this site's own      /admin/assistant (the editor) and
 *                        /admin/assistant/chat over /api/admin/assistant, for
 *                        the site's staff — "*", ASSISTANT_PLATFORM
 *
 * The chat needs a model: it is wired with --ai (the key, the rate table and
 * the usage ledger). Without --ai the settings and the editor still work and
 * the chat says it isn't switched on.
 *
 * In its own module because emit.ts is long enough already (the
 * features-emit.ts precedent). The generator's rules apply: no emitted `if`
 * about an answer — each file is written per mode and per feature set.
 */

import { tenantLabel, type Answers } from "./answers.js";
import { plansEnforced } from "./plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** Does this project's assistant answer with a model (assistant + ai)? */
export function assistantChats(answers: Answers): boolean {
  return answers.includeAssistant && answers.includeAi;
}

// ---------------------------------------------------------------------------
// src/server/assistant.ts
// ---------------------------------------------------------------------------

export function renderAssistantGlue(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const chats = assistantChats(answers);
  const noun = tenantLabel(answers).toLowerCase();

  const imports = [
    `import {`,
    `  ASSISTANT_PLATFORM,`,
    `  createAssistantHandlers,`,
    ...(chats ? [`  type AssistantAllowanceVerdict,`, `  type AssistantTurnUsage,`] : []),
    `  type ProviderAdapter,`,
    `} from "${scope}/assistant";`,
    ...(chats
      ? [
          `import { createAnthropicProvider, DEFAULT_ASSISTANT_MODEL } from "${scope}/assistant/anthropic";`,
          `import { estimateCostMicros } from "${scope}/ai";`,
          `import { checkAiAllowance, recordAiUsage, reserveAiAllowance, settleAiReservation, type AiAllowanceVerdict } from "${scope}/ai/server";`,
        ]
      : []),
    `import { db } from "@/db";`,
    ...(chats ? [`import { env } from "@/env";`, `import { AI_SITE_DAILY_CENTS, alertSiteCeiling, anthropic, MODEL_RATES } from "@/server/ai";`] : []),
    `import { ${companies ? "companyAssistantTools, companyStarters, " : ""}platformAssistantTools, platformStarters } from "@/server/assistant-tools";`,
    ...(companies ? [`import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(chats ? [`import { log } from "@/server/logger";`, `import { failClosedLimiter } from "@/server/rate-limit";`] : []),
    ...(companies && chats ? [`import { assistantMessageLimit } from "@/server/plan-gate";`] : []),
    `import { authorizeStaffFor } from "@/server/staff-access";`,
  ];

  const model = chats
    ? `
/**
 * The model the assistant calls: Claude Haiku 4.5 unless ASSISTANT_MODEL
 * names another — the founder's rule, the cheapest model that does the job.
 * Another model needs its price in MODEL_RATES (src/server/ai.ts): an
 * unpriced model couldn't be metered, so the chat stays off and the server
 * log says why.
 */
export const ASSISTANT_MODEL: string = env.ASSISTANT_MODEL ?? DEFAULT_ASSISTANT_MODEL;

/**
 * THE MONTH'S QUESTIONS — the one limit a ${companies ? noun : "business"} sees${companies && plansEnforced(answers) ? `, unless its plan
 * sets its own (src/plans.ts, "AI assistant messages a month")` : ""}. Only
 * questions the model ANSWERED count (one the provider refused doesn't), and
 * an answer the ${companies ? noun : "business"} wrote itself, asked word for word, is free and never counts.
 */
export const ASSISTANT_MONTHLY_MESSAGES = 300;

/**
 * A SAFETY CAP ON CENTS, set so the message count is what really limits the
 * month — never this. The most one question can cost at Haiku 4.5's prices
 * ($1 in, $5 out per million tokens), with this assistant's defaults (4 tool
 * steps; ~11,000 tokens of prompt, history and tool results re-sent per step;
 * 1,024 output tokens per step):
 *
 *   input   4 × 11,000 = 44,000 tokens × $1/M  = 4.4¢
 *   output  4 × 1,024  =  4,096 tokens × $5/M  ≈ 2.0¢
 *   worst case                                 ≈ 6.5¢ a question
 *
 * A typical question is one step and well under half a cent. So the cap is
 * 7¢ × the month's questions: only a month of nothing but worst cases could
 * reach it before the questions run out — and if it ever does, the chat and
 * the settings say so ("it reached its spending limit"). A ${companies ? noun : "business"} with
 * UNLIMITED questions still has a cap (ASSISTANT_UNLIMITED_CENTS, $50 a
 * month), so no one ${companies ? noun : "account"} can spend the whole site's AI_SITE_DAILY_CENTS
 * every day of the month.
 */
export const ASSISTANT_WORST_CASE_CENTS = 7;
export const ASSISTANT_UNLIMITED_CENTS = 5_000;

/**
 * ONE ${companies ? noun.toUpperCase() : "BUSINESS"}'S SHARE OF THE SITE'S DAY: at most a quarter of
 * AI_SITE_DAILY_CENTS, whatever its month allows — so no single ${companies ? noun : "account"} (an
 * unlimited plan included) can spend the whole site's ceiling and close AI
 * for everyone else. At $5 a day that's $1.25, over a hundred typical questions.
 */
export const ASSISTANT_DAILY_SHARE_CENTS = Math.max(1, Math.floor(AI_SITE_DAILY_CENTS / 4));

/** The cents cap for a month of this many questions (null: unlimited questions). */
export function assistantCentsCap(messages: number | null): number {
  return messages === null ? ASSISTANT_UNLIMITED_CENTS : messages * ASSISTANT_WORST_CASE_CENTS;
}

/** What each assistant question is counted as in ai_usage. */
const OPERATION = "assistant_chat";

/**
 * How fast one person, and one ${companies ? noun : "business"} together, may ask — on the shared
 * limiter, failing closed (an unreachable limiter refuses: an unthrottled
 * model route is the one omission that produces a same-day bill).
 */
const ASSISTANT_PERSON_POLICY = { limit: 10, windowMs: 60_000 } as const;
const ASSISTANT_COMPANY_POLICY = { limit: 30, windowMs: 60_000 } as const;

async function assistantRateLimit({ tenantId, userId }: { tenantId: string; userId: string }): Promise<true | string> {
  const person = await failClosedLimiter.limit({ key: \`assistant:person:\${tenantId}:\${userId}\`, policy: ASSISTANT_PERSON_POLICY });
  if (!person.allowed) return "You're asking faster than the assistant can keep up. Give it a minute.";
  const company = await failClosedLimiter.limit({ key: \`assistant:company:\${tenantId}\`, policy: ASSISTANT_COMPANY_POLICY });
  if (!company.allowed) return "Your team is asking faster than the assistant can keep up. Give it a minute.";
  return true;
}

/** The model, or null: no ANTHROPIC_API_KEY, or a model with no price (fail closed: an unmetered call is never made). */
export function assistantProvider(): ProviderAdapter | null {
  if (!anthropic) return null;
  if (!MODEL_RATES[ASSISTANT_MODEL]) {
    log.error({ model: ASSISTANT_MODEL }, "assistant: the chat is off — MODEL_RATES in src/server/ai.ts has no price for this model");
    return null;
  }
  return createAnthropicProvider({ client: anthropic, model: ASSISTANT_MODEL });
}

/** The ledger's verdict, in the assistant's words. */
function toVerdict(verdict: AiAllowanceVerdict, reservation?: string): AssistantAllowanceVerdict {
  const usage = verdict.usage
    ? {
        messagesUsed: verdict.usage.messages,
        messageLimit: verdict.usage.messageLimit,
        centsUsed: verdict.usage.cents,
        centLimit: verdict.usage.centLimit,
        resetsAt: verdict.usage.resetsAt,
        ...(verdict.usage.limitedBy ? { limitedBy: verdict.usage.limitedBy } : {}),
        ...(verdict.usage.siteResetsAt ? { siteResetsAt: verdict.usage.siteResetsAt } : {}),
      }
    : null;
  if (verdict.ok) return { ok: true, usage, ...(reservation ? { reservation } : {}) };
  const code =
    verdict.reason === "site_ceiling" || verdict.reason === "company_day"
      ? "site_limit"
      : verdict.reason === "unavailable"
        ? "allowance_unavailable"
        : "allowance_used_up";
  return { ok: false, code, message: verdict.message, usage };
}

function allowanceInput(tenantId: string, messages: number | null) {
  return {
    tenantId,
    operations: [OPERATION],
    allowance: { monthlyMessages: messages, monthlyCents: assistantCentsCap(messages), dailyCents: ASSISTANT_DAILY_SHARE_CENTS },
    siteDailyCents: AI_SITE_DAILY_CENTS,
    onSiteCeiling: alertSiteCeiling,
  };
}

/** Where a month stands, for the status and settings screens (read only). */
async function allowanceFor(tenantId: string, messages: number | null): Promise<AssistantAllowanceVerdict> {
  return toVerdict(await checkAiAllowance(db, allowanceInput(tenantId, messages)));
}

/**
 * CHECK AND HOLD, before every model call: this question's worst case is
 * held in ai_usage ("reserved"), inside one lock, so questions sent at once
 * see each other — forty at once on a three-question month get three
 * answers, not forty. Settled with the real cost after (recordTurn).
 */
async function reserveFor(
  tenantId: string,
  userId: string,
  messages: number | null,
  estimate: { model: string; maxInputTokens: number; maxOutputTokens: number },
): Promise<AssistantAllowanceVerdict> {
  const rate = MODEL_RATES[estimate.model];
  const reserveMicros = rate
    ? estimateCostMicros({ inputTokens: estimate.maxInputTokens, outputTokens: estimate.maxOutputTokens, rate })
    : BigInt(ASSISTANT_WORST_CASE_CENTS) * 10_000n;
  const verdict = await reserveAiAllowance(db, {
    ...allowanceInput(tenantId, messages),
    userId,
    operation: OPERATION,
    model: estimate.model,
    reserveMicros,
  });
  return toVerdict(verdict, verdict.ok ? verdict.reservationId : undefined);
}

/**
 * Settle a question's held place with what it really cost: the PROVIDER's
 * token counts (or, for an answer cut short, what was sent and streamed),
 * priced in code from MODEL_RATES — never the model's word, never left free.
 * A question that failed doesn't use up a message; its tokens still count.
 */
async function recordTurn(turn: AssistantTurnUsage): Promise<void> {
  const usage = {
    model: turn.model,
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
    cachedInputTokens: turn.usage.cacheReadTokens,
    cachedWriteTokens: turn.usage.cacheWriteTokens,
    reported: turn.usage.complete,
  };
  const status = !turn.answered ? "errored" : turn.aborted ? "cancelled" : "completed";
  const onError = (error: unknown) =>
    log.error({ err: error instanceof Error ? error.message : String(error), tenantId: turn.tenantId }, "assistant: this question's AI use couldn't be recorded");
  if (turn.reservation) {
    await settleAiReservation(db, MODEL_RATES, turn.reservation, { usage, status, latencyMs: turn.latencyMs }, { onError });
    return;
  }
  await recordAiUsage(db, MODEL_RATES, { tenantId: turn.tenantId, userId: turn.userId, operation: OPERATION, usage, status, latencyMs: turn.latencyMs }, { onError });
}
`
    : `
/**
 * The model: none. ${answers.projectName} was generated without --ai, so the
 * assistant's chat says it isn't switched on here, and everything else — the
 * editor, ${companies ? `each ${noun}'s settings, ` : ""}its FAQs and house rules — works. \`add ai\`
 * wires in Claude Haiku 4.5, metered, with a monthly allowance.
 */
export function assistantProvider(): ProviderAdapter | null {
  return null;
}
`;

  const errors = `
/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportAssistantError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "assistant", route: context.route },
  });
}

/** What a test swaps: the model (the project's own tests never call a real one). */
export interface AssistantModelOverride {
  readonly provider?: ProviderAdapter | null;
}
`;

  const staff = `
/**
 * The staff key each assistant permission is checked against on THIS SITE'S
 * OWN assistant (/admin/assistant): one key per job, never the shell's
 * staff.dashboard.view.
 *
 *   staff.assistant.use     ask it, see your own conversations, confirm its changes
 *   staff.assistant.manage  its personality, house rules, words and answers
 *
 * A tool's own permission is a staff key already (src/server/assistant-tools.ts)
 * and is checked as it is: the assistant reads only what that person could.
 */
export const ASSISTANT_STAFF_KEYS: Readonly<Record<string, string>> = {
  "assistant.use": "staff.assistant.use",
  "assistant.settings.manage": "staff.assistant.manage",
};

const staffAuthorize = authorizeStaffFor(
  new Proxy(ASSISTANT_STAFF_KEYS, {
    // A staff key (a tool's) is itself; an unknown key matches nothing.
    get: (keys, permission: string) => keys[permission] ?? (permission.startsWith("staff.") ? permission : "staff.nobody"),
  }),
  "Sign in to use the assistant.",
);

/**
 * THIS SITE'S OWN assistant, for its staff (/admin/assistant/chat over
 * /api/admin/assistant): its own personality ("*"), conversations and
 * answers. Never a ${companies ? noun + "'s" : "customer's"}: the assistant is fixed.
 */
export function buildPlatformAssistantHandlers(overrides: AssistantModelOverride = {}) {
  return createAssistantHandlers({
    db,
    tenantId: ASSISTANT_PLATFORM,
    authorize: staffAuthorize,
    provider: overrides.provider !== undefined ? overrides.provider : assistantProvider(),
    tools: platformAssistantTools,${chats ? `
    allowance: ({ tenantId }) => allowanceFor(tenantId, ASSISTANT_MONTHLY_MESSAGES),
    reserve: ({ tenantId, userId, ...estimate }) => reserveFor(tenantId, userId, ASSISTANT_MONTHLY_MESSAGES, estimate),
    recordUsage: recordTurn,
    rateLimit: assistantRateLimit,` : ""}
    starters: platformStarters,
    onError: reportAssistantError,
  });
}
`;

  const company = companies
    ? `
${chats ? `/** A ${noun}'s questions a month: its plan's, else the project's own. */
async function monthlyMessagesOf(tenantId: string): Promise<number | null> {
  const planned = await assistantMessageLimit(tenantId);
  return planned === undefined ? ASSISTANT_MONTHLY_MESSAGES : planned;
}

` : ""}/**
 * A ${noun}'s own assistant (/app pages and /app/assistant, over
 * /api/app/{${noun} id}/assistant): the ${noun} is the one the PATH names,
 * asked on every call (assistant.use to ask, assistant.settings.manage for
 * its settings), and each tool is asked for again with the person's own
 * permission in that ${noun}. Another ${noun}'s conversation, change, rule,
 * word or answer is "not found". \`overrides\` is how the project's isolation
 * proof calls it as somebody else, with a scripted model.
 */
export function buildAssistantHandlers(overrides: FeatureHandlerOverrides & AssistantModelOverride = {}) {
  return createAssistantHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    provider: overrides.provider !== undefined ? overrides.provider : assistantProvider(),
    tools: companyAssistantTools,${chats ? `
    // The ${noun}'s plan sets its questions a month${plansEnforced(answers) ? "" : " (none in this project: the default applies)"}; its cents cap follows from it.
    allowance: async ({ tenantId }) => allowanceFor(tenantId, await monthlyMessagesOf(tenantId)),
    reserve: async ({ tenantId, userId, ...estimate }) => reserveFor(tenantId, userId, await monthlyMessagesOf(tenantId), estimate),
    recordUsage: recordTurn,
    rateLimit: assistantRateLimit,` : ""}
    starters: companyStarters,
    onError: reportAssistantError,
  });
}
`
    : "";

  return `${imports.join("\n")}

/**
 * The app's side of ${scope}/assistant${companies ? ` in a COMPANIES project (Tenancy 2b-3): every
 * ${noun} has its own assistant, under its own id, and this site keeps its own
 * for its staff ("*").` : ` in a SINGLE-BUSINESS project: one assistant, the
 * site's own ("*"), for its staff at /admin/assistant.`}
 *
 * ASK BEFORE ACTING. The assistant reads through tools; anything that would
 * change something is offered as a card the person answers ("Yes, do it"),
 * and runs once, as them, with their permissions.
 *
 * THE MODEL NEVER DOES MATH. Every figure it quotes comes from a tool, worked
 * out in code; every cost is priced in code from the provider's counts.
 */
${model}${errors}${staff}${company}`;
}

// ---------------------------------------------------------------------------
// src/server/assistant-tools.ts
// ---------------------------------------------------------------------------

interface ToolPlan {
  /** The module-level helpers this tool needs (imports are collected separately). */
  readonly source: string;
  readonly name: string;
  readonly starter: string | null;
}

/** "Which company's rows": the person's company, or the single business's fixed one. */
function tenantExpr(companies: boolean, singleConst: string): string {
  return companies ? "ctx.tenantId" : singleConst;
}

export function renderAssistantTools(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const imports: string[] = [
    `import { z } from "zod";`,
    `import { createToolRegistry, saveFaq, type AssistantTool } from "${scope}/assistant";`,
  ];
  const tools: ToolPlan[] = [];
  // A single business's tools read its fixed business, so they take no context.
  const ctxParam = companies ? ", ctx" : "";

  if (answers.includeScheduling) {
    imports.push(`import { getSchedulingSettings, listCalendar, todayIn } from "${scope}/scheduling";`);
    if (!companies) imports.push(`import { SCHEDULING_TENANT } from "@/server/scheduling-staff";`);
    const permission = companies ? "schedule.view" : "staff.schedule.view";
    tools.push({
      name: "scheduleForDay",
      starter: "What's on the schedule tomorrow?",
      source: `
/** "2026-10-17" plus some days, on the calendar (no clock involved). */
function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const VISIT_WORDS: Readonly<Record<string, string>> = {
  pending: "waiting for an answer",
  confirmed: "booked",
  in_progress: "under way",
  completed: "done",
  no_show: "no-show",
};

const scheduleForDayInput = z.object({ day: z.string().regex(/^(today|tomorrow|\\d{4}-\\d{2}-\\d{2})$/) });

/** The visits on one day, in the ${noun}'s own time zone, from the calendar the schedule screen reads. */
const scheduleForDay: AssistantTool<z.infer<typeof scheduleForDayInput>> = {
  name: "schedule_for_day",
  description: "The visits booked on one day: today, tomorrow, or a date (YYYY-MM-DD). Times are the ${noun}'s own.",
  inputSchema: {
    type: "object",
    properties: { day: { type: "string", description: '"today", "tomorrow" or a date like 2026-10-17' } },
    required: ["day"],
    additionalProperties: false,
  },
  parse: (input) => scheduleForDayInput.parse(input),
  requiresPermission: "${permission}",
  label: "Looking at the schedule",
  // Customers' names and addresses come from a public booking form: their
  // words are data, never instructions, and not the business's own record.
  authoritative: false,
  maxResultTokens: 1_500,
  run: async (input${ctxParam}) => {
    const tenantId = ${tenantExpr(companies, "SCHEDULING_TENANT")};
    const settings = await getSchedulingSettings(db, tenantId);
    const today = todayIn(new Date(), settings.timeZone);
    const date = input.day === "today" ? today : input.day === "tomorrow" ? addDays(today, 1) : input.day;
    const calendar = await listCalendar(db, tenantId, { from: date, to: date }, { settings });
    const visits = calendar.visits.map((visit) => ({
      time: \`\${visit.startTime}–\${visit.endTime}\`,
      what: visit.serviceName,
      customer: visit.customerName ?? "No name given",
      address: visit.address ?? "No address",
      crew: visit.resourceName ?? "No crew yet",
      status: VISIT_WORDS[visit.status] ?? visit.status,
    }));
    return {
      date: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(\`\${date}T12:00:00Z\`)),
      visitCount: visits.length,
      visits: visits.slice(0, 25),
      requestsWaitingForAnAnswer: calendar.pending.length,
    };
  },
};
`,
    });
  }

  if (answers.includeInvoicing) {
    imports.push(`import { formatCents, listOverdueInvoices, resolveInvoicingBusiness } from "${scope}/invoicing";`);
    imports.push(
      companies
        ? `import { invoicingBusiness } from "@/server/invoicing";`
        : `import { INVOICING_BUSINESS, INVOICING_TENANT } from "@/server/invoicing";`,
    );
    const permission = companies ? "invoices.view" : "staff.invoices.view";
    tools.push({
      name: "overdueInvoices",
      starter: "Which invoices are overdue?",
      source: `
/** The most overdue invoices one answer looks at. */
const OVERDUE_SHOWN = 200;

/** Every invoice past its due date with money still owed, oldest first — the ledger's own rule and figures. */
const overdueInvoices: AssistantTool<Record<string, never>> = {
  name: "overdue_invoices",
  description: "Invoices past their due date with money still owed: who owes, how much, and how many days late.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  parse: (input) => z.object({}).strict().parse(input ?? {}) as Record<string, never>,
  requiresPermission: "${permission}",
  label: "Looking at overdue invoices",
  // The amounts are the ledger's, but customer names were typed by people outside the business.
  authoritative: false,
  maxResultTokens: 1_500,
  run: async (_input${ctxParam}) => {
    const tenantId = ${tenantExpr(companies, "INVOICING_TENANT")};
    const business = resolveInvoicingBusiness(${companies ? "await invoicingBusiness(tenantId)" : "INVOICING_BUSINESS"});
    const now = new Date();
    // Every overdue invoice, not only the last week's (the alerts' window) —
    // up to 200, and asked for one more so a longer list is never presented as
    // the whole of it.
    const found = await listOverdueInvoices(db, tenantId, { now, timeZone: business.timeZone, dueSince: "2000-01-01", limit: OVERDUE_SHOWN + 1 });
    const more = found.length > OVERDUE_SHOWN;
    const due = found.slice(0, OVERDUE_SHOWN);
    const owed = due.reduce((sum, invoice) => sum + invoice.balanceDue, 0);
    const money = (cents: number) => formatCents(cents, business.currency, business.locale);
    const day = new Intl.DateTimeFormat(business.locale, { timeZone: business.timeZone, dateStyle: "medium" });
    return {
      // A lower bound says so in words: "at least 200", never "200".
      overdueCount: more ? \`at least \${OVERDUE_SHOWN}\` : due.length,
      totalOwed: more ? \`at least \${money(owed)}\` : money(owed),
      ...(more ? { note: \`There are more than \${OVERDUE_SHOWN} overdue invoices; open Invoices for the full list.\` } : {}),
      invoices: due.slice(0, 20).map((invoice) => ({
        number: invoice.number,
        customer: invoice.customerName ?? "No name given",
        owed: money(invoice.balanceDue),
        dueOn: day.format(invoice.dueDate),
        daysLate: Math.max(1, Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86_400_000) + 1),
      })),
    };
  },
};
`,
    });
  }

  if (answers.includeEstimator) {
    imports.push(`import { formatMoney as formatEstimateMoney, getEstimatorSettings, listProducts } from "${scope}/estimator";`);
    if (!companies) imports.push(`import { ESTIMATOR_TENANT } from "@/server/estimator-staff";`);
    const permission = companies ? "estimator.view" : "staff.estimates.view";
    tools.push({
      name: "priceBookLookup",
      // Not a fixed product: the starter names one of the business's own (assistantStarters).
      starter: null,
      source: `
const PRICED_BY: Readonly<Record<string, string>> = {
  area: "by the area (width × length)",
  linear: "by the length",
  unit: "per item",
};

const priceBookInput = z.object({ search: z.string().max(80).default("") });

/**
 * What the price book says about a product: its name, what it's for, how it's
 * priced and its minimum charge. An exact price depends on the measurements,
 * which the online estimate (or the estimate editor) works out — never the
 * assistant.
 */
const priceBookLookup: AssistantTool<z.infer<typeof priceBookInput>> = {
  name: "price_book_lookup",
  description: "Look up products in the price book by name: what each is, how it's priced and its minimum charge.",
  inputSchema: {
    type: "object",
    properties: { search: { type: "string", description: "Words from the product's name; empty lists the first few." } },
    additionalProperties: false,
  },
  parse: (input) => priceBookInput.parse(input ?? {}),
  requiresPermission: "${permission}",
  label: "Looking at the price book",
  // The business's own price book, written by its owner.
  authoritative: true,
  maxResultTokens: 1_200,
  run: async (input${ctxParam}) => {
    const tenantId = ${tenantExpr(companies, "ESTIMATOR_TENANT")};
    const settings = await getEstimatorSettings(db, tenantId);
    const words = input.search.toLowerCase().split(/\\s+/).filter((w) => w.length > 1);
    const products = (await listProducts(db, tenantId)).filter(
      (product) => words.length === 0 || words.some((word) => \`\${product.name} \${product.category ?? ""}\`.toLowerCase().includes(word)),
    );
    return {
      found: products.length,
      products: products.slice(0, 10).map((product) => ({
        name: product.name,
        about: product.description ?? null,
        pricedBy: PRICED_BY[product.measurementMode] ?? "per job",
        minimumCharge: product.minimumCharge > 0 ? formatEstimateMoney(product.minimumCharge, settings) : null,
        onTheOnlineEstimate: product.showInEstimator,
      })),
      note: "An exact price depends on the job's measurements; the online estimate works it out.",
    };
  },
};
`,
    });
  }

  // The one write: remembering an answer, as an FAQ. Never done in the chat —
  // it's offered, and saved only when the person says yes.
  const faqPermissionCompany = "assistant.settings.manage";
  const faqTool = (permission: string, variable: string) => `
const rememberInput = z.object({
  question: z.string().trim().min(3).max(300),
  answer: z.string().trim().min(1).max(4_000),
});

/**
 * THE ONE CHANGE THE ASSISTANT CAN OFFER: remember an answer. When someone
 * says "remember that we don't work Sundays", it offers to save it as one of
 * the ${noun}'s answers to common questions — and saves it only when they say
 * "Yes, do it". From then on that question is answered with their words,
 * without AI. Needs the permission to change the assistant's settings.
 */
const ${variable}: AssistantTool<z.infer<typeof rememberInput>> = {
  name: "remember_answer",
  description:
    "Offer to save an answer to a common question, in the person's own words, so it's answered the same way next time. Only when they ask you to remember something. They must confirm it.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, as a customer or teammate would ask it" },
      answer: { type: "string", description: "The answer, in the person's own words" },
    },
    required: ["question", "answer"],
    additionalProperties: false,
  },
  parse: (input) => rememberInput.parse(input),
  requiresPermission: "${permission}",
  write: true,
  summarize: (input) => \`Save an answer to “\${input.question}”\`,
  // The card shows BOTH in full, as plain text, and either can be changed
  // before "Yes, do it": what is saved — and then given word for word to
  // everyone who asks — is what the person saw.
  fields: (input) => [
    { key: "question", label: "Question", value: input.question, multiline: false },
    { key: "answer", label: "Answer", value: input.answer, multiline: true },
  ],
  done: () => "Saved. That question will be answered with these words from now on.",
  label: "Preparing an answer to save",
  run: async (input, ctx) => {
    const saved = await saveFaq(db, ctx.tenantId, { question: input.question, answer: input.answer }, ctx.userId);
    if (!saved.saved) throw new Error(saved.reason === "too_many" ? "There are as many answers as the assistant keeps." : "That answer isn't here.");
    return { saved: true };
  },
};
`;

  imports.push(`import { db } from "@/db";`);
  const toolNames = tools.map((t) => t.name);
  const starters = tools.map((t) => t.starter).filter((s): s is string => s !== null);
  const body = tools.map((t) => t.source).join("");

  const companyPart = companies
    ? `${faqTool(faqPermissionCompany, "rememberAnswer")}
/**
 * A ${noun}'s assistant's tools: reads of the ${noun}'s own ${[
        ...(answers.includeScheduling ? ["schedule"] : []),
        ...(answers.includeInvoicing ? ["invoices"] : []),
        ...(answers.includeEstimator ? ["price book"] : []),
      ].join(", ") || "answers"}, each through the
 * feature's own read function and permission, and the one offered change.
 * Every tool reads \`ctx.tenantId\` — the ${noun} the person is working in —
 * and nothing else: the model can't name another ${noun}.
 */
export const companyAssistantTools = createToolRegistry([
  ${[...toolNames, "rememberAnswer"].map((n) => `${n} as AssistantTool`).join(",\n  ")},
]);

/**
 * The one-tap questions a ${noun}'s chat offers (its own FAQ questions are
 * added after these) — each one a tool can answer.${answers.includeEstimator ? ` The price-book one names
 * the ${noun}'s own first product, so it's never a product it doesn't sell.` : ""}
 */
export async function companyStarters(tenantId: string): Promise<readonly string[]> {
${answers.includeEstimator ? `  const [first] = await listProducts(db, tenantId);
  return [...${JSON.stringify(starters)}, ...(first ? [\`What do we charge for \${first.name}?\`] : [])];` : `  void tenantId;
  return ${JSON.stringify(starters)};`}
}

/** This site's own assistant (its staff's): the offered change only — no ${noun}'s data is the site's. */
const rememberSiteAnswer: AssistantTool = { ...(rememberAnswer as AssistantTool), requiresPermission: "staff.assistant.manage" };
export const platformAssistantTools = createToolRegistry([rememberSiteAnswer]);
export async function platformStarters(): Promise<readonly string[]> {
  return [];
}
`
    : `${faqTool("staff.assistant.manage", "rememberAnswer")}
/**
 * The business's assistant's tools: reads of its ${[
        ...(answers.includeScheduling ? ["schedule"] : []),
        ...(answers.includeInvoicing ? ["invoices"] : []),
        ...(answers.includeEstimator ? ["price book"] : []),
      ].join(", ") || "answers"}, each through the feature's own read
 * function and on its own staff key, and the one offered change.
 */
export const platformAssistantTools = createToolRegistry([
  ${[...toolNames, "rememberAnswer"].map((n) => `${n} as AssistantTool`).join(",\n  ")},
]);

/** The one-tap questions the chat offers (the business's own FAQ questions are added after these), each one a tool can answer. */
export async function platformStarters(): Promise<readonly string[]> {
${answers.includeEstimator ? `  const [first] = await listProducts(db, ESTIMATOR_TENANT);
  return [...${JSON.stringify(starters)}, ...(first ? [\`What do we charge for \${first.name}?\`] : [])];` : `  return ${JSON.stringify(starters)};`}
}
`;

  return `${imports.join("\n")}

/**
 * WHAT THE ASSISTANT MAY LOOK UP — the whitelisted tools the model can name,
 * and its only way to live data (Tenancy 2b-3). Each one:
 *
 *   - reads through the installed feature's OWN read function, for the
 *     ${companies ? `${noun} the person is working in (\`ctx.tenantId\`)` : "business"} only;
 *   - asks for the permission the feature's own screen asks, so the assistant
 *     reads only what that person could read there;
 *   - returns FINISHED figures — counts, totals, dates and money worked out
 *     and formatted here, in code. The model quotes them; it never computes.
 *
 * Generated per installed feature. Add your own the same way: a name, a
 * description, a schema, a permission, and a \`run\` that reads.
 */
${body}${companyPart}`;
}

// ---------------------------------------------------------------------------
// src/components/AssistantLauncherSlot.tsx (companies)
// ---------------------------------------------------------------------------

export function renderAssistantLauncherSlot(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  if (!assistantChats(answers)) {
    return `import type { ReactNode } from "react";

/**
 * The assistant's button on a ${noun}'s pages. Nothing: ${answers.projectName}
 * was generated without --ai, so there is no model for it to ask. Each ${noun}
 * can still write what its assistant knows at /app/assistant; \`add ai\`
 * switches the chat on. (GENERATED in two variants.)
 */
export async function AssistantLauncherSlot(): Promise<ReactNode> {
  return null;
}
`;
  }
  return `import { headers } from "next/headers";
import type { ReactNode } from "react";
import { AssistantLauncher } from "${scope}/assistant-widget";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import { loadTenantPermissions } from "@/server/permissions";
import { tenancy } from "@/server/tenancy";

/**
 * The assistant's button on every page of a ${noun}'s area (/app/…): it opens
 * the chat as a panel, for the ${noun} the person is working in, over
 * /api/app/{${noun} id}/assistant. Shown only to someone whose role there
 * holds assistant.use; the routes check again on every request.
 *
 * It must never fail a page: anything it can't read, it doesn't show.
 */
export async function AssistantLauncherSlot(): Promise<ReactNode> {
  try {
    if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) return null;
    // A prerendered page has no request, and no person to help.
    if ((await headers()).get("host") === null) return null;
    const principal = await currentPrincipal();
    if (!principal) return null;
    const session = await tenancy.resolveSession({ userId: principal.userId });
    if (session.state !== "ready") return null;
    const permissions = await loadTenantPermissions({ principal, tenantId: session.company.id });
    if (!permissions?.can("assistant.use")) return null;
    return (
      <AssistantLauncher
        config={{
          baseUrl: \`/api/app/\${session.company.id}/assistant\`,
          title: \`\${session.company.name}'s assistant\`,
          subtitle: "It looks things up for you, and asks before it changes anything.",
          settingsHref: "/app/assistant",
        }}
      />
    );
  } catch {
    return null;
  }
}
`;
}

/**
 * TENANCY 2b-3, AS THE GENERATOR WRITES IT (create-app 0.29): an AI assistant
 * for each company. Read from the PLAN as text; the generated project's own
 * suite (the isolation proof on PGlite) runs it.
 *
 *   - companies mode: the button on /app pages, /app/assistant settings, the
 *     route under /api/app/{id}/assistant, the company keys, the nav entry;
 *   - with --ai: Claude Haiku 4.5, the monthly allowance and the site's day
 *     (failing closed), every question metered; the plan's quota where plans
 *     are sold; without --ai, no model and no ledger, settings still there;
 *   - tools through each installed feature's own reads and permissions, for
 *     the person's company only; one offered change, confirmed;
 *   - this site's own assistant on staff keys, in both modes;
 *   - the isolation proof drives ASSISTANT_ADMIN_ROUTES with a scripted model
 *     and checks the tools.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, overlayNamesFor, packagesFor, type Answers } from "../answers.js";
import { planEmit, packageVersions, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES, featureSuiteNames } from "../feature-proofs-emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-assistant", ...overrides };
}

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

function has(p: EmitPlan, ...segments: string[]): boolean {
  return p.files.has(join(...segments));
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const FIELD: Partial<Answers> = { includeScheduling: true, includeEstimator: true, includeInvoicing: true, includeComms: true, includeEmail: true };
const COMPANIES: Partial<Answers> = { tenantNoun: "Company", adminShell: "full", includeAssistant: true, includeAi: true };
const SELLS: Partial<Answers> = { businessModel: "subscription" };

describe("packages, overlays and versions", () => {
  it("installs the assistant and its widget; the chat's admin page only with a model", () => {
    expect(packagesFor(answers({ includeAssistant: true }))).toEqual(
      expect.arrayContaining(["@adminigloo/assistant", "@adminigloo/assistant-widget"]),
    );
    expect(overlayNamesFor(answers({ ...COMPANIES }))).toEqual(
      expect.arrayContaining(["assistant", "assistant-admin", "assistant-chat-admin", "assistant-companies"]),
    );
    expect(overlayNamesFor(answers({ ...COMPANIES, includeAi: false }))).not.toContain("assistant-chat-admin");
    expect(overlayNamesFor(answers({ includeAssistant: true, tenantNoun: "none", adminShell: "full" }))).not.toContain("assistant-companies");
    const versions = packageVersions();
    expect(versions.assistant).toBe("0.9.0");
    expect(versions["assistant-widget"]).toBe("0.3.0");
    expect(versions.ai).toBe("0.2.0");
  });
});

describe("companies mode, with --ai", () => {
  it("builds each company's handler on the company seams, a metered Haiku model, and an allowance that fails closed", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD, ...SELLS });
    const glue = code(file(p, "src", "server", "assistant.ts"));
    expect(glue).toContain("export function buildAssistantHandlers(");
    expect(glue).toContain("resolveTenant: companyRoutes.resolveTenant");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("createAnthropicProvider({ client: anthropic, model: ASSISTANT_MODEL })");
    expect(glue).toContain("env.ASSISTANT_MODEL ?? DEFAULT_ASSISTANT_MODEL");
    expect(glue).toContain("await checkAiAllowance(db, allowanceInput(tenantId, messages))");
    expect(glue).toContain("siteDailyCents: AI_SITE_DAILY_CENTS");
    expect(glue).toContain("await assistantMessageLimit(tenantId)");
    // Review H2: the question's place is HELD before the model is called, and
    // settled after; a per-person and per-company rate limit on the shared limiter.
    expect(glue).toContain("reserveAiAllowance(db, {");
    expect(glue).toContain("reserve: async ({ tenantId, userId, ...estimate }) => reserveFor(tenantId, userId, await monthlyMessagesOf(tenantId), estimate),");
    expect(glue).toContain("await settleAiReservation(db, MODEL_RATES, turn.reservation,");
    expect(glue).toContain("rateLimit: assistantRateLimit,");
    expect(glue).toContain("await failClosedLimiter.limit({ key: `assistant:person:${tenantId}:${userId}`");
    expect(glue).toContain("await failClosedLimiter.limit({ key: `assistant:company:${tenantId}`");
    // Review M4/M5: every company has a cents cap — unlimited ones too — set
    // from its messages so the messages are the limit people see.
    expect(glue).toContain("monthlyCents: assistantCentsCap(messages)");
    expect(glue).toContain("return messages === null ? ASSISTANT_UNLIMITED_CENTS : messages * ASSISTANT_WORST_CASE_CENTS;");
    expect(glue).toContain("onSiteCeiling: alertSiteCeiling,");
    // Review L7: a failed question doesn't use up a message.
    expect(glue).toContain('const status = !turn.answered ? "errored" : turn.aborted ? "cancelled" : "completed";');
    expect(glue).toContain("recordAiUsage(db, MODEL_RATES,");
    // An unpriced model can't be metered, so it never runs.
    expect(glue).toContain("if (!MODEL_RATES[ASSISTANT_MODEL]) {");
    // The site's own assistant, on staff keys.
    expect(glue).toContain("tenantId: ASSISTANT_PLATFORM");
    expect(glue).toContain('"assistant.use": "staff.assistant.use"');
    // A companies project holds no fixed tenant (Tenancy 2a, D12).
    expect(glue).not.toMatch(/"primary"/);
  });

  it("mounts the button on every /app page, settings at /app/assistant, the route under /api/app/{id}/assistant", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD });
    expect(file(p, "app", "(site)", "app", "layout.tsx")).toContain("<AssistantLauncherSlot />");
    const slot = file(p, "src", "components", "AssistantLauncherSlot.tsx");
    expect(slot).toContain("<AssistantLauncher");
    expect(slot).toContain('permissions?.can("assistant.use")');
    expect(slot).toContain("baseUrl: `/api/app/${session.company.id}/assistant`");
    const settings = file(p, "app", "(site)", "app", "assistant", "page.tsx");
    expect(settings).toContain('permission="assistant.settings.manage"');
    expect(settings).toContain("<AssistantSettings baseUrl={`/api/app/${company.id}/assistant`} />");
    expect(file(p, "app", "api", "app", "[tenantId]", "assistant", "[...path]", "route.ts")).toContain("buildAssistantHandlers()");
    expect(file(p, "app", "api", "admin", "assistant", "[...path]", "route.ts")).toContain("buildPlatformAssistantHandlers()");
    expect(file(p, "app", "admin", "assistant", "chat", "page.tsx")).toContain('baseUrl: "/api/admin/assistant"');
    expect(file(p, "src", "nav.ts")).toContain('"/app/assistant"');
  });

  it("puts the company keys in the tenant catalog and the site's in the staff one", async () => {
    const p = await plan({ ...COMPANIES });
    const catalog = file(p, "src", "permissions", "catalog.ts");
    expect(catalog).toContain('import { assistantPermissions } from "@adminigloo/assistant";');
    expect(catalog).toMatch(/definePermissions\(\s*"tenant",\s*\{[^}]*\.\.\.assistantPermissions/);
    expect(catalog).toContain('"staff.assistant.use"');
    expect(catalog).toContain('"staff.assistant.manage"');
    // The site's brain router is on its own key, not the shell's.
    const router = code(file(p, "src", "server", "routers", "assistant.ts"));
    expect(router).not.toContain("staff.dashboard.view");
    expect(router).toContain('requireStaff("staff.assistant.manage")');
    expect(router).not.toContain('"default"');
  });

  it("wires the starter tools to each installed feature's own reads and keys, for the person's company only", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD });
    const tools = code(file(p, "src", "server", "assistant-tools.ts"));
    expect(tools).toContain('name: "schedule_for_day"');
    expect(tools).toContain('requiresPermission: "schedule.view"');
    expect(tools).toContain("listCalendar(db, tenantId,");
    expect(tools).toContain('name: "overdue_invoices"');
    expect(tools).toContain('requiresPermission: "invoices.view"');
    expect(tools).toContain("listOverdueInvoices(db, tenantId,");
    expect(tools).toContain('name: "price_book_lookup"');
    expect(tools).toContain('requiresPermission: "estimator.view"');
    expect(tools).toContain("listProducts(db, tenantId)");
    // Each read is the person's company, never a fixed one.
    expect(tools.match(/const tenantId = ctx\.tenantId;/g)?.length).toBe(3);
    expect(tools).not.toMatch(/"primary"|SCHEDULING_TENANT|INVOICING_TENANT|ESTIMATOR_TENANT/);
    // The one change it can offer, confirmed, on the settings key.
    expect(tools).toContain('name: "remember_answer"');
    expect(tools).toContain("write: true");
    expect(tools).toContain('requiresPermission: "assistant.settings.manage"');
    // Code works out the figures the model quotes.
    expect(tools).toContain("const owed = due.reduce((sum, invoice) => sum + invoice.balanceDue, 0);");
    expect(tools).toContain('"What\'s on the schedule tomorrow?"');
    // Review L8: a list cut at 200 says "at least 200", never "200".
    expect(tools).toContain("limit: OVERDUE_SHOWN + 1");
    expect(tools).toContain("overdueCount: more ? `at least ${OVERDUE_SHOWN}` : due.length,");
    // Review L9: the price-book starter names one of the company's own products.
    expect(tools).not.toContain("a ramp");
    expect(tools).toContain("const [first] = await listProducts(db, tenantId);");
    expect(tools).toContain("What do we charge for ${first.name}?");
    // Review H3: outside text isn't authoritative; the offered change shows its fields in full.
    expect(tools.match(/authoritative: false,/g)).toHaveLength(2);
    expect(tools).toContain("authoritative: true,");
    expect(tools).toContain('{ key: "answer", label: "Answer", value: input.answer, multiline: true },');
  });

  it("sells \"AI assistant messages a month\" on each plan, enforced through the plan gate", async () => {
    const p = await plan({ ...COMPANIES, ...SELLS });
    const plans = file(p, "src", "plans.ts");
    expect(plans).toContain('assistant_messages: { kind: "quota", label: "AI assistant messages a month"');
    expect(plans.match(/assistant_messages: (100|500|null),/g)).toHaveLength(4);
    expect(code(file(p, "src", "server", "plan-gate.ts"))).toContain('return planLimit(tenantId, "assistant_messages");');
    // Not where nothing would enforce it: no plans sold, or no chat.
    expect(file(await plan({ ...COMPANIES, businessModel: "one-time" }), "src", "plans.ts")).not.toContain("assistant_messages");
    expect(file(await plan({ ...COMPANIES, ...SELLS, includeAi: false }), "src", "plans.ts")).not.toContain("assistant_messages");
    expect(code(file(await plan({ ...COMPANIES }), "src", "server", "plan-gate.ts"))).toContain("return undefined;");
  });

  it("names the model in the env, Haiku by default", async () => {
    const p = await plan({ ...COMPANIES });
    expect(file(p, "src", "env.ts")).toContain("ASSISTANT_MODEL: z.string().min(1).max(120).optional()");
    expect(file(p, ".env.example")).toContain("# in MODEL_RATES (src/server/ai.ts) or the chat stays off.\nASSISTANT_MODEL=");
    expect(file(p, "src", "server", "ai.ts")).toContain("export const AI_MODEL: string = DEFAULT_AI_MODEL;");
  });
});

describe("companies mode, without --ai", () => {
  it("has no model and no ledger, and keeps the settings", async () => {
    const p = await plan({ ...COMPANIES, includeAi: false });
    const glue = code(file(p, "src", "server", "assistant.ts"));
    expect(glue).toContain("export function assistantProvider(): ProviderAdapter | null {\n  return null;\n}");
    expect(glue).not.toMatch(/ai\/server|checkAiAllowance|createAnthropicProvider|@\/server\/ai"/);
    expect(code(file(p, "src", "components", "AssistantLauncherSlot.tsx"))).toContain("return null;");
    expect(has(p, "app", "(site)", "app", "assistant", "page.tsx")).toBe(true);
    expect(has(p, "app", "admin", "assistant", "chat", "page.tsx")).toBe(false);
    expect(file(p, "src", "env.ts")).not.toContain("ASSISTANT_MODEL");
  });
});

describe("a single business (--tenant-noun none)", () => {
  it("keeps one assistant, the site's, with the feature tools on their staff keys", async () => {
    const p = await plan({ tenantNoun: "none", adminShell: "full", includeAssistant: true, includeAi: true, ...FIELD });
    expect(has(p, "src", "components", "AssistantLauncherSlot.tsx")).toBe(false);
    expect(has(p, "app", "(site)", "app", "assistant", "page.tsx")).toBe(false);
    const glue = code(file(p, "src", "server", "assistant.ts"));
    expect(glue).not.toContain("buildAssistantHandlers(");
    expect(glue).not.toContain("company-routes");
    expect(glue).toContain("export function buildPlatformAssistantHandlers(");
    const tools = code(file(p, "src", "server", "assistant-tools.ts"));
    expect(tools).toContain('requiresPermission: "staff.schedule.view"');
    expect(tools).toContain("const tenantId = SCHEDULING_TENANT;");
    expect(tools).toContain('requiresPermission: "staff.invoices.view"');
    expect(tools).toContain("resolveInvoicingBusiness(INVOICING_BUSINESS)");
    expect(tools).toContain('requiresPermission: "staff.estimates.view"');
    expect(tools).toContain('requiresPermission: "staff.assistant.manage"');
    expect(file(p, "src", "permissions", "catalog.ts")).not.toContain("assistantPermissions");
  });

  it("works with nothing else installed: the offered change only", async () => {
    const p = await plan({ tenantNoun: "none", adminShell: "full", includeAssistant: true, includeAi: true });
    const tools = code(file(p, "src", "server", "assistant-tools.ts"));
    expect(tools).toContain('name: "remember_answer"');
    expect(tools).not.toMatch(/schedule_for_day|overdue_invoices|price_book_lookup/);
    expect(has(p, "src", "server", "staff-access.ts")).toBe(true);
  });
});

describe("the isolation proof", () => {
  it("drives ASSISTANT_ADMIN_ROUTES with a scripted model, plants A's assistant rows, snapshots its tables and checks the tools", async () => {
    const answersCo = answers({ ...COMPANIES, ...FIELD, includeNotifications: true });
    expect(featureSuiteNames(answersCo)).toContain("assistant");
    expect(FEATURE_ENTITIES.assistant).toEqual(["conversation", "action", "house-rule", "glossary-term", "faq"]);
    const p = await plan({ ...COMPANIES, ...FIELD, includeNotifications: true });
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toMatch(/^import \{ [^}]*ASSISTANT_ADMIN_ROUTES[^}]* \} from "@adminigloo\/assistant";$/m);
    expect(proof).toContain("adminRoutes: ASSISTANT_ADMIN_ROUTES,");
    expect(proof).toContain("admin: (overrides) => buildAssistantHandlers({ ...overrides, provider: proofAssistantModel }),");
    expect(proof).toContain("const proofAssistantModel: ProviderAdapter = {");
    for (const table of ["assistant_sections", "assistant_section_versions", "assistant_conversations", "assistant_messages", "assistant_pending_actions", "assistant_page_docs"]) {
      expect(proof).toContain(`    ${table}: await all(sql\``);
    }
    expect(proof).toContain('describe("feature isolation: the assistant\'s tools", () => {');
    expect(proof).toContain("B's never return A's rows, and A's do");
    const rows = file(p, "src", "test", "company-rows.ts");
    for (const entity of FEATURE_ENTITIES.assistant!) expect(rows).toMatch(new RegExp(`rows(\\.${entity}|\\["${entity}"\\]) = `));
  });

  it("exists for a companies project with the assistant and nothing else", async () => {
    const p = await plan({ tenantNoun: "Company", adminShell: "full", includeAssistant: true });
    expect(has(p, "src", "server", "__tests__", "feature-isolation.test.ts")).toBe(true);
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).toContain("// No feature with planted rows to read here");
  });
});

describe("the photo reading and the generic chat share the site's day (review M4)", () => {
  it("checks the same ceiling before every photo reading, and alerts the site owner once a day", async () => {
    const p = await plan({ ...COMPANIES, ...FIELD });
    const services = code(file(p, "src", "server", "estimator-services.ts"));
    expect(services).toContain("if (!(await siteCeilingOpen())) throw new Error(\"the site's AI limit for today is reached\");");
    const ai = code(file(p, "src", "server", "ai.ts"));
    expect(ai).toContain("export function alertSiteCeiling(");
    expect(ai).toContain("void reportError({");
    expect(ai).toContain("onSiteCeiling: alertSiteCeiling,");
  });
});

describe("the isolation proof with no feature whose routes mix rows (pre-existing bug)", () => {
  it("doesn't demand a mixed pass in an invoicing-only companies project", async () => {
    const p = await plan({ tenantNoun: "Company", adminShell: "full", includeInvoicing: true, includeAssistant: true });
    const proof = file(p, "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(proof).not.toContain('expect(mixed, "no route mixes two rows');
    expect(proof).toContain("void mixed;");
    const withScheduling = file(await plan({ ...COMPANIES, ...FIELD }), "src", "server", "__tests__", "feature-isolation.test.ts");
    expect(withScheduling).toContain('expect(mixed, "no route mixes two rows, so the mixed pass checked nothing").toBeGreaterThan(0);');
  });
});

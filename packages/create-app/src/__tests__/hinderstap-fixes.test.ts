import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * FIXES FROM BUILDING HINDERSTAP (create-app 0.42.x): a consumer one-time shop
 * with AI, SEO and the assistant, generated with these answers, where each of
 * these went wrong in the generated project.
 */
const sep = (path: string) => join(...path.split("/"));

const HINDERSTAP: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "hinderstap",
  tenantNoun: "none",
  audience: "consumers",
  businessModel: "one-time",
  adminShell: "full",
  includeAi: true,
  includeEmail: true,
  includeSeo: true,
  includeSeoReports: true,
  includeAnalytics: true,
  includeAssistant: true,
  includeCustomers: true,
  includeFeedback: true,
};
const BUSINESS: Answers = { ...HINDERSTAP, audience: "business" };
const COMPANIES: Answers = { ...HINDERSTAP, tenantNoun: "Company", audience: "business" };
const BARE: Answers = { ...DEFAULT_ANSWERS, projectName: "bare", tenantNoun: "none", adminShell: "none" };

async function plan(answers: Answers): Promise<EmitPlan> {
  return planEmit(TEMPLATE_DIR, "/out", answers);
}
function file(p: EmitPlan, path: string): string {
  const body = p.files.get(sep(path));
  if (body === undefined) throw new Error(`the plan has no ${path}`);
  return body;
}
/** What the project RUNS: the file with its comments taken out. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the generated AI wrapper records every count the provider bills", () => {
  it("carries cache writes and web-search fees to the ledger", async () => {
    const ai = code(file(await plan(HINDERSTAP), "src/server/ai.ts"));
    expect(ai).toContain("cachedWriteTokens: spend.cachedWriteTokens,");
    expect(ai).toContain("feesMicros: spend.feesMicros,");
    expect(ai).toContain("spend.cachedWriteTokens = usage.cache_creation_input_tokens ?? 0;");
    expect(ai).toContain("BigInt(usage.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_FEE_MICROS");
  });

  it("has the chat route copy the provider's usage through one function", async () => {
    const route = code(file(await plan(HINDERSTAP), "app/api/ai/chat/route.ts"));
    expect(route).toContain("spendFromUsage(spend, final.model, final.usage);");
    // The hand-copied fields that dropped cache writes are gone.
    expect(route).not.toContain("spend.cachedInputTokens = final.usage.cache_read_input_tokens");
  });
});

describe("the generated permissions integration test, in every audience", () => {
  it.each([
    ["consumers", HINDERSTAP],
    ["business", BUSINESS],
    ["companies", COMPANIES],
  ] as const)("seeds an account the %s membership gate admits", async (_name, answers) => {
    const test = code(file(await plan(answers), "src/server/__tests__/permissions.integration.test.ts"));
    // A consumers project's gate admits a person to their OWN personal account
    // only; a company fixture made five of its tests answer NULL there.
    expect(test).toContain("tenant: personalWorkspaceId(memberId),");
    expect(test).toContain('kind: "personal",');
    expect(test).toContain("ownerUserId: ids.member,");
    expect(test).not.toContain('kind: "org"');
  });
});

describe("/sign-out stays out of every index", () => {
  it("is private in the path list a --seo project reads", async () => {
    const paths = file(await plan(HINDERSTAP), "src/seo-paths.ts");
    expect(paths).toContain('"/sign-out",');
    // Still fetched-but-unlisted, unchanged: the sign-in pair.
    expect(paths).toContain('noindex: ["/sign-in", "/sign-up"]');
  });

  it("is disallowed in a project without --seo too", async () => {
    expect(file(await plan(BARE), "src/seo-paths.ts")).toContain('"/sign-out"');
  });
});

describe("the key pays only for the live site (create-app 0.44)", () => {
  it("builds the AI client only when mayCallModels() says so", async () => {
    const ai = code(file(await plan(HINDERSTAP), "src/server/ai.ts"));
    expect(ai).toContain("isAiConfigured(env) && mayCallModels() ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : null;");
    expect(ai).toContain('mayCallModels, type StreamUsage, type TokenRate } from "@adminigloo/ai";');
  });

  it("generates the no-unmetered-ai test for --ai, scanning from the project root", async () => {
    const test = file(await plan(HINDERSTAP), "src/__tests__/no-unmetered-ai.test.ts");
    expect(test).toContain('from "@adminigloo/ai";');
    expect(test).toContain("new\\s+Anthropic\\s*\\(");
    expect(test).toContain('SKIP_DIRS = new Set(["node_modules", ".next", ".git"');
    // Scans from the project root, not from src/ alone: a dot-folder harness
    // outside src/ is exactly what the 2026-11-10 incident this guards against
    // looked like.
    expect(test).toContain('ROOT = join(__dirname, "..", "..")');
  });

  it("has no client to protect, and no test for one, in a project with no AI at all", async () => {
    const p = await plan(BARE);
    expect(p.files.has(sep("src/__tests__/no-unmetered-ai.test.ts"))).toBe(false);
    expect(p.files.has("CLAUDE.md")).toBe(false);
  });

  it("tells every Claude agent working in the project never to spend its own key on testing", async () => {
    const claudeMd = file(await plan(HINDERSTAP), "CLAUDE.md");
    expect(claudeMd).toContain("Test and grade with Claude Code itself");
    expect(claudeMd).toContain("No key on laptops");
    expect(claudeMd).toContain("`AI_OWNER_APPROVED_SCRIPT_RUN`");
    expect(claudeMd).toContain("src/__tests__/no-unmetered-ai.test.ts");
  });

  it("notes in .env.example that the key belongs only in the deployment environment", async () => {
    const example = file(await plan(HINDERSTAP), ".env.example");
    expect(example).toContain("# Deployment only — never a laptop's .env.local:\nANTHROPIC_API_KEY=");
  });
});

describe("next dev opened as 127.0.0.1", () => {
  it.each([
    ["hinderstap", HINDERSTAP],
    ["bare", BARE],
  ] as const)("is an allowed dev origin in %s's next.config.ts", async (_name, answers) => {
    expect(code(file(await plan(answers), "next.config.ts"))).toContain('allowedDevOrigins: ["127.0.0.1"],');
  });
});

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


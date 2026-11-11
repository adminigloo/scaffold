import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { mayCallModels } from "__SCOPE__/ai";

/**
 * NOTHING SPENDS THIS SITE'S MODEL BUDGET BEHIND THE APP'S BACK.
 *
 * On 2026-11-10, on a sibling project, agent test scripts built their own Anthropic
 * client from a laptop's .env.local and graded thousands of test replies with it,
 * spending the owner's whole monthly budget in about two hours. The key is for this
 * site's own traffic; testing and grading are a coding agent's own job. So the one
 * client lives in src/server/ai.ts, it exists only inside the running app
 * (`mayCallModels`, __SCOPE__/ai), and this test fails if any OTHER file in the
 * project builds its own client or reads the key. Dot-folders are scanned too
 * (skipping node_modules, .next and .git), which is where the 2026-11-10 harnesses
 * actually lived — a scanner that only looked at `src/` would have missed them.
 */

const ROOT = join(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "coverage", "dist", ".turbo"]);
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ALLOWED = new Set([join("src", "server", "ai.ts"), join("src", "env.ts")]);
const THIS_FILE = join("src", "__tests__", "no-unmetered-ai.test.ts");

/** `new Anthropic(...)`: a client of its own. */
const BUILDS_CLIENT = /new\s+Anthropic\s*\(/;
/**
 * Reading the key: `env.ANTHROPIC_API_KEY`, `env["ANTHROPIC_API_KEY"]`, or parsing
 * `ANTHROPIC_API_KEY=` out of an env file. Naming it (a comment, the setup page) is
 * fine — only a read of it is reported.
 */
const READS_KEY = /env\s*\.\s*ANTHROPIC_API_KEY|\[\s*["'`]ANTHROPIC_API_KEY["'`]\s*\]|ANTHROPIC_API_KEY\s*=/;

function* codeFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) yield* codeFiles(path);
    else if (CODE.test(name)) yield path;
  }
}

describe("the AI key pays only for this site's own traffic", () => {
  it("no file builds its own Anthropic client or reads the key, except src/server/ai.ts", () => {
    const offenders: string[] = [];
    for (const file of codeFiles(ROOT)) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel) || rel === THIS_FILE) continue;
      const text = readFileSync(file, "utf8");
      if (BUILDS_CLIENT.test(text) || READS_KEY.test(text)) offenders.push(rel.split(sep).join("/"));
    }
    expect(offenders, "test and grade with a coding agent, never with this project's own key (CLAUDE.md)").toEqual([]);
  });

  it("the client exists only inside the running app, unless the owner approved one script run", () => {
    expect(mayCallModels({})).toBe(false);
    expect(mayCallModels({ AI_OWNER_APPROVED_SCRIPT_RUN: "true" })).toBe(false);
    expect(mayCallModels({ NEXT_RUNTIME: "nodejs" })).toBe(true);
    expect(mayCallModels({ VERCEL: "1" })).toBe(true);
    expect(mayCallModels({ AI_OWNER_APPROVED_SCRIPT_RUN: "yes" })).toBe(true);
  });
});

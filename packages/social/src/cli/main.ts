import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { planInit, type AiChoice, type InitPlan, type PlannedFile } from "./init.js";

/**
 * adminigloo-social — the package's command (social 0.3).
 *
 *   npx adminigloo-social init [--ai openai|ai-sdk-openai|ai-sdk-anthropic|anthropic|none] [--admin /admin/posts] [--dry-run]
 */

const HELP = `adminigloo-social init: wire the social posts screen into this Next.js app.

  --ai <which>      openai | ai-sdk-openai | ai-sdk-anthropic | anthropic | none
                    (found from your dependencies when left out)
  --admin <path>    where the posts screen lives (default /admin/posts)
  --dry-run         say what it would write, and write nothing

It never overwrites a file you have. The screen stays closed to everyone
until you wire your staff check into lib/social-posts.ts (WIRE 1).`;

const CHOICES: readonly AiChoice[] = ["openai", "ai-sdk-openai", "ai-sdk-anthropic", "anthropic", "none"];

export interface Applied {
  readonly written: readonly string[];
  readonly kept: readonly string[];
}

/** Write the plan: a new file only where there's none, an append only where its marker isn't there yet. */
export function applyPlan(plan: InitPlan, options: { readonly dryRun?: boolean } = {}): Applied {
  const written: string[] = [];
  const kept: string[] = [];
  for (const file of plan.files) {
    if (alreadyDone(file)) {
      kept.push(file.path);
      continue;
    }
    written.push(file.path);
    if (options.dryRun) continue;
    mkdirSync(dirname(file.path), { recursive: true });
    if (file.mode === "create") writeFileSync(file.path, file.contents, { flag: "wx" });
    else appendFileSync(file.path, file.contents);
  }
  return { written, kept };
}

function alreadyDone(file: PlannedFile): boolean {
  if (!existsSync(file.path)) return false;
  if (file.mode === "create") return true;
  return readFileSync(file.path, "utf8").includes(file.marker ?? file.contents.trim());
}

function argValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function main(argv: readonly string[], cwd: string, log: (line: string) => void = console.log): number {
  const [command, ...args] = argv;
  if (command !== "init" || args.includes("--help") || args.includes("-h")) {
    log(HELP);
    return command === "init" || command === "--help" || command === "-h" || command === undefined ? 0 : 1;
  }
  const ai = argValue(args, "--ai");
  if (ai && !CHOICES.includes(ai as AiChoice)) {
    log(`--ai must be one of: ${CHOICES.join(", ")}`);
    return 1;
  }
  const dryRun = args.includes("--dry-run");
  let plan: InitPlan;
  try {
    plan = planInit({ root: cwd, ai: ai as AiChoice | undefined, adminPath: argValue(args, "--admin") });
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const applied = applyPlan(plan, { dryRun });
  const show = (path: string) => relative(cwd, path) || path;
  log(`Social posts${dryRun ? " (dry run: nothing written)" : ""}: app directory ${plan.found.appDir}, database ${plan.found.db ?? "not found"}, schema ${plan.found.schema ?? "not found"}, AI ${plan.ai}.`);
  for (const path of applied.written) log(`  ${dryRun ? "would write" : "wrote"}  ${show(path)}`);
  for (const path of applied.kept) log(`  kept yours  ${show(path)}`);
  for (const warning of plan.warnings) log(`  note: ${warning}`);
  log("\nNext:");
  plan.next.forEach((step, i) => log(`  ${i + 1}. ${step}`));
  return 0;
}

// Run as the bin (not when a test imports it).
const invoked = typeof process !== "undefined" && process.argv[1] && /adminigloo-social|cli\.(c?js|mjs)$/.test(process.argv[1]);
if (invoked) process.exitCode = main(process.argv.slice(2), process.cwd());

import { resolve } from "node:path";
import {
  DEFAULT_ANSWERS,
  packagesFor,
  requiredEnvFor,
  validateProjectName,
  type AdminShell,
  type Answers,
  type BusinessModel,
  type TenantNoun,
} from "./answers.js";
import { createPrompter, type Prompter } from "./prompt.js";

export interface CliFlags {
  readonly name?: string;
  readonly yes: boolean;
  readonly help: boolean;
  readonly dir?: string;
}

export function parseArgs(argv: readonly string[]): CliFlags {
  let name: string | undefined;
  let dir: string | undefined;
  let yes = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--dir") dir = argv[i + 1];
    else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
    else if (!arg.startsWith("-")) name ??= arg;
  }

  return { name, dir, yes, help };
}

export const HELP = `
@adminigloo/create-app — generate a Next.js project with the base already wired.

  pnpm dlx @adminigloo/create-app <name> [options]

  The package is scoped because GitHub Packages rejects unscoped names. The
  command it installs is still create-adminigloo-app.

  --yes, -y     Accept every default. Also implied when stdin is not a TTY,
                so this never hangs waiting for input inside CI.
  --dir <path>  Generate into this directory instead of ./<name>.
  --help, -h    Show this.
`.trimStart();

/**
 * Ask the questions.
 *
 * Every answer resolves at generation time into a different set of files and
 * dependencies. None of them becomes a conditional in the emitted app.
 */
export async function collectAnswers(
  flags: CliFlags,
  prompter: Prompter,
): Promise<Answers> {
  const projectName = validateProjectName(
    flags.name ?? (await prompter.text("Project name", DEFAULT_ANSWERS.projectName)),
  );

  const tenantNoun = await prompter.select<TenantNoun>(
    "What do you call a customer organisation? This is UI copy, not schema.",
    [
      { value: "Organization", label: "Organization" },
      { value: "Company", label: "Company" },
      { value: "Workspace", label: "Workspace" },
      { value: "Team", label: "Team" },
      {
        value: "none",
        label: "None — this is consumer-facing",
        hint: "still tenanted, via an invisible personal workspace",
      },
    ],
    DEFAULT_ANSWERS.tenantNoun,
  );

  const businessModel = await prompter.select<BusinessModel>(
    "Does it take money?",
    [
      { value: "none", label: "Not yet" },
      { value: "one-time", label: "One-time purchases", hint: "cart, orders, shipping" },
      { value: "subscription", label: "Subscriptions", hint: "plans, entitlements" },
      { value: "both", label: "Both" },
    ],
    DEFAULT_ANSWERS.businessModel,
  );

  const adminShell = await prompter.select<AdminShell>(
    "Admin panel? Copied as source, because every client restyles it.",
    [
      { value: "minimal", label: "Minimal", hint: "dashboard, users, tenants, audit" },
      { value: "full", label: "Full", hint: "adds support, errors, health, data explorer" },
      { value: "none", label: "None" },
    ],
    DEFAULT_ANSWERS.adminShell,
  );

  const includeAi = await prompter.confirm(
    "AI or streaming routes?",
    DEFAULT_ANSWERS.includeAi,
  );
  const includeEmail = await prompter.confirm(
    "Transactional email?",
    DEFAULT_ANSWERS.includeEmail,
  );

  return {
    projectName,
    tenantNoun,
    businessModel,
    adminShell,
    includeAi,
    includeEmail,
    scope: DEFAULT_ANSWERS.scope,
  };
}

export function targetDirFor(flags: CliFlags, answers: Answers, cwd: string): string {
  return resolve(cwd, flags.dir ?? answers.projectName);
}

/**
 * What the person has to do next, and nothing they do not.
 *
 * The env list is derived from what was actually installed, so a project
 * without Stripe is never told to go and find a Stripe key — the fastest way
 * to teach someone to skim past this block.
 */
export function nextSteps(answers: Answers, targetDir: string): string {
  const lines = [
    "",
    `Generated ${answers.projectName} at ${targetDir}`,
    "",
    "Installed:",
    ...packagesFor(answers).map((p) => `  ${p}`),
    "",
    "Next:",
    `  cd ${answers.projectName}`,
    "  cp .env.example .env.local",
    "",
    "Then fill in .env.local. The app will not boot until these are set:",
    ...requiredEnvFor(answers).map((v) => `  ${v}`),
    "",
    "  pnpm install",
    "  pnpm db:generate && pnpm db:migrate",
    "  pnpm dev",
    "",
  ];

  if (answers.businessModel !== "none") {
    lines.push(
      "Stripe keys must be TEST mode outside production. A live key throws at",
      "boot, and no environment variable turns that check off.",
      "",
    );
  }

  return lines.join("\n");
}

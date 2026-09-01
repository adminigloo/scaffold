import { resolve } from "node:path";
import {
  ADMIN_SHELLS,
  BUSINESS_MODELS,
  DEFAULT_ANSWERS,
  TENANT_NOUNS,
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
  /**
   * Non-interactive answers. Present so the generator can be scripted — a CLI
   * whose only non-interactive mode is "all defaults" cannot be used to
   * reproduce a specific project, which is the first thing you want when a
   * generated app misbehaves.
   */
  readonly tenantNoun?: TenantNoun;
  readonly businessModel?: BusinessModel;
  readonly adminShell?: AdminShell;
  readonly ai?: boolean;
  readonly email?: boolean;
  readonly marketing?: boolean;
}

export class UnknownFlagValueError extends Error {
  readonly name = "UnknownFlagValueError";
  constructor(flag: string, value: string, allowed: readonly string[]) {
    super(
      `--${flag} does not accept "${value}". Use one of: ${allowed.join(", ")}.`,
    );
  }
}

function oneOf<T extends string>(
  flag: string,
  value: string,
  allowed: readonly T[],
): T {
  const match = allowed.find((a) => a === value);
  if (!match) throw new UnknownFlagValueError(flag, value, allowed);
  return match;
}

export function parseArgs(argv: readonly string[]): CliFlags {
  let name: string | undefined;
  let dir: string | undefined;
  let yes = false;
  let help = false;

  let tenantNoun: TenantNoun | undefined;
  let businessModel: BusinessModel | undefined;
  let adminShell: AdminShell | undefined;
  let ai: boolean | undefined;
  let email: boolean | undefined;
  let marketing: boolean | undefined;

  /** Supports both `--flag value` and `--flag=value`. */
  const readValue = (arg: string, prefix: string, index: number): string | undefined =>
    arg === prefix ? argv[index + 1] : arg.slice(prefix.length + 1);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--ai") ai = true;
    else if (arg === "--no-ai") ai = false;
    else if (arg === "--email") email = true;
    else if (arg === "--no-email") email = false;
    else if (arg === "--marketing") marketing = true;
    else if (arg === "--no-marketing") marketing = false;
    else if (arg === "--dir" || arg.startsWith("--dir=")) {
      dir = readValue(arg, "--dir", i);
    } else if (arg === "--tenant-noun" || arg.startsWith("--tenant-noun=")) {
      const v = readValue(arg, "--tenant-noun", i);
      if (v !== undefined) tenantNoun = oneOf("tenant-noun", v, TENANT_NOUNS);
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const v = readValue(arg, "--model", i);
      if (v !== undefined) businessModel = oneOf("model", v, BUSINESS_MODELS);
    } else if (arg === "--admin" || arg.startsWith("--admin=")) {
      const v = readValue(arg, "--admin", i);
      if (v !== undefined) adminShell = oneOf("admin", v, ADMIN_SHELLS);
    } else if (!arg.startsWith("-")) {
      // A bare word that is not the value of the flag before it.
      const previous = argv[i - 1];
      const consumed =
        previous === "--dir" ||
        previous === "--tenant-noun" ||
        previous === "--model" ||
        previous === "--admin";
      if (!consumed) name ??= arg;
    }
  }

  return {
    name,
    dir,
    yes,
    help,
    tenantNoun,
    businessModel,
    adminShell,
    ai,
    email,
    marketing,
  };
}

export const HELP = `
@adminigloo/create-app — generate a Next.js project with the base already wired.

  pnpm dlx @adminigloo/create-app <name> [options]

  The package is scoped because GitHub Packages rejects unscoped names. The
  command it installs is still create-adminigloo-app.

  --yes, -y            Accept every default. Also implied when stdin is not a
                       TTY, so this never hangs waiting for input inside CI.
  --dir <path>         Generate into this directory instead of ./<name>.
  --tenant-noun <n>    Organization | Company | Workspace | Team | none
  --model <m>          none | one-time | subscription | both
  --admin <a>          none | minimal | full
  --ai / --no-ai       Include streaming route conventions.
  --email / --no-email Include transactional email.
  --marketing          Landing page, pricing page and legal routes, as source.
    / --no-marketing   Off by default: every string on a landing page is a claim
                       only the client can make. Privacy and terms are generated
                       for any project that takes money either way, because
                       Stripe will not activate an account without them.
  --help, -h           Show this.

  Any flag given is used verbatim; only the rest are prompted for.
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

  const tenantNoun = flags.tenantNoun ?? (await prompter.select<TenantNoun>(
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
  ));

  const businessModel = flags.businessModel ?? (await prompter.select<BusinessModel>(
    "Does it take money?",
    [
      { value: "none", label: "Not yet" },
      { value: "one-time", label: "One-time purchases", hint: "cart, orders, shipping" },
      { value: "subscription", label: "Subscriptions", hint: "plans, entitlements" },
      { value: "both", label: "Both" },
    ],
    DEFAULT_ANSWERS.businessModel,
  ));

  const adminShell = flags.adminShell ?? (await prompter.select<AdminShell>(
    "Admin panel? Copied as source, because every client restyles it.",
    [
      { value: "minimal", label: "Minimal", hint: "dashboard, users, tenants, audit" },
      { value: "full", label: "Full", hint: "adds support, errors, health, data explorer" },
      { value: "none", label: "None" },
    ],
    DEFAULT_ANSWERS.adminShell,
  ));

  const includeAi =
    flags.ai ?? (await prompter.confirm("AI or streaming routes?", DEFAULT_ANSWERS.includeAi));
  const includeEmail =
    flags.email ??
    (await prompter.confirm("Transactional email?", DEFAULT_ANSWERS.includeEmail));

  const includeMarketing =
    flags.marketing ??
    (await prompter.confirm(
      "Public marketing site? Landing page, pricing and legal, copied as source.",
      DEFAULT_ANSWERS.includeMarketing,
    ));

  return {
    projectName,
    tenantNoun,
    businessModel,
    adminShell,
    includeAi,
    includeEmail,
    includeMarketing,
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
      // WHERE THE LEGAL PAGES CAME FROM, said once and in the place somebody
      // reads. Stripe refuses to activate an account without a public privacy
      // policy and terms of service, which is why they are generated for any
      // project that takes money rather than only for one with a marketing
      // site — and why this paragraph is inside the money branch.
      "/privacy and /terms are generated, and the list of who else sees your",
      "customers' data is derived from the packages this project installed.",
      "Fill in src/legal-publisher.ts and have a lawyer read both before you",
      "ask Stripe to activate the account; it checks that the URLs resolve.",
      "",
      // THE ONE PARAGRAPH THAT MAKES THE SHOP FINDABLE. Everything after "Buy"
      // works with no Stripe account at all — the order, the entitlement, the
      // licence key — and none of it was reachable, because the catalogue was
      // empty and nothing anywhere said which command fills it. A capability
      // nobody can find is a capability nobody has, and the terminal directly
      // after generation is the only documentation that gets read.
      "You can walk the whole purchase path before any Stripe account exists.",
      "With DATABASE_URL set:",
      "",
      "  pnpm db:seed && pnpm db:seed:demo",
      "  pnpm dev, then open /products and buy something",
      "",
      "With no STRIPE_SECRET_KEY the checkout records the order and applies",
      "every grant through the same function a real payment runs. It refuses",
      "as soon as Stripe is configured, and on production either way.",
      "",
    );
  }

  return lines.join("\n");
}

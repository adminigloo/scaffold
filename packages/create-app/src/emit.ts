import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  isPersonalWorkspaceOnly,
  packagesFor,
  requiredEnvFor,
  tenantLabel,
  type Answers,
} from "./answers.js";

export interface EmitPlan {
  readonly targetDir: string;
  /** Relative path -> file contents. Everything the generator will write. */
  readonly files: ReadonlyMap<string, string>;
}

export class TargetNotEmptyError extends Error {
  readonly name = "TargetNotEmptyError";
  constructor(dir: string, offenders: readonly string[]) {
    super(
      `${dir} already contains ${offenders.join(", ")}. Generating here would ` +
        `overwrite work. Pick an empty directory, or delete those first.`,
    );
  }
}

/**
 * Files that may exist in the target without blocking generation.
 *
 * Running `git init` before generating is a normal thing to do, and so is a
 * README written while deciding on a name. Refusing those would push people
 * toward a --force flag, which is how the check stops meaning anything.
 */
const HARMLESS = new Set([".git", ".gitkeep", "README.md", ".DS_Store"]);

export async function assertTargetUsable(targetDir: string): Promise<void> {
  if (!existsSync(targetDir)) return;
  const entries = await readdir(targetDir);
  const offenders = entries.filter((e) => !HARMLESS.has(e));
  if (offenders.length > 0) throw new TargetNotEmptyError(targetDir, offenders);
}

/**
 * Token substitution over template files.
 *
 * Deliberately not a templating language. Every token is a value the CLI asked
 * for, and a template that can branch is a template that will grow branches —
 * the thing the additive-packages design exists to avoid.
 */
export function renderTokens(source: string, answers: Answers): string {
  const tokens: Record<string, string> = {
    __PROJECT_NAME__: answers.projectName,
    __SCOPE__: answers.scope,
    __SCOPE_NAME__: answers.scope.replace(/^@/, ""),
    __TENANT_LABEL__: tenantLabel(answers),
    __TENANT_LABEL_LOWER__: tenantLabel(answers).toLowerCase(),
    __TENANT_LABEL_PLURAL__: `${tenantLabel(answers)}s`,
  };
  let out = source;
  for (const [token, value] of Object.entries(tokens)) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * npm strips a literal `.gitignore` from a published tarball, and has done
 * forever. Template files that must land as dotfiles ship with a leading
 * underscore and are renamed on the way out — the alternative is a generated
 * project with no ignore file, which nobody notices until node_modules is
 * committed.
 *
 * AN ALLOWLIST, not a rule about leading underscores. Renaming every leading
 * underscore turned `src/server/routers/_app.ts` into `.app.ts` — a hidden file
 * that the app then failed to import, and that nobody would think to look for.
 * A missing entry here leaves a file named `_foo`, which is visible and
 * obviously wrong; the general rule failed silently in the other direction.
 */
const DOTFILE_TEMPLATES = new Set([
  "_gitignore",
  "_gitattributes",
  "_npmrc",
  "_github",
  "_vscode",
  "_editorconfig",
  "_nvmrc",
]);

export function targetNameFor(templateRelativePath: string): string {
  return templateRelativePath
    .split(sep)
    .map((segment) =>
      DOTFILE_TEMPLATES.has(segment) ? `.${segment.slice(1)}` : segment,
    )
    .join(sep);
}

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(relative(base, full));
  }
  return out;
}

/**
 * Build the complete set of files before writing any of them.
 *
 * Planning first means a failure halfway through leaves an empty directory
 * rather than a half-generated project that looks plausible enough to start
 * editing.
 */
export async function planEmit(
  templateDir: string,
  targetDir: string,
  answers: Answers,
): Promise<EmitPlan> {
  const files = new Map<string, string>();

  for (const relPath of await walk(templateDir)) {
    const source = await readFile(join(templateDir, relPath), "utf8");
    files.set(targetNameFor(relPath), renderTokens(source, answers));
  }

  files.set("package.json", renderPackageJson(answers));
  files.set(".env.example", renderEnvExample(answers));
  files.set("SCAFFOLD.md", renderScaffoldRecord(answers));

  return { targetDir, files };
}

export async function writePlan(plan: EmitPlan): Promise<void> {
  for (const [relPath, contents] of plan.files) {
    const full = join(plan.targetDir, relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, "utf8");
  }
}

const STRIPE_DEV_SCRIPT =
  'concurrently -k -n next,stripe -c blue,magenta "next dev" ' +
  '"stripe listen --forward-to localhost:3000/api/webhooks/stripe"';

export function renderPackageJson(answers: Answers): string {
  const deps: Record<string, string> = {
    "@clerk/nextjs": "^7.6.4",
    "@neondatabase/serverless": "^1.1.0",
    "@t3-oss/env-nextjs": "^0.13.11",
    "@tanstack/react-query": "^5.90.16",
    "@trpc/client": "^11.0.0",
    "@trpc/react-query": "^11.0.0",
    "@trpc/server": "^11.0.0",
    "drizzle-orm": "^0.45.2",
    next: "16.2.12",
    react: "19.2.4",
    "react-dom": "19.2.4",
    superjson: "^2.2.1",
    zod: "^4.5.1",
  };
  if (answers.businessModel !== "none") deps["stripe"] = "^22.6.0";
  for (const pkg of packagesFor(answers)) deps[pkg] = "^0.1.0";

  const devDeps: Record<string, string> = {
    "@types/node": "^26.4.0",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "drizzle-kit": "^0.31.10",
    typescript: "^5.9.3",
    vitest: "^4.1.11",
  };
  if (answers.businessModel !== "none") devDeps["concurrently"] = "^9.1.0";

  const manifest = {
    name: answers.projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      // The Stripe listener runs alongside `next dev` by default. Webhooks that
      // are only exercised in production are webhooks nobody has tested.
      dev: answers.businessModel === "none" ? "next dev" : STRIPE_DEV_SCRIPT,
      build: "next build",
      start: "next start",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      "db:generate": "drizzle-kit generate",
      "db:migrate": "drizzle-kit migrate",
      "db:studio": "drizzle-kit studio",
    },
    dependencies: Object.fromEntries(Object.entries(deps).sort()),
    devDependencies: Object.fromEntries(Object.entries(devDeps).sort()),
    // pnpm 10 stopped running dependency install scripts unless they are named
    // here. Without it Next's image optimiser has no sharp binary and esbuild
    // has no platform binary, and both fail at the first build rather than at
    // install — where the warning that explains it has already scrolled past.
    pnpm: { onlyBuiltDependencies: ["esbuild", "sharp"] },
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderEnvExample(answers: Answers): string {
  const lines = [
    "# Copy to .env.local and fill in. Every value is validated at boot;",
    "# a missing or malformed one stops the server rather than failing later.",
    "#",
    "# TEST-MODE KEYS ONLY, here and in the Vercel Preview scope. A live key",
    "# outside production throws KeyModeMismatchError at boot, by design, and",
    "# no environment variable can switch that check off.",
    "",
  ];
  for (const name of requiredEnvFor(answers)) lines.push(`${name}=`);
  return `${lines.join("\n")}\n`;
}

/**
 * What was generated, and from what.
 *
 * Copied source stops receiving upstream fixes the moment it is copied. A year
 * later the only way to tell a deliberate edit from a stale default is to diff
 * against the version that produced it — which requires knowing that version.
 */
export function renderScaffoldRecord(answers: Answers): string {
  return [
    `# ${answers.projectName}`,
    "",
    "Generated by `create-adminigloo-app`.",
    "",
    "| Answer | Value |",
    "| --- | --- |",
    `| Customer organisation | ${answers.tenantNoun} |`,
    `| Business model | ${answers.businessModel} |`,
    `| Admin shell | ${answers.adminShell} |`,
    `| AI routes | ${answers.includeAi ? "yes" : "no"} |`,
    `| Transactional email | ${answers.includeEmail ? "yes" : "no"} |`,
    `| Personal-workspace only | ${isPersonalWorkspaceOnly(answers) ? "yes" : "no"} |`,
    "",
    "## Installed packages",
    "",
    ...packagesFor(answers).map((p) => `- \`${p}\``),
    "",
    "## Forked modules",
    "",
    "Record any base module copied into this repo and no longer imported, with",
    "the version it was forked from. Forking is legitimate; forking silently is",
    "what turns the next upgrade into a negotiation.",
    "",
    "_none yet_",
    "",
  ].join("\n");
}

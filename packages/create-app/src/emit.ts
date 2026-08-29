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

export class OverlayCollisionError extends Error {
  readonly name = "OverlayCollisionError";
  constructor(path: string) {
    super(
      `An overlay tried to overwrite ${path}, which the base template owns. ` +
        `Overlays must be purely additive — silently replacing a base file is ` +
        `how two templates drift apart without anyone noticing.`,
    );
  }
}

/**
 * Which overlay directories this project's answers select.
 *
 * The admin shell is COPIED SOURCE, because every client restyles it. Copying
 * it means it stops receiving upstream fixes, which is why only presentation
 * lives here: its routers, permission checks and audit calls stay in the
 * runtime packages, so a security fix still reaches everyone without a re-copy.
 */
async function overlayDirsFor(
  templateDir: string,
  answers: Answers,
): Promise<string[]> {
  const overlaysRoot = join(templateDir, "..", "overlays");
  const names: string[] = [];

  if (answers.adminShell === "minimal") names.push("admin-minimal");
  if (answers.adminShell === "full") names.push("admin-minimal", "admin-full");
  // The Stripe webhook route and client only exist for projects that take
  // money. Copying them into a project without Stripe would leave a route that
  // imports a package the app never installed.
  if (answers.businessModel !== "none") names.push("stripe");

  const present: string[] = [];
  for (const name of names) {
    const dir = join(overlaysRoot, name);
    if (existsSync(dir)) present.push(dir);
  }
  return present;
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

  // Base first, then overlays. An overlay ADDS files; it never rewrites one the
  // base owns, and `assertOverlaysAreAdditive` enforces that rather than
  // trusting it. Selecting the admin shell copies a directory — it does not
  // switch a flag that some emitted file then branches on.
  for (const dir of [templateDir, ...(await overlayDirsFor(templateDir, answers))]) {
    for (const relPath of await walk(dir)) {
      const target = targetNameFor(relPath);
      if (dir !== templateDir && files.has(target)) {
        throw new OverlayCollisionError(target);
      }
      const source = await readFile(join(dir, relPath), "utf8");
      files.set(target, renderTokens(source, answers));
    }
  }

  files.set("package.json", renderPackageJson(answers));
  files.set(join("src", "env.ts"), renderEnvModule(answers));
  files.set(join("src", "db", "schema.ts"), renderSchemaModule(answers));
  files.set(".env.example", renderEnvExample(answers));
  // Written directly, not just as an example. It is gitignored, and it carries
  // the one value that is not a credential — so `pnpm install && pnpm dev`
  // works with no setup at all, which is the whole point of deferring the rest.
  files.set(".env.local", renderEnvLocal(answers));
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

/**
 * The version of each package a NEW project should install.
 *
 * Hardcoded, and guarded by a test that reads the workspace manifests — because
 * the obvious shortcut is wrong in a way that fails silently. Every package sat
 * at `^0.1.0`, and a caret range on a 0.x version means `>=0.1.0 <0.2.0`: the
 * moment @adminigloo/env shipped 0.2.0, a freshly generated project quietly
 * installed the OLD one. Everything resolved, everything built, and the feature
 * the release added simply was not there.
 *
 * Keep in step with the workspace. `create-app.versions.test.ts` fails the
 * build if this drifts, which is the only reason a hardcoded list is safe.
 */
const PACKAGE_VERSIONS: Readonly<Record<string, string>> = {
  env: "0.2.0",
  db: "0.2.0",
  auth: "0.1.1",
  tenancy: "0.1.1",
  permissions: "0.1.1",
  trpc: "0.1.0",
  observability: "0.1.1",
  stripe: "0.1.1",
  commerce: "0.1.1",
  billing: "0.1.1",
  ai: "0.1.1",
  email: "0.1.1",
};

export class UnknownPackageVersionError extends Error {
  readonly name = "UnknownPackageVersionError";
  constructor(pkg: string) {
    super(
      `No version recorded for ${pkg}. Add it to PACKAGE_VERSIONS in emit.ts — ` +
        `guessing a range here is how a project silently installs the wrong one.`,
    );
  }
}

/** `@scope/name` -> the caret range a generated project should depend on. */
export function versionRangeFor(scopedName: string): string {
  const bare = scopedName.replace(/^@[^/]+\//, "");
  const version = PACKAGE_VERSIONS[bare];
  if (!version) throw new UnknownPackageVersionError(scopedName);
  return `^${version}`;
}

export function packageVersions(): Readonly<Record<string, string>> {
  return PACKAGE_VERSIONS;
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
    "server-only": "^0.0.1",
    superjson: "^2.2.1",
    zod: "^4.5.1",
  };
  if (answers.businessModel !== "none") deps["stripe"] = "^22.6.0";
  for (const pkg of packagesFor(answers)) deps[pkg] = versionRangeFor(pkg);

  const devDeps: Record<string, string> = {
    "@types/node": "^26.4.0",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "drizzle-kit": "^0.31.10",
    // The seed script is TypeScript and is run directly, not built.
    tsx: "^4.23.5",
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
      // Idempotent: re-run it after adding a permission to the catalog. It only
      // touches templates it created, never one you have customised.
      "db:seed": "tsx scripts/seed-roles.ts",
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

/**
 * A ready-to-run `.env.local`.
 *
 * Every credential is present but commented out, with where to get it. An empty
 * file would boot equally well and tell you nothing; a file listing what is
 * missing turns "read the README" into "uncomment the line".
 */
export function renderEnvLocal(answers: Answers): string {
  const port = 3000;
  const lines = [
    "# Local development. Gitignored, and already valid — `pnpm dev` runs as is.",
    "#",
    "# Everything below is commented out. Uncomment and fill one in whenever you",
    "# want the feature it unlocks; visit /setup to see what is on and what is off.",
    "# A malformed value still fails at boot, so a half-pasted key is caught here",
    "# rather than three screens later.",
    "",
    `NEXT_PUBLIC_APP_URL=http://localhost:${port}`,
    "",
    "# --- Neon -----------------------------------------------------------------",
    "# console.neon.tech -> your STAGING project -> Connection Details.",
    "# Two different strings: the pooled host contains `-pooler`, the direct one",
    "# does not. They are not interchangeable and boot validation checks which is",
    "# which, so a swap fails immediately instead of hanging drizzle-kit later.",
    "# DATABASE_URL=",
    "# DATABASE_URL_UNPOOLED=",
    "",
    "# --- Clerk ----------------------------------------------------------------",
    "# dashboard.clerk.com -> API keys. Test mode.",
    "# The webhook secret is only needed once you have a public URL; on localhost",
    "# the user row is created from the session instead.",
    "# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=",
    "# CLERK_SECRET_KEY=",
    "# CLERK_WEBHOOK_SIGNING_SECRET=",
  ];

  if (answers.businessModel !== "none") {
    lines.push(
      "",
      "# --- Stripe ---------------------------------------------------------------",
      "# dashboard.stripe.com -> Developers -> API keys, with Test mode ON.",
      "# STRIPE_WEBHOOK_SECRET is printed by `stripe listen`, which `pnpm dev`",
      "# starts for you — it is NOT the one in the dashboard.",
      "# NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=",
      "# STRIPE_SECRET_KEY=",
      "# STRIPE_WEBHOOK_SECRET=",
    );
  }
  if (answers.includeEmail) {
    lines.push(
      "",
      "# --- Resend ---------------------------------------------------------------",
      "# Without RESEND_API_KEY, sends are recorded as `skipped` and logged, so you",
      "# can see exactly what would have gone out.",
      "# RESEND_API_KEY=",
      "# EMAIL_FROM=Your Name <hello@yourdomain.com>",
    );
  }
  if (answers.includeAi) {
    lines.push(
      "",
      "# --- AI ---------------------------------------------------------------------",
      "# ANTHROPIC_API_KEY=",
    );
  }

  return `${lines.join("\n")}\n`;
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
    "Generated by `@adminigloo/create-app`.",
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

/**
 * `src/env.ts` for this project.
 *
 * Derived rather than templated because the fragments an app composes are
 * exactly the packages it installed. A static file would either demand a Stripe
 * key from a project with no Stripe, or omit it from one that needs it — and
 * the second failure only surfaces at the first payment.
 */
export function renderEnvModule(answers: Answers): string {
  const takesMoney = answers.businessModel !== "none";
  const scope = answers.scope;

  const imports = [
    `import { authClient, authServer, AUTH_MODE_BOUND_KEYS } from "${scope}/auth";`,
    `import { dbServer, DB_OPTIONAL_UNTIL_DEPLOYED } from "${scope}/db";`,
    `import { coreClient, coreServer, defineEnv } from "${scope}/env";`,
  ];
  if (takesMoney) {
    imports.push(
      `import { stripeClient, stripeServer, STRIPE_MODE_BOUND_KEYS } from "${scope}/stripe";`,
    );
  }
  if (answers.includeAi) imports.push(`import { aiServer } from "${scope}/ai";`);
  if (answers.includeEmail) imports.push(`import { emailServer } from "${scope}/email";`);

  const serverSpreads = ["...coreServer()", "...dbServer()", "...authServer()"];
  const clientSpreads = ["...coreClient()", "...authClient()"];
  const modeBound = ["...AUTH_MODE_BOUND_KEYS"];
  const runtime = [
    "NODE_ENV: process.env.NODE_ENV",
    "LOG_LEVEL: process.env.LOG_LEVEL",
    "DATABASE_URL: process.env.DATABASE_URL",
    "DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED",
    "CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET",
    "NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  ];

  // Required on a deployment, deferrable on a laptop. Everything a service
  // account issues belongs here; NEXT_PUBLIC_APP_URL does not, because you
  // already know it and nothing has to be signed up for.
  const deferred = [
    "...DB_OPTIONAL_UNTIL_DEPLOYED",
    '"CLERK_SECRET_KEY"',
    '"CLERK_WEBHOOK_SIGNING_SECRET"',
    '"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"',
  ];

  const features = [
    `{ name: "Database", vars: [...DB_OPTIONAL_UNTIL_DEPLOYED], disables: "Anything that reads or writes data." }`,
    `{ name: "Sign-in", vars: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_WEBHOOK_SIGNING_SECRET"], disables: "Signing in, and every permission check." }`,
  ];

  if (takesMoney) {
    serverSpreads.push("...stripeServer()");
    clientSpreads.push("...stripeClient()");
    modeBound.push("...STRIPE_MODE_BOUND_KEYS");
    runtime.push(
      "STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    );
    deferred.push(
      '"STRIPE_SECRET_KEY"',
      '"STRIPE_WEBHOOK_SECRET"',
      '"NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"',
    );
    features.push(
      `{ name: "Payments", vars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY"], disables: "Checkout, subscriptions and the webhook ledger." }`,
    );
  }

  if (answers.includeAi) {
    serverSpreads.push("...aiServer()");
    runtime.push(
      "ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY",
      "OPENAI_API_KEY: process.env.OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY: process.env.GOOGLE_GENERATIVE_AI_API_KEY",
    );
    features.push(
      `{ name: "AI", vars: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"], disables: "AI routes." }`,
    );
  }

  if (answers.includeEmail) {
    serverSpreads.push("...emailServer()");
    runtime.push(
      "RESEND_API_KEY: process.env.RESEND_API_KEY",
      "EMAIL_FROM: process.env.EMAIL_FROM",
      "EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO",
      "RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET",
    );
    deferred.push('"EMAIL_FROM"');
    features.push(
      `{ name: "Email", vars: ["RESEND_API_KEY", "EMAIL_FROM"], disables: "Sending mail. Sends are recorded as skipped instead." }`,
    );
  }

  return `${imports.join("\n")}

/**
 * The environment contract for ${answers.projectName}.
 *
 * HARD RULE: this is the only module allowed to read \`process.env\`. Everywhere
 * else imports \`env\`. Composed from the fragments of the packages actually
 * installed, so this project is never asked for a credential it has no use for.
 */
const server = {
  ${serverSpreads.join(",\n  ")},
};

const client = {
  ${clientSpreads.join(",\n  ")},
};

const runtimeEnv = {
  ${runtime.join(",\n  ")},
};

/**
 * Credentials you can add LATER.
 *
 * On a laptop these may be absent: the app boots, /setup lists what is missing,
 * and the feature each one unlocks stays off until you paste a value in. That
 * is the difference between a scaffold you can run and one you have to finish
 * shopping for first.
 *
 * On a deployment they are hard-required and the build fails without them,
 * because a forgotten Vercel variable should stop a release rather than reach a
 * customer as a broken page. A value that is PRESENT but malformed still fails
 * everywhere — a mistyped connection string is not a deferred credential.
 */
const optionalUntilDeployed = [
  ${deferred.join(",\n  ")},
] as const;

export const env = defineEnv({
  server,
  client,
  runtimeEnv,
  optionalUntilDeployed,
  // Their \`_test_\` / \`_live_\` mode must match the deployment. Checked outside
  // Zod on the raw values, so neither SKIP_ENV_VALIDATION nor deferring a key
  // above can switch it off.
  modeBoundKeys: [${modeBound.join(", ")}],
});

/**
 * Inputs for the /setup page, exported so it reads the SAME schemas boot
 * validation uses. A setup page with its own copy of the list drifts the first
 * time a package is added, and then confidently reports that everything is
 * configured.
 */
export const envDescription = {
  server,
  client,
  runtimeEnv,
  optionalUntilDeployed,
  features: [
    ${features.join(",\n    ")},
  ],
};
`;
}

/**
 * `src/db/schema.ts` for this project.
 *
 * Re-exports the base tables so drizzle-kit sees ONE schema and a migration
 * covers base and app tables together. Copying a base table's definition here
 * instead would fork its migrations silently.
 */
export function renderSchemaModule(answers: Answers): string {
  const scope = answers.scope;
  // EVERY installed package that owns a table must appear here. drizzle.config
  // points drizzle-kit at this one file, so a package omitted from this list
  // has its tables silently excluded from every migration — the code compiles,
  // the app boots, and the first insert fails against a table that was never
  // created.
  const exports = [
    `export * from "${scope}/auth/schema";`,
    `export * from "${scope}/tenancy/schema";`,
    `export * from "${scope}/permissions/schema";`,
    `export * from "${scope}/observability/schema";`,
  ];
  if (answers.businessModel !== "none") {
    exports.push(`export * from "${scope}/stripe/schema";`);
  }
  if (answers.includeAi) {
    exports.push(`export * from "${scope}/ai/schema";`);
  }
  if (answers.includeEmail) {
    exports.push(`export * from "${scope}/email/schema";`);
  }

  return `/**
 * ${answers.projectName} schema.
 *
 * Base tables come from the packages that own them. Do NOT copy a base table's
 * definition into this file — the package owns its migrations, and a local copy
 * forks them without anyone noticing until an upgrade fails.
 */
${exports.join("\n")}

// ---------------------------------------------------------------------------
// ${answers.projectName} tables go below. Use the shared column helpers so ids,
// timestamps and money follow the same rules everywhere:
//
//   import { idColumn, createdAt, updatedAt, amountMinor } from "${scope}/db";
// ---------------------------------------------------------------------------
`;
}

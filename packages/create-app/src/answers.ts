/**
 * Every question the generator asks, and the shape the emitter consumes.
 *
 * Answers resolve at GENERATION time into a different set of files and
 * dependencies. Nothing here becomes a conditional in the emitted app — a
 * generated project that carries `if (features.stripe)` is a template with
 * extra steps, and the branches rot the moment one client edits them.
 */

export type BusinessModel = "none" | "one-time" | "subscription" | "both";
export type AdminShell = "none" | "minimal" | "full";
export type TenantNoun = "Organization" | "Company" | "Workspace" | "Team" | "none";

export interface Answers {
  /** Directory and package name. Lowercase, url-safe. */
  readonly projectName: string;
  /** What a customer organisation is called throughout the UI. */
  readonly tenantNoun: TenantNoun;
  readonly businessModel: BusinessModel;
  readonly adminShell: AdminShell;
  readonly includeAi: boolean;
  readonly includeEmail: boolean;
  /** Scope the packages are published under. */
  readonly scope: string;
}

export const DEFAULT_ANSWERS: Answers = {
  projectName: "my-app",
  tenantNoun: "Organization",
  businessModel: "none",
  adminShell: "minimal",
  includeAi: false,
  includeEmail: false,
  scope: "@adminigloo",
};

export class InvalidProjectNameError extends Error {
  readonly name = "InvalidProjectNameError";
  constructor(value: string, reason: string) {
    super(`"${value}" is not a usable project name: ${reason}`);
  }
}

/**
 * npm's own rules, plus the ones that only bite later.
 *
 * The directory name, the package name and the Vercel project name are all
 * this string. A capital letter is legal in a folder and illegal in a package
 * name; a leading dot produces a hidden directory that the shell then hides
 * from the person wondering where their project went.
 */
export function validateProjectName(value: string): string {
  const name = value.trim();
  if (name.length === 0) throw new InvalidProjectNameError(value, "it is empty");
  if (name.length > 214) {
    throw new InvalidProjectNameError(value, "npm caps package names at 214 characters");
  }
  if (name !== name.toLowerCase()) {
    throw new InvalidProjectNameError(value, "npm package names must be lowercase");
  }
  if (name.startsWith(".") || name.startsWith("_")) {
    throw new InvalidProjectNameError(value, "it cannot start with '.' or '_'");
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new InvalidProjectNameError(
      value,
      "use lowercase letters, digits, dot, dash or underscore",
    );
  }
  return name;
}

/**
 * Which packages this project installs.
 *
 * The only structural branch in the system, and it branches by choosing
 * dependencies rather than by templating conditionals.
 */
export function packagesFor(answers: Answers): readonly string[] {
  // Only packages that are actually published. A dependency on something that
  // does not exist yet makes `pnpm install` fail on the first command the
  // person runs, which is the worst possible first impression of a generator.
  const base = [
    "env",
    "db",
    "auth",
    "tenancy",
    "permissions",
    "trpc",
    "observability",
  ];
  const optional: string[] = [];

  // Stripe is the primitive: sessions, signature verification, the event
  // ledger, idempotent dispatch. Every money-taking project needs it.
  if (answers.businessModel !== "none") optional.push("stripe");

  // Cart, shipping, tax and orders — one-time purchases.
  if (answers.businessModel === "one-time" || answers.businessModel === "both") {
    optional.push("commerce");
  }
  // Plans, entitlements, proration and the portal — recurring revenue.
  if (answers.businessModel === "subscription" || answers.businessModel === "both") {
    optional.push("billing");
  }

  if (answers.includeAi) optional.push("ai");
  if (answers.includeEmail) optional.push("email");

  return [...base, ...optional].map((p) => `${answers.scope}/${p}`);
}

/**
 * Environment variables this project must have, given what it installed.
 *
 * Drives `.env.example` and the "what you still need to paste in" summary the
 * CLI prints at the end. Keyed to packages so a project without Stripe is
 * never told to go and find a Stripe key.
 */
export function requiredEnvFor(answers: Answers): readonly string[] {
  const vars = [
    "NEXT_PUBLIC_APP_URL",
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  ];
  if (answers.businessModel !== "none") {
    vars.push(
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    );
  }
  // Names must match what @adminigloo/email actually declares. This listed
  // RESEND_FROM_EMAIL, which nothing reads — so .env.example told you to set a
  // variable that does nothing, while EMAIL_FROM, which the schema REQUIRES,
  // went unmentioned and the app refused to boot.
  if (answers.includeEmail) vars.push("RESEND_API_KEY", "EMAIL_FROM");
  if (answers.includeAi) vars.push("ANTHROPIC_API_KEY");
  return vars;
}

/** Singular noun used in generated UI copy. `none` means a B2C project. */
export function tenantLabel(answers: Answers): string {
  return answers.tenantNoun === "none" ? "Workspace" : answers.tenantNoun;
}

/** A B2C project mints a personal workspace and never renders a switcher. */
export function isPersonalWorkspaceOnly(answers: Answers): boolean {
  return answers.tenantNoun === "none";
}

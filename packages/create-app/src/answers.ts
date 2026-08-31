/**
 * Every question the generator asks, and the shape the emitter consumes.
 *
 * Answers resolve at GENERATION time into a different set of files and
 * dependencies. Nothing here becomes a conditional in the emitted app — a
 * generated project that carries `if (features.stripe)` is a template with
 * extra steps, and the branches rot the moment one client edits them.
 */

/**
 * EVERY VALUE EACH ANSWER CAN TAKE, as data rather than as a union spelled out
 * in three places.
 *
 * The types below are derived from these tuples, so a sixth tenant noun is one
 * edit here and not four — and, more to the point, anything that iterates the
 * answer space picks it up automatically. That is load-bearing: the guarantee
 * "the generator can produce every configuration" is only worth having if
 * "every" is computed from the option sets rather than restated by hand beside
 * them, where the restatement is one value short the day after somebody adds
 * one and nothing says so.
 *
 * `cli.ts` validates flags against exactly these arrays, so a value the CLI
 * accepts is a value the sweep generates, and there is no third list.
 */
export const TENANT_NOUNS = [
  "Organization",
  "Company",
  "Workspace",
  "Team",
  "none",
] as const;
export const BUSINESS_MODELS = ["none", "one-time", "subscription", "both"] as const;
export const ADMIN_SHELLS = ["none", "minimal", "full"] as const;

export type BusinessModel = (typeof BUSINESS_MODELS)[number];
export type AdminShell = (typeof ADMIN_SHELLS)[number];
export type TenantNoun = (typeof TENANT_NOUNS)[number];

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

  // Taking money at all needs these four together, and splitting them by
  // business model was a bug: `fulfilPurchase` writes an order (commerce),
  // grants an entitlement (billing), reads its price from a variant (catalog)
  // and charges through stripe — on BOTH the one-time and subscription paths.
  // Installing commerce without billing generated a project that could not
  // resolve its own imports.
  //
  // An "order" is the record of any purchase, recurring or not; entitlements
  // are how either kind grants something. The one-time/subscription answer
  // shapes the UI and the plan handling, not the package set.
  if (answers.businessModel !== "none") {
    optional.push("stripe", "catalog", "commerce", "billing");
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

/**
 * Variables the project can read but runs perfectly well without.
 *
 * SEPARATE FROM `requiredEnvFor` because the CLI's closing summary introduces
 * that list with "the app will not boot until these are set", and mixing in
 * three optional keys makes the sentence false — after which people skim the
 * whole block, including the two lines that were load-bearing.
 *
 * They still belong in `.env.example`, and leaving them out was a real defect
 * rather than tidiness: `SENTRY_DSN`, `UPSTASH_REDIS_REST_URL` and
 * `UPSTASH_REDIS_REST_TOKEN` are declared by `@adminigloo/observability`, which
 * every project installs, and a variable absent from the example file is one
 * nobody discovers exists. The rate limiter in particular reads the Upstash
 * pair to decide whether it counts in shared storage or in one process's
 * memory, and there was no way to tell it.
 *
 * `LOG_LEVEL` is deliberately not here. It has a schema default, so it is not
 * something to go and find — listing it would put a line in the example file
 * that changes nothing when filled in.
 */
export function optionalEnvFor(answers: Answers): readonly string[] {
  const vars = [
    // Which environment this is, on a host that is not Vercel.
    //
    // Optional because a laptop needs no answer — the toolchain's own NODE_ENV
    // already says "development" there — and because on Vercel the platform
    // answers first and this is ignored. It is listed because on Docker, Fly,
    // Railway, Render, ECS or a VPS it is the ONLY thing that names the
    // environment, and a deployment nobody named is treated as an unlabelled
    // one: deferred credentials stay deferred, the automatic first-admin grant
    // stays off, and live Stripe keys are refused. It is also not read through
    // `src/env.ts`, so /setup cannot list it from the schema — which makes this
    // file the only place a reader would ever meet it.
    "APP_ENV",
    // Who becomes the first administrator on a DEPLOYED environment. Optional,
    // and unset means a deployment grants nobody automatically.
    "BOOTSTRAP_ADMIN_EMAIL",
    // Observability is in the base package set, so these are in every project.
    "SENTRY_DSN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
  ];
  if (answers.businessModel !== "none") {
    // Authorises booking paid orders with no payment. Off unless it is exactly
    // "true", never available on production, and needed nowhere locally.
    vars.push("ALLOW_SIMULATED_CHECKOUT");
  }
  if (answers.includeAi) {
    vars.push("OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY");
  }
  if (answers.includeEmail) {
    vars.push("EMAIL_REPLY_TO", "RESEND_WEBHOOK_SECRET");
  }
  return vars;
}

/** Singular noun used in generated UI copy. `none` means a B2C project. */
export function tenantLabel(answers: Answers): string {
  return answers.tenantNoun === "none" ? "Workspace" : answers.tenantNoun;
}

/**
 * The plural of each noun the CLI offers, written down rather than derived.
 *
 * `${tenantLabel(answers)}s` produced "Companys" — in the admin sidebar, in the
 * heading of /admin/tenants, in its empty state and in two permission
 * categories, which is to say on the first screen a client is shown. English
 * pluralisation is not a suffix, and the alternative to this table is an
 * inflection engine that would be wrong in a different, less predictable place.
 *
 * A LOOKUP OVER A CLOSED SET IS THE WHOLE POINT. `TenantNoun` is a union of
 * five values the CLI validates against, so `Record<TenantNoun, string>` makes
 * a sixth noun a type error at the moment it is added — which is the only
 * moment anybody is thinking about its plural. A general pluraliser would
 * silently guess instead.
 *
 * `none` is a B2C project, whose singular is already "Workspace"; both forms
 * have to agree or the same screen says Workspace and Workspacs.
 */
const TENANT_PLURALS: Record<TenantNoun, string> = {
  Organization: "Organizations",
  Company: "Companies",
  Workspace: "Workspaces",
  Team: "Teams",
  none: "Workspaces",
};

/** Plural noun used in generated UI copy — headings, nav entries, categories. */
export function tenantLabelPlural(answers: Answers): string {
  return TENANT_PLURALS[answers.tenantNoun];
}

/** A B2C project mints a personal workspace and never renders a switcher. */
export function isPersonalWorkspaceOnly(answers: Answers): boolean {
  return answers.tenantNoun === "none";
}

/**
 * Which overlay directories these answers select, by name.
 *
 * Separated from the copying so the same list can be recorded in the project
 * manifest. An overlay that was applied is a fact about the project that
 * nothing else records: the admin shell is COPIED SOURCE, so a year later the
 * only way to tell a deliberate edit from a stale default is to know which
 * overlay put the file there and at what generator version.
 *
 * The admin shell is copied because every client restyles it. Copying means it
 * stops receiving upstream fixes, which is why only presentation lives in an
 * overlay: routers, permission checks and audit calls stay in the runtime
 * packages, so a security fix still reaches everyone without a re-copy.
 */
export function overlayNamesFor(answers: Answers): readonly string[] {
  const names: string[] = [];

  if (answers.adminShell === "minimal") names.push("admin-minimal");
  if (answers.adminShell === "full") names.push("admin-minimal", "admin-full");

  // The Stripe webhook route and client only exist for projects that take
  // money. Copying them into a project without Stripe would leave a route that
  // imports a package the app never installed.
  if (answers.businessModel !== "none") names.push("stripe");

  // The product builder is an ADMIN surface, so it needs both: something to
  // sell AND an admin shell to put it in. In the base template it emitted even
  // with `--admin none`, which put admin pages in a project that had
  // deliberately declined one.
  if (answers.businessModel !== "none" && answers.adminShell !== "none") {
    names.push("catalog-admin");
  }

  // The customer's own side of the line: `/account`, their orders, one order
  // in full, and their billing. Selected on the SAME condition as the stripe
  // overlay — anything that can be bought needs somewhere the buyer can see it
  // afterwards — and never without it, because these pages read
  // `@/server/fulfilment`, `@/server/routers/checkout` and `@/server/stripe`,
  // all of which the stripe overlay owns.
  //
  // Its own directory rather than more files inside `stripe` because the two
  // have different subjects. The stripe overlay is the sale: the shop window,
  // the card form, the webhook, the one function that books an order. This is
  // everything after it, and it is the half that did not exist — every order
  // `fulfilPurchase` wrote, every licence key it minted and every entitlement
  // it granted was readable by exactly one page, keyed on a reference in a URL
  // the buyer was about to leave. Splitting them means a project can restyle
  // the account area without touching the checkout.
  if (answers.businessModel !== "none") names.push("account");

  // The mail templates and the preview that renders them. They import
  // @__SCOPE_NAME__/email, which a project generated without `--email` never
  // installs, so copying them there would emit a page that cannot compile.
  // Absence is a directory that was not copied — not a flag some emitted file
  // then has to branch on.
  if (answers.includeEmail) names.push("email");

  // The streaming assistant, its rate table and the usage row it writes. They
  // import @__SCOPE_NAME__/ai and the Anthropic SDK, neither of which a project
  // generated without `--ai` installs, so copying them anywhere else would emit
  // a route that cannot compile. This overlay is what makes the `ai.streaming`
  // capability in adminigloo.json true rather than a claim: before it existed,
  // `--ai` contributed an env fragment, a permission fragment and a table, and
  // nothing that ever called a model.
  if (answers.includeAi) names.push("ai");

  return names;
}

/**
 * What this project can be expected to do, as stable keys.
 *
 * The question "what is enabled here?" is currently answered by reading
 * `package.json` and walking the directory tree, which means every tool that
 * wants to know reimplements the same inference and gets it subtly differently.
 * A capability is the answer written down once, by the only code that actually
 * knows: the generator.
 *
 * Keys are for machines — the matrix CI, a `doctor` command, a component
 * registry deciding whether a component's dependencies are present. They are
 * therefore an API: rename one and every consumer silently stops matching, so
 * add rather than rename, and bump `MANIFEST_VERSION` if the vocabulary ever
 * has to change shape.
 *
 * DERIVED, never asked for. A capability the generator cannot work out from the
 * answers is a capability that would have to be maintained by hand, and a
 * hand-maintained record of what a project has is exactly the thing this
 * replaces.
 */
export function capabilitiesFor(answers: Answers): readonly string[] {
  const takesMoney = answers.businessModel !== "none";
  const keys: string[] = [
    // The base package set, which every project installs. Listed rather than
    // assumed: a consumer that has to know which keys are implicit is a
    // consumer that has hardcoded this function's behaviour at a distance.
    "auth.clerk",
    "permissions.two-layer",
    "trpc.procedure-ladder",
    "tenancy.invitations",
    "observability.audit-log",
    "observability.error-log",
    "observability.rate-limit",
  ];

  // Both are tenanted. The difference is whether an organisation is a thing the
  // user can see and switch between, or an invisible personal workspace that
  // makes the B2C query path identical to the B2B one.
  keys.push(
    isPersonalWorkspaceOnly(answers)
      ? "tenancy.personal-workspace"
      : "tenancy.organizations",
  );

  if (answers.adminShell !== "none") keys.push("admin.shell");
  if (answers.adminShell === "full") keys.push("admin.support-tools");
  if (takesMoney && answers.adminShell !== "none") {
    keys.push("admin.product-builder");
  }

  if (takesMoney) {
    keys.push(
      "payments.stripe",
      "catalog.products",
      "storefront",
      // An order is the record of any purchase, recurring or not, and an
      // entitlement is how either kind grants something. Both exist on both
      // paths, which is why they are not conditioned on the business model.
      "commerce.orders",
      "billing.entitlements",
      // The buyer's own side. Distinct from `commerce.orders`, which is the
      // WRITE — `fulfilPurchase` booking a row — and was true for a year while
      // no customer-facing screen could read one back. A consumer asking "can
      // a person see what they bought here" was getting the answer to a
      // different question.
      "commerce.customer-account",
    );
  }
  if (answers.businessModel === "one-time" || answers.businessModel === "both") {
    keys.push("commerce.one-time-checkout");
  }
  if (
    answers.businessModel === "subscription" ||
    answers.businessModel === "both"
  ) {
    keys.push("billing.subscriptions");
  }

  if (answers.includeEmail) keys.push("email.transactional");
  if (answers.includeAi) keys.push("ai.streaming");

  return [...keys].sort();
}

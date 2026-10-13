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
  /**
   * In-app feedback: the end-user widget, the key-authenticated intake API,
   * and — when there is an admin shell to put them in — the staff queue and
   * Kanban board that triage what arrives.
   *
   * A boolean like `includeAi` rather than a shape of its own, because the
   * only structural fork inside it (does the triage UI exist?) is already
   * answered by `adminShell`, exactly the way `catalog-admin` reads two
   * answers rather than inventing a third.
   *
   * DEFAULTS TO FALSE. The widget does not mount until a client key is issued
   * and pasted into ADMINIGLOO_FEEDBACK_KEY, so a default-on feedback feature
   * would put an intake API and an empty queue in every internal tool that
   * never asked for one — surface with nothing behind it.
   */
  readonly includeFeedback: boolean;
  /**
   * SEO & AEO self-audits: the site crawling its own sitemap and scoring how
   * search engines and answer engines will read it, receipts in the app's own
   * database. The staff report page rides `adminShell`, the same fork
   * feedback's triage UI takes.
   *
   * DEFAULTS TO FALSE, but for a different reason than the others: the audit
   * has no credential to wait for — it would work on first boot. It is off by
   * default because it is a SELLABLE feature, and the generator's rule is
   * that what is for sale arrives by being asked for.
   */
  readonly includeSeoReports: boolean;
  /**
   * The in-app inbox: durable per-recipient notifications your events write
   * and your header badge reads. The package ships the primitive; PRODUCERS
   * ARE THE PROJECT'S TO WIRE — feedback's `onEvent` hook is the proven first
   * one, and adminigloo.com's intake route is the shape to copy.
   *
   * DEFAULTS TO FALSE: an inbox nothing writes to is a page that teaches
   * people to stop checking it.
   */
  readonly includeNotifications: boolean;
  /**
   * Tenant-scoped file storage: rows in the app's own database, bytes behind
   * a two-method adapter the app owns (the emitted one chooses Vercel Blob).
   * The upload is a plain route handler — files do not ride superjson — and
   * the staff library page rides `adminShell`.
   *
   * DEFAULTS TO FALSE. Without BLOB_READ_WRITE_TOKEN the library says so in
   * one sentence instead of erroring, so default-on would only add surface
   * with nothing behind it — the feedback-widget rule.
   */
  readonly includeStorage: boolean;
  /**
   * The AI assistant's editable brain: a personality stored as versioned,
   * revertible database rows an admin edits without a deploy, per-tenant
   * overlays, a glossary, and a change log — plus the `assemblePrompt`
   * function the app's own AI route calls to build its system prompt from
   * them. The staff editor rides `adminShell`.
   *
   * DEFAULTS TO FALSE, and independent of `includeAi`: the brain is editable
   * config whether or not this project streams. A project with both gets the
   * natural pairing — the AI route assembles its prompt from the brain — but
   * that wiring is the app's to make; the flag ships the config and the
   * function, not an opinion about the route.
   */
  readonly includeAssistant: boolean;
  /**
   * Does this project have a PUBLIC FACE — a landing page, a pricing page, a
   * privacy policy — or is it only the application behind the sign-in?
   *
   * ITS OWN QUESTION, because nothing else already asked answers it. A project
   * that sells is not necessarily one anybody markets: a B2B tool sold on a call
   * still charges a card and still needs terms. A project that sells nothing
   * still has a landing page, because "landing page" and "shop" are different
   * things. And an internal admin tool has neither, so `/` is better spent on
   * the orientation page than on a hero somebody has to delete.
   *
   * IT SELECTS COPIED SOURCE AND NOTHING ELSE — no package, no table, no
   * environment variable — which is exactly what `adminShell` does, and the
   * precedent that makes this a legitimate answer rather than a flag bolted on
   * to dodge a decision.
   *
   * DEFAULTS TO FALSE. Marketing copy is the one thing in a generated project
   * that is certainly wrong on arrival: every string is a claim about a product
   * only the client can make. Turning it on by default would put placeholder
   * claims at `/` of every internal tool this firm generates. The SEO half is
   * deliberately NOT behind this answer — see `renderSeoModule` — because a
   * staging deployment that gets indexed is a harm, and a harm must not be
   * opt-in.
   */
  readonly includeMarketing: boolean;
  /**
   * FIELD-SERVICE FEATURES — the quote → book → bill spine plus the two around
   * it, each a standalone, composable overlay. They are the testbed's
   * @__SCOPE_NAME__/{estimator,scheduling,invoicing,comms,aeo} packages, wired
   * the same way the other suite features are: a server half (router + any
   * app-owned glue) on the answer alone, an admin page half gated on the shell.
   *
   * Each stands alone. Where two are selected together the generator writes
   * the glue between them into GENERATED modules — a booking request
   * acknowledged through comms (src/server/scheduling-notify.ts); an estimate
   * emailed through comms, its photo kept through storage, read through the
   * --ai model, an accepted quote booking the visit and becoming an invoice
   * (src/server/estimator-notify.ts, src/server/estimator-services.ts) —
   * because a static overlay cannot conditionally depend on a sibling overlay.
   * Glue nothing generates yet (a citation check asking the app's model) is a
   * degrading stub the project wires, the rule notifications follows.
   */
  readonly includeEstimator: boolean;
  readonly includeScheduling: boolean;
  readonly includeInvoicing: boolean;
  readonly includeComms: boolean;
  readonly includeAeo: boolean;
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
  includeFeedback: false,
  includeSeoReports: false,
  includeNotifications: false,
  includeStorage: false,
  includeAssistant: false,
  includeMarketing: false,
  includeEstimator: false,
  includeScheduling: false,
  includeInvoicing: false,
  includeComms: false,
  includeAeo: false,
  scope: "@adminigloo",
};

/**
 * A combination of answers that generates a project which can't do what it
 * promises — refused, in plain words, before anything is written.
 */
export class IncompatibleAnswersError extends Error {
  readonly name = "IncompatibleAnswersError";
}

/**
 * Refuse the answer sets that would ship a broken business.
 *
 * SCHEDULING NEEDS AN ADMIN PANEL. Online requests are accepted or declined
 * on the staff calendar, and crews open today's route there. A project
 * generated with `--scheduling --admin none` took bookings nobody could
 * answer — every one sat until it expired, after the customer had been told
 * "we'll confirm it soon" — and its next steps still pointed at three admin
 * pages that 404.
 */
export function assertAnswersCompatible(answers: Answers): void {
  if (answers.includeScheduling && answers.adminShell === "none") {
    throw new IncompatibleAnswersError(
      "Scheduling needs an admin panel: staff accept or decline online booking requests on its calendar, and crews open today's route there. " +
        "With --admin none every request would wait unanswered until it expired. Use --admin minimal (or full) with --scheduling.",
    );
  }
  // THE ESTIMATOR NEEDS ONE TOO, for the same reason: leads nobody can answer.
  // The price book is built, the lead is read and the quote is sent from the
  // staff screens. With --admin none the public page would price from an
  // empty catalog for ever, and a lead a customer saved would sit in a table
  // no page reads.
  if (answers.includeEstimator && answers.adminShell === "none") {
    throw new IncompatibleAnswersError(
      "The estimator needs an admin panel: the owner builds the price book there, and staff read each lead, edit it and send the quote from it. " +
        "With --admin none nothing could be priced and every saved estimate would go unanswered. Use --admin minimal (or full) with --estimator.",
    );
  }
}

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
    // THE COMPANY SCREENS, in every project (Tenancy 1). The team page is in
    // both modes — a single-business project still invites its staff — and the
    // operator console lists every company or workspace. They ship as package
    // components so a fix to who may remove whom reaches a project by
    // `npm update` instead of being frozen into a copied page.
    "tenancy-widget",
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

  // Two packages for one answer, deliberately. `feedback` is the platform
  // half — schema, key issuance, the HTTP handlers — and `feedback-widget` is
  // the client SDK the layout mounts. They version independently (a widget
  // capture fix is not a schema change), and a client buying only the widget
  // against a hosted platform installs exactly one of them, so folding them
  // into one package here would misstate what is actually for sale.
  if (answers.includeFeedback) optional.push("feedback", "feedback-widget");
  if (answers.includeSeoReports) optional.push("seo-reports");
  if (answers.includeNotifications) optional.push("notifications");
  if (answers.includeStorage) optional.push("storage");
  if (answers.includeAssistant) optional.push("assistant");

  // Field service. Each installs only its own package; the cross-feature glue
  // (booking acknowledgements and confirmations through comms, a citation
  // check through a model) is shipped as a wired-yourself stub, so none of
  // these pulls in another.
  // Two packages for one answer, the scheduling split: `estimator` is the
  // server half (schema, the public and staff HTTP handlers, the comms
  // listener, the photo reading on Claude) and `estimator-widget` is the
  // screens — the estimate page, the quote page a customer accepts on and,
  // under /admin, the leads queue, the estimate editor, the price book and
  // the settings. They version independently, and a business's other website
  // that only embeds the estimate installs the widget alone.
  if (answers.includeEstimator) optional.push("estimator", "estimator-widget");
  // Two packages for one answer, the feedback split: `scheduling` is the
  // server half (schema, the two HTTP handlers, the comms listener) and
  // `scheduling-widget` is the screens — the booking and manage-your-visit
  // pages and, under /admin, the calendar, today's route and settings. They
  // version independently, and a marketing site that only embeds the picker
  // against a hosted API installs the widget alone.
  if (answers.includeScheduling) optional.push("scheduling", "scheduling-widget");
  if (answers.includeInvoicing) optional.push("invoicing");
  if (answers.includeComms) optional.push("comms");
  if (answers.includeAeo) optional.push("aeo");

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
/**
 * The variables a DEPLOYMENT refuses to start without, and a laptop doesn't
 * need yet — the env module's `optionalUntilDeployed` list, by name.
 *
 * ONE LIST, read by both: renderEnvModule writes it into src/env.ts, and the
 * CLI's next steps print it as "a deployment refuses to start without". They
 * used to be two hand-written lists, and the printed one said "the app will
 * not boot until these are set" about keys that never stopped a laptop
 * (TB-DEPLOY-14).
 */
export function deferredUntilDeployedFor(answers: Answers): readonly string[] {
  const vars = [
    // DB_OPTIONAL_UNTIL_DEPLOYED, from __SCOPE__/db (the env module spreads
    // the package's constant; a generator test holds the two together).
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "CLERK_SECRET_KEY",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  ];
  if (answers.includeEmail) vars.push("EMAIL_FROM");
  return vars;
}

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
    // Where a suspended company is told to write (Tenancy 1). Optional: without
    // it — and without BOOTSTRAP_ADMIN_EMAIL, which the suspended screen falls
    // back to — the screen says "contact support" with no address to write to.
    "SUPPORT_EMAIL",
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
  if (answers.includeFeedback) {
    // Both optional because both degrade rather than disable the app. Without
    // the key the widget is simply not mounted — the intake API still answers,
    // so another app holding a key can still submit. Without the blob token,
    // uploads answer 503 {skipped} and reports arrive without screenshots.
    vars.push("ADMINIGLOO_FEEDBACK_KEY", "BLOB_READ_WRITE_TOKEN");
  }
  if (answers.includeStorage) {
    // Same variable feedback's screenshots use — one blob store per project,
    // so the file library and the screenshots share a credential.
    vars.push("BLOB_READ_WRITE_TOKEN");
  }
  if (answers.includeComms || answers.includeScheduling || answers.includeEstimator) {
    // What the /api/cron/* routes check. Optional because a laptop drains
    // nothing on a schedule; on a deployment, unset means every cron call is
    // refused — reminders and quote follow-ups wait, and expired requests and
    // quotes go untold — which is why it is listed here, where somebody will
    // see it, rather than only in src/env.ts.
    vars.push("CRON_SECRET");
  }
  if (answers.includeScheduling) {
    // Both degrade rather than disable. Without the key drive times are
    // straight-line estimates and addresses are stored as typed; without the
    // zone the business starts in Mountain Time and the owner changes it in
    // Schedule settings.
    vars.push("GOOGLE_MAPS_API_KEY", "SCHEDULING_TIME_ZONE");
  }
  if (answers.includeEstimator) {
    // The zone the dates on quotes start in (the owner changes it in Estimate
    // settings) and, with --ai, which model reads a customer's photo: Claude
    // Haiku 4.5 unless this names another — the founder's choice of the
    // cheapest capable model. The photos themselves are kept with
    // BLOB_READ_WRITE_TOKEN, listed above with storage.
    vars.push("ESTIMATOR_TIME_ZONE");
    if (answers.includeAi) vars.push("ESTIMATOR_TAKEOFF_MODEL");
  }
  // Deduped, not sorted: two features naming one variable (the blob token)
  // must not print it twice, and order is the order the reader meets them.
  return [...new Set(vars)];
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

  // THE COMPANY PAGES (Tenancy 1): onboarding ("What's your company
  // called?"), the company dashboard with its setup checklist, company
  // settings and the reserved public face at /t/[slug]. Only when the
  // customer is a company somebody names; a single-business project
  // (`--tenant-noun none`) has one invisible workspace per person and none of
  // these pages — the overlay is the switch, so no emitted file asks which
  // mode it is in.
  if (answers.tenantNoun !== "none") names.push("companies");

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

  // THE FEEDBACK FEATURE IS TWO OVERLAYS, split the way catalog-admin is split
  // from stripe and for the same reason: the two halves have two different
  // conditions, and one directory would be wrong in one configuration each way.
  //
  // `feedback` is the intake half — the key-authenticated API route, the staff
  // router, the widget mount and the key-issuing script. It needs only the
  // answer: tickets can arrive and be read over tRPC whether or not there is
  // an admin shell to render them in.
  if (answers.includeFeedback) names.push("feedback");

  // `feedback-admin` is the triage UI — the queue page and the Kanban board,
  // both under /admin. An admin surface needs an admin shell to put it in;
  // copying these pages into a project generated with `--admin none` would
  // emit routes with no shell layout, no sidebar entry, and no way in — the
  // exact leak catalog-admin once had.
  if (answers.includeFeedback && answers.adminShell !== "none") {
    names.push("feedback-admin");
  }

  // THE THREE NEWEST SUITE FEATURES, each split on the feedback shape: the
  // server half (router, helpers, API routes) needs only its answer, because
  // it is reachable over tRPC or HTTP whether or not there is a shell; the
  // `-admin` half is pages, and pages without a shell are the catalog-admin
  // leak all over again.
  if (answers.includeSeoReports) names.push("seo-reports");
  if (answers.includeSeoReports && answers.adminShell !== "none") {
    names.push("seo-admin");
  }
  if (answers.includeNotifications) names.push("notifications");
  if (answers.includeNotifications && answers.adminShell !== "none") {
    names.push("notifications-admin");
  }
  if (answers.includeStorage) names.push("storage");
  if (answers.includeStorage && answers.adminShell !== "none") {
    names.push("storage-admin");
  }
  if (answers.includeAssistant) names.push("assistant");
  if (answers.includeAssistant && answers.adminShell !== "none") {
    names.push("assistant-admin");
  }

  // FIELD SERVICE, each on the feedback shape: the server half (router + glue)
  // on the answer alone, the `-admin` page half gated on a shell to hold it.
  if (answers.includeEstimator) names.push("estimator");
  if (answers.includeEstimator && answers.adminShell !== "none") {
    names.push("estimator-admin");
  }
  if (answers.includeScheduling) names.push("scheduling");
  if (answers.includeScheduling && answers.adminShell !== "none") {
    names.push("scheduling-admin");
  }
  if (answers.includeInvoicing) names.push("invoicing");
  if (answers.includeInvoicing && answers.adminShell !== "none") {
    names.push("invoicing-admin");
  }
  if (answers.includeComms) names.push("comms");
  if (answers.includeComms && answers.adminShell !== "none") {
    names.push("comms-admin");
  }
  if (answers.includeAeo) names.push("aeo");
  if (answers.includeAeo && answers.adminShell !== "none") {
    names.push("aeo-admin");
  }

  // THE PUBLIC FACE, in three overlays rather than one, because the three have
  // three different conditions and folding them together would make one of the
  // three wrong in every configuration.
  //
  // `legal` is the widest. A privacy policy and terms of service are not
  // marketing: Stripe will not activate an account without a public URL for
  // each, so a project that takes money needs both whether or not anybody
  // markets it — and a project with a marketing site needs both because its
  // footer links to them. Hence the disjunction. It also carries the one thing a
  // generic legal template always gets wrong, which is the subprocessor list,
  // and that list is only accurate because `renderLegalRecord` derives it from
  // the packages this project actually installed.
  if (answers.includeMarketing || answers.businessModel !== "none") {
    names.push("legal");
  }

  // `marketing` is the landing page and the sections it is composed of. It owns
  // `app/(site)/page.tsx`, which is why `planEmit` writes the orientation page
  // to /setup/start instead when this is selected — two files cannot both be
  // `/`, and the client-facing one is the one that belongs there.
  if (answers.includeMarketing) names.push("marketing");

  // `marketing-pricing` needs BOTH answers, exactly as `catalog-admin` does. A
  // pricing page reads `src/plans.ts`, which is written only for a project that
  // takes money — so copying it into a `--model none` project would emit a page
  // that cannot resolve its own import, and copying it into a project with no
  // marketing site would put a public pricing page in an app that has no public
  // face to reach it from.
  if (answers.includeMarketing && answers.businessModel !== "none") {
    names.push("marketing-pricing");
  }

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
    // In the BASE list, and that placement is the claim. Every project resolves
    // a metadataBase, carries a title template, and refuses indexing anywhere
    // that is not production — because the harm a missing one does is not
    // proportional to how much marketing a project has. A preview deployment
    // that gets crawled outranks the client's real site for their own brand
    // terms, and undoing it is a Search Console removal plus weeks of waiting.
    "seo.metadata",
  ];

  // Both are tenanted. The difference is whether an organisation is a thing the
  // user can see and switch between, or an invisible personal workspace that
  // makes the B2C query path identical to the B2B one.
  keys.push(
    isPersonalWorkspaceOnly(answers)
      ? "tenancy.personal-workspace"
      : "tenancy.organizations",
  );

  // TENANCY 1, in every project: the permission catalog is seeded on every
  // deploy and the first administrator can always be recovered (first-run),
  // and the generated project proves its own company isolation and procedure
  // scopes in its unit suite (isolation-proof). Base keys because neither is a
  // feature somebody opts into — they are what makes the rest trustworthy.
  keys.push("tenancy.first-run", "tenancy.isolation-proof");

  if (answers.adminShell !== "none") keys.push("admin.shell");
  // The platform owner's view of every company — list, detail, suspend,
  // reassign an owner — and People, where staff roles are given. Both are
  // pages, so they need a shell to live in.
  if (answers.adminShell !== "none") keys.push("admin.operator-console");
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

  // Two keys for the two halves, because a consumer asking "can this project
  // receive feedback" and one asking "can staff triage it here" are asking
  // different questions with different answers: `--feedback --admin none`
  // takes reports and renders no queue.
  if (answers.includeFeedback) keys.push("feedback.intake");
  if (answers.includeFeedback && answers.adminShell !== "none") {
    keys.push("feedback.triage");
  }

  // Split the way feedback is, for the same reason: "can this project audit
  // itself / fan out notifications / store files" and "is there a staff
  // screen for it here" are different questions with different answers.
  if (answers.includeSeoReports) keys.push("seo.audits");
  if (answers.includeSeoReports && answers.adminShell !== "none") {
    keys.push("seo.reports");
  }
  if (answers.includeNotifications) keys.push("notifications.fanout");
  if (answers.includeNotifications && answers.adminShell !== "none") {
    keys.push("notifications.inbox");
  }
  if (answers.includeStorage) keys.push("storage.files");
  if (answers.includeStorage && answers.adminShell !== "none") {
    keys.push("storage.library");
  }
  if (answers.includeAssistant) keys.push("assistant.brain");
  if (answers.includeAssistant && answers.adminShell !== "none") {
    keys.push("assistant.editor");
  }

  // Field service. Split the way the other suite features are: the server half
  // (router/handlers/schema) on the answer, the staff screen on the shell.
  //
  // The estimator: instant prices on the public page and the embed, quotes a
  // customer accepts on /quote/[token] (sent from the admin), the staff
  // screens — and then one key per feature it is GLUED to, because "is a
  // customer's photo kept here", "is it read by a model", "does an unanswered
  // quote get a follow-up", "can an accepted quote book the visit" and "can it
  // become an invoice" each have their own answer.
  if (answers.includeEstimator) {
    keys.push("estimator.pricing", "estimator.embed", "estimator.quotes");
  }
  if (answers.includeEstimator && answers.adminShell !== "none") {
    keys.push("estimator.builder");
  }
  if (answers.includeEstimator && answers.includeStorage) keys.push("estimator.photos");
  if (answers.includeEstimator && answers.includeAi) keys.push("estimator.photo-reading");
  if (answers.includeEstimator && answers.includeComms) keys.push("estimator.followups");
  if (answers.includeEstimator && answers.includeScheduling) keys.push("estimator.book-visit");
  if (answers.includeEstimator && answers.includeInvoicing) keys.push("estimator.invoicing");
  // Scheduling: the public booking and manage pages on the answer; the
  // calendar and the crew's route under the shell; and the emails —
  // confirmations, reminders, expiry notices — only where comms is there to
  // send them, which is a question a consumer asks separately ("does a
  // customer here get reminded?").
  if (answers.includeScheduling) keys.push("scheduling.booking");
  if (answers.includeScheduling && answers.adminShell !== "none") {
    keys.push("scheduling.calendar", "scheduling.route");
  }
  if (answers.includeScheduling && answers.includeComms) {
    keys.push("scheduling.reminders");
  }
  if (answers.includeInvoicing) keys.push("invoicing.invoices");
  if (answers.includeInvoicing && answers.adminShell !== "none") {
    keys.push("invoicing.ledger");
  }
  if (answers.includeComms) keys.push("comms.messaging");
  if (answers.includeComms && answers.adminShell !== "none") {
    keys.push("comms.console");
  }
  if (answers.includeAeo) keys.push("aeo.citations");
  if (answers.includeAeo && answers.adminShell !== "none") {
    keys.push("aeo.dashboard");
  }

  // The public face. Three keys rather than one, because a consumer asking
  // "does this project have a pricing page" is asking something a single
  // `marketing` key could not answer — `--marketing --model none` has a landing
  // page and no pricing page at all.
  if (answers.includeMarketing) keys.push("marketing.landing");
  if (answers.includeMarketing && takesMoney) keys.push("marketing.pricing");
  // Claimed on the same disjunction that selects the overlay: a project that
  // takes money has these pages whether or not it markets itself, because
  // Stripe requires both before it will activate an account.
  if (answers.includeMarketing || takesMoney) keys.push("legal.policies");

  return [...keys].sort();
}

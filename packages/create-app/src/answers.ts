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
   * ALERTS (Tenancy 2b-1): a bell in the header with each person's own
   * alerts in the company they're working in — a new lead, a quote answered,
   * a visit request, a customer moving a visit, an invoice opened, paid or
   * overdue, an email that didn't go, a teammate who joined or left — each
   * person's choice of "In the app" or "In the app and by email", and one
   * place where the owner picks who hears about new work.
   *
   * THE PRODUCERS ARE WIRED, not left for the project: every installed
   * feature's events reach the alerts (src/server/alerts.ts), the office
   * emails go to the people Alert settings name, and the alerts cron sends
   * what a request couldn't and produces the time-based ones (a request
   * about to lapse, an invoice gone overdue). In both modes: a single
   * business's staff get the same bell.
   *
   * DEFAULTS TO FALSE: a business that installs no feature has nothing to be
   * alerted about, and the bell is a promise.
   */
  readonly includeNotifications: boolean;
  /**
   * PHOTOS AND FILES (Tenancy 2b-1): each company's files, PRIVATE by
   * default — served only through its signed-in screens or a short-lived
   * signed link — on its visits, estimates and invoices (a crew member adds
   * them from their phone at the job), the customer's estimate photo kept
   * privately with the estimate, the logo uploaded in company settings (the
   * one public file, under an unguessable address), and a Files screen that
   * says "Using X of Y" against a per-company allowance.
   *
   * Two Vercel Blob stores (a private one and the public one); with neither
   * token, and outside production, files are kept on this computer's disk so
   * a laptop works with nothing set.
   *
   * DEFAULTS TO FALSE: a business with no visits, estimates or invoices has
   * little to keep, and every stored byte costs somebody.
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
  /**
   * WEBSITE VISITS (Tenancy 2b-4a): first-party, cookieless visit counts —
   * where visitors came from (search, AI assistants by name, other sites),
   * which pages they read, which AI crawlers read them — with the business's
   * own people left out (@adminigloo/audience comes with it).
   *
   * In a companies project EACH COMPANY has its own: its pages here
   * (/t/{web address}) are counted for it, it registers its own website and
   * pastes one line to count that too, and it reads its numbers at
   * /app/website. This site's own numbers are at /admin/analytics. A single
   * business counts its one site, as adminigloo.com does.
   *
   * DEFAULTS TO FALSE: it is a sellable feature, and what is for sale arrives
   * by being asked for (the SEO reports' rule).
   */
  readonly includeAnalytics: boolean;
  /**
   * SEARCH AND AI-ANSWER BASICS (Tenancy 2b-4a), through @adminigloo/seo:
   * page titles with the brand once, canonical addresses, robots.txt that
   * names the AI crawlers, a sitemap. In a companies project each company's
   * public pages (/t/{web address}) get their own title, description,
   * canonical address and LocalBusiness details from its company profile, and
   * are listed in the sitemap — token pages stay out of search.
   *
   * Without it the project keeps its own, thinner SEO (src/seo.ts), and a
   * company's pages stay out of search (Tenancy 2a, D17).
   */
  readonly includeSeo: boolean;
  /**
   * BOOK A CALL (Tenancy 2b-4c): a booking page where customers pick a time
   * for a call with the business — its people, their weekly hours, time off,
   * holidays and call types — with a private link to move or cancel, calendar
   * files, and reminders. With companies, each company's own: its calls at
   * /app/calls and its booking page at /t/{web address}/book. One business:
   * /admin/calls and /book.
   */
  readonly includeBooking: boolean;
  /**
   * A STORE OF ITS OWN (getting paid, part 2): the business sells its own
   * products online — name, price, photo, stock — with a cart, Stripe's
   * checkout and an orders list. With companies, each company's own: its
   * products and orders at /app/store, its store at /t/{web address}/store,
   * paid into its own connected Stripe account (as invoices' Pay now is).
   * One business: /admin/store and /store, on its own Stripe keys.
   *
   * Not the same as --model one-time, which is THIS SITE selling its own
   * catalog. DEFAULTS TO FALSE: it is a sellable feature.
   */
  readonly includeStore: boolean;
  /**
   * ONE CUSTOMER LIST (create-app 0.35, @adminigloo/customers): each
   * customer once — their emails, phones, addresses and notes — with every
   * quote, visit, invoice, call, order and message that is theirs on one
   * timeline. With companies, each company's own at /app/customers; one
   * business at /admin/customers. The features' glue finds or creates the
   * customer inside the company and links the record (src/server/customers.ts).
   *
   * ON BY DEFAULT WHENEVER A FIELD FEATURE IS (`customersByDefault`):
   * estimator, scheduling, invoicing, booking, the store or comms. --no-customers
   * turns it off.
   */
  readonly includeCustomers: boolean;
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
  includeAnalytics: false,
  includeSeo: false,
  includeBooking: false,
  includeStore: false,
  includeCustomers: false,
  scope: "@adminigloo",
};

/**
 * A combination of answers that generates a project which can't do what it
 * promises — refused, in plain words, before anything is written.
 */
/**
 * The customer list's default (create-app 0.35): on whenever a field feature
 * is — something that has customers — and there is somewhere to work it (a
 * company's /app, or one business's admin panel).
 */
export function customersByDefault(answers: Pick<Answers, "tenantNoun" | "adminShell" | "includeEstimator" | "includeScheduling" | "includeInvoicing" | "includeBooking" | "includeStore" | "includeComms">): boolean {
  const field =
    answers.includeEstimator || answers.includeScheduling || answers.includeInvoicing || answers.includeBooking || answers.includeStore || answers.includeComms;
  return field && (answers.tenantNoun !== "none" || answers.adminShell !== "none");
}

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
  // BOOK A CALL, ONE BUSINESS, NEEDS AN ADMIN PANEL: its calls, hours and call
  // types are worked at /admin/calls. (A company's are at /app/calls, which
  // needs no shell.)
  if (answers.includeBooking && answers.tenantNoun === "none" && answers.adminShell === "none") {
    throw new IncompatibleAnswersError(
      "Booking calls needs an admin panel in a single-business project: the calls, the hours and the call types are worked at /admin/calls. " +
        "With --admin none nobody could see a booked call or set when people can book. Use --admin minimal (or full) with --booking.",
    );
  }
  // A STORE, ONE BUSINESS, NEEDS AN ADMIN PANEL: its products and orders are
  // worked at /admin/store. (A company's are at /app/store, which needs none.)
  if (answers.includeStore && answers.tenantNoun === "none" && answers.adminShell === "none") {
    throw new IncompatibleAnswersError(
      "A store needs an admin panel in a single-business project: the products, prices and orders are worked at /admin/store. " +
        "With --admin none nobody could add a product or see an order. Use --admin minimal (or full) with --store.",
    );
  }
  // THE CUSTOMER LIST, ONE BUSINESS, NEEDS AN ADMIN PANEL: it is worked at
  // /admin/customers. (A company's is at /app/customers, which needs none.)
  if (answers.includeCustomers && answers.tenantNoun === "none" && answers.adminShell === "none") {
    throw new IncompatibleAnswersError(
      "The customer list needs an admin panel in a single-business project: customers are looked up, edited, merged and imported at /admin/customers. " +
        "Use --admin minimal (or full) with --customers, or leave it off with --no-customers.",
    );
  }
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
  // Two packages each since Tenancy 2b-1, the scheduling split: the server
  // half (`notifications`: alerts, choices, who hears, the email copies and
  // the handlers; `storage`: the files, the stores, the allowance, signed
  // links and the handlers) and the screens (`notifications-widget`: the
  // bell, the alerts page, Alert settings; `storage-widget`: a record's
  // photos and files, the Files screen, the usage meter). A fix to the bell
  // reaches every project by `npm update`.
  if (answers.includeNotifications) optional.push("notifications", "notifications-widget");
  if (answers.includeStorage) optional.push("storage", "storage-widget");
  // Two packages since Tenancy 2b-3, the feedback split: `assistant` is the
  // server half (the brain, the tool loop, the company handlers, the Anthropic
  // adapter) and `assistant-widget` the screens (the launcher and chat, and
  // the owner's settings under ./admin). The chat's model and its usage
  // ledger come with --ai.
  if (answers.includeAssistant) optional.push("assistant", "assistant-widget");

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
  // Two packages each since Tenancy 2a (D3), the scheduling split: the server
  // half (`invoicing`: the ledger's rules, its HTTP handlers, the invoice email;
  // `comms`: the queue, the log, the Messages console's handlers) and the
  // screens (`invoicing-widget`: the ledger, one invoice's editor, the
  // customer's invoice page; `comms-widget`: the Messages console). The
  // screens used to be pages copied into the project over a tRPC router, so a
  // fix to the ledger had to be hand-applied to every project; now it reaches
  // them by `npm update`, in both modes.
  if (answers.includeInvoicing) optional.push("invoicing", "invoicing-widget");
  // Getting paid, part 1: "Pay now" on an invoice runs on @adminigloo/stripe
  // (Connect in a companies project, the business's own keys for one), so a
  // project that sells nothing itself still installs it with invoicing.
  if (answers.includeInvoicing && answers.businessModel === "none") optional.push("stripe");
  // Getting paid, part 2: a store of its own — its products are catalog rows
  // under the business's id, its orders are commerce's, paid through stripe.
  if (answers.includeStore) {
    for (const pkg of ["stripe", "catalog", "commerce"]) if (!optional.includes(pkg)) optional.push(pkg);
  }
  if (answers.includeComms) optional.push("comms", "comms-widget");
  // The customer list (create-app 0.35): one package, its screens under ./admin.
  if (answers.includeCustomers) optional.push("customers");
  if (answers.includeAeo) optional.push("aeo");
  // Two packages for one answer (Tenancy 2b-4c), the feedback split: `booking`
  // is the server half (the slot engine, the company handlers and route
  // tables, the calendar reader, the emails as data) and `booking-widget` the
  // screens (the booking page, the manage page, and the calls admin under
  // ./admin).
  if (answers.includeBooking) optional.push("booking", "booking-widget");
  // Two packages for one answer (Tenancy 2b-4a): `analytics` counts the
  // visits and draws the screens; `audience` decides whose visits don't count
  // (the business's own people). Analytics leaves people out only through an
  // audience, so selling one without the other would sell numbers with the
  // owner's own browsing in them.
  if (answers.includeAnalytics) optional.push("analytics", "audience");
  if (answers.includeSeo) optional.push("seo");

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
    // TWO STORES (Tenancy 2b-1, D10): the private one for photos and files,
    // and the public one (the variable feedback's screenshots already use)
    // for company logos. A Vercel Blob store is private or public as a
    // whole, so they are two stores with two tokens — the env check refuses
    // the same token in both. Without either, and outside production, files
    // are kept on this computer's disk.
    vars.push("BLOB_PRIVATE_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN");
    // How much each company may store (default 5 GB until the billing chunk
    // sets it per plan), and the key for "Copy link" (else one is made from
    // CLERK_SECRET_KEY).
    vars.push("FILES_ALLOWANCE_MB", "FILES_LINK_SECRET");
  }
  if (
    answers.includeComms ||
    answers.includeScheduling ||
    answers.includeEstimator ||
    // The alerts cron (email retries, the time-based alerts, clean-up) and
    // the files cron (the purge, the move to private) check it too.
    answers.includeNotifications ||
    answers.includeStorage ||
    // Tenancy 2b-4a: the website numbers' daily tidy-up checks it too.
    answers.includeAnalytics ||
    // Tenancy 2b-4b: and the weekly search check and AI mentions.
    answers.includeSeoReports ||
    answers.includeAeo ||
    // Tenancy 2b-4c: and the calls' reminders and hold clean-up.
    answers.includeBooking
  ) {
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
    // cheapest capable model. The photos themselves are kept privately with
    // the estimate, in the private store (BLOB_PRIVATE_READ_WRITE_TOKEN,
    // listed above with storage).
    vars.push("ESTIMATOR_TIME_ZONE");
    if (answers.includeAi) vars.push("ESTIMATOR_TAKEOFF_MODEL");
  }
  // Tenancy 2b-3: which model the assistant answers with — Claude Haiku 4.5
  // unless this names another, the founder's cheapest-capable rule.
  if (answers.includeAssistant && answers.includeAi) vars.push("ASSISTANT_MODEL");
  // Tenancy 2b-4a: the key whose visitor links and "leave this person out"
  // marks are made with. Optional: without it one is made from
  // CLERK_SECRET_KEY, which a deployment already requires.
  if (answers.includeAnalytics) vars.push("AUDIENCE_SECRET");
  // Getting paid, part 1: "Pay now" on invoices. Optional — without them the
  // invoice page shows "How to pay" only. A companies project uses Connect
  // (each company's own Stripe account) and may take a fee; one business uses
  // its own Stripe keys and an endpoint of its own.
  // Getting paid, part 2: a store of its own takes the same card payments, on the same variables.
  if (answers.includeInvoicing || answers.includeStore) {
    if (answers.businessModel === "none") vars.push("STRIPE_SECRET_KEY");
    if (answers.tenantNoun !== "none") vars.push("STRIPE_CONNECT_WEBHOOK_SECRET", "PLATFORM_FEE_BPS");
    else vars.push("STRIPE_INVOICE_WEBHOOK_SECRET");
  }
  // PLANS (billing 0.3), in a companies project that sells subscriptions (the
  // same test as plans-emit.ts's `plansEnforced`, inlined to keep this module
  // free of the emitters): the free trial's length, and the day plans were
  // first enforced on a project that ran before.
  if (answers.tenantNoun !== "none" && (answers.businessModel === "subscription" || answers.businessModel === "both")) {
    vars.push("BILLING_TRIAL_DAYS", "PLANS_ENFORCED_FROM");
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

  // `feedback-companies` (Tenancy 2b-2a): each company's own board at
  // /app/feedback with its settings, its routes under /api/app/{id}/feedback,
  // and its customers' feedback page at /t/{web address}/feedback. No shell
  // condition — a company's area is not the platform's /admin — and nothing of
  // it in a single-business project, whose one board is the site's own.
  if (answers.includeFeedback && answers.tenantNoun !== "none") {
    names.push("feedback-companies");
  }

  // THE THREE NEWEST SUITE FEATURES, each split on the feedback shape: the
  // server half (router, helpers, API routes) needs only its answer, because
  // it is reachable over tRPC or HTTP whether or not there is a shell; the
  // `-admin` half is pages, and pages without a shell are the catalog-admin
  // leak all over again.
  // Tenancy 2b-4b: the search check runs on the package's handlers. Its
  // route and screen for this site's own (seo-reports), the page under the
  // shell (seo-admin), and each company's route (seo-reports-companies).
  if (answers.includeSeoReports) names.push("seo-reports");
  if (answers.includeSeoReports && answers.adminShell !== "none") {
    names.push("seo-admin");
  }
  if (answers.includeSeoReports && answers.tenantNoun !== "none") names.push("seo-reports-companies");
  // ALERTS AND FILES (Tenancy 2b-1), cut by mode the way the field-service
  // features are (below), because their files have the same four
  // conditions. The 0.1 `notifications` overlay is gone: its notify helper
  // and tRPC router were replaced by the generated src/server/alerts.ts and
  // the package's own handlers.
  //
  //   notifications-companies  each company's alerts page, Alert settings and
  //                            its alerts route (/api/app/{id}/alerts)
  //   notifications-single     the one business's alerts route
  //                            (/api/admin/alerts)
  //   notifications-admin      its pages under the shell, and /admin/inbox
  //                            as a redirect to /admin/alerts
  //   storage                  both modes: signed links and public files
  //                            (/api/files) and the files cron
  //   storage-companies        each company's Files page and files route
  //   storage-visits-*         a visit's photos-and-files page (a visit has
  //                            no page of its own), with scheduling
  //   storage-single / -admin  the one business's files route and pages
  {
    const companies = answers.tenantNoun !== "none";
    const shell = answers.adminShell !== "none";
    if (answers.includeNotifications) {
      if (companies) names.push("notifications-companies");
      else {
        names.push("notifications-single");
        if (shell) names.push("notifications-admin");
      }
    }
    if (answers.includeStorage) {
      names.push("storage");
      if (companies) {
        names.push("storage-companies");
        if (answers.includeScheduling) names.push("storage-visits-companies");
      } else {
        names.push("storage-single");
        if (shell) names.push("storage-admin");
        if (shell && answers.includeScheduling) names.push("storage-visits-admin");
      }
    }
  }
  // THE ASSISTANT (Tenancy 2b-3), cut by its conditions:
  //   assistant             both modes: the site's own brain router and its
  //                         handler route (/api/admin/assistant)
  //   assistant-admin       the site's own editor under the shell
  //   assistant-chat-admin  the site's own chat under the shell, with --ai
  //                         (the chat needs a model)
  //   assistant-companies   each company's settings (/app/assistant), its
  //                         route (/api/app/{id}/assistant) and the /app
  //                         layout that mounts the chat's button
  if (answers.includeAssistant) names.push("assistant");
  if (answers.includeAssistant && answers.adminShell !== "none") {
    names.push("assistant-admin");
  }
  if (answers.includeAssistant && answers.includeAi && answers.adminShell !== "none") {
    names.push("assistant-chat-admin");
  }
  if (answers.includeAssistant && answers.tenantNoun !== "none") {
    names.push("assistant-companies");
  }

  // FIELD SERVICE (Tenancy 2a): each feature cut into up to four overlays,
  // because its files have four different conditions —
  //
  //   <f>            what BOTH modes share: the pure decisions in
  //                  src/server/<f>-config.ts (first settings, rate limits,
  //                  delivery wording, paths). Pushed only for a feature that
  //                  has such a file (scheduling and the estimator); invoicing
  //                  and comms have none, and an empty overlay is never copied.
  //   <f>-single     one business (--tenant-noun none): the feature runs for
  //                  the fixed business at today's paths (/book-visit,
  //                  /estimate, /api/schedule …) on the staff ladder.
  //   <f>-admin      single only, and only with a shell: today's staff pages
  //                  under /admin.
  //   <f>-companies  companies: each company's own screens under /app, its
  //                  public pages under /t/{web-address}, its routes under
  //                  /api/app/{id} and /api/t/{web-address}. No shell
  //                  condition — a company's area is not the platform's /admin.
  //
  // The two modes share no route file and no page. A single-business project
  // contains nothing of the company area, and a companies project contains no
  // fixed business: a generator test greps one for "primary" and every fixed
  // tenant constant (D12), the cheapest guard against the leak 2a closes.
  const companies = answers.tenantNoun !== "none";
  const shell = answers.adminShell !== "none";
  const fieldService: ReadonlyArray<{ readonly name: string; readonly on: boolean; readonly shared: boolean }> = [
    { name: "estimator", on: answers.includeEstimator, shared: true },
    { name: "scheduling", on: answers.includeScheduling, shared: true },
    { name: "invoicing", on: answers.includeInvoicing, shared: false },
    { name: "comms", on: answers.includeComms, shared: false },
  ];
  for (const feature of fieldService) {
    if (!feature.on) continue;
    if (feature.shared) names.push(feature.name);
    if (companies) {
      names.push(`${feature.name}-companies`);
    } else {
      names.push(`${feature.name}-single`);
      if (shell) names.push(`${feature.name}-admin`);
    }
  }
  // Tenancy 2b-4b: AI mentions, cut the same way as the search check.
  if (answers.includeAeo) names.push("aeo");
  if (answers.includeAeo && answers.adminShell !== "none") {
    names.push("aeo-admin");
  }
  if (answers.includeAeo && answers.tenantNoun !== "none") names.push("aeo-companies");
  // WEBSITE VISITS (Tenancy 2b-4a), cut by its conditions:
  //   analytics             both modes: this site's own beacon endpoint, the
  //                         keyed endpoint every website calls (/api/w), this
  //                         site's own report and audience routes, and the
  //                         screens' client components
  //   analytics-admin       this site's own numbers at /admin/analytics
  //   analytics-companies   each company's /app/website, its routes, and the
  //                         beacon on its pages here (/t/{web address})
  if (answers.includeAnalytics) names.push("analytics");
  if (answers.includeAnalytics && answers.adminShell !== "none") names.push("analytics-admin");
  if (answers.includeAnalytics && answers.tenantNoun !== "none") names.push("analytics-companies");

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
  // Alerts and files (Tenancy 2b-1). The screens are a company's own in a
  // companies project (its area needs no shell) and the shell's for a single
  // business — so "is there an alerts page / a Files screen here" is
  // companies OR a shell, the field-service rule.
  {
    const ownScreens = answers.tenantNoun !== "none" || answers.adminShell !== "none";
    const fieldFeature =
      answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing || answers.includeComms;
    if (answers.includeNotifications) keys.push("notifications.fanout", "notifications.bell");
    if (answers.includeNotifications && ownScreens) keys.push("notifications.inbox");
    // Every installed field-service feature's events reach the alerts (the
    // team's own alerts, in companies mode, ride tenancy's events either way).
    if (answers.includeNotifications && fieldFeature) {
      keys.push("notifications.producers");
    }
    if (answers.includeStorage) keys.push("storage.files");
    if (answers.includeStorage && ownScreens) keys.push("storage.library");
    if (
      answers.includeStorage &&
      (answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing)
    ) {
      keys.push("storage.attachments");
    }
  }
  if (answers.includeAssistant) keys.push("assistant.brain");
  // Tenancy 2b-3: the chat (with a model), and each company's own assistant.
  if (answers.includeAssistant && answers.includeAi) keys.push("assistant.chat");
  if (answers.includeAssistant && answers.tenantNoun !== "none") keys.push("assistant.companies");
  if (answers.includeAssistant && answers.adminShell !== "none") {
    keys.push("assistant.editor");
  }

  // Field service. Split the way the other suite features are: the server half
  // (handlers/schema) on the answer, the staff screen where there is one to
  // hold it — the shell's /admin for a single business, each company's own
  // area (/app) in a companies project (Tenancy 2a), which needs no shell.
  //
  // The estimator: instant prices on the public page and the embed, quotes a
  // customer accepts on their quote page (sent from the staff screens), the
  // staff screens — and then one key per feature it is GLUED to, because "is a
  // customer's photo kept here", "is it read by a model", "does an unanswered
  // quote get a follow-up", "can an accepted quote book the visit" and "can it
  // become an invoice" each have their own answer.
  const companies = answers.tenantNoun !== "none";
  const staffScreens = companies || answers.adminShell !== "none";
  if (answers.includeEstimator) {
    keys.push("estimator.pricing", "estimator.embed", "estimator.quotes");
  }
  if (answers.includeEstimator && staffScreens) {
    keys.push("estimator.builder");
  }
  if (answers.includeEstimator && answers.includeStorage) keys.push("estimator.photos");
  if (answers.includeEstimator && answers.includeAi) keys.push("estimator.photo-reading");
  if (answers.includeEstimator && answers.includeComms) keys.push("estimator.followups");
  if (answers.includeEstimator && answers.includeScheduling) keys.push("estimator.book-visit");
  if (answers.includeEstimator && answers.includeInvoicing) keys.push("estimator.invoicing");
  // Scheduling: the public booking and manage pages on the answer; the
  // calendar and the crew's route where the staff screens are; and the emails
  // — confirmations, reminders, expiry notices — only where comms is there to
  // send them, which is a question a consumer asks separately ("does a
  // customer here get reminded?").
  if (answers.includeScheduling) keys.push("scheduling.booking");
  if (answers.includeScheduling && staffScreens) {
    keys.push("scheduling.calendar", "scheduling.route");
  }
  if (answers.includeScheduling && answers.includeComms) {
    keys.push("scheduling.reminders");
  }
  if (answers.includeInvoicing) keys.push("invoicing.invoices");
  if (answers.includeInvoicing && staffScreens) {
    keys.push("invoicing.ledger");
  }
  if (answers.includeComms) keys.push("comms.messaging");
  if (answers.includeComms && staffScreens) {
    keys.push("comms.console");
  }

  // EACH COMPANY RUNS THE FEATURES ITSELF (Tenancy 2a). Four keys, because a
  // consumer asking "does each company get its own schedule and ledger", "does
  // each company have public pages", "is it proved that one company can't
  // reach another's rows through the feature routes" and "do the crons serve
  // every company" is asking four questions with different answers: invoicing
  // alone has public pages and no cron; comms alone has a cron and no public
  // page.
  const fieldFeature =
    answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing || answers.includeComms;
  if (companies && fieldFeature) {
    keys.push("companies.feature-area", "companies.feature-isolation-proof");
  } else if (companies && (answers.includeFeedback || answers.includeSeoReports || answers.includeAeo || answers.includeBooking)) {
    // Tenancy 2b-2a: each company's feedback board is a feature route the
    // isolation proof drives, so a companies project with feedback alone has
    // the proof too.
    keys.push("companies.feature-isolation-proof");
  }
  if (companies && (answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing)) {
    keys.push("companies.public-pages");
  }
  if (companies && (answers.includeScheduling || answers.includeEstimator || answers.includeComms)) {
    keys.push("companies.crons");
  }
  if (answers.includeAeo) keys.push("aeo.citations");
  if (answers.includeAeo && answers.adminShell !== "none") {
    keys.push("aeo.dashboard");
  }
  // Tenancy 2b-4b: each company's own search check and AI mentions.
  if (answers.includeSeoReports && companies) keys.push("seo.search-check-companies");
  if (answers.includeAeo && companies) keys.push("aeo.companies");
  if (answers.includeAeo && answers.includeAi) keys.push("aeo.metered-checks");
  // Tenancy 2b-4c: book a call — a company's own, or the one business's.
  if (answers.includeBooking) keys.push(companies ? "booking.companies" : "booking.calls");
  // Getting paid, part 2: a store of its own — each company's, or the one business's.
  if (answers.includeStore) keys.push(companies ? "commerce.company-store" : "commerce.store");
  // The customer list (create-app 0.35) — each company's, or the one business's.
  if (answers.includeCustomers) keys.push(companies ? "customers.companies" : "customers.list");
  // Tenancy 2b-4a: counting visits (and leaving the business's own people out
  // of them), this site's own report under the shell, and each company's own.
  if (answers.includeAnalytics) keys.push("analytics.visits", "analytics.audience");
  if (answers.includeAnalytics && answers.adminShell !== "none") keys.push("analytics.dashboard");
  if (answers.includeAnalytics && companies) keys.push("analytics.companies");
  // Search basics through @adminigloo/seo, and each company's public pages in search.
  if (answers.includeSeo) keys.push("seo.package");
  if (answers.includeSeo && companies) keys.push("seo.companies");

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

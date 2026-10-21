import { resolve } from "node:path";
import {
  ADMIN_SHELLS,
  AUDIENCES,
  BUSINESS_MODELS,
  DEFAULT_ANSWERS,
  TENANT_NOUNS,
  assertAnswersCompatible,
  customersByDefault,
  packagesFor,
  requiredEnvFor,
  deferredUntilDeployedFor,
  tenantLabelPlural,
  validateProjectName,
  type AdminShell,
  type Answers,
  type Audience,
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
  /** Who signs up with --tenant-noun none (billing 0.5): business (default) or consumers. */
  readonly audience?: Audience;
  readonly businessModel?: BusinessModel;
  readonly adminShell?: AdminShell;
  readonly ai?: boolean;
  readonly email?: boolean;
  readonly feedback?: boolean;
  readonly seoReports?: boolean;
  readonly notifications?: boolean;
  readonly storage?: boolean;
  readonly assistant?: boolean;
  readonly marketing?: boolean;
  readonly estimator?: boolean;
  readonly scheduling?: boolean;
  readonly invoicing?: boolean;
  readonly comms?: boolean;
  readonly aeo?: boolean;
  readonly analytics?: boolean;
  readonly seo?: boolean;
  readonly booking?: boolean;
  readonly store?: boolean;
  readonly customers?: boolean;
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
  let audience: Audience | undefined;
  let businessModel: BusinessModel | undefined;
  let adminShell: AdminShell | undefined;
  let ai: boolean | undefined;
  let email: boolean | undefined;
  let feedback: boolean | undefined;
  let seoReports: boolean | undefined;
  let notifications: boolean | undefined;
  let storage: boolean | undefined;
  let assistant: boolean | undefined;
  let marketing: boolean | undefined;
  let estimator: boolean | undefined;
  let scheduling: boolean | undefined;
  let invoicing: boolean | undefined;
  let comms: boolean | undefined;
  let aeo: boolean | undefined;
  let analytics: boolean | undefined;
  let seo: boolean | undefined;
  let booking: boolean | undefined;
  let store: boolean | undefined;
  let customers: boolean | undefined;

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
    else if (arg === "--feedback") feedback = true;
    else if (arg === "--no-feedback") feedback = false;
    else if (arg === "--seo-reports") seoReports = true;
    else if (arg === "--no-seo-reports") seoReports = false;
    else if (arg === "--notifications") notifications = true;
    else if (arg === "--no-notifications") notifications = false;
    else if (arg === "--storage") storage = true;
    else if (arg === "--no-storage") storage = false;
    else if (arg === "--assistant") assistant = true;
    else if (arg === "--no-assistant") assistant = false;
    else if (arg === "--marketing") marketing = true;
    else if (arg === "--no-marketing") marketing = false;
    else if (arg === "--estimator") estimator = true;
    else if (arg === "--no-estimator") estimator = false;
    else if (arg === "--scheduling") scheduling = true;
    else if (arg === "--no-scheduling") scheduling = false;
    else if (arg === "--invoicing") invoicing = true;
    else if (arg === "--no-invoicing") invoicing = false;
    else if (arg === "--comms") comms = true;
    else if (arg === "--no-comms") comms = false;
    else if (arg === "--booking") booking = true;
    else if (arg === "--no-booking") booking = false;
    else if (arg === "--store") store = true;
    else if (arg === "--no-store") store = false;
    else if (arg === "--customers") customers = true;
    else if (arg === "--no-customers") customers = false;
    else if (arg === "--aeo") aeo = true;
    else if (arg === "--no-aeo") aeo = false;
    else if (arg === "--analytics") analytics = true;
    else if (arg === "--no-analytics") analytics = false;
    else if (arg === "--seo") seo = true;
    else if (arg === "--no-seo") seo = false;
    else if (arg === "--dir" || arg.startsWith("--dir=")) {
      dir = readValue(arg, "--dir", i);
    } else if (arg === "--tenant-noun" || arg.startsWith("--tenant-noun=")) {
      const v = readValue(arg, "--tenant-noun", i);
      if (v !== undefined) tenantNoun = oneOf("tenant-noun", v, TENANT_NOUNS);
    } else if (arg === "--audience" || arg.startsWith("--audience=")) {
      const v = readValue(arg, "--audience", i);
      if (v !== undefined) audience = oneOf("audience", v, AUDIENCES);
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
        previous === "--audience" ||
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
    audience,
    businessModel,
    adminShell,
    ai,
    email,
    feedback,
    seoReports,
    notifications,
    storage,
    assistant,
    marketing,
    estimator,
    scheduling,
    invoicing,
    comms,
    aeo,
    analytics,
    seo,
    booking,
    store,
    customers,
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
  --audience <a>       business | consumers. Who signs up when there are no
                       companies (--tenant-noun none). business (the default):
                       one business's staff, working at /admin. consumers:
                       people sign up as themselves and are the customers —
                       with --model subscription each person pays for their own
                       plans (one card, one bill, several product lines), there
                       is no team page and no one can invite anyone in, and you
                       see who pays for what at /admin/billing/subscribers.
  --model <m>          none | one-time | subscription | both
  --admin <a>          none | minimal | full
  --ai / --no-ai       Include streaming route conventions.
  --email / --no-email Include transactional email.
  --feedback           In-app feedback: the end-user widget, the key-authenticated
    / --no-feedback    intake API, this site's own Kanban board (under /admin with
                       an admin shell) and, in a project with companies, each
                       company's own board and feedback page. Off by default:
                       the widget does not mount until its key is issued.
  --seo-reports        Search check: how Google, Bing and AI assistants read the
    / --no-seo-reports site's pages, as a list of things to fix, every check
                       kept. With companies, each company checks its own pages
                       and websites at /app/website; this site's own is at
                       /admin/seo. Only its own addresses are ever fetched.
  --notifications      Alerts: a bell in the header, an alerts page, and Alert
    / --no-notifications
                       settings, where each person picks "in the app" or "in
                       the app and by email" and the owner picks who hears
                       about new work. Every installed feature raises its own
                       alerts (new requests and leads, quotes, invoices, emails
                       that didn't go, the team), each company's its own.
  --storage            Photos and files, kept private: on visits, estimates and
    / --no-storage     invoices, a Files screen with each company's storage
                       allowance, and the company logo. Needs a second, private
                       Vercel Blob store when deployed (DEPLOYMENT.md).
  --assistant          The AI assistant's editable brain: a personality stored
    / --no-assistant   as versioned, revertible rows an admin edits without a
                       deploy, plus the assemblePrompt function your AI route
                       calls. The editor rides the admin shell.
  --marketing          Landing page, pricing page and legal routes, as source.
    / --no-marketing   Off by default: every string on a landing page is a claim
                       only the client can make. Privacy and terms are generated
                       for any project that takes money either way, because
                       Stripe will not activate an account without them.
  --estimator          Field service — estimator: instant prices from your own
    / --no-estimator   supplies, photo estimates, quotes customers accept online,
                       follow-ups. A public /estimate page, an embed for your
                       other website, the leads queue, the estimate editor and
                       the price book. Needs an admin panel. Brings --comms,
                       --storage and --email with it (the lead and quote emails,
                       the customer's photo kept with the estimate) unless you
                       say --no-comms, --no-storage or --no-email. With --ai a
                       photo's steps are counted by Claude Haiku; without it the
                       customer counts them.
  --scheduling         Field service: a booking page for customers,
    / --no-scheduling  manage-your-visit links, a staff calendar with
                       drag-to-move, today's route for crews, and settings in
                       the business's own time zone. Needs an admin panel
                       (--admin minimal or full). Brings --comms and --email
                       with it — the confirmations, reminders and expiry
                       notices are emails — unless you say --no-comms or
                       --no-email. Google drive times with GOOGLE_MAPS_API_KEY.
  --invoicing          Field service: invoices with a public pay-by-token page
    / --no-invoicing   customers view without an account, and a staff ledger.
  --comms              Field service: templated email/SMS with a scheduler and a
    / --no-comms       cron drain. Senders are injected — no provider, clean skip.
  --booking            Book a call: a booking page where customers pick a time
    / --no-booking     for a call, a private link to move or cancel it, and the
                       calls, hours, time off and call types behind it. With
                       companies, each company's own at /app/calls and
                       /t/{web address}/book; one business, /admin/calls and /book.
  --store              A store of its own: products with photos, prices and stock,
    / --no-store       a cart, Stripe checkout and an orders list. With companies,
                       each company sells at /t/{web address}/store into its own
                       Stripe account (/app/store); one business, /store and
                       /admin/store (needs --admin minimal or full).
  --customers          One customer list: each customer once, with every quote,
    / --no-customers   visit, invoice, call, order and message of theirs on one
                       timeline; search, merge, CSV import and export. On by
                       default with any field feature. With companies, each
                       company's at /app/customers; one business, /admin/customers.
  --aeo                AI mentions: do AI assistants name you when customers ask
    / --no-aeo         them questions — the quote, the sources, the competitors,
                       the trend. With companies, each company's own at
                       /app/website. With --ai, asked of Claude Haiku 4.5 with
                       web search, metered against each month's AI.
  --analytics          Website visits, cookieless: where visitors came from
    / --no-analytics   (search, AI assistants by name, other sites), the pages
                       they read and the AI crawlers that read them, with the
                       business's own people left out. With companies, each
                       company counts its pages here and its own website (one
                       line to paste) at /app/website; this site's own numbers
                       are at /admin/analytics.
  --seo / --no-seo     Search basics from @adminigloo/seo: titles with the brand
                       once, canonical addresses, robots.txt naming the AI
                       crawlers, a sitemap. With companies, each company's
                       public pages get their own title, address and business
                       details and join the sitemap; token pages stay out.

  With a --tenant-noun (companies), the estimator, scheduling, invoicing and
  messages are EACH COMPANY'S: its own screens at /app, its own public pages
  at /t/{web address}, emails under its own name, crons that serve every
  company. With --tenant-noun none they run for your one business at /admin
  (with --audience consumers too: the people who sign up are its customers).
  --help, -h           Show this.

  Any flag given is used verbatim; only the rest are prompted for.

  To turn a feature on in a project you already generated:

    pnpm dlx @adminigloo/create-app add <feature> [--dir <path>]

  See \`add --help\`. It wires the feature in the way generating with it would
  have, and never overwrites a file you have edited.

  To bring a project an earlier create-app made up to this version (its
  packages, its files, and a list of exactly what's left for you to merge):

    pnpm dlx @adminigloo/create-app upgrade [--dir <path>]

  See \`upgrade --help\`.
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
        label: "None — one business",
        hint: "staff, or customers signing up as themselves; each person gets an invisible workspace",
      },
    ],
    DEFAULT_ANSWERS.tenantNoun,
  ));

  // WHO SIGNS UP (billing 0.5), asked only where it means something: with no
  // companies. A companies project's people always sign up into a company.
  const audience: Audience =
    tenantNoun !== "none"
      ? (flags.audience ?? DEFAULT_ANSWERS.audience)
      : (flags.audience ??
        (await prompter.select<Audience>(
          "Who signs up?",
          [
            { value: "business", label: "Our own staff", hint: "one business, worked at /admin" },
            {
              value: "consumers",
              label: "Our customers, as themselves",
              hint: "each person pays for their own plans; no teams, no sharing",
            },
          ],
          DEFAULT_ANSWERS.audience,
        )));

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
  const includeFeedback =
    flags.feedback ??
    (await prompter.confirm(
      "In-app feedback? Widget, intake API, and a staff ticket board.",
      DEFAULT_ANSWERS.includeFeedback,
    ));

  const includeSeoReports =
    flags.seoReports ??
    (await prompter.confirm(
      "Search check? How search engines and AI assistants read the site, as a list of things to fix.",
      DEFAULT_ANSWERS.includeSeoReports,
    ));
  const includeNotifications =
    flags.notifications ??
    (await prompter.confirm(
      "Alerts? A bell in the header, an alerts page, and each person's choice of in the app or by email.",
      DEFAULT_ANSWERS.includeNotifications,
    ));
  const includeStorage =
    flags.storage ??
    (await prompter.confirm(
      "Photos and files? Kept private, on visits, estimates and invoices, with a Files screen.",
      DEFAULT_ANSWERS.includeStorage,
    ));
  const includeAssistant =
    flags.assistant ??
    (await prompter.confirm(
      "AI assistant brain? An editable, versioned personality your AI route assembles its prompt from.",
      DEFAULT_ANSWERS.includeAssistant,
    ));

  const includeMarketing =
    flags.marketing ??
    (await prompter.confirm(
      "Public marketing site? Landing page, pricing and legal, copied as source.",
      DEFAULT_ANSWERS.includeMarketing,
    ));

  // With companies, the field-service features run for the PLATFORM owner in
  // this release (review R2 TB2-06): said when the question is asked, not
  // only afterwards.
  const forPlatform =
    tenantNoun !== "none"
      ? ` (With ${tenantLabelPlural({ ...DEFAULT_ANSWERS, tenantNoun }).toLowerCase()}, this release runs it for your own business, not for each ${tenantNoun.toLowerCase()}: that comes in Tenancy 2.)`
      : "";
  const includeEstimator =
    flags.estimator ??
    (await prompter.confirm(
      `Field service — estimator: instant prices from your own supplies, photo estimates, quotes customers accept online, follow-ups.${forPlatform}`,
      DEFAULT_ANSWERS.includeEstimator,
    ));
  // The estimator keeps each customer's photo with their estimate, so the
  // business sees the steps before anybody drives out — and the bytes go to
  // the file store. Storage was asked before the estimator was, so with the
  // estimator on and storage left to a default it is asked again, defaulting
  // to yes. Only an explicit --no-storage keeps it off (photos are then read
  // and thrown away, and the admin says so).
  const includeStorageForEstimator =
    includeEstimator && !includeStorage && flags.storage === undefined
      ? await prompter.confirm(
          "The estimator keeps each customer's photo with their estimate. Include file storage?",
          true,
        )
      : includeStorage;
  const includeScheduling =
    flags.scheduling ??
    (await prompter.confirm(
      `Field service — scheduling? A booking page, manage-your-visit links, a staff calendar with drag-to-move and today's route for crews.${forPlatform}`,
      DEFAULT_ANSWERS.includeScheduling,
    ));
  // Scheduling's whole customer side is email — the acknowledgement, the
  // confirmation with the manage link, the reminder, the expiry notice — and
  // so is the estimator's: the new-lead alert, the customer's copy, the quote
  // link, the follow-up. Email was asked before either was, so with one of
  // them on and email left to a default, it is asked again, defaulting to
  // yes. Only an explicit --no-email keeps it off.
  const includeEmailForFieldService =
    (includeScheduling || includeEstimator) && !includeEmail && flags.email === undefined
      ? await prompter.confirm(
          includeScheduling
            ? "Scheduling emails customers their confirmations and reminders. Include transactional email?"
            : "The estimator emails new leads to you and quotes to your customers. Include transactional email?",
          true,
        )
      : includeEmail;
  const includeInvoicing =
    flags.invoicing ??
    (await prompter.confirm(
      `Field service — invoicing? Invoices with a public pay-by-token page and a staff ledger.${forPlatform}`,
      DEFAULT_ANSWERS.includeInvoicing,
    ));
  const includeComms =
    flags.comms ??
    (await prompter.confirm(
      "Field service — comms? Templated email/SMS with a scheduler and a cron drain.",
      // Scheduling and the estimator send their emails through comms, so with
      // either it defaults to yes; --no-comms still says no.
      includeScheduling || includeEstimator ? true : DEFAULT_ANSWERS.includeComms,
    ));
  const includeAeo =
    flags.aeo ??
    (await prompter.confirm(
      "AI mentions? Whether AI assistants name you when customers ask them questions.",
      DEFAULT_ANSWERS.includeAeo,
    ));

  const includeAnalytics =
    flags.analytics ??
    (await prompter.confirm(
      tenantNoun !== "none"
        ? "Website visits? Each company sees who visits its pages and its own website — from search, AI assistants and other sites — with its own people left out."
        : "Website visits? Who visits your site — from search, AI assistants and other sites — with your own people left out.",
      DEFAULT_ANSWERS.includeAnalytics,
    ));
  const includeSeo =
    flags.seo ??
    (await prompter.confirm(
      tenantNoun !== "none"
        ? "Search basics? Titles, addresses and business details search engines and AI assistants read — for this site and each company's public pages."
        : "Search basics? Titles, addresses and business details search engines and AI assistants read.",
      DEFAULT_ANSWERS.includeSeo,
    ));
  const includeBooking =
    flags.booking ??
    (await prompter.confirm(
      tenantNoun !== "none"
        ? "Book a call? Each company gets a booking page where customers pick a time to talk, with its calls and hours on its own screen."
        : "Book a call? A booking page where customers pick a time to talk, with the calls and hours under /admin.",
      DEFAULT_ANSWERS.includeBooking,
    ));
  const includeStore =
    flags.store ??
    (await prompter.confirm(
      tenantNoun !== "none"
        ? "A store? Each company sells its own products online — photos, prices, stock — paid into its own Stripe account, with its orders on its own screen."
        : "A store? Sell your own products online — photos, prices, stock — paid into your own Stripe account, with the orders under /admin.",
      DEFAULT_ANSWERS.includeStore,
    ));

  // The customer list (create-app 0.35): on whenever a field feature is, unless --no-customers.
  const includeCustomers =
    flags.customers ??
    customersByDefault({ tenantNoun, adminShell, includeEstimator, includeScheduling, includeInvoicing, includeBooking, includeStore, includeComms });

  const answers: Answers = {
    projectName,
    tenantNoun,
    audience,
    businessModel,
    adminShell,
    includeAi,
    includeEmail: includeEmailForFieldService,
    includeFeedback,
    includeSeoReports,
    includeNotifications,
    includeStorage: includeStorageForEstimator,
    includeAssistant,
    includeMarketing,
    includeEstimator,
    includeScheduling,
    includeInvoicing,
    includeComms,
    includeAeo,
    includeAnalytics,
    includeSeo,
    includeBooking,
    includeStore,
    includeCustomers,
    scope: DEFAULT_ANSWERS.scope,
  };
  // Refused here, before a directory is created, with the reason.
  assertAnswersCompatible(answers);
  return answers;
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
    // NOT `cp .env.example .env.local` (TB-DEPLOY-14): .env.local was just
    // written, commented and ready to run, and copying the example over it
    // threw that away — along with the localhost app URL.
    "  .env.local is already there and the app runs as is; fill in what you",
    "  need as you go (/setup lists what is set and what each missing key",
    "  switches off).",
    "",
    "  Before pnpm install: export GITHUB_TOKEN, a CLASSIC personal access token",
    "  with read:packages from a GitHub account that has access to the",
    "  @adminigloo packages (README.md, \"Private packages\"); .npmrc reads it.",
    "  pnpm install",
    "  pnpm dev",
    "",
    // The database steps need a database (review R2 TB2-04): .env.local
    // starts without one, and migrate and seed fail on an empty URL.
    "Then put your Neon staging DATABASE_URL and DATABASE_URL_UNPOOLED, and",
    "Clerk's development keys, in .env.local, and:",
    "  pnpm db:generate && pnpm db:migrate",
    "  pnpm db:seed",
    "",
    // What really happens locally (review R2 T1BO-11): the first sign-in is
    // made administrator at once, and staff with no company land in /admin.
    "Sign in. On your laptop the first person to sign in becomes the",
    "administrator straight away and lands in /admin; on a deployment it's",
    "BOOTSTRAP_ADMIN_EMAIL (DEPLOYMENT.md).",
    "",
    // SPLIT, and pulled from the env module's own deferred list so it can't
    // drift: what stops a DEPLOYMENT from starting, and what only switches a
    // feature off. "The app will not boot until these are set" was wrong on a
    // laptop for every one of them.
    "A deployment refuses to start without:",
    ...deferredUntilDeployedFor(answers).map((v) => `  ${v}`),
    "",
    "Each of these switches its feature on (it stays off, and says so, until set):",
    ...requiredEnvFor(answers)
      .filter((v) => !deferredUntilDeployedFor(answers).includes(v))
      .map((v) => `  ${v}`),
    "",
    "Deploying: DEPLOYMENT.md walks through Clerk's production instance and its",
    "webhook, the database, NEXT_PUBLIC_APP_URL, and the first administrator.",
    "",
  ];

  if (answers.tenantNoun !== "none") {
    const noun = answers.tenantNoun.toLowerCase();
    lines.push(
      // What a business owner can do on day one, and — said plainly, because a
      // developer telling an owner "companies work" must not overstate it
      // (review T1-10) — what this release does not do yet.
      `${tenantLabelPlural(answers)}:`,
      `  A new owner signs up, names their ${noun} at /onboarding, and invites`,
      `  their team at /settings/team (owner, admin, member or viewer).`,
      ...(answers.adminShell !== "none"
        ? [`  Every ${noun} is at /admin/companies: suspend, reactivate, new owner.`]
        : []),
      // Tenancy 2a, said where it's read (review R2 TB2-06): WHO the field
      // features are for. Each company runs them itself — its own screens
      // under /app, its own public pages under /t/{web address}.
      ...(answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing || answers.includeComms
        ? [
            `  Each ${noun} runs its own ${[
              ...(answers.includeScheduling ? ["schedule"] : []),
              ...(answers.includeEstimator ? ["estimates"] : []),
              ...(answers.includeInvoicing ? ["invoices"] : []),
              ...(answers.includeComms ? ["messages"] : []),
            ].join(", ")} at /app, with its own`,
            `  public pages at /t/{its web address} and emails under its own name.`,
          ]
        : []),
      `  Set SUPPORT_EMAIL so a suspended ${noun} knows where to write.`,
      "",
    );
    if (!answers.includeEmail) {
      lines.push(
        // TB-DEPLOY-07: without mail, every invitation is a link the inviter
        // copies. The team page handles that well; nothing else would say so.
        "Invitations are copy-a-link until email is added (they need a sending",
        "domain you've verified in Resend):",
        "  pnpm dlx @adminigloo/create-app add email",
        "",
      );
    }
  } else {
    lines.push(
      "Single business: everyone who signs up gets their own workspace, and",
      "you invite your staff from /settings/team.",
      "",
    );
  }

  if (answers.includeComms) {
    lines.push(
      // CA-11: the queue drains from a cron, and the cron refuses everyone
      // until the secret is set — so without this line scheduled messages sit
      // there and nothing anywhere says why.
      "Scheduled messages need CRON_SECRET in Vercel; until then",
      "/api/cron/comms answers 401.",
      "",
    );
  }

  if (answers.includeFeedback) {
    lines.push(
      // The one feature here that is dark until a key exists, and the command
      // that turns it on. The widget mount is a configuration check, so
      // nothing anywhere errors while the key is absent — which means nothing
      // anywhere would ever have told you this command exists.
      "This site's own feedback button mounts once its key exists. With",
      "DATABASE_URL set and migrations run:",
      "",
      "  pnpm feedback:issue-key",
      "",
      "It prints the key once; put it in ADMINIGLOO_FEEDBACK_KEY in .env.local.",
      "Screenshot uploads also want BLOB_READ_WRITE_TOKEN — without it, reports",
      "still arrive, just without images.",
      "",
    );
  }

  if (answers.includeSeoReports && answers.adminShell !== "none") {
    lines.push(
      // The one feature that works on first boot with no credential at all,
      // and the button that proves it.
      "Run your first search check from /admin/seo once the app is deployed — it",
      "reads this site's own public pages (never localhost), so there is nothing to configure.",
      "",
    );
  }

  if (answers.includeNotifications) {
    // Tenancy 2b-1: every installed feature's alerts are wired by the
    // generator (no longer "producers are yours to wire"), so what is left
    // to say is where the choices live and what makes the emails go. The
    // settings page is the company's own in a companies project, the admin
    // panel's in a single business, and absent with no panel (13.4).
    const companies = answers.tenantNoun !== "none";
    const settingsPage = companies
      ? "/app/alerts/settings"
      : answers.adminShell !== "none"
        ? "/admin/alerts/settings"
        : null;
    lines.push(
      "Alerts are on: every feature you installed raises its own (new",
      `requests and leads, quote answers, invoices, emails that didn't go${companies ? ", the team" : ""}),`,
      "in the bell in the header.",
      ...(settingsPage
        ? [
            `At ${settingsPage} each person picks "In the app" or "In the app and`,
            'by email", and the owner picks who hears about new work.',
          ]
        : ["Staff get the bell; Alert settings come with the admin panel (--admin)."]),
      ...(answers.includeComms && answers.includeEmail
        ? [
            "Alert emails go out once RESEND_API_KEY is set. Set CRON_SECRET too:",
            "/api/cron/alerts retries an alert email that didn't go and clears old",
            "read alerts.",
          ]
        : [
            "Alerts stay in the app: their email copies come with --comms and --email.",
            "Set CRON_SECRET so /api/cron/alerts clears old read alerts.",
          ]),
      "",
    );
  }

  if (answers.includeStorage) {
    // Tenancy 2b-1: files are private, kept on this computer while
    // developing (review BO-08) and in a SECOND, private Blob store once
    // deployed (13.7, 13.9). The public store (BLOB_READ_WRITE_TOKEN) keeps
    // only a company's logo — and feedback screenshots, which feedback's own
    // block above names.
    lines.push(
      "Photos and files are kept private. While you develop (pnpm dev) they're",
      "kept on this computer, in .data/files. Deployed, they need a second",
      "Vercel Blob store with access Private, connected with the prefix",
      answers.tenantNoun !== "none"
        ? "BLOB_PRIVATE (the store behind BLOB_READ_WRITE_TOKEN keeps company logos)."
        : "BLOB_PRIVATE.",
      "DEPLOYMENT.md has the steps; until then the screens say files can't be added.",
      "",
    );
  }

  // A companies project's features are each company's own: its screens under
  // /app, its public pages under /t/{web address} (Tenancy 2a). The /admin
  // paths below are a single business's, and a companies project has none of
  // them, so its steps name the company's own pages.
  const companies = answers.tenantNoun !== "none";

  if (answers.includeScheduling) {
    const emails = answers.includeComms && answers.includeEmail;
    lines.push(
      // Where the feature is, and the things that make it a business's rather
      // than a demo. The terminal right after generating is the only
      // documentation that reliably gets read. Only pages this project has:
      // scheduling is refused without an admin panel (assertAnswersCompatible).
      ...(companies
        ? [
            `Scheduling (each ${answers.tenantNoun.toLowerCase()} runs its own):`,
            "  1. Online booking starts OFF. The owner opens Schedule settings",
            "     (/app/schedule/settings), sets the services, crews and hours, then",
            "     switches on \"Take bookings online\". The name, time zone and phone",
            "     come from /settings/company. Customers book at",
            "     /t/{its web address}/book-visit.",
            "  2. Its people answer requests and run the week at /app/schedule.",
            "  3. Crews: the owner invites each crew member at /settings/team with",
            "     the Crew role, then picks them for their crew in Schedule settings",
            "     → Crews. That gives them Today's route (/app/schedule/today) on",
            "     their phone — their own stops, nothing else. No developer, no",
            "     database.",
          ]
        : [
            "Scheduling:",
            "  1. Online booking starts OFF. Open /admin/schedule/settings, set the",
            "     business name, time zone, phone, services, crews and hours, then",
            "     switch on \"Take bookings online\". Customers book at /book-visit.",
            "  2. Staff answer requests and run the week at /admin/schedule.",
            "  3. Crews: each crew member signs in once at /sign-in; then pick them",
            "     for their crew in Schedule settings → Crews. That gives them",
            "     Today's route (/admin/schedule/today) on their phone — their own",
            "     stops, nothing else. No developer, no database.",
          ]),
      ...(emails
        ? [
            "  4. Set CRON_SECRET on the deployment: reminders and expiry notices",
            "     go out from a daily job that won't run without it. On Vercel Hobby",
            "     it runs once a day (7 AM Mountain), so each reminder arrives the",
            "     day before the visit — at least the lead time ahead, often more.",
            "     For reminders at exactly the lead time, run /api/cron/comms every",
            "     15 minutes (DEPLOYMENT.md).",
          ]
        : []),
      "Set GOOGLE_MAPS_API_KEY for real drive times (straight-line estimates",
      "without it).",
      "",
    );
    if (!emails) {
      lines.push(
        // Said plainly, because the business scenario is mostly emails and
        // nothing else in the project will mention that none are going out.
        "This project sends no visit emails: scheduling emails need both",
        "--comms and --email. Customers keep the manage link the booking page",
        "shows them. To add them later:",
        "",
        ...(answers.includeComms ? [] : ["  pnpm dlx @adminigloo/create-app add comms"]),
        ...(answers.includeEmail ? [] : ["  pnpm dlx @adminigloo/create-app add email"]),
        "",
      );
    }
  }

  if (answers.includeEstimator) {
    const emails = answers.includeComms && answers.includeEmail;
    lines.push(
      // The estimator's first afternoon, in the order an owner does it. Only
      // pages this project has: the estimator is refused without an admin
      // panel (assertAnswersCompatible), and /book-visit and the invoice step
      // are named only when scheduling and invoicing were installed with it.
      ...(companies
        ? [
            `Estimator (each ${answers.tenantNoun.toLowerCase()} runs its own):`,
            "  1. The owner saves the sales tax and labor rate in Estimate settings",
            "     (/app/estimates/settings); the name comes from /settings/company.",
            "     Until then its estimate page is closed and no quote can be sent.",
            "  2. It builds its price book at /app/price-book: its products, priced",
            "     from its own supplies, labor and markup — or \"Load a sample",
            "     catalog\" to start from an example. A product stays off the",
            "     estimate page until it's turned on; nothing is added for it.",
            "  3. Customers get a price at /t/{its web address}/estimate. Each one",
            "     they save is a lead in /app/estimates: edit it, then send the",
            "     quote. They accept it on the page the email links to.",
            ...(answers.includeScheduling
              ? [`     An accepted quote books the visit on the ${answers.tenantNoun.toLowerCase()}'s booking page in one click.`]
              : []),
          ]
        : [
            "Estimator:",
            "  1. Save your business name, sales tax and labor rate at",
            "     /admin/estimator/settings. Until you do, /estimate is closed and no",
            "     quote can be sent.",
            "  2. Build your price book at /admin/estimator: your products, priced",
            "     from your own supplies, labor and markup — or \"Load a sample",
            "     catalog\" to start from an example. A product stays off /estimate",
            "     until you turn it on; nothing is added for you.",
            "  3. Customers get a price at /estimate. Each one they save is a lead in",
            "     /admin/estimates: edit it, then send the quote. They accept it on",
            "     the page the email links to.",
            ...(answers.includeScheduling
              ? ["     An accepted quote books the visit at /book-visit in one click."]
              : []),
          ]),
      ...(answers.includeInvoicing
        ? ["     An accepted quote becomes an invoice in one click."]
        : []),
      ...(emails
        ? [
            "  4. Set CRON_SECRET on the deployment: the follow-up on an unanswered",
            "     quote and the note when one expires go out from daily jobs that",
            "     won't run without it.",
          ]
        : []),
      ...(answers.includeStorage
        ? [
            // Tenancy 2b-1 (contract 10.5): the estimator's photos are on the
            // PRIVATE files store now, not the public Blob store.
            "Customers' photos are kept privately with their estimate: on this",
            "computer while you develop, in the private Blob store once deployed.",
          ]
        : [
            "Customers' photos are not kept: this project has no file storage.",
            "  pnpm dlx @adminigloo/create-app add storage",
          ]),
      ...(answers.includeAi
        ? [
            "A photo's steps are counted by Claude Haiku 4.5 once ANTHROPIC_API_KEY",
            "is set: a fraction of a cent a photo, capped by the daily budget in",
            "Estimate settings. Customers can always count them instead.",
          ]
        : [
            "Photo reading is off: this project was generated without --ai, so",
            "customers count the steps themselves. To have photos read:",
            "  pnpm dlx @adminigloo/create-app add ai",
          ]),
      "",
    );
    if (!emails) {
      lines.push(
        // Said plainly: a lead nobody is told about is a lead found days late.
        "This project sends no estimate emails: they need both --comms and",
        `--email. New leads wait in ${companies ? "/app/estimates" : "/admin/estimates"}, and you copy the quote`,
        "link to the customer yourself. To add them later:",
        "",
        ...(answers.includeComms ? [] : ["  pnpm dlx @adminigloo/create-app add comms"]),
        ...(answers.includeEmail ? [] : ["  pnpm dlx @adminigloo/create-app add email"]),
        "",
      );
    }
  }

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

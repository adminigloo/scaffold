/**
 * The generated project's README.md (CA-10).
 *
 * The first file a buyer — or the developer a business owner hired — opens.
 * Rendered from the MANIFEST, like SCAFFOLD.md, so it can't say anything the
 * manifest doesn't: what this project is, the quick start (the same steps the
 * CLI printed), first run and recovery, what the companies or single-business
 * mode does and plainly does NOT do yet, and the installed packages.
 */

import { tenantLabel, tenantLabelPlural } from "./answers.js";
import type { ProjectManifest } from "./manifest.js";

/**
 * Tenancy 1's "Not included" items (contract 14.2) that are STILL true after
 * Tenancy 2a, word for word. The ones 2a delivered (feature routes pinned to
 * the fixed business, public company pages) or restated in its own list
 * (plans and billing, impersonation, custom roles, custom domains) are gone
 * from here — a README must never say a thing doesn't work once it does.
 */
export const TENANCY_1_NOT_INCLUDED: readonly string[] = [
  "Company deletion, data export, operator notes, and comping a plan.",
  "Suspending a single member. You remove them instead. The `suspended` member status exists only for closed accounts.",
  "Moving billing ownership in Stripe when ownership is transferred.",
  "Emails to removed members or to a new owner. `onEvent` is the seam.",
  "Converting a legacy personal workspace into a company. In companies mode, personal workspaces are ignored.",
  "Identity providers other than Clerk.",
  "Table prefixes, or a dedicated Postgres schema.",
];

/**
 * Tenancy 2a's "Not included" list (contract 15.2), word for word — the same
 * list every README that 2a touched carries.
 */
export const TENANCY_2A_NOT_INCLUDED: readonly string[] = [
  "**Per-company boards and widgets for feedback, notifications, files, the assistant, analytics, SEO/AEO and book-a-call (booking)** — Tenancy 2b.",
  "**Payments to companies** (Stripe Connect: a customer paying a company's invoice by card). Invoices are paid however the payment instructions say; staff record the payment.",
  "**Plans, limits and billing enforcement** per company.",
  "**Custom domains and subdomains.** Public pages live at `/t/{web-address}`.",
  "**Impersonation** (\"view as this company\") from the operator console, and platform-wide feature reports (all companies' visits, estimates, invoices) in `/admin`.",
  "**Search indexing of company pages**, and per-company SEO.",
  "**Logo and colour inside emails.** Emails carry the company's name and reply-to; their bodies are plain text.",
  "**Emailing customers about a time-zone correction** made in company settings. Visits keep their clock times and reminders are re-queued silently.",
  "**A scheduling embed** (a script for the company's own website). The booking page's address is shown to copy. The estimator gives each company a button and a page frame for its website; its keyed React component needs a React site and access to the private package registry.",
  "**Payment instructions and per-feature identity in single-business mode.** A single business's invoices carry the name, contact and time zone saved in its Schedule or Estimate settings (else the site's name); how customers pay is left blank.",
  "**Per-company custom roles and per-person permission changes.** Crew is a fixed role scheduling adds.",
  "**Moving a pre-2a companies project's feature rows** (written under the fixed `\"primary\"` business) into a company. The emitted README gives the SQL for one company; nothing does it automatically.",
  // Added by the Tenancy 2a review (SEC-2A-03, T2A-BO-14): what the platform
  // still does NOT do about companies' email and suspended companies.
  "**Sending from a company's own domain.** Every company's email leaves from this site's one verified domain, under the company's name, held to a sending allowance (100 an hour and 500 a day; 20 and 100 in its first week).",
  "**Rules on what a company may call itself.** Nothing stops a company naming itself after another business; suspend it from the operator console.",
  "**A suspended company's customer links.** While a company is suspended, all of its public pages, its customers' invoice, quote and visit links included, say it isn't taking requests online and how to reach it.",
];

/**
 * Tenancy 2b-1's "Not included" list (contract 17.2), word for word — the same
 * list every README that 2b-1 touched carries.
 */
export const TENANCY_2B1_NOT_INCLUDED: readonly string[] = [
  "**Epics on the feedback board** (grouping tickets under a bigger piece of work) — its next release. Its filters, search, New ticket, editing and settings screens are here (feedback 0.11), and so are the board per company, its alerts and its private screenshots (Tenancy 2b-2a).",
  "**The AI assistant per company** — Tenancy 2b-3.",
  "**Website analytics, SEO/AEO and book-a-call (booking) per company** — Tenancy 2b-4.",
  "**Text (SMS) and push alerts.** Alerts come in the app and by email — S9.",
  "**Plans, limits and billing enforcement** — the billing chunk. Each company's storage allowance is one setting for everyone (`FILES_ALLOWANCE_MB`) until then; the seam the billing chunk fills is there.",
  "**Stripe Connect** (customers paying a company by card).",
  "**Custom domains.**",
  "**Virus scanning of uploads.** Files are checked for their type and size only.",
  "**Uploads over 4 MB, and uploads straight from the browser to storage.** Phone photos are made smaller before they're sent; other files over 4 MB are refused with a plain sentence.",
  "**Serving files straight from S3 or R2 by presigned link.** Every private file is sent through the site's own route.",
  "**Thumbnails.** Photos are shown at their (shrunk) size.",
  "**Turning a kind of alert off.** Each kind comes in the app, or in the app and by email; who gets the work alerts is the owner's choice.",
  "**Alerts from your other companies in the bell.** The bell shows the company you're working in.",
  "**A daily or weekly digest of alerts.**",
  "**Customers seeing files** (photos on their quote or invoice page).",
  "**Editing the wording of the team alert email** beyond the Messages screen (it is the `team_alert` message there).",
  "**Carrying 2a's per-feature alert address lists over.** With alerts installed, the people (and extra addresses) are chosen again in Alert settings; the old lists are no longer read.",
  "**Alert settings in a single-business project without an admin shell.** Its staff get the bell; the office emails keep 2a's lists.",
  "**A transactional outbox.** Alerts are written right after the change they report (D8); the events package (S2) brings the outbox.",
  "**Crew alerts when the office moves, reassigns or cancels their visit.** Only a customer's change alerts the crew.",
  "**An alert when a customer opens a quote** (invoices only).",
  "**A history of cron runs, and an alert when a cron fails.**",
  "**Alerts for the platform owner** (a new company, a company out of storage). A company's storage refusal is reported in `/admin/errors` once a day.",
  "**Giving one company more storage than the others.** `FILES_ALLOWANCE_MB` is one number until the billing chunk.",
  "**Checking an address before it gets a company's alert emails.** The owner adds up to five per group; the company's team sending allowance bounds what they get.",
];

/**
 * 2a's items that 2b-1's list supersedes or restates, so a README never says
 * a thing twice — or says it doesn't work once it does: notifications and
 * files per company are delivered (the rest of that item is restated as
 * 2b-2, 2b-3 and 2b-4), and Stripe Connect, plans and custom domains are
 * restated word for word above.
 */
export const TENANCY_2A_SUPERSEDED: ReadonlySet<string> = new Set([
  TENANCY_2A_NOT_INCLUDED[0]!,
  TENANCY_2A_NOT_INCLUDED[1]!,
  TENANCY_2A_NOT_INCLUDED[2]!,
  TENANCY_2A_NOT_INCLUDED[3]!,
]);

/**
 * The items that are only about companies — a single-business project has no
 * company pages, no company roles and no company emails, so its README leaves
 * them out (review R2 TB2-07) instead of describing what it doesn't have.
 */
const COMPANIES_ONLY_ITEMS: ReadonlySet<string> = new Set([
  TENANCY_1_NOT_INCLUDED[4]!,
  TENANCY_2A_NOT_INCLUDED[0]!,
  TENANCY_2A_NOT_INCLUDED[1]!,
  TENANCY_2A_NOT_INCLUDED[2]!,
  TENANCY_2A_NOT_INCLUDED[3]!,
  TENANCY_2A_NOT_INCLUDED[4]!,
  TENANCY_2A_NOT_INCLUDED[5]!,
  TENANCY_2A_NOT_INCLUDED[7]!,
  TENANCY_2A_NOT_INCLUDED[10]!,
  TENANCY_2A_NOT_INCLUDED[11]!,
  TENANCY_2A_NOT_INCLUDED[12]!,
  TENANCY_2A_NOT_INCLUDED[13]!,
  TENANCY_2A_NOT_INCLUDED[14]!,
  // Tenancy 2b-1's items about companies: per-company boards, a company's
  // card payments and domain, the bell's other companies, one company's
  // storage.
  TENANCY_2B1_NOT_INCLUDED[0]!,
  TENANCY_2B1_NOT_INCLUDED[1]!,
  TENANCY_2B1_NOT_INCLUDED[2]!,
  TENANCY_2B1_NOT_INCLUDED[4]!,
  TENANCY_2B1_NOT_INCLUDED[5]!,
  TENANCY_2B1_NOT_INCLUDED[6]!,
  TENANCY_2B1_NOT_INCLUDED[12]!,
  TENANCY_2B1_NOT_INCLUDED[23]!,
]);

/** The items only a single-business project has (a companies project always has its alert settings). */
const SINGLE_ONLY_ITEMS: ReadonlySet<string> = new Set([TENANCY_2B1_NOT_INCLUDED[17]!]);

/**
 * The "Not included" list for this project's mode: 2b-1's list, 2a's still-true
 * items, then Tenancy 1's.
 */
export function notIncludedFor(companies: boolean): readonly string[] {
  const all = [
    ...TENANCY_2B1_NOT_INCLUDED,
    ...TENANCY_2A_NOT_INCLUDED.filter((item) => !TENANCY_2A_SUPERSEDED.has(item)),
    ...TENANCY_1_NOT_INCLUDED,
  ];
  return companies
    ? all.filter((item) => !SINGLE_ONLY_ITEMS.has(item))
    : all.filter((item) => !COMPANIES_ONLY_ITEMS.has(item));
}

/** What the feedback boards don't do yet (feedback 0.11): the next release's, said plainly. */
export const FEEDBACK_2B2A_NOT_INCLUDED: readonly string[] = [
  "**Epics** (grouping tickets under a bigger piece of work) — the next release of the feedback board.",
  "**Saved views per person** (filters are kept in the page's address and remembered per browser) and **custom fields** on a ticket.",
  "**Custom domains** for a feedback page.",
  "**Checking a reporter's email address.** The address someone types on a feedback form isn't confirmed; the team's answer goes to it as typed.",
  "**Answering while a business's plan has ended.** Its customers can still read and reply on their tickets; its team can't answer until it has a plan again.",
  "**\"My reports\" on another device.** A reporter follows their tickets on the device and the feedback page they sent them from.",
];

/**
 * The "Feedback" section (Tenancy 2b-2a): the boards this project has — each
 * company's own and this site's own, or the one board of a single business —
 * and what they don't do yet. Empty without feedback.
 */
export function feedbackSection(answers: ProjectManifest["answers"]): string[] {
  if (!answers.includeFeedback) return [];
  const companies = answers.tenantNoun !== "none";
  const shell = answers.adminShell !== "none";
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const lines: string[] = ["### Feedback", ""];
  if (companies) {
    lines.push(
      `- **Each ${noun}'s own board** (/app/feedback): what its customers send, as columns to drag between, with search and filters (status, priority, category, who it's assigned to, where it came from, when it was sent; Mine, Unassigned and Critical in one click), **New ticket** for the team (and a + on each column), a ticket's conversation, replies, editing (title, priority, category, assignee picked from the 's people) with its activity trail, and archive. Its columns, categories, feedback page address and website keys are at /app/feedback/settings (owners and admins change them; members answer and sort; viewers look; crew don't see it).`,
      `- **Its customers' feedback page** (/t/{web address}/feedback): they send feedback with their name and email, and follow their ticket under "My reports". A suspended ${noun}, or one whose plan ended, takes no new feedback and still lets them read and answer theirs.`,
      ...(answers.includeComms
        ? [`- **The reporter is emailed** when the team replies or moves their ticket, in the ${noun}'s name with its reply-to; the wording is in its Messages.`]
        : [`- This project was generated without messages (comms), so reporters aren't emailed: they read the team's answer under "My reports".`]),
      ...(answers.includeNotifications ? [`- **Alerts**: a new ticket and a customer's answer, to everyone who can see the board.`] : []),
      answers.includeStorage
        ? `- **Screenshots** from a ${noun}'s own website are kept privately, on their ticket, for the ${noun}'s people who can see the board. Its feedback page takes none.`
        : `- **Screenshots** from a ${noun}'s own website go to the public Blob store under addresses nobody can guess (this project has no private file storage, --storage). Its feedback page takes none.`,
    );
  }
  lines.push(
    shell
      ? `- **This site's own board** (/admin/feedback, settings at /admin/feedback/settings), for your staff: what people send with the feedback button on every page of this app, with the same search, filters, New ticket and editing (the assignee picked from your staff). Issue its key with \`pnpm feedback:issue-key\` and set ADMINIGLOO_FEEDBACK_KEY.`
      : `- **This site's own board**, for your staff, over /api/admin/feedback (this project has no admin panel to show it in): what people send with the feedback button on every page of this app. Issue its key with \`pnpm feedback:issue-key\` and set ADMINIGLOO_FEEDBACK_KEY.`,
    "",
    "Not included yet:",
    "",
    ...FEEDBACK_2B2A_NOT_INCLUDED.map((item) => `- ${item}`),
    "",
  );
  return lines;
}

/**
 * The "Alerts and files" section (Tenancy 2b-1, 13.9): what each company (or
 * the one business) gets — the bell, the choices, who hears about new work,
 * files on visits, estimates and invoices, the Files screen and its
 * allowance. Empty without notifications and storage.
 */
export function alertsAndFilesSection(answers: ProjectManifest["answers"]): string[] {
  const notifications = answers.includeNotifications;
  const storage = answers.includeStorage;
  if (!notifications && !storage) return [];
  const companies = answers.tenantNoun !== "none";
  const shell = answers.adminShell !== "none";
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const at = (companyPath: string, adminPath: string) => (companies ? companyPath : adminPath);
  const screens = companies || shell;
  const records = [
    ...(answers.includeScheduling ? ["visits"] : []),
    ...(answers.includeEstimator ? ["estimates"] : []),
    ...(answers.includeInvoicing ? ["invoices"] : []),
  ];
  const lines: string[] = ["### Alerts and files", ""];
  if (notifications) {
    lines.push(
      screens
        ? `- **The bell** in the header shows the ${noun}'s unread alerts, on a phone too, and opens each one where it happened; the full list is at ${at("/app/alerts", "/admin/alerts")}.`
        : "- **The bell** in the header shows your staff the unread alerts, on a phone too, and opens each one where it happened.",
      ...(screens
        ? [
            `- **Alert settings** (${at("/app/alerts/settings", "/admin/alerts/settings")}): each person chooses, kind by kind, "In the app" or "In the app and by email".${
              records.length > 0 || answers.includeComms
                ? ` The owner chooses who hears about new work — visit requests, leads and invoices: "The owner" (their copy at the business email in ${companies ? "company " : ""}settings), or named people plus up to five extra addresses — and the office emails go to exactly those people, one email per lead. An office email that fails is sent again by the alerts cron.`
                : ""
            }`,
          ]
        : []),
      `- **Alert emails** go out ${companies ? `as the ${noun}, ` : ""}through Messages (the "Team alert" message, which the owner can reword or switch off), counted in ${companies ? `the ${noun}'s own` : "their own"} team sending allowance, never in the one customers' quotes and invoices use.`,
    );
  }
  if (storage) {
    lines.push(
      ...(records.length > 0
        ? [
            `- **Photos and files** on ${list(records)}${answers.includeScheduling ? ` (a visit's are at ${at("/app/schedule/visits/{id}/files", "/admin/schedule/visits/{id}/files")}, from the calendar and the crew's day)` : ""}. Who may see a record's files is decided by that record's own permissions.${answers.includeEstimator ? " Customers' estimate photos are kept the same way, attached to their estimate." : ""}`,
          ]
        : []),
      ...(screens
        ? [
            `- **Files** (${at("/app/files", "/admin/files")}): everything the ${noun} keeps, its usage against its allowance (\`FILES_ALLOWANCE_MB\`, 5 GB by default), and a link to copy that lasts at most an hour.`,
          ]
        : []),
      `- **Private by default.** A file is opened through this site's own routes by someone allowed to see it; a copied link stops working when its maker leaves${companies ? ` the ${noun} or the ${noun} is suspended` : ""}. The logo is the one public file, under an address nobody can guess. Files need a second, private Blob store (DEPLOYMENT.md); while developing with no store, they are kept in \`.data/files\`.`,
    );
  }
  lines.push("");
  return lines;
}

/** The installed field-service features, in words, for the README's first paragraph. */
export function companyRunFeatures(answers: ProjectManifest["answers"]): string[] {
  return [
    ...(answers.includeScheduling ? ["its schedule (online booking, crews, today's route)"] : []),
    ...(answers.includeEstimator ? ["its price book, estimates and quotes"] : []),
    ...(answers.includeInvoicing ? ["its invoices"] : []),
    ...(answers.includeComms ? ["its customer messages"] : []),
  ];
}

/**
 * The tables a pre-2a companies project wrote under the fixed "primary"
 * business, per installed feature: what the README's moving SQL updates.
 */
function primaryTables(answers: ProjectManifest["answers"]): string[] {
  return [
    ...(answers.includeScheduling
      ? ["scheduling_settings", "scheduling_resources", "scheduling_availability", "scheduling_bookings", "scheduling_visit_tokens"]
      : []),
    ...(answers.includeEstimator
      ? [
          "estimator_settings",
          "estimator_products",
          "estimator_components",
          "estimator_estimates",
          "estimator_client_keys",
          "estimator_quote_tokens",
          "estimator_photos",
          "estimator_takeoffs",
        ]
      : []),
    ...(answers.includeInvoicing ? ["invoices"] : []),
    ...(answers.includeComms ? ["comms_templates", "comms_messages", "comms_scheduled"] : []),
  ];
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function renderProjectReadme(manifest: ProjectManifest): string {
  const answers = manifest.answers;
  const companies = answers.tenantNoun !== "none";
  const noun = tenantLabel(answers).toLowerCase();
  const plural = tenantLabelPlural(answers).toLowerCase();
  const shell = answers.adminShell !== "none";

  const what = companies
    ? `A multi-${noun} web application: a business owner signs up, names their ${noun}, invites their team and runs it; you, the platform owner, see and steer every ${noun} from the admin console.`
    : `A single-business web application: everyone who signs up gets their own workspace, and you invite your staff into yours.`;
  // Said in the first paragraph (review R2 TB2-06): with companies, WHO the
  // features are for. Since Tenancy 2a, each company runs them itself.
  const features = companyRunFeatures(answers);
  const featureNote =
    companies && features.length > 0
      ? ` Each ${noun} runs ${list(features)} itself, in its own area (/app), with its own public pages at /t/{its web address} and its own emails — not with each other's, and not with yours.`
      : "";

  const lines: string[] = [
    `# ${answers.projectName}`,
    "",
    `${what}${featureNote} Generated by \`${manifest.generator.name}\` ${manifest.generator.version} (Next.js, Clerk for sign-in, Postgres on Neon); SCAFFOLD.md records every answer it was generated with.`,
    "",
    "## Quick start",
    "",
    // In the order that works on a fresh project (review R2 TB2-04): the
    // database steps need a database, and .env.local starts without one.
    "1. Before `pnpm install`: export `GITHUB_TOKEN`; `.npmrc` reads it. It must be a **classic** personal access token with the `read:packages` scope (GitHub's fine-grained tokens can't read npm packages), from a GitHub account that has been given access to the `@adminigloo` packages — see \"Private packages\" below.",
    "2. `pnpm install`",
    "3. `pnpm dev` — the site runs with nothing set; `/setup` lists what is set and what each missing key switches off.",
    "4. To sign in and keep data, put your Neon **staging** branch's `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct), and Clerk's development keys, into `.env.local` (it's already there, with every name commented). Then:",
    "   - `pnpm db:generate && pnpm db:migrate`",
    "   - `pnpm db:seed`",
    "5. Sign in. On your laptop the first person to sign in becomes the administrator straight away and lands in /admin; on a deployment it's BOOTSTRAP_ADMIN_EMAIL (DEPLOYMENT.md).",
    "",
    "## Private packages",
    "",
    "The `@adminigloo/*` packages install from GitHub Packages, which only serves them to a GitHub account that has been given read access to them. Your seller grants that access to your GitHub account (or your developer's); then create a **classic** personal access token on that account with the `read:packages` scope, and use it as `GITHUB_TOKEN` locally and as the `PACKAGES_READ_TOKEN` repository secret for CI and deploys.",
    "",
    "- `404 Not Found` from `npm.pkg.github.com`: the token works but its account has no access to the package yet. Ask for access.",
    "- `401 Unauthorized`: the token is missing, expired, fine-grained, or lacks `read:packages`. Make a new classic one.",
    "",
    "## First run and recovery",
    "",
    "- **Every deploy installs the roles.** `.github/workflows/deploy.yml` runs `pnpm db:migrate:deploy` and then `pnpm db:seed:deploy` on staging and production, so a permission a new feature adds reaches the roles in the same release. DEPLOYMENT.md has the whole release path.",
    "- **The first administrator** on a deployment is `BOOTSTRAP_ADMIN_EMAIL` — set it as a GitHub repository (or environment) variable for the deploy seed AND in Vercel. They are made an administrator whenever no administrator exists, once they sign in with that address verified. Keep \"verify email at sign-up\" on in both Clerk instances.",
    `- **Signed in before the roles were installed?** Open /admin again after the seed (or the next deploy)${shell ? "" : " — or, in this project without an admin panel, after `pnpm admin:grant`"}: the first administrator is made on the spot.`,
    "- **Locked out, and an administrator exists?** On your laptop: `pnpm admin:grant you@example.com` (it changes the database in `.env.local`, which is staging). For production: GitHub → Actions → Deploy → Run workflow, with your email — it runs behind the production environment's reviewer.",
    "",
  ];

  if (companies) {
    lines.push(
      `## ${tenantLabelPlural(answers)}`,
      "",
      "What a business owner can do:",
      "",
      `- Sign up and land on "What's your ${noun} called?" (/onboarding). The web address is suggested from the name and can be changed; reserved words are refused in a sentence. Refreshing or double-clicking never makes two.`,
      `- Someone invited signs up through the link and lands in the ${noun} that invited them, without onboarding.`,
      `- Work through a setup checklist on the ${noun} dashboard (/dashboard): business details, invite the team, logo and colour${features.length > 0 ? " — and what each feature needs before customers can use it" : ""}.`,
      `- Run the team at /settings/team: invite by email with a role (owner, admin, member, viewer${answers.includeScheduling ? ", crew" : ""}), resend or withdraw, change a role, remove someone (they lose access on their very next request), leave, and hand over ownership with the name typed.`,
      `- Belong to several ${plural} and switch between them from the header; the choice is remembered.`,
      `- Set the ${noun}'s name, web address, logo, brand colour, time zone and contact details at /settings/company — once; every feature reads them from there${answers.includeInvoicing ? ", and the Invoices section says how customers pay" : ""}.`,
      "",
    );
    if (features.length > 0) {
      lines.push(
        `### What each ${noun} runs itself`,
        "",
        ...(answers.includeScheduling
          ? [
              `- **Schedule** (/app/schedule): every crew's visits in the ${noun}'s time zone, online requests to accept or decline, Schedule settings (services, crews, hours, online booking). **Today's route** (/app/schedule/today) on a phone for a crew member. Public: /t/{web address}/book-visit, and the manage-your-visit link in every visit email.`,
            ]
          : []),
        ...(answers.includeEstimator
          ? [
              `- **Estimates** (/app/estimates), the **price book** (/app/price-book) and estimate settings, with "Your website": a button and a page frame for the ${noun}'s own website (any site builder), and a keyed React component for React sites. Public: /t/{web address}/estimate (instant prices from the ${noun}'s own price book) and the quote page a customer accepts on.${answers.includeAi ? ` Photo reading is capped at $1.00 a day per ${noun}, and at $5.00 a day for the whole site, because every ${noun} spends your AI key: the constants ESTIMATOR_AI_CEILING_CENTS and ESTIMATOR_AI_SITE_CEILING_CENTS in src/server/estimator-config.ts (code, not environment variables).` : ""}`,
            ]
          : []),
        ...(answers.includeInvoicing
          ? [`- **Invoices** (/app/invoices): raise, send, record payments. Public: the customer's invoice page, /t/{web address}/invoice/….`]
          : []),
        ...(answers.includeComms
          ? [`- **Messages** (/app/messages): the wording of every email its customers get, and what went out under its name.`]
          : []),
        "",
        `**Roles.** Owners and admins manage everything; a member works the estimates, the schedule and the invoices; ${answers.includeScheduling ? "a crew member sees only today's route; " : ""}a viewer reads. Each screen and each route checks the person's role in THAT ${noun}.`,
        "",
        `**Emails.** ${answers.includeComms ? `Every customer email goes out with the ${noun}'s name (on your one sending address, \`EMAIL_FROM\`) and its reply-to, links to the ${noun}'s own pages, and the office notices go to ${answers.includeNotifications ? `the people the owner names in Alert settings` : `the ${noun}'s own addresses`} — never to you.` : `This project was generated without messages (comms), so nothing is emailed about visits, quotes or invoices; customers keep the links the pages hand them.`}`,
        "",
        `**Crons.** ${answers.includeScheduling || answers.includeEstimator || answers.includeComms ? `Each daily job serves every active ${noun}, skips a suspended one, and reports one ${noun}'s failure without stopping the rest (DEPLOYMENT.md, \`vercel.json\` crons).` : `None of these features needs one.`}`,
        "",
        `**Proven.** \`pnpm test\` proves, on this project's own schema, that one ${noun} can't reach another's rows through any feature route (src/server/__tests__/feature-isolation.test.ts)${answers.includeScheduling || answers.includeEstimator || answers.includeComms ? ", that the crons serve every active one (company-crons.test.ts)" : ""}${answers.includeComms && answers.includeEmail ? ", that each one's email goes out under its own name (company-email.test.ts)" : ""}${answers.includeNotifications ? ", that its alerts are its own (company-alerts.test.ts)" : ""}${answers.includeStorage ? ", that its files are its own and private (company-files.test.ts)" : ""}.`,
        "",
      );
    }
    lines.push(
      ...(shell
        ? [
            "What you, the platform owner, can do at /admin:",
            "",
            `- See every ${noun} (/admin/companies): search, open one, see its team and recent activity in plain words.`,
            `- Suspend and reactivate a ${noun}; its people see a plain "suspended — contact support" screen (set SUPPORT_EMAIL so they know where to write)${features.length > 0 ? ", and its public pages say it isn't taking requests online" : ""}.`,
            `- Give a ${noun} whose owner closed their account a new owner, and release its old web addresses.`,
            "- Give staff roles on People (/admin/people), including making another administrator.",
            "",
          ]
        : []),
    );
  } else {
    lines.push(
      "## Single business",
      "",
      "- Everyone who signs up gets their own workspace, named after them.",
      "- Invite your staff from /settings/team (owner, admin, member, viewer); change roles, remove, hand over ownership.",
      ...(shell ? ["- Every workspace, and the staff roles, are in /admin (Companies and People)."] : []),
      ...(features.length > 0
        ? [
            `- The field-service features run for your one business, on your staff's own keys (one per job — a crew member's route never needs the office's full power), at today's paths: ${[
              ...(answers.includeScheduling ? ["/book-visit", "/admin/schedule"] : []),
              ...(answers.includeEstimator ? ["/estimate", "/admin/estimates"] : []),
              ...(answers.includeInvoicing ? ["/admin/invoices"] : []),
              ...(answers.includeComms ? ["/admin/comms"] : []),
            ].join(", ")}.`,
          ]
        : []),
      "",
    );
  }

  lines.push(...feedbackSection(answers));
  lines.push(...alertsAndFilesSection(answers));
  lines.push("### Not included", "", ...notIncludedFor(companies).map((item) => `- ${item}`), "");

  const tables = primaryTables(answers);
  if (companies && tables.length > 0) {
    lines.push(
      "### Moving a pre-2a project's feature rows into a company",
      "",
      "Before Tenancy 2a, a companies project's field-service features wrote every row under one fixed business, `primary`. To give those rows to one company, find its id (/admin/companies, open it) and run, in one transaction, BEFORE that company has used the features (its first request writes its own settings rows, which would then clash):",
      "",
      "```sql",
      "begin;",
      ...tables.map((table) => `update ${table} set tenant_id = '<company id>' where tenant_id = 'primary';`),
      "commit;",
      "```",
      "",
      "Line items, payments, options and estimate lines follow their parent rows. Nothing does this automatically.",
      "",
    );
  }

  // How this project reaches a newer create-app (review BUY-01): one command,
  // and where its by-hand steps are written down.
  lines.push(
    "## Upgrading",
    "",
    `Made by create-app ${manifest.generator.version} (adminigloo.json). To bring it up to a newer create-app — its packages, the files it wrote, and a list of exactly what is left for you to merge — run \`pnpm dlx @adminigloo/create-app upgrade\` in this folder. It never overwrites a file you changed (the new version lands beside it as \`<file>.new\`) and never touches \`.env.local\`. DEPLOYMENT.md §9 says what it does, and what each release asks of you after it.`,
    "",
  );

  lines.push(
    "## Installed packages",
    "",
    ...Object.entries(manifest.packages).map(([name, range]) => `- \`${name}\` ${range}`),
    "",
  );

  return lines.join("\n");
}

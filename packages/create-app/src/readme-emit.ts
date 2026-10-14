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
]);

/** The "Not included" list for this project's mode: 2a's list, then Tenancy 1's still-true items. */
export function notIncludedFor(companies: boolean): readonly string[] {
  const all = [...TENANCY_2A_NOT_INCLUDED, ...TENANCY_1_NOT_INCLUDED];
  return companies ? all : all.filter((item) => !COMPANIES_ONLY_ITEMS.has(item));
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
        `**Emails.** ${answers.includeComms ? `Every customer email goes out with the ${noun}'s name (on your one sending address, \`EMAIL_FROM\`) and its reply-to, links to the ${noun}'s own pages, and the office notices go to the ${noun}'s own addresses — never to you.` : `This project was generated without messages (comms), so nothing is emailed about visits, quotes or invoices; customers keep the links the pages hand them.`}`,
        "",
        `**Crons.** ${answers.includeScheduling || answers.includeEstimator || answers.includeComms ? `Each daily job serves every active ${noun}, skips a suspended one, and reports one ${noun}'s failure without stopping the rest (DEPLOYMENT.md, \`vercel.json\` crons).` : `None of these features needs one.`}`,
        "",
        `**Proven.** \`pnpm test\` proves, on this project's own schema, that one ${noun} can't reach another's rows through any feature route (src/server/__tests__/feature-isolation.test.ts)${answers.includeScheduling || answers.includeEstimator || answers.includeComms ? ", that the crons serve every active one (company-crons.test.ts)" : ""}${answers.includeComms && answers.includeEmail ? ", and that each one's email goes out under its own name (company-email.test.ts)" : ""}.`,
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

  lines.push(
    "## Installed packages",
    "",
    ...Object.entries(manifest.packages).map(([name, range]) => `- \`${name}\` ${range}`),
    "",
  );

  return lines.join("\n");
}

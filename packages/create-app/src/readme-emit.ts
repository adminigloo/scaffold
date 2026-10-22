/**
 * The generated project's README.md (CA-10).
 *
 * The first file a buyer — or the developer a business owner hired — opens.
 * Rendered from the MANIFEST, like SCAFFOLD.md, so it can't say anything the
 * manifest doesn't: what this project is, the quick start (the same steps the
 * CLI printed), first run and recovery, what the companies or single-business
 * mode does and plainly does NOT do yet, and the installed packages.
 */

import { tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";
import { cardPaymentsSetup } from "./payments-emit.js";
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
  "**Per-company analytics, SEO/AEO and book-a-call (booking)** — Tenancy 2b-4. (Feedback, alerts, files and the assistant are per company already.)",
  "**Selling products per company** (a company's own shop and orders) — getting paid, part 2. Customers already pay invoices and deposits by card (Taking card payments, below).",
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
  "**Sprints and swimlanes by epic on the feedback board.** Its epics, filters, search, New ticket, editing and settings screens are here (feedback 0.12), and so are the board per company, its alerts and its private screenshots (Tenancy 2b-2a).",
  "**The assistant answering customers on a public page.** Each company's assistant is its team's, behind sign-in (Tenancy 2b-3).",
  "**SEO reports, AI-citation tracking and book-a-call (booking) per company** — Tenancy 2b-4b and 2b-4c. Website visits and search basics are per company since Tenancy 2b-4a (`--analytics`, `--seo`).",
  "**Text (SMS) and push alerts.** Alerts come in the app and by email — S9.",
  "**Plans, limits and billing enforcement** — the billing chunk. Each company's storage allowance is one setting for everyone (`FILES_ALLOWANCE_MB`) until then; the seam the billing chunk fills is there.",
  "**Card payouts to anyone but the company itself**, and **SMS** payment links. (Customers pay invoices and deposits by card into the company's own Stripe account.)",
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
export function notIncludedFor(companies: boolean, options: { readonly seo?: boolean } = {}): readonly string[] {
  const all = [
    ...TENANCY_2B1_NOT_INCLUDED,
    // Tenancy 2b-4a: with --seo a company's public pages ARE in search, so
    // 2a's "search indexing of company pages" isn't said of that project.
    ...TENANCY_2A_NOT_INCLUDED.filter((item) => !TENANCY_2A_SUPERSEDED.has(item) && !(options.seo === true && item === TENANCY_2A_NOT_INCLUDED[5])),
    ...TENANCY_1_NOT_INCLUDED,
  ];
  return companies
    ? all.filter((item) => !SINGLE_ONLY_ITEMS.has(item))
    : all.filter((item) => !COMPANIES_ONLY_ITEMS.has(item));
}

/** What the assistant doesn't do (assistant 0.9), said plainly. */
export const ASSISTANT_2B3_NOT_INCLUDED: readonly string[] = [
  "**Answering customers on a public page.** The assistant is the team's, behind sign-in.",
  "**Changing records for you.** It reads the schedule, invoices and price book; the one change it can offer is saving an answer to a common question, and only when you say \"Yes, do it\".",
  "**Vector search.** It finds what it knows by keyword, which needs nothing extra; the optional vector table needs pgvector and an embeddings key.",
];

/**
 * The "Assistant" section (Tenancy 2b-3): who asks it, what it knows, what it
 * costs, and what it doesn't do. Empty without the assistant.
 */
export function assistantSection(answers: ProjectManifest["answers"]): string[] {
  if (!answers.includeAssistant) return [];
  const companies = answers.tenantNoun !== "none";
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const chats = answers.includeAi;
  const lines: string[] = ["### Assistant", ""];
  if (companies) {
    lines.push(
      chats
        ? `- **Each ${noun}'s own assistant**: an "Ask the assistant" button on every page of its area (/app). It answers from what the ${noun} wrote and looks things up — ${[
            ...(answers.includeScheduling ? ["the schedule"] : []),
            ...(answers.includeInvoicing ? ["overdue invoices"] : []),
            ...(answers.includeEstimator ? ["the price book"] : []),
          ].join(", ") || "its answers"} — with the asker's own permissions, and asks before it changes anything.`
        : `- **Each ${noun}'s own assistant** settings at /app/assistant. Its chat needs a model: add --ai (\`add ai\`).`,
      `- **What it knows** (/app/assistant, owners and admins): the business in the owner's words, answers to common questions (asked word for word, answered with those words and no AI), house rules and the words the business uses${chats ? ", and this month's AI use against its allowance" : ""}.`,
    );
  }
  lines.push(
    answers.adminShell !== "none"
      ? `- **This site's own assistant** (/admin/assistant${chats ? ", its chat at /admin/assistant/chat" : ""}), for your staff: its personality, house rules, words and change log.`
      : `- **This site's own assistant**, for your staff, over /api/admin/assistant.`,
  );
  if (chats) {
    lines.push(
      `- **What it costs**: Claude Haiku 4.5 (ASSISTANT_MODEL to change it), well under a cent a question. Each ${noun} has a month of questions (src/server/assistant.ts${companies && (answers.businessModel === "subscription" || answers.businessModel === "both") ? ', or its plan\'s "AI assistant messages a month"' : ""}) and the whole site stops for the day at AI_SITE_DAILY_CENTS (src/server/ai.ts) — checked before every question, refusing in plain words when spent, and when it can't check. Every question is recorded in ai_usage.`,
    );
  }
  lines.push("", "Not included:", "", ...ASSISTANT_2B3_NOT_INCLUDED.map((line) => `- ${line}`), "");
  return lines;
}

/** What website visits and search basics don't do (Tenancy 2b-4a), said plainly. */
export const WEBSITE_2B4A_NOT_INCLUDED: readonly string[] = [
  "**Search checks and AI mentions** (how search engines read the pages, whether AI assistants name the business) come with `--seo-reports` and `--aeo` (Tenancy 2b-4b).",
  "**Book-a-call per company** — Tenancy 2b-4c.",
  "**Google Search Console** (clicks and positions in Google search).",
  "**Crawlers on a website of the business's own.** Crawlers don't run the pasted line, so they are counted on its pages here only.",
  "**Visitors followed across days.** Nothing here uses cookies: a visitor is the same visitor within a day, and a phone or computer opened once from a \"leave this device out\" link stays left out on that device.",
];

/**
 * The "Website visits" and "Search" sections (Tenancy 2b-4a): where visits are
 * counted, who is left out, where the numbers are read, what search engines
 * see. Empty without either answer.
 */
export function websiteSection(answers: ProjectManifest["answers"]): string[] {
  if (!answers.includeAnalytics && !answers.includeSeo) return [];
  const companies = answers.tenantNoun !== "none";
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const shell = answers.adminShell !== "none";
  const lines: string[] = [];
  if (answers.includeAnalytics) {
    lines.push("### Website visits", "");
    if (companies) {
      lines.push(
        `- **Each ${noun}'s own numbers** at /app/website: visits to its pages here (/t/{web address}) and to its own website, where they came from (search engines, AI assistants by name, other sites), the pages read and the AI crawlers that read its pages — with its own team left out of its numbers.`,
        `- **Its own website**: the ${noun} adds it at /app/website and pastes one line before </head> on every page. A visit counts only from that website's own addresses${plansAnswer(answers) ? `; how many websites it may add is on its plan (src/plans.ts, "websites of your own, with visit counts")` : ""}.`,
        `- **Who is left out** (owners and admins): its team, automatically; a team member's email, everyone at an email domain, an office internet connection or a monitoring tool it adds (found only among its own members and invitations), cleaned out of past numbers at once and put back exactly when removed; and "leave this device out" links for the phones and computers it looks at its website on.`,
      );
    }
    lines.push(
      shell
        ? `- **This site's own numbers** at /admin/analytics (staff.analytics.view), its own pages counted by the beacon in every (site) page and any website it registers, with its staff left out.`
        : `- **This site's own numbers** over /api/admin/analytics, its own pages counted by the beacon in every (site) page, with its staff left out.`,
      "- **Nothing uses cookies.** A visitor's address and browser become a code that changes every day; Global Privacy Control, Do Not Track and `?analytics=off` are honoured. AUDIENCE_SECRET is optional (one is made from CLERK_SECRET_KEY). The daily tidy-up is /api/cron/analytics (vercel.json; it needs CRON_SECRET).",
    );
    lines.push("");
  }
  if (answers.includeSeo) {
    lines.push(
      "### Search",
      "",
      "- **One path list** (src/seo-paths.ts, `paths`; its public pages are src/site-pages.ts's) drives robots.txt, the noindex tags, the proxy's X-Robots-Tag and the sitemap, through @adminigloo/seo. Nothing is indexed off production. Replace SITE_DESCRIPTION: it is what search results and AI answers quote.",
      ...(companies
        ? [
            `- **Each ${noun}'s public pages are in search**: its own title, canonical address and business details (LocalBusiness, from its company settings — fill in the address for a local result), and every active ${noun}'s pages in /sitemap.xml. Token pages (quotes, visits, invoices) stay out.`,
          ]
        : []),
      "- **robots.txt names the AI crawlers** and lets them in, so AI assistants can find and quote the site, in ONE group (its rules written once). To keep AI training out, see app/robots.ts.",
      "- **Page metadata:** every generated public page exports `metadataFor({ path, title, description })` (src/seo.ts): its own canonical, the brand in the title once, the share card. A page with its own opengraph-image.tsx passes `ownImage: true`; a page that publishes a table of data can add `dataset()` JSON-LD with its CSV.",
      "",
    );
  }
  lines.push("Not included:", "", ...WEBSITE_2B4A_NOT_INCLUDED.map((line) => `- ${line}`), "");
  return lines;
}

/** What the search check and AI mentions don't do (Tenancy 2b-4b), said plainly. */
export const WEBSITE_2B4B_NOT_INCLUDED: readonly string[] = [
  "**Google Search Console** (clicks, impressions and positions) and **Bing Webmaster**.",
  "**ChatGPT, Perplexity and Gemini** as answer engines. AI mentions asks Claude with web search; another engine is an adapter of the same shape.",
  "**Sites behind a password, and pages only a browser can draw.** The search check reads what a server sends, as search engines first do.",
  "**Checking a page on a laptop's own address** (localhost and private networks are never fetched, for safety). Check a deployed address.",
  "**Fixing the problems for you.** The search check lists what to change; the changes are yours to make.",
];

/** SEO by default (create-app 0.40), in every project. */
export function seoDefaultsSection(answers: ProjectManifest["answers"]): string[] {
  return [
    "### Search basics",
    "",
    "- **Icons and a share card from your name and brand colour** (src/brand.ts): the tab icon, the home-screen icons, /manifest.webmanifest and /og.png, the card every page without its own shows. Keep src/brand.ts in step with app/globals.css when you rebrand.",
    "- **One list of public pages** (src/site-pages.ts) for /sitemap.xml, /llms.txt and /llms-full.txt, and **one hook for database-backed pages** (`dynamicPages()` in src/dynamic-pages.ts): a page per row lands in all three. The sitemap and both llms files are cached for an hour.",
    "- **X-Robots-Tag** on every answer under a private route (sign-in, sign-up, /account, /admin, /api, /setup, /welcome …), from the same list robots.txt reads (src/seo-paths.ts), sent by proxy.ts.",
    ...(answers.includeAnalytics
      ? ["- **Every AI crawler's read is logged** by proxy.ts, on every page (not only /llms.txt), after the answer has gone: a person's request costs one user-agent test, and never loads the database there."]
      : []),
    "",
  ];
}

/** The "Book a call" section (Tenancy 2b-4c). Empty without the answer. */
export function bookingSection(answers: ProjectManifest["answers"]): string[] {
  if (!answers.includeBooking) return [];
  const companies = answers.tenantNoun !== "none";
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const plans = plansAnswer(answers);
  return [
    "### Book a call",
    "",
    companies
      ? `- **Each ${noun}'s own booking page** at /t/{web address}/book, linked from its public home: its customers pick a call type, a day and a time in their own time zone, and get a private link to move or cancel (/t/{web address}/book/manage/…). A suspended ${noun}, or one whose plan ended, takes no new bookings and says so by name; links it already sent keep working while its plan is closed.`
      : "- **The booking page** at /book: customers pick a call type, a day and a time in their own time zone, and get a private link to move or cancel (/book/manage/…).",
    companies
      ? `- **Its calls** at /app/calls (booking.calls.view): upcoming and past calls, the hours and time off of each person taking calls, holidays and call types. Only the ${noun}'s own people can take calls${plans ? ', and its plan sets how many at once ("people taking calls", src/plans.ts)' : ""}.`
      : "- **The calls** at /admin/calls (booking.calls.view on the staff ladder): upcoming and past calls, hours, time off, holidays and call types.",
    `- **Abuse caps**: 2 times held per visitor, 30 held per ${noun} at once, 50 bookings per ${noun} a day, a hidden form field only scripts fill, and per-visitor rate limits.`,
    answers.includeEmail
      ? `- **Emails** go out as the ${noun} (its name, and replies to its own address) once RESEND_API_KEY is set: the confirmation, a move, a cancellation, the host's notice and a reminder the day before (/api/cron/booking, which needs CRON_SECRET).`
      : "- **No emails**: this project has no email (`create-app add email`). The booking page doesn't promise one.",
    "- **A host's real calendar** can block times: paste its secret iCal address in the calls screen. Only public addresses are read, connected to the checked address, every redirect re-checked.",
    "",
  ];
}

/**
 * The "Search check" and "AI mentions" sections (Tenancy 2b-4b): what each
 * reads, where it's seen, what it costs. Empty without either answer.
 */
export function websiteReportsSection(answers: ProjectManifest["answers"]): string[] {
  if (!answers.includeSeoReports && !answers.includeAeo) return [];
  const companies = answers.tenantNoun !== "none";
  const noun = companies ? tenantLabel(answers).toLowerCase() : "business";
  const shell = answers.adminShell !== "none";
  const plans = plansAnswer(answers);
  const lines: string[] = [];
  if (answers.includeSeoReports) {
    lines.push("### Search check", "");
    if (companies) {
      lines.push(
        `- **Each ${noun}'s own check** on /app/website: how Google, Bing and AI assistants read its pages here and its own websites${answers.includeAnalytics ? " (the ones it added under Website)" : ""}, as a list of things to fix in plain words, with every past check kept. Owners and admins press Check now${plans ? ` (its plan sets how often a month, src/plans.ts)` : " (20 times a month)"}; a check also runs by itself every week, free.`,
      );
    }
    lines.push(
      shell
        ? "- **This site's own check** at /admin/seo (staff.seo_reports.view), of its own pages."
        : "- **This site's own check** over /api/admin/search-check, of its own pages.",
      "- **Safe by design**: a check reads only the business's own addresses — never a private or cloud-internal one, every redirect re-checked — at most 50 pages, 2 MB a page and 45 seconds. The weekly re-check is /api/cron/search-check (vercel.json; it needs CRON_SECRET).",
      "",
    );
  }
  if (answers.includeAeo) {
    lines.push("### AI mentions", "");
    if (companies) {
      lines.push(
        `- **Each ${noun}'s own questions** on /app/website: the questions its customers ask an AI assistant ("wheelchair ramp rental Raleigh"), whether the answer names it (by name, or its website among the sources), the quoted words, the competitors named, and how often over eight weeks.`,
      );
    }
    lines.push(
      shell
        ? "- **This site's own** at /admin/aeo (staff.aeo.view)."
        : "- **This site's own** over /api/admin/ai-mentions.",
      answers.includeAi
        ? `- **What it costs**: each check asks Claude Haiku 4.5 with web search; the cost is estimated — see /admin/aeo for the measured average. Every answer is held against the month (src/server/ai-mentions.ts${companies && plans ? ', or its plan\'s "AI answer checks a month" and "questions tracked in AI answers"' : ""}), AI mentions' own day (AI_MENTIONS_DAILY_CENTS, at most half the site's) and the site's day (AI_SITE_DAILY_CENTS) before it's asked, and recorded in ai_usage — web searches priced in. Code, not the model, decides whether the business was named. Each question is asked again weekly by /api/cron/ai-mentions (it needs CRON_SECRET).`
        : "- **No answers are asked yet**: this project has no AI (`create-app add ai`). Questions and who the business is can be kept; Check now says checking isn't switched on.",
      "",
    );
  }
  lines.push("Not included:", "", ...WEBSITE_2B4B_NOT_INCLUDED.map((line) => `- ${line}`), "");
  return lines;
}

function plansAnswer(answers: ProjectManifest["answers"]): boolean {
  return answers.tenantNoun !== "none" && (answers.businessModel === "subscription" || answers.businessModel === "both");
}

/** What the feedback boards don't do (feedback 0.12), said plainly. */
export const FEEDBACK_2B2A_NOT_INCLUDED: readonly string[] = [
  "**Sprints** (a time box tickets are planned into) and **swimlanes by epic** (a row of columns per epic). Filter the board by an epic, or open the epic's page.",
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
      `- **Each ${noun}'s own board** (/app/feedback): what its customers send, as columns to drag between, with search and filters (status, priority, category, who it's assigned to, its epic, where it came from, when it was sent; Mine, Unassigned and Critical in one click), **New ticket** for the team (and a + on each column), a ticket's conversation, replies, editing (title, priority, category, assignee picked from the ${noun}'s people, epic) with its activity trail, and archive. Its columns, categories, feedback page address and website keys are at /app/feedback/settings (owners and admins change them; members answer and sort; viewers look; crew don't see it).`,
      `- **Its epics** (/app/feedback/epics): bigger pieces of work its tickets are grouped under — each card on the board shows its epic. An epic's page lists its tickets by how far along they are (done, waiting, in progress, not started — by the board's columns), adds and takes out tickets, and asks "mark it completed?" when every ticket is done; an epic starts by itself when one of its tickets starts moving. Members make and change them; viewers look.`,
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
      ? `- **This site's own board** (/admin/feedback, epics at /admin/feedback/epics, settings at /admin/feedback/settings), for your staff: what people send with the feedback button on every page of this app, with the same search, filters, New ticket, editing (the assignee picked from your staff) and epics. Issue its key with \`pnpm feedback:issue-key\` and set ADMINIGLOO_FEEDBACK_KEY.`
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
    : answers.audience === "consumers"
      ? `A web application for people who sign up as themselves: each account is one person's, with its own plans${answers.businessModel === "subscription" || answers.businessModel === "both" ? " (src/plans.ts)" : ""}, and nobody shares one.`
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
    "5. Sign in. On the dev server (`pnpm dev`) the first person to sign in becomes the administrator straight away and lands in /admin — or only BOOTSTRAP_ADMIN_EMAIL, once you set it; anywhere else (a production build, `pnpm start` on your laptop included) it's BOOTSTRAP_ADMIN_EMAIL, or `pnpm admin:grant <your email>` (DEPLOYMENT.md).",
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
  } else if (answers.audience === "consumers") {
    // PERSONAL ACCOUNTS (create-app 0.39): one person each, no team.
    const plansSold = answers.businessModel === "subscription" || answers.businessModel === "both";
    lines.push(
      "## Personal accounts",
      "",
      "- Each person who signs up gets their own account. There is no team page and no invitations: the seat limit of one refuses them, and no role (the owner included) holds the keys to invite, remove, change roles or hand an account over.",
      ...(plansSold
        ? [
            "- Plans are each person's (src/plans.ts): `requireEntitlement(feature)`, `withEntitlement` and `<Entitled feature>` (src/server/access.ts) answer from the person's OWN account. `free:` in src/plans.ts is what an account with no plan gets.",
            ...(shell ? ["- Who pays for what: /admin (subscribers by plan, MRR and ARR, new and cancelled, failed payments, free to paid) and /admin/billing/subscribers (each person, and Give free months)."] : []),
          ]
        : []),
      ...(answers.includeEmail
        ? [
            "",
            "### Each person's emails",
            "",
            "- **Their choice, off until they say yes.** At /account/email each person ticks the digests and alert kinds they want (src/digests.ts), and picks the hour their digests come in their own time zone (7 AM, the zone from their browser at sign-up, else `SITE_TIME_ZONE`). The sign-up page offers each digest beside the form, unticked.",
            "- **Your digest's sections** go in src/digests.ts: each a server function of the person and the day returning `{ title, text, html }` (made with the escaping `html` tag), or null when it has nothing to say. A day where every section is null sends nothing; a digest with no section is offered nowhere.",
            "- **One email per person per local day**, at or after their hour: /api/cron/digest (vercel.json, daily on Hobby; run it hourly on Pro). A second run sends nobody anything (the `digest_sends` ledger), it ends by 50 seconds, and with no RESEND_API_KEY every digest is recorded as skipped, never an error.",
            "- **Alert emails:** `digests.sendAlert({ userId, kind, dedupeKey, subject, text, html })` (src/server/digest.ts) emails only the people who chose that kind, once per key.",
            "- **One-click unsubscribe** on every email (RFC 8058's List-Unsubscribe headers, which Gmail and Yahoo show as their own button) and a signed link to /unsubscribe that works without signing in. Each stops only that one email.",
            `- **The preview:** /api/email/v1/preview?person={id}&digest=morning&day=2026-10-21 renders anybody's digest for any day, exactly as it would go, and sends nothing${shell ? " (staff with \"Preview people's emails\", admin and cs_lead)" : " (staff with staff.digest.preview)"}.`,
          ]
        : []),
      "",
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

  lines.push(...seoDefaultsSection(answers));
  lines.push(...feedbackSection(answers));
  lines.push(...assistantSection(answers));
  lines.push(...alertsAndFilesSection(answers));
  lines.push(...websiteSection(answers));
  lines.push(...websiteReportsSection(answers));
  lines.push(...bookingSection(answers));
  // Getting paid, part 1: what to turn on in Stripe for Pay now.
  if (answers.includeInvoicing) lines.push(...cardPaymentsSetup(answers as unknown as Answers, "###").split("\n"));
  lines.push("### Not included", "", ...notIncludedFor(companies, { seo: answers.includeSeo }).map((item) => `- ${item}`), "");

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

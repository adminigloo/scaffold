/**
 * The Tenancy 2a renderers: the files that move the field-service features —
 * scheduling, the estimator, invoicing and messages (comms) — into each
 * company of a companies project, and onto the package handlers and widgets
 * in both modes (contract section 11).
 *
 * In their own module because emit.ts is long enough already (the
 * tenancy-emit.ts precedent), and because these files are one subject:
 * "whose feature is this?" — answered per request from the path in a
 * companies project, and by the one fixed business in a single-business one.
 *
 * THE GENERATOR'S RULES APPLY HERE AS EVERYWHERE (README "Rules"):
 *
 *   - No emitted `if` asks whether a feature or a mode is installed. Each
 *     file below is written per mode and per feature set; a feature that
 *     isn't installed contributes no line, no import and no array entry.
 *   - The screens are package components; the emitted files are glue.
 *   - A companies project contains no fixed business: nothing below emits
 *     "primary" or a *_TENANT constant into one (D12, a generator test).
 */

import { tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";
import { COMMS_CRON_DAILY_AT_UTC } from "./emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** True when any of the four field-service features is installed. */
export function hasFieldService(answers: Answers): boolean {
  return answers.includeScheduling || answers.includeEstimator || answers.includeInvoicing || answers.includeComms;
}

/** "14:00": the daily comms run, as the listeners' `dailyAtUtc` wants it. */
function commsRunAt(): string {
  return `${String(COMMS_CRON_DAILY_AT_UTC.hour).padStart(2, "0")}:${String(COMMS_CRON_DAILY_AT_UTC.minute).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// src/permissions/roles.ts — the company roles this project offers (both modes)
// ---------------------------------------------------------------------------

/**
 * `src/permissions/roles.ts` (11.7): the roles a company's people can hold.
 * Tenancy's four (owner, admin, member, viewer), plus Crew from scheduling in
 * a companies project — scheduling contributes the role, tenancy never names
 * a field-service role itself (D9). A single-business project keeps
 * scheduling's crew STAFF role instead, so its list here is empty.
 */
export function renderTenantRoles(answers: Answers): string {
  const scope = answers.scope;
  const crew = companiesMode(answers) && answers.includeScheduling;
  const noun = tenantLabel(answers).toLowerCase();
  const extra = crew
    ? `/**
 * The four every ${noun} has — owner, admin, member, viewer — and CREW, from
 * scheduling: "Crew member", who opens their own crew's route for the day on
 * a phone and sees nothing else (their only key is \`schedule.route\`). Ranked
 * 5, below every other role, so owners and admins manage crew members and a
 * crew member manages nobody.
 *
 * Owners invite a crew member from the Team page with the Crew role, then pick
 * them for a crew in Schedule settings.
 */
export const TENANT_ROLES = defineTenantRoles([SCHEDULING_CREW_ROLE]);`
    : `/**
 * The four every ${noun} has — owner, admin, member, viewer — and nothing
 * more: ${
        answers.includeScheduling
          ? "this single-business project gives its crews scheduling's crew STAFF role instead (src/server/scheduling-staff.ts), because its schedule is the business's own, run from /admin."
          : "no installed package adds a role here. (With scheduling in a companies project, Crew joins them.)"
      }
 */
export const TENANT_ROLES = defineTenantRoles([]);`;
  // Tenancy 2b-1: alerts' `alerts.view` names scheduling's Crew among its
  // defaults (a crew member hears about their own visits). Without
  // scheduling there is no Crew role, so that default grants nothing — by
  // design, and said here so the catalog test doesn't read it as a
  // misplaced fragment. GENERATED: an array, empty where it doesn't apply.
  const absent = companiesMode(answers) && answers.includeNotifications && !answers.includeScheduling ? ["crew"] : [];
  const absentRoles = `
/**
 * Roles an installed package's defaults name that ANOTHER package adds, and
 * which this project doesn't have${absent.length > 0 ? ": scheduling's Crew (alerts give a crew member\n * their own visits' alerts). Nobody here holds it, so those defaults grant\n * nothing, by design" : " (none)"}. The catalog test reads this list.
 */
export const ROLES_NOT_IN_THIS_PROJECT: readonly string[] = [${absent.map((r) => JSON.stringify(r)).join(", ")}];
`;
  return `import { defineTenantRoles } from "${scope}/tenancy";
${crew ? `import { SCHEDULING_CREW_ROLE } from "${scope}/scheduling";\n` : ""}
/**
 * Every role a ${noun}'s people can hold in ${answers.projectName}, composed ONCE
 * (Tenancy 2a): the tenancy service is built with it (src/server/tenancy.ts),
 * the seed installs its templates on every deploy (src/permissions/seed.ts),
 * and the team page offers exactly these.
 *
 * GENERATED, like the permission catalog: which packages contribute a role
 * depends on what was installed, and an emitted \`if\` about a package it can't
 * see is what the generator refuses to write.
 */

${extra}
${absentRoles}
`;
}

// ---------------------------------------------------------------------------
// src/server/company-routes.ts — whose request is this? (companies)
// ---------------------------------------------------------------------------

export function renderCompanyRoutes(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `import {
  createCompanyRouteSeams,
  createPublicCompanySeams,
  type CompanyRouteSeams,
  type PublicCompanySeams,
} from "${scope}/tenancy/server";
import { ensureCompanySetup } from "./company-setup";
import { companyPlanOption } from "./plan-gate";
import { tenancy } from "./tenancy";
import { requestPrincipal } from "./tenancy-handlers";

/**
 * WHOSE REQUEST IS THIS — the one answer every feature route in a companies
 * project shares (Tenancy 2a, D1–D2). Two shapes of route, two seams:
 *
 *   /api/app/{${noun} id}/<feature>/…   a ${noun}'s own screens. The id in the
 *                                    PATH decides, never the session's active
 *                                    ${noun}: a tab still showing Green Acres
 *                                    acts on Green Acres after its owner
 *                                    switched to Summit in another tab.
 *                                    \`companyAuthorizer\` asks, for that id:
 *                                    signed in → a member → not suspended →
 *                                    holds the route's permission.
 *   /api/t/{web address}/<feature>/…    a ${noun}'s public pages. The web address
 *                                    (current or old) decides; a suspended
 *                                    ${noun} is closed with a plain sentence
 *                                    (\`admitPublic\`).
 *
 * The feature packages never import tenancy (D4): each takes these as plain
 * functions (\`resolveTenant\`, \`authorize\`, \`admit\`), so the same packages
 * still install in somebody else's app with their own tenant lookup.
 *
 * FIRST-TIME SETUP RIDES ON THE SAME CALLS (D11): a ${noun}'s first settings
 * and email templates are written right after it is created, and again — at
 * most once per process — the first time one of its feature routes is used,
 * which is what makes them survive a crash between the two. Only for a REAL
 * ${noun}: after \`authorize\` passed, after the web address resolved, after an
 * embed key verified — an anonymous request with a made-up id never writes a
 * row.
 *
 * IMPORT ORDER. This module imports company-setup, which imports the feature
 * glue, which imports this module: a cycle by design, safe only while every
 * cross-module use happens INSIDE a function (the builders run when a route
 * file calls them, after every module has loaded). Keep top-level code here to
 * the two seam objects below.
 */
export const companyRoutes: CompanyRouteSeams = createCompanyRouteSeams({
  tenancy,
  principal: () => requestPrincipal(),
  // Each ${noun}'s plan (billing 0.3): a closed plan refuses new work with
  // "This ${noun}'s plan has ended…" and keeps reading, billing and the team
  // open. Empty in a project that doesn't sell plans (src/server/plan-gate.ts).
  ...companyPlanOption,
});

// A closed plan closes the public pages too, in the same words as a suspended ${noun}.
export const publicCompanies: PublicCompanySeams = createPublicCompanySeams({ tenancy, ...companyPlanOption });

/** What a test swaps: who is calling (the project's isolation proof calls every route as somebody else). */
export interface FeatureHandlerOverrides {
  readonly principal?: (req: Request) => Promise<{ readonly userId: string } | null>;
}

/**
 * The private handlers' \`authorize\`: the ${noun}'s membership and permission
 * check (\`companyRoutes.authorize\`), then — only once it passed — the
 * ${noun}'s first-time setup. A refusal (signed out 401, not a member or
 * suspended 403, a missing permission \`false\`) is returned as it is, before
 * anything is written.
 */
export function companyAuthorizer(overrides: FeatureHandlerOverrides = {}): CompanyRouteSeams["authorize"] {
  const seams = overrides.principal
    ? createCompanyRouteSeams({ tenancy, principal: overrides.principal, ...companyPlanOption })
    : companyRoutes;
  return async (req, permission, tenantId) => {
    const verdict = await seams.authorize(req, permission, tenantId);
    if (verdict === false || verdict instanceof Response) return verdict;
    await ensureCompanySetup(tenantId);
    return verdict;
  };
}

/**
 * The public handlers' \`resolveTenant\`: the ${noun} whose web address is in
 * the path (current or old, active or suspended), then its first-time setup.
 * Unknown → null, and the handler answers "not found".
 */
export async function resolvePublicTenant(req: Request): Promise<string | null> {
  const tenantId = await publicCompanies.resolveTenant(req);
  if (tenantId === null) return null;
  await ensureCompanySetup(tenantId);
  return tenantId;
}

/**
 * The public handlers' \`admit\`, for the web-address path AND the embed-key
 * path (the estimator's embed knows its ${noun} only from the key): the
 * ${noun}'s first-time setup (which writes nothing for an id that isn't a real
 * ${noun}), then "is it taking requests?" — open for an active ${noun}; closed,
 * with "{Name} isn't taking requests online right now" and how to reach it,
 * for a suspended or unknown one.
 */
export async function admitPublic(
  tenantId: string,
  req: Request,
): Promise<{ readonly open: true } | { readonly open: false; readonly message: string }> {
  await ensureCompanySetup(tenantId);
  return publicCompanies.admit(tenantId, req);
}
`;
}

// ---------------------------------------------------------------------------
// src/server/company-links.ts — a company's links on this deployment
// ---------------------------------------------------------------------------

export function renderCompanyLinks(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import { env } from "@/env";
import { tenancy } from "./tenancy";

/**
 * A ${noun}'s links on this deployment (Tenancy 2a): its public pages under
 * /t/{web address}, and its own screens through the switch route. Every email
 * a ${noun}'s customers or office get carries these, so a Green Acres customer
 * is only ever sent to Green Acres' pages.
 *
 * ABSOLUTE, because they leave the site in an email. Built from
 * NEXT_PUBLIC_APP_URL (which a production deployment requires) and the
 * ${noun}'s CURRENT web address, read per call — a ${noun} that renamed itself
 * gets links to its new address, and its old one still redirects.
 *
 * A TOKEN GOES INTO ONE ENCODED PATH SEGMENT AND NOWHERE ELSE: it is the
 * customer's whole key to their visit, quote or invoice, so never a query
 * string a proxy might record, and never a log line.
 */
export interface CompanyLinks {
  /** {app}/t/{web address} */
  readonly home: string;
  readonly estimate: string;
  /** The booking page; with an estimate, tied to it. */
  readonly bookVisit: (estimateId?: string) => string;
  readonly manageVisit: (token: string) => string;
  readonly quote: (token: string) => string;
  readonly invoice: (token: string) => string;
  /**
   * One of the ${noun}'s own screens, THROUGH THE SWITCH ROUTE (D2):
   * {app}/app/switch/{web address}?next={path}. Someone in two ${tenantLabelPlural(answers).toLowerCase()} who
   * clicks "see the new request" in an email lands in the ${noun} the email
   * was about, not whichever one they last had open. Tenancy 2b-1: the
   * company settings and the team page too (an alert about a teammate opens
   * the team page).
   */
  readonly app: (path: \`/app/\${string}\` | \`/settings/\${string}\` | "/dashboard") => string;
}

export class UnknownCompanyError extends Error {
  readonly name = "UnknownCompanyError";
  constructor(tenantId: string) {
    super(\`There is no ${noun} \${tenantId} to build links for (unknown or deleted).\`);
  }
}

/** This deployment's own address, with the slash \`new URL\` needs to join under a path. */
function appBase(): string {
  const app = env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return app.endsWith("/") ? app : \`\${app}/\`;
}

/** The links for a web address. Pure: the pages that already hold the ${noun} use this. */
export function companyLinksFor(slug: string, base: string = appBase()): CompanyLinks {
  const at = (path: string) => new URL(path, base).toString();
  const home = \`t/\${encodeURIComponent(slug)}\`;
  return {
    home: at(home),
    estimate: at(\`\${home}/estimate\`),
    bookVisit: (estimateId) =>
      at(\`\${home}/book-visit\${estimateId ? \`?estimate=\${encodeURIComponent(estimateId)}\` : ""}\`),
    manageVisit: (token) => at(\`\${home}/visit/\${encodeURIComponent(token)}\`),
    quote: (token) => at(\`\${home}/quote/\${encodeURIComponent(token)}\`),
    invoice: (token) => at(\`\${home}/invoice/\${encodeURIComponent(token)}\`),
    app: (path) => {
      const url = new URL(\`app/switch/\${encodeURIComponent(slug)}\`, base);
      url.searchParams.set("next", path);
      return url.toString();
    },
  };
}

/** A ${noun}'s links, by its id (the feature packages' link seams). Throws for an unknown one. */
export async function companyLinks(tenantId: string): Promise<CompanyLinks> {
  const profile = await tenancy.companyProfile(tenantId);
  if (!profile) throw new UnknownCompanyError(tenantId);
  return companyLinksFor(profile.slug);
}

/**
 * Where the switch route may send someone (D2): a page of the working area
 * (/app/…), the dashboard, or — Tenancy 2b-1 — the ${noun}'s settings and
 * team pages (/settings/company, /settings/team: an alert about a teammate
 * opens the team page). Anything else — another site, a protocol-relative
 * "//evil.example", a path that climbs out with "..", a backslash a browser
 * might read as a slash, or the switch route itself — is the dashboard
 * instead.
 */
const SWITCH_SETTINGS_PAGES: ReadonlySet<string> = new Set(["/settings/company", "/settings/team"]);

export function safeSwitchNext(value: string | null | undefined): string {
  if (typeof value !== "string") return "/dashboard";
  if (value === "/dashboard") return value;
  if (/[\\\\\\u0000-\\u001f]/.test(value)) return "/dashboard";
  const settings = SWITCH_SETTINGS_PAGES.has(value.split(/[?#]/)[0] ?? "");
  if (!value.startsWith("/app/") && !settings) return "/dashboard";
  const parsed = new URL(value, "http://this.site");
  if (parsed.host !== "this.site") return "/dashboard";
  if (!parsed.pathname.startsWith("/app/") && !SWITCH_SETTINGS_PAGES.has(parsed.pathname)) return "/dashboard";
  if (parsed.pathname.startsWith("/app/switch/")) return "/dashboard";
  return \`\${parsed.pathname}\${parsed.search}\`;
}
`;
}

// ---------------------------------------------------------------------------
// src/server/company-setup.ts — each company's first-time setup (companies)
// ---------------------------------------------------------------------------

export function renderCompanySetup(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const setups: { name: string; module: string; fn: string; what: string }[] = [];
  if (answers.includeScheduling) {
    setups.push({
      name: "scheduling",
      module: "./scheduling",
      fn: "setupSchedulingFor",
      what: "its first schedule settings (its zone, an address required, one service, online booking OFF) and the visit emails",
    });
  }
  if (answers.includeEstimator) {
    setups.push({
      name: "estimator",
      module: "./estimator",
      fn: "setupEstimatorFor",
      what: "the zone its quotes are dated in (settings unsaved, so instant estimates wait for the owner) and the estimate emails",
    });
  }
  if (answers.includeInvoicing) {
    setups.push({
      name: "invoicing",
      module: "./invoicing",
      fn: "setupInvoicingFor",
      what: answers.includeComms ? "the invoice email" : "nothing yet (no email to send invoices with)",
    });
  }
  // No comms entry (review T2A-BO-08): its starter templates ("Booking
  // confirmation", "Review request") are sent by nothing in a companies
  // project, so seeding them only showed an owner emails to edit that never
  // go out. Every feature adds its own emails in its own setup above.
  //
  // ALERTS (Tenancy 2b-1), with comms to send them: the team alert email,
  // added if absent, so the owner can read it in Messages before the first
  // alert email goes.
  if (answers.includeNotifications && answers.includeComms) {
    setups.push({
      name: "alerts",
      module: "./alerts",
      fn: "ensureTeamAlertTemplate",
      what: "the team alert email (Team alert, in Messages)",
    });
  }
  const alerts = answers.includeNotifications;
  const alertImports = [
    ...(alerts && answers.includeComms ? ["ensureTeamAlertTemplate"] : []),
    ...(alerts ? ["alertOnTenancyEvent"] : []),
  ];
  const imports = [
    `import type { TenancyEvent } from "${scope}/tenancy/server";`,
    `import { log } from "./logger";`,
    `import { tenancy } from "./tenancy";`,
    ...setups
      .filter((s) => s.name !== "alerts")
      .map((s) =>
        s.name === "scheduling"
          ? `import { linkNewCrewMember, setupSchedulingFor, syncSchedulingCompany } from "./scheduling";`
          : `import { ${s.fn} } from "${s.module}";`,
      ),
    ...(alertImports.length > 0 ? [`import { ${alertImports.join(", ")} } from "./alerts";`] : []),
  ];
  const entries =
    setups.length === 0
      ? "[]"
      : `[\n${setups
          .map(
            (s) =>
              `  // ${s.name}: ${s.what}.\n  { name: "${s.name}", run: (tenantId) => ${s.fn}(tenantId) },`,
          )
          .join("\n")}\n]`;
  const zoneLine = answers.includeScheduling
    ? `
    // The owner changed the ${noun}'s time zone: scheduling converges at once
    // (D5) — every booked visit keeps its clock time and its reminder moves —
    // rather than waiting for the next request or the nightly cron.
    if (event.type === "company.settings.updated" && event.section === "company" && event.changed.includes("timeZone")) {
      await syncSchedulingCompany(event.tenantId);
    }
    // Somebody joined, or changed role: if they are now a crew member and the
    // ${noun} has exactly one free crew, they are put on it, so their first
    // morning isn't a dead end (review T2A-BO-04). Otherwise the schedule names
    // them for the owner.
    if (event.type === "member.joined" || event.type === "member.role.changed") {
      await linkNewCrewMember(event.tenantId, event.userId);
    }`
    : "";
  // ALERTS (Tenancy 2b-1, 13.6): every tenancy event is handed to the alerts
  // too — "Cam joined the team", and the housekeeping a removal or a role
  // change needs (forget, prune). After the setup above, in its own step.
  const alertsLine = alerts
    ? `
    // A teammate joined, left or was removed, or changed role: the team's
    // alerts, and forgetting or pruning that person's own (Tenancy 2b-1). In
    // the same try/catch: alertOnTenancyEvent never throws anyway.
    await alertOnTenancyEvent(event);`
    : "";
  return `${imports.join("\n")}

/**
 * Each ${noun}'s first-time setup for the features this project installed
 * (Tenancy 2a, D11) — so a ${noun} that has just signed up finds its schedule
 * settings, its estimate settings and its email templates waiting, not empty.
 *
 * EVERY STEP IS INSERT-IF-ABSENT, never over an owner's edit, so running it
 * twice writes nothing the second time. It runs:
 *
 *   - when the ${noun} is created (tenancy's \`company.created\` event,
 *     \`onCompanyEvent\` below), and
 *   - again before the ${noun}'s first feature request in each process
 *     (src/server/company-routes.ts) — which is what makes it survive a crash
 *     between the ${noun} committing and its setup finishing.
 *
 * ONLY FOR A REAL ${noun.toUpperCase()}: an id that is unknown, deleted or a personal
 * workspace writes nothing and is not remembered, so an anonymous request with
 * a made-up id can't plant rows.
 *
 * IMPORT ORDER: company-routes → this module → the feature glue →
 * company-routes is a cycle by design. Every use below of what the feature
 * modules export happens INSIDE a function (that is why each entry wraps its
 * setup in an arrow), never at this module's top level, so whichever module
 * loads first, none reads another half-initialised. The project's unit tests
 * import each glue module first and alone, which fails loudly if that rule is
 * ever broken.
 *
 * GENERATED: one entry per installed feature.
 */
interface CompanySetup {
  readonly name: string;
  readonly run: (tenantId: string) => Promise<void>;
}

const SETUPS: readonly CompanySetup[] = ${entries};

/** Per ${noun}, per process. A failed setup is forgotten, so the next request tries again. */
const done = new Map<string, Promise<void>>();

/** Run every installed feature's first-time setup for this ${noun}, once per process. */
export function ensureCompanySetup(tenantId: string): Promise<void> {
  const known = done.get(tenantId);
  if (known) return known;
  const pending = runSetups(tenantId).then(
    (real) => {
      // Not a ${noun} (yet): nothing was written, and nothing is remembered.
      if (!real) done.delete(tenantId);
    },
    (error: unknown) => {
      done.delete(tenantId);
      throw error;
    },
  );
  done.set(tenantId, pending);
  return pending;
}

async function runSetups(tenantId: string): Promise<boolean> {
  const profile = await tenancy.companyProfile(tenantId);
  if (!profile || profile.kind !== "org") return false;
  for (const setup of SETUPS) await setup.run(tenantId);
  return true;
}

/**
 * Tenancy's \`onEvent\` (src/server/tenancy.ts), after each change commits.
 * NEVER THROWS: a setup that fails here is logged and runs again before the
 * ${noun}'s first feature request; the ${noun} itself was made either way.
 * (These \`if\`s are about which EVENT arrived — runtime state — not about
 * which features were installed.)
 */
export async function onCompanyEvent(event: TenancyEvent): Promise<void> {
  try {
    if (event.type === "company.created") await ensureCompanySetup(event.tenantId);${zoneLine}${alertsLine}
  } catch (error) {
    log.error({ err: error, type: event.type }, "a ${noun}'s feature setup couldn't run after an event");
  }
}
`;
}

// ---------------------------------------------------------------------------
// src/components/PublicCompanyGate.tsx — every /t/[slug] page (companies)
// ---------------------------------------------------------------------------

export function renderPublicCompanyGate(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { cache, type ReactNode } from "react";
import { CompanyBrandBar, CompanyUnavailable, type PublicCompanyWire } from "${scope}/tenancy-widget";
import { publicCompanyToWire } from "${scope}/tenancy/server";
import { tenancy } from "@/server/tenancy";

/**
 * The ${noun} a web address names, looked up ONCE per page render: the page's
 * title (\`publicCompanyMetadata\`) and its body (\`PublicCompanyGate\`) both
 * ask, and React's \`cache\` makes the second ask free.
 */
const findPublicCompany = cache((slug: string) => tenancy.resolvePublicCompany(slug));

/**
 * A ${noun} page's tab title and link preview, in THE ${noun.toUpperCase()}'S name (Tenancy 2a
 * review T2A-BO-01): "Instant estimate · Green Acres", and \`openGraph.siteName\`
 * Green Acres — never this site's name. When Green Acres texts or posts its
 * booking link, the preview a customer sees is Green Acres'. \`title.absolute\`
 * skips the site's "%s · {site name}" template. Not indexed (D17), and every
 * page says so here, so none can forget.
 */
export async function publicCompanyMetadata(
  slug: string,
  page: string | null,
  options: { readonly description?: string; readonly noReferrer?: boolean } = {},
): Promise<Metadata> {
  const found = await findPublicCompany(slug);
  const name = found?.company.name ?? null;
  const title = name ? (page ? \`\${page} · \${name}\` : name) : (page ?? "Not found");
  const description = options.description ?? (name ? \`\${name}: \${page ?? "get in touch, get an estimate or book a visit online"}.\` : undefined);
  return {
    title: { absolute: title },
    ...(description ? { description } : {}),
    robots: { index: false, follow: false },
    ...(options.noReferrer ? { referrer: "no-referrer" as const } : {}),
    openGraph: {
      title,
      ...(description ? { description } : {}),
      ...(name ? { siteName: name } : {}),
      ...(found?.company.logoUrl ? { images: [{ url: found.company.logoUrl }] } : {}),
    },
    // X/Twitter reads its own block, and Next replaces nested metadata whole
    // rather than merging it, so without this the site-wide twitter block in
    // src/seo.ts wins and a shared Green Acres link previews as this site's
    // name and description. "summary", not the large card: a logo is small
    // and square, and the large card would stretch it into a banner.
    twitter: {
      card: "summary",
      title,
      ...(description ? { description } : {}),
      ...(found?.company.logoUrl ? { images: [found.company.logoUrl] } : {}),
    },
  };
}

/**
 * Every public page of a ${noun} starts here (Tenancy 2a): /t/{web address}
 * and the pages under it.
 *
 *   1. An unknown web address (or a deleted ${noun}) → "not found".
 *   2. An OLD web address (the ${noun} renamed itself) → a permanent redirect
 *      to the same page at the current one, query kept, so printed links and
 *      old emails keep working.
 *   3. The ${noun}'s name, logo and brand colour head the page
 *      (<CompanyBrandBar>) — here, on its public face, the colour is the point.
 *   4. A SUSPENDED ${noun}: "{Name} isn't taking requests online right now",
 *      and how to reach it (<CompanyUnavailable>). No widget mounts, so no
 *      request is made. (A runtime STATE, not a feature switch.)
 *   5. Otherwise, the page — handed the ${noun} as its public wire (no id).
 *
 * The APIs behind the pages refuse a suspended ${noun} as well, for an embed
 * on its own website or a page loaded before the suspension.
 *
 * THE ${noun.toUpperCase()}'S PAGE, NOT THIS SITE'S (review T2A-BO-01): the /t pages live in
 * the \`(company)\` route group, outside \`(site)\`, so a customer sees the
 * ${noun}'s bar and nothing of the platform — no site header, no "Sign in", no
 * footer inviting them to make an account, no link to this site's home page.
 */
export async function PublicCompanyGate(props: {
  /** The web address from the URL. */
  readonly slug: string;
  /** The path after /t/{web address}, for the old-address redirect, e.g. "/book-visit" ("" for the home). */
  readonly path: string;
  /** The page's search params, kept across that redirect. */
  readonly query?: Readonly<Record<string, string | string[] | undefined>>;
  readonly children: (company: PublicCompanyWire) => ReactNode;
}): Promise<ReactNode> {
  const found = await findPublicCompany(props.slug);
  if (!found) notFound();
  const company = publicCompanyToWire(found);
  if (found.retiredSlug !== null) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(props.query ?? {})) {
      for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, one);
    }
    const query = search.toString();
    permanentRedirect(\`\${company.publicPath}\${props.path}\${query ? \`?\${query}\` : ""}\`);
  }
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-6 sm:py-12">
      <CompanyBrandBar company={company} />
      <div className="mt-6">{company.status === "suspended" ? <CompanyUnavailable company={company} /> : props.children(company)}</div>
    </main>
  );
}
`;
}

// ---------------------------------------------------------------------------
// src/server/staff-access.ts — the staff ladder for invoicing/comms (single)
// ---------------------------------------------------------------------------

export function renderStaffAccess(answers: Answers): string {
  return `import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * Who may use a feature's staff screens in this single-business project: the
 * same ladder the admin shell climbs (Tenancy 2a, D12).
 *
 * A verified principal, then staff permissions resolved from THIS project's
 * tables (never from a session claim), then the staff key the package's
 * permission maps to — ONE KEY PER JOB, never \`staff.dashboard.view\` (the key
 * that only admits somebody to the shell) for everything. Nobody signed in is
 * a 401 the widgets show as "signed out"; signed in but not staff, or staff
 * without the key, is a 403.
 *
 * Invoicing and messages use it (src/server/invoicing.ts, src/server/comms.ts)
 * with their own key maps; the returned \`userId\` is who the ledger records as
 * having recorded a payment.
 */
export function authorizeStaffFor<P extends string>(
  keys: Readonly<Record<P, string>>,
  signedOut: string,
): (req: Request, permission: P, tenantId: string) => Promise<{ userId: string } | Response | false> {
  return async (_req, permission) => {
    const principal = await currentPrincipal();
    if (!principal) {
      return Response.json(
        { error: { code: "forbidden", message: signedOut } },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const can = await loadStaffPermissions({ principal });
    if (!can || !can.can(keys[permission])) return false;
    return { userId: principal.userId };
  };
}
`;
}

// ---------------------------------------------------------------------------
// src/server/invoicing.ts — the ledger's glue (both modes; variants)
// ---------------------------------------------------------------------------

/** The rate limits on a customer's invoice page, written into the glue in both modes. */
const INVOICING_RATE_LIMITS_SOURCE = `/**
 * How often one visitor may hit the customer's invoice page API:
 *
 *   read     120 a minute   opening an invoice
 *   viewed    30 an hour    "the customer opened it" (one per real visit)
 *
 * The token is a 43-character random key, so these bound how fast a script
 * can try, not whether it can guess; they count in Upstash when configured.
 */
export const INVOICING_RATE_LIMITS = {
  read: { limit: 120, windowMs: 60 * 1000 },
  viewed: { limit: 30, windowMs: 60 * 60 * 1000 },
} as const;

/**
 * The caller as the NEAREST proxy saw it: the last X-Forwarded-For entry (on
 * Vercel, the caller) — the rule scheduling's and the estimator's throttles
 * use, because the first entry is whatever the caller chose to send. Null with
 * no proxy in front (a laptop, the project's own tests): not limited.
 */
function callerKey(req: Request): string | null {
  const entries = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.at(-1) ?? null;
}`;

export function renderInvoicingGlue(answers: Answers): string {
  return companiesMode(answers) ? renderInvoicingCompanies(answers) : renderInvoicingSingle(answers);
}

function renderInvoicingCompanies(answers: Answers): string {
  const scope = answers.scope;
  const comms = answers.includeComms;
  const alerts = answers.includeNotifications;
  const noun = tenantLabel(answers).toLowerCase();
  // The zone a company with no zone of its own is dated in: the same starting
  // zone scheduling and the estimator fall back to (review T2A-BO-07), never
  // UTC, so its features agree on what day it is. Generated per feature set.
  const startingZones = [
    ...(answers.includeScheduling ? ["env.SCHEDULING_TIME_ZONE"] : []),
    ...(answers.includeEstimator ? ["env.ESTIMATOR_TIME_ZONE"] : []),
  ];
  const startingZone = [...startingZones, `"America/Denver"`].join(" ?? ");
  const imports = [
    `import {`,
    `  createInvoicingAdminHandlers,`,
    `  createInvoicingHandlers,`,
    ...(alerts ? [`  invoicingOverdueAlert,`, `  listOverdueInvoices,`] : []),
    `  readInvoicingDetails,`,
    ...(alerts ? [`  resolveInvoicingBusiness,`, `  type InvoicingAlertDraft,`] : []),
    `  type InvoicingBusiness,`,
    `  type InvoicingDelivery,`,
    `} from "${scope}/invoicing";`,
    ...(comms ? [`import { createInvoicingComms } from "${scope}/invoicing/comms";`] : []),
    `import { db } from "@/db";`,
    ...(startingZones.length > 0 ? [`import { env } from "@/env";`] : []),
    ...(alerts ? [`import { alertOnInvoicingEvent } from "@/server/alerts";`] : []),
    ...(comms ? [`import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";`] : []),
    `import { companyLinks } from "@/server/company-links";`,
    `import {`,
    `  admitPublic,`,
    `  companyAuthorizer,`,
    `  companyRoutes,`,
    `  publicCompanies,`,
    `  resolvePublicTenant,`,
    `  type FeatureHandlerOverrides,`,
    `} from "@/server/company-routes";`,
    `import { reportError } from "@/server/error-reporter";`,
    `import { log } from "@/server/logger";`,
    `import { limiter } from "@/server/rate-limit";`,
    `import { tenancy } from "@/server/tenancy";`,
  ];
  const commsBlock = comms
    ? `
/**
 * The invoice email, through comms: "Invoice INV-0042 from Green Acres", the
 * total and due date in the ${noun}'s currency and zone, the link to the
 * ${noun}'s own invoice page, and its payment instructions — sent FROM the
 * ${noun} (its name on this site's sending address, its reply-to). The token
 * in the link is replaced with ":token" in the delivery log right after
 * sending. The ${noun} edits the wording in Messages.
 */
export const invoicingComms = createInvoicingComms({
  db,
  senders: commsSenders,
  invoiceUrl: async (token, tenantId) => (await companyLinks(tenantId)).invoice(token),
  business: invoicingBusiness,
  onError: (error, context) => log.error({ err: error, ...context }, "invoicing: an email step failed"),
});

/**
 * Whether "Send" really emails (the ledger's notice says why not), in a
 * ${noun}'s words: it can't set this site's email key, so it isn't told
 * the key's name (review T2A-BO-05) — /setup tells you.
 */
export async function invoicingDelivery(_tenantId: string): Promise<InvoicingDelivery> {
  return commsEmailConfigured
    ? { emails: true, emailsOffReason: null }
    : {
        emails: false,
        emailsOffReason: "This site doesn't send email yet, so invoices aren't emailed. Copy the link and send it yourself.",
      };
}

/** A ${noun}'s invoice email template, added if absent (never over its edit). Logged, never fatal. */
export async function setupInvoicingFor(tenantId: string): Promise<void> {
  try {
    await invoicingComms.ensureTemplates(tenantId);
  } catch (error) {
    log.error({ err: error, tenantId }, "invoicing: a ${noun}'s invoice email template couldn't be added");
  }
}
`
    : `
/**
 * Whether "Send" emails: never in this project, which was generated without
 * messages (comms) — "Send" marks the invoice sent and says to copy the link.
 * \`add comms\` (and \`add email\`) wires the invoice email in.
 */
export async function invoicingDelivery(_tenantId: string): Promise<InvoicingDelivery> {
  return {
    emails: false,
    emailsOffReason: "This site was set up without customer emails, so invoices aren't emailed. Copy the link and send it yourself.",
  };
}

/** Nothing to set up per ${noun} without an invoice email to add. */
export async function setupInvoicingFor(_tenantId: string): Promise<void> {}
`;
  return `${imports.join("\n")}

/**
 * The app's side of ${scope}/invoicing in a COMPANIES project (Tenancy 2a): every
 * ${noun} keeps its own ledger, under its own id.
 *
 *   /app/invoices …                    the ${noun}'s own screens, over
 *   /api/app/{${noun} id}/invoices      the staff handler
 *   /t/{web address}/invoice/[token]    the customer's page, over
 *   /api/t/{web address}/invoices       the public handler
 *
 * The ${noun} is the one the path names, asked on every staff call whether the
 * caller may (\`invoices.view\`, \`invoices.manage\`, \`invoices.payments.record\`,
 * \`invoices.payments.reverse\`); an invoice token is read inside the ${noun}
 * whose web address is in the URL only (D13), so a Summit token under Green
 * Acres' address is "not available".
 */

${INVOICING_RATE_LIMITS_SOURCE}

/** The zone a ${noun} with no zone of its own starts in: the one its schedule and quotes start in. */
const STARTING_TIME_ZONE: string = ${startingZone};

/**
 * The ${noun} on its invoices: its name, contact, zone, logo and colour from
 * the ${noun} profile, and its invoice details — how customers pay it, how
 * many days until due, a footer note — from the Invoices section of
 * /settings/company. Read per request; nothing is copied.
 */
export async function invoicingBusiness(tenantId: string): Promise<InvoicingBusiness | null> {
  const profile = await tenancy.companyProfile(tenantId);
  if (!profile) return null;
  return {
    name: profile.name,
    // A ${noun} that hasn't set its zone yet is dated in the zone its schedule
    // and quotes start in — never UTC — so its features agree on what day an
    // invoice is due (review T2A-BO-07).
    timeZone: profile.timeZone ?? STARTING_TIME_ZONE,
    contactEmail: profile.contactEmail,
    contactPhone: profile.contactPhone,
    logoUrl: profile.logoUrl,
    brandColor: profile.brandColor,
    ...readInvoicingDetails(profile.settings.invoicing),
  };
}

/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportInvoicingError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "invoicing", route: context.route },
  });
}

/**
 * When an invoice raised now is due: the END of the day, in the ${noun}'s
 * time zone, its "invoices are due after N days" from today there. Code does
 * the date maths on the business's calendar, not the server's, so "due in 14
 * days" is the evening of the 14th day where the business is — the rule the
 * ledger's "New invoice" follows. (An accepted quote turned into an invoice
 * uses it: src/server/estimator-services.ts.)
 */
export function dueDateFor(business: Pick<InvoicingBusiness, "dueDays" | "timeZone">, now: Date = new Date()): Date {
  const zone = business.timeZone && isZone(business.timeZone) ? business.timeZone : "UTC";
  const today = wallClockIn(now, zone);
  const due = new Date(Date.UTC(today.year, today.month - 1, today.day + business.dueDays));
  return endOfDayIn(due.getUTCFullYear(), due.getUTCMonth() + 1, due.getUTCDate(), zone);
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date and clock time a moment reads as in a zone. */
function wallClockIn(at: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour") % 24,
    minute: part("minute"),
    second: part("second"),
  };
}

/** The instant that reads 23:59:59.999 on that date in the zone (a few corrections cover any offset or DST change). */
function endOfDayIn(year: number, month: number, day: number, zone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const seen = wallClockIn(new Date(guess), zone);
    const drift = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second, 999) - wanted;
    if (drift === 0) break;
    guess -= drift;
  }
  return new Date(guess);
}

/**
 * The customer page's throttle, PER ${noun.toUpperCase()}, on the app's shared limiter.
 * A request with no forwarded IP (a laptop, the project's own tests) is not
 * limited — the rule the tRPC ladder's anonymous floor follows.
 */
export async function invoicingRateLimit(req: Request, bucket: keyof typeof INVOICING_RATE_LIMITS): Promise<boolean> {
  const caller = callerKey(req);
  if (!caller) return true;
  const tenantId = (await publicCompanies.resolveTenant(req)) ?? "unknown";
  const result = await limiter.limit({ key: \`invoicing:\${tenantId}:\${bucket}:\${caller}\`, policy: INVOICING_RATE_LIMITS[bucket] });
  return result.allowed;
}
${commsBlock}${alerts ? `
/**
 * Invoices newly overdue, as alerts (Tenancy 2b-1, 11.2), for the alerts
 * cron's sweep (src/server/alerts.ts \`runAlertSweeps\`, which imports this
 * function DYNAMICALLY: this module imports company-routes, and alerts.ts must
 * not). In the ${noun}'s own zone and currency: "newly" is the last seven days
 * there, so the first run after deploy doesn't alert once per old invoice.
 */
export async function overdueInvoiceAlerts(
  tenantId: string,
  options: { readonly invoiceHref: string; readonly now?: Date },
): Promise<readonly InvoicingAlertDraft[]> {
  const business = resolveInvoicingBusiness(await invoicingBusiness(tenantId));
  const format = { currency: business.currency, locale: business.locale, timeZone: business.timeZone };
  const due = await listOverdueInvoices(db, tenantId, { now: options.now, timeZone: business.timeZone });
  return due.map((invoice) => invoicingOverdueAlert(tenantId, invoice, { hrefs: { invoice: options.invoiceHref }, format }));
}
` : ""}
/**
 * The staff side, for one ${noun} per request. \`overrides.principal\` is how
 * the project's isolation proof calls it as somebody else.
 *
 * "Copy link" and the email both use the ${noun}'s own invoice page. The
 * ledger's notice links to where the ${noun} fills in how customers pay it.
 */
export function buildInvoicingAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createInvoicingAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    business: invoicingBusiness,
    invoiceUrl: async (token, tenantId) => (await companyLinks(tenantId)).invoice(token),${comms ? "\n    sendInvoiceEmail: (input) => invoicingComms.sendInvoice(input)," : ""}
    delivery: (tenantId) => invoicingDelivery(tenantId),
    detailsHref: "/settings/company#invoicing",${alerts ? `
    // A customer opened an invoice, or a payment settled it: the alerts
    // (Tenancy 2b-1). Inside an arrow on purpose: alerts.ts and this module
    // import each other, and nothing here reads it at load (13.10 rule 3).
    onEvent: (event) => alertOnInvoicingEvent(event),` : ""}
    onError: reportInvoicingError,
  });
}

/** The customer side: the invoice whose token is in the path, inside the ${noun} whose web address is. */
export function buildInvoicingPublicHandlers() {
  return createInvoicingHandlers({
    db,
    resolveTenant: resolvePublicTenant,
    admit: admitPublic,
    business: invoicingBusiness,
    rateLimit: invoicingRateLimit,${alerts ? `
    // A customer opened an invoice, or a payment settled it: the alerts
    // (Tenancy 2b-1). Inside an arrow on purpose: alerts.ts and this module
    // import each other, and nothing here reads it at load (13.10 rule 3).
    onEvent: (event) => alertOnInvoicingEvent(event),` : ""}
    onError: reportInvoicingError,
  });
}
`;
}

function renderInvoicingSingle(answers: Answers): string {
  const scope = answers.scope;
  const comms = answers.includeComms;
  const alerts = answers.includeNotifications;
  // The zone the business's invoices are dated in: whichever of the features'
  // own starting zones this project has (generated), else Mountain Time.
  const zones = [
    ...(answers.includeScheduling ? ["env.SCHEDULING_TIME_ZONE"] : []),
    ...(answers.includeEstimator ? ["env.ESTIMATOR_TIME_ZONE"] : []),
  ];
  const zone = [...zones, `"America/Denver"`].join(" ?? ");
  const contact = answers.includeEmail ? "env.EMAIL_REPLY_TO ?? null" : "null";
  // Where the business's own details live, when a feature keeps them (review
  // T2A-BO-11): Schedule settings, else Estimate settings — what the owner
  // already edits in /admin. Generated per feature set; none → the constant.
  const detailsFrom: "scheduling" | "estimator" | null = answers.includeScheduling
    ? "scheduling"
    : answers.includeEstimator
      ? "estimator"
      : null;
  const imports = [
    `import {`,
    `  createInvoicingAdminHandlers,`,
    `  createInvoicingHandlers,`,
    ...(alerts ? [`  invoicingOverdueAlert,`, `  listOverdueInvoices,`, `  resolveInvoicingBusiness,`, `  type InvoicingAlertDraft,`] : []),
    `  type InvoicingBusiness,`,
    `  type InvoicingDelivery,`,
    `  type InvoicingPermission,`,
    `} from "${scope}/invoicing";`,
    ...(comms ? [`import { createInvoicingComms } from "${scope}/invoicing/comms";`] : []),
    ...(detailsFrom === "scheduling" ? [`import { getSchedulingSettings } from "${scope}/scheduling";`] : []),
    ...(detailsFrom === "estimator" ? [`import { getEstimatorSettings } from "${scope}/estimator";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    `import { SITE_NAME } from "@/seo";`,
    ...(alerts ? [`import { alertOnInvoicingEvent } from "@/server/alerts";`] : []),
    ...(comms ? [`import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(detailsFrom === "estimator" ? [`import { ESTIMATOR_TENANT } from "@/server/estimator-staff";`] : []),
    ...(comms || detailsFrom ? [`import { log } from "@/server/logger";`] : []),
    `import { limiter } from "@/server/rate-limit";`,
    ...(detailsFrom === "scheduling" ? [`import { SCHEDULING_TENANT } from "@/server/scheduling-staff";`] : []),
    `import { authorizeStaffFor } from "@/server/staff-access";`,
  ];
  const businessFn =
    detailsFrom === null
      ? `
/** The business on its invoices: INVOICING_BUSINESS (no feature here keeps its details). */
export async function invoicingBusiness(): Promise<InvoicingBusiness> {
  return INVOICING_BUSINESS;
}
`
      : `
/**
 * The business on its invoices, read per call (review T2A-BO-11): its name,
 * contact and time zone from ${detailsFrom === "scheduling" ? "Schedule settings (/admin/schedule/settings)" : "Estimate settings (/admin/estimator/settings)"} — where the
 * owner already keeps them, no developer needed — over INVOICING_BUSINESS. So
 * an invoice is signed with the name the owner chose, and "due in 14 days" ends
 * on the owner's own clock even after they change their zone. Until those
 * settings are saved once, INVOICING_BUSINESS stands in; a read that fails is
 * logged and INVOICING_BUSINESS is used.
 */
export async function invoicingBusiness(): Promise<InvoicingBusiness> {
  try {
    const settings = await ${detailsFrom === "scheduling" ? "getSchedulingSettings(db, SCHEDULING_TENANT)" : "getEstimatorSettings(db, ESTIMATOR_TENANT)"};
    if (!settings.saved) return INVOICING_BUSINESS;
    return {
      ...INVOICING_BUSINESS,
      name: settings.businessName.trim() || INVOICING_BUSINESS.name,
      timeZone: settings.timeZone,
      contactEmail: settings.contactEmail ?? INVOICING_BUSINESS.contactEmail,
      contactPhone: settings.contactPhone ?? INVOICING_BUSINESS.contactPhone,
    };
  } catch (error) {
    log.warn({ err: error }, "invoicing: couldn't read the business's details; using the site's own");
    return INVOICING_BUSINESS;
  }
}
`;
  const commsBlock = comms
    ? `
/**
 * The invoice email, through comms: "Invoice INV-0042 from" the site name, the
 * total and due date, the link to the customer's invoice page and how to pay.
 * The token in the link is replaced with ":token" in the delivery log right
 * after sending. The wording is edited in Messages (/admin/comms).
 */
export const invoicingComms = createInvoicingComms({
  db,
  senders: commsSenders,
  invoiceUrl: (token) => invoiceLink(token),
  business: () => invoicingBusiness(),
  onError: (error, context) => log.error({ err: error, ...context }, "invoicing: an email step failed"),
});

/** Whether "Send" really emails (the ledger's notice says why not). */
export async function invoicingDelivery(): Promise<InvoicingDelivery> {
  return commsEmailConfigured
    ? { emails: true, emailsOffReason: null }
    : {
        emails: false,
        emailsOffReason:
          "No email service is set up yet (RESEND_API_KEY), so invoices aren't emailed. Copy the link and send it yourself.",
      };
}
`
    : `
/**
 * Whether "Send" emails: never in this project, which was generated without
 * messages (comms) — "Send" marks the invoice sent and says to copy the link.
 */
export async function invoicingDelivery(): Promise<InvoicingDelivery> {
  return {
    emails: false,
    emailsOffReason: "This site was set up without customer emails, so invoices aren't emailed. Copy the link and send it yourself.",
  };
}
`;
  return `${imports.join("\n")}

/**
 * The app's side of ${scope}/invoicing for this single business (Tenancy 2a, D3):
 * the package's own handlers behind the ledger (/admin/invoices) and the
 * customer's invoice page (/invoice/[token]) — the same handlers every
 * company of a companies project runs on, so a fix to the ledger reaches this
 * project with \`pnpm update\` instead of being frozen into a copied page.
 */

/**
 * The one business this project invoices for — "primary", the same id as the
 * rest of the field-service features, so an estimate and the invoice it
 * becomes are found under one tenant.
 */
export const INVOICING_TENANT = "primary";

/**
 * The staff key each invoicing permission is checked against: ONE KEY PER JOB
 * (D12), never \`staff.dashboard.view\` for everything.
 *
 *   staff.invoices.view      the ledger and every invoice
 *   staff.invoices.manage    raise, edit, send and void invoices, and record
 *                            and reverse payments
 *
 * Declared in src/permissions/catalog.ts with the roles that hold them.
 */
export const INVOICING_STAFF_KEYS: Readonly<Record<InvoicingPermission, string>> = {
  "invoices.view": "staff.invoices.view",
  "invoices.manage": "staff.invoices.manage",
  "invoices.payments.record": "staff.invoices.manage",
  "invoices.payments.reverse": "staff.invoices.manage",
};

/**
 * The business on its invoices, before its own settings say otherwise. A
 * single-business site has no company settings page, so this is the site's
 * own name (what its header already says), its reply-to address, and the zone
 * its other features start in — and \`invoicingBusiness()\` below lays the
 * owner's own saved details over it. Editable invoice details (how customers
 * pay you, a footer) come with companies; here they are left blank. Change
 * them below if you like.
 */
export const INVOICING_BUSINESS: InvoicingBusiness = {
  name: SITE_NAME,
  timeZone: ${zone},
  contactEmail: ${contact},
  contactPhone: null,
  logoUrl: null,
  brandColor: null,
  paymentInstructions: null,
  dueDays: 14,
  footer: null,
};

${businessFn}
${INVOICING_RATE_LIMITS_SOURCE}

/** The customer's invoice page for a token, absolute: it leaves the site in an email. */
export function invoiceLink(token: string): string {
  const app = env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return new URL(\`invoice/\${encodeURIComponent(token)}\`, app.endsWith("/") ? app : \`\${app}/\`).toString();
}

/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportInvoicingError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "invoicing", route: context.route },
  });
}

/** The customer page's throttle. A request with no forwarded IP is not limited. */
export async function invoicingRateLimit(req: Request, bucket: keyof typeof INVOICING_RATE_LIMITS): Promise<boolean> {
  const caller = callerKey(req);
  if (!caller) return true;
  const result = await limiter.limit({ key: \`invoicing:\${bucket}:\${caller}\`, policy: INVOICING_RATE_LIMITS[bucket] });
  return result.allowed;
}
${commsBlock}${alerts ? `
/**
 * Invoices newly overdue, as alerts (Tenancy 2b-1, 11.2), for the alerts
 * cron's sweep (src/server/alerts.ts \`runAlertSweeps\`, which imports this
 * function DYNAMICALLY: this module imports alerts.ts back). In the
 * business's own zone: "newly" is the last seven days there.
 */
export async function overdueInvoiceAlerts(
  tenantId: string,
  options: { readonly invoiceHref: string; readonly now?: Date },
): Promise<readonly InvoicingAlertDraft[]> {
  const business = resolveInvoicingBusiness(await invoicingBusiness());
  const format = { currency: business.currency, locale: business.locale, timeZone: business.timeZone };
  const due = await listOverdueInvoices(db, tenantId, { now: options.now, timeZone: business.timeZone });
  return due.map((invoice) => invoicingOverdueAlert(tenantId, invoice, { hrefs: { invoice: options.invoiceHref }, format }));
}
` : ""}
/** The staff side: the ledger, on this project's staff keys. */
export function buildInvoicingAdminHandlers() {
  return createInvoicingAdminHandlers({
    db,
    tenantId: INVOICING_TENANT,
    authorize: authorizeStaffFor(INVOICING_STAFF_KEYS, "Sign in to see invoices."),
    business: () => invoicingBusiness(),
    invoiceUrl: (token) => invoiceLink(token),${comms ? "\n    sendInvoiceEmail: (input) => invoicingComms.sendInvoice(input)," : ""}
    delivery: () => invoicingDelivery(),${alerts ? `
    // A customer opened an invoice, or a payment settled it: the alerts
    // (Tenancy 2b-1). Inside an arrow on purpose: alerts.ts and this module
    // import each other, and nothing here reads it at load (13.10 rule 3).
    onEvent: (event) => alertOnInvoicingEvent(event),` : ""}
    onError: reportInvoicingError,
  });
}

/** The customer side: the invoice whose token is in the path. */
export function buildInvoicingPublicHandlers() {
  return createInvoicingHandlers({
    db,
    tenantId: INVOICING_TENANT,
    business: () => invoicingBusiness(),
    rateLimit: invoicingRateLimit,${alerts ? `
    // A customer opened an invoice, or a payment settled it: the alerts
    // (Tenancy 2b-1). Inside an arrow on purpose: alerts.ts and this module
    // import each other, and nothing here reads it at load (13.10 rule 3).
    onEvent: (event) => alertOnInvoicingEvent(event),` : ""}
    onError: reportInvoicingError,
  });
}
`;
}

// ---------------------------------------------------------------------------
// src/server/comms.ts — the Messages console's glue (both modes; variants)
// ---------------------------------------------------------------------------

export function renderCommsGlue(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const delivery = answers.includeEmail
    ? `/**
 * Whether email really leaves (the console's first card): only once
 * RESEND_API_KEY is set. Until then every message is logged "skipped".
 */
export async function commsDelivery(): Promise<CommsDelivery> {
  return commsEmailConfigured
    ? { emails: true, emailsOffReason: null }
    : { emails: false, emailsOffReason: ${companies ? '"This site doesn\'t send email yet, so nothing is emailed: each message is logged as skipped."' : '"No email service is set up yet (RESEND_API_KEY), so nothing is emailed: each message is logged as skipped."'} };
}`
    : `/**
 * Whether email really leaves: never in this project, which was generated
 * without the email package — every message is logged "skipped". \`add email\`
 * wires Resend in.
 */
export async function commsDelivery(): Promise<CommsDelivery> {
  return { emails: false, emailsOffReason: "This site was set up without email, so nothing is emailed: each message is logged as skipped." };
}`;
  const report = `/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportCommsError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({
    error,
    source: "route",
    tenantId: context.tenantId,
    context: { feature: "comms", route: context.route },
  });
}`;
  if (companies) {
    return `import { createCommsAdminHandlers, type CommsDelivery } from "${scope}/comms";
import { db } from "@/db";
import { afterCommsRun, commsBeforeSend } from "@/server/comms-hooks";
import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";
import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";
import { ensureCompanySetup } from "@/server/company-setup";
import { reportError } from "@/server/error-reporter";

/**
 * The app's side of ${scope}/comms's Messages console in a COMPANIES project
 * (Tenancy 2a): each ${noun}'s own email wording, its own delivery log, who its
 * emails go out as, and "Send what's due now" for its own queued messages —
 * at /api/app/{${noun} id}/messages, for /app/messages.
 *
 * The ${noun} is the one the path names, asked on every call (\`comms.view\` to
 * read, \`comms.manage\` to edit or send). A template only another ${noun} has
 * is "not found" here.
 */

${delivery}

${report}

/**
 * The console's handlers, for one ${noun} per request. \`overrides.principal\` is
 * how the project's isolation proof calls it as somebody else.
 *
 *   ensureTemplates   before the templates are listed: the ${noun}'s
 *                     first-time setup — every installed feature's emails
 *                     (visits, estimates, invoices) — so the owner can read
 *                     and edit them before the first one is sent. ONLY those:
 *                     comms' starter templates ("Booking confirmation",
 *                     "Review request") are not added, because nothing here
 *                     sends them, and an owner who reworded one would see no
 *                     effect (review T2A-BO-08).
 *   beforeSend /      "Send what's due now" runs through the cron's own hooks
 *   afterRun          (a reminder re-checked, its link minted, then scrubbed).
 */
export function buildCommsAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createCommsAdminHandlers({
    db,
    senders: commsSenders,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    ensureTemplates: (tenantId) => ensureCompanySetup(tenantId),
    beforeSend: commsBeforeSend,
    afterRun: afterCommsRun,
    delivery: () => commsDelivery(),
    onError: reportCommsError,
  });
}
`;
  }
  return `import { createCommsAdminHandlers, type CommsDelivery, type CommsPermission } from "${scope}/comms";
import { db } from "@/db";
import { afterCommsRun, commsBeforeSend, ensureProducerTemplates } from "@/server/comms-hooks";
import { COMMS_TENANT, commsEmailConfigured, commsSenders, ensureCommsTemplates } from "@/server/comms-senders";
import { reportError } from "@/server/error-reporter";
import { authorizeStaffFor } from "@/server/staff-access";

/**
 * The app's side of ${scope}/comms's Messages console for this single business
 * (Tenancy 2a, D3): the package's own handlers behind /admin/comms — the email
 * wording, the delivery log, and "Send what's due now" — instead of a tRPC
 * router and a copied page, so a fix reaches this project with \`pnpm update\`.
 */

/**
 * The staff key each messages permission is checked against: ONE KEY PER JOB
 * (D12), never \`staff.dashboard.view\` for everything.
 *
 *   staff.comms.view     the templates and the delivery log
 *   staff.comms.manage   edit a template, switch one off or on, send what's due
 */
export const COMMS_STAFF_KEYS: Readonly<Record<CommsPermission, string>> = {
  "comms.view": "staff.comms.view",
  "comms.manage": "staff.comms.manage",
};

${delivery}

${report}

/** The console's handlers, for the one business, on this project's staff keys. */
export function buildCommsAdminHandlers() {
  return createCommsAdminHandlers({
    db,
    senders: commsSenders,
    tenantId: COMMS_TENANT,
    authorize: authorizeStaffFor(COMMS_STAFF_KEYS, "Sign in to see messages."),
    // comms' own templates and every feature's (the visit, estimate and
    // invoice emails), added if absent — never over an owner's edit.
    ensureTemplates: async (tenantId) => {
      await ensureCommsTemplates(db);
      await ensureProducerTemplates(tenantId);
    },
    beforeSend: commsBeforeSend,
    afterRun: afterCommsRun,
    delivery: () => commsDelivery(),
    onError: reportCommsError,
  });
}
`;
}

// ---------------------------------------------------------------------------
// app/api/cron/comms/route.ts — the queue drain (both modes; variants)
// ---------------------------------------------------------------------------

export function renderCommsCron(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const drain = companies
    ? `    // EVERY ACTIVE ${noun.toUpperCase()}, and only those (D10): a suspended ${noun}'s
    // queued reminders wait — and after 48 hours expire instead of going out
    // late. One drain, claiming only these ${tenantLabelPlural(answers).toLowerCase()}' rows:
    //
    //   - ${tenantLabelPlural(answers).toUpperCase()} TAKE TURNS (review SEC-2A-01): with a list, comms
    //     claims every ${noun}'s oldest due message, then every ${noun}'s
    //     second, and so on — so when the time budget ends the run, what is
    //     left over is spread across the busiest ${tenantLabelPlural(answers).toLowerCase()}, never one quiet
    //     ${noun}'s only reminder stuck behind another's backlog of hundreds;
    //   - the row limit is high (1000) because the TIME budget is the real
    //     ceiling: each email is one call to Resend, so a run sends a few
    //     hundred at most. A platform whose ${tenantLabelPlural(answers).toLowerCase()} send more than that in a
    //     day needs this route run more often than daily (DEPLOYMENT.md);
    //   - a run that stops early is logged and reported to /admin/errors, and
    //     each ${noun}'s Messages screen says when its messages missed a run;
    //   - one bad row never stops the rest (each row has its own try/catch),
    //     each ${noun}'s emails go out under its own name and reply-to, and each
    //     is held to its sending allowance (src/server/comms-senders.ts).
    const result = await runDueMessages(db, commsSenders, {
      tenantIds: await tenancy.activeCompanyIds(),
      limit: 1000,
      timeBudgetMs: TIME_BUDGET_MS,
      beforeSend: commsBeforeSend,
    });
    if (result.stoppedEarly) {
      log.error({ processed: result.processed }, "comms cron: due messages were left for the next run (the time budget ran out)");
      void reportError({
        error: new Error(\`The comms cron ran out of time after \${result.processed} messages; the rest wait for the next run. Run it more often (DEPLOYMENT.md).\`),
        source: "route",
        tenantId: null,
        context: { feature: "comms", route: "cron:comms", processed: result.processed },
      });
    }`
    : `    const result = await runDueMessages(db, commsSenders, {
      timeBudgetMs: TIME_BUDGET_MS,
      beforeSend: commsBeforeSend,
    });`;
  return `import { NextResponse } from "next/server";
import { runDueMessages } from "${scope}/comms";
import { db } from "@/db";
import { env } from "@/env";
import { afterCommsRun, commsBeforeSend } from "@/server/comms-hooks";
import { commsSenders } from "@/server/comms-senders";${companies ? `\nimport { reportError } from "@/server/error-reporter";\nimport { log } from "@/server/logger";\nimport { tenancy } from "@/server/tenancy";` : ""}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The platform kills the function at this limit. The drain below stops
// claiming new rows well before it (timeBudgetMs), so a big backlog ends the
// run cleanly and the next tick picks up the rest — a row killed mid-send is
// reclaimed after ten minutes, but only a clean stop avoids that wait.
export const maxDuration = 60;
const TIME_BUDGET_MS = 45_000;

/**
 * Drains the scheduled-message queue — visit reminders, quote follow-ups.
 * GENERATED (Tenancy 2a), because ${companies ? `in a companies project it drains every active ${noun}'s queue and nobody else's` : "its tenant list differs between the two modes; this single-business project drains its one business's queue"}.
 *
 * Point a scheduler at it (Vercel Cron sends \`Authorization: Bearer
 * $CRON_SECRET\`) or call it with \`x-cron-secret\`. Refuses everything while
 * CRON_SECRET is unset, so an unconfigured deployment can't have its queue
 * drained by a stranger. SCHEDULED IN vercel.json, once a day at
 * ${commsRunAt()} UTC (Vercel Hobby); on Pro tighten it, or point any outside
 * scheduler at it every 15 minutes (DEPLOYMENT.md)${companies ? " — with more than a\n * handful of " + tenantLabelPlural(answers).toLowerCase() + ", once a day is not enough" : ""}. A reminder that waits
 * more than 48 hours past its time ends "expired" rather than going out days
 * late.
 *
 * NOT FOR IMMEDIATE MESSAGES. A message the customer is waiting for goes out
 * in the request that causes it (\`sendNow\`); only future messages are queued.
 *
 * RE-CHECKED AT SEND TIME through \`commsBeforeSend\`
 * (src/server/comms-hooks.ts): a reminder whose visit was moved or cancelled
 * is skipped, and the link it carries is minted fresh. \`afterCommsRun\` then
 * scrubs those links out of the delivery log — IN A \`finally\`, so a drain
 * that throws part-way still scrubs what it sent.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
${drain}
    return NextResponse.json(result);
  } finally {
    await afterCommsRun();
  }
}

export const GET = handle;
export const POST = handle;
`;
}

// ---------------------------------------------------------------------------
// Companies variants of the feature glue emit.ts renders for single mode
// ---------------------------------------------------------------------------

/** `src/server/scheduling-notify.ts`, companies mode. */
export function renderSchedulingNotifyCompanies(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const alerts = answers.includeNotifications;
  // ALERTS FIRST (Tenancy 2b-1, 4.5): the alert rows are written before the
  // office email, so the email finds them to claim. Inside an arrow on
  // purpose (13.10 rule 3): alerts.ts sits in the same import chain.
  const alertListener = alerts ? ["(event) => alertOnSchedulingEvent(event)"] : [];
  const header = `/**
 * Who hears about each visit, in every ${noun} — the listeners every scheduling
 * event is handed to, after the write that caused it has committed.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with. Add your own listener to LISTENERS (a Slack ping, a webhook); each is
 * awaited in turn, and one that throws is logged without stopping the others
 * or failing the customer's request.
 *
 * An event carries no manage token and no requester key, so it is safe to log
 * or forward as it is.
 */`;
  const dispatch = `
/** The \`onEvent\` both scheduling route handlers and the cron are given. Never throws. */
export async function onSchedulingEvent(event: SchedulingEvent): Promise<void> {
  for (const listener of LISTENERS) {
    try {
      await listener(event);
    } catch (error) {
      log.error({ err: error, eventId: event.id, type: event.type, tenantId: event.tenantId }, "a scheduling listener failed");
    }
  }
}
`;
  if (!answers.includeComms) {
    return `import type { DeliveryStatus, SchedulingEvent, SchedulingEventListener } from "${scope}/scheduling";
${alerts ? `import { alertOnSchedulingEvent } from "@/server/alerts";\n` : ""}import { log } from "@/server/logger";
import { schedulingDeliveryStatus } from "@/server/scheduling-config";

${header}

/**
 * ${alerts ? "THE ALERTS ONLY" : "EMPTY"}: ${answers.projectName} was generated without ${scope}/comms, so no
 * email is sent about a visit. Customers keep the manage link the booking page
 * hands them, and each ${noun} sees its requests in /app/schedule${alerts ? " — and its\n * people get the alerts (the bell), in the app" : ""}.
 * \`add comms\` (and \`add email\`) wires the emails in.
 */
const LISTENERS: readonly SchedulingEventListener[] = [${alertListener.join(", ")}];

/** False: the booking page promises no email and shows the manage link to keep instead. */
export const SCHEDULING_EMAILS_ENABLED: boolean = false;

/** No comms, so no email templates to add for a ${noun}. */
export async function ensureSchedulingEmailTemplates(_tenantId: string): Promise<void> {}

/** What a ${noun}'s schedule screens are told: no email leaves this project. */
export async function schedulingDelivery(_tenantId: string): Promise<DeliveryStatus> {
  return schedulingDeliveryStatus({
    commsInstalled: false,
    emailConfigured: false,
    cronSecretSet: false,
    reminderRuns: { dailyAtUtc: "00:00" },
    failedLastWeek: 0,
    overdueReminders: 0,
    overdueSince: null,
    timeZone: "UTC",
    audience: "company",
  });
}
${dispatch}`;
  }
  return `import { and, count, eq, gte, like, lt, min } from "drizzle-orm";
import { commsMessages, commsScheduled } from "${scope}/comms";
import { getSchedulingSettings, type DeliveryStatus, type SchedulingEvent, type SchedulingEventListener } from "${scope}/scheduling";
import { SCHEDULING_COMMS_REF_TYPE, createSchedulingCommsListener } from "${scope}/scheduling/comms";
import { db } from "@/db";
import { env } from "@/env";
import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";
${alerts ? `import { alertOnSchedulingEvent, officeRecipientsFor, officeSentFor } from "@/server/alerts";\n` : ""}import { companyLinks } from "@/server/company-links";
import { log } from "@/server/logger";
import { schedulingDeliveryStatus } from "@/server/scheduling-config";
import { tenancy } from "@/server/tenancy";

${header}

/**
 * When the comms cron runs: vercel.json's "/api/cron/comms" schedule, once a
 * day at ${commsRunAt()} UTC (Vercel Hobby). Each reminder is queued for the
 * last run at or before its time. Tighten the cron and change this to
 * \`{ everyMinutes: 15 }\` with it.
 */
const REMINDER_RUNS = { dailyAtUtc: "${commsRunAt()}" } as const;

/**
 * The visit emails, through ${scope}/comms — EACH ONE THE ${noun.toUpperCase()}'S
 * (Tenancy 2a, D8):
 *
 *   - its name, contact and time zone in every email, from the ${noun} profile
 *     (\`company\`);
 *   - every link to its own pages: the manage link to
 *     /t/{web address}/visit/…, "pick another time" to its booking page, and
 *     the office's link to its schedule through the switch route;
 *   - it goes out under its name with its reply-to (comms' sender identity,
 *     src/server/comms-senders.ts);
 *   - the office's notices (a new request, a customer's change) go to ${alerts ? `the
 *     people the ${noun} chose in Alert settings (its owner, at the business
 *     email, until it chooses; Tenancy 2b-1)` : `the
 *     addresses the ${noun} set in Schedule settings, else to the ${noun}'s
 *     own inbox — its contact email, else its owner`} — NEVER to the platform
 *     owner: one ${noun}'s leads are nobody else's.
 *
 * A link that can't be built (the ${noun} was deleted) leaves its line empty
 * and is logged; the email still goes.
 */
export const schedulingComms = createSchedulingCommsListener({
  db,
  senders: commsSenders,
  company: (tenantId) => tenancy.companyProfile(tenantId),
  manageUrl: async (token, tenantId) => (await companyLinks(tenantId)).manageVisit(token),
  bookUrl: async (tenantId) => (await companyLinks(tenantId)).bookVisit(),
  adminUrl: async (tenantId) => (await companyLinks(tenantId)).app("/app/schedule"),
  staffEmails: async (tenantId) => (await tenancy.companyProfile(tenantId))?.inbox ?? [],${alerts ? `
  // WHO GETS THE OFFICE EMAIL (Tenancy 2b-1, D6): the people Alert settings
  // name for visit requests and customers' changes, and their extra addresses — the ONE place the owner
  // chooses — each claimed once (src/server/alerts.ts \`officeRecipientsFor\`),
  // so the same event handed over twice is never two emails. The saved
  // per-feature list is no longer read; \`staffEmails\` above is read ONLY when
  // this throws (alerts unreachable), so the office still hears at the
  // business email (review BO-02).
  officeRecipients: (notice) => officeRecipientsFor(notice),
  // A failed office email goes back to the alerts cron, sent once as a team
  // alert (review BO-02).
  officeSent: (notice, result) => officeSentFor(notice, result),` : ""}
  reminderRuns: REMINDER_RUNS,
  onError: (error, context) => log.error({ err: error, ...context }, "scheduling: an email step failed"),
});

const LISTENERS: readonly SchedulingEventListener[] = [${[...alertListener, "schedulingComms.onEvent"].join(", ")}];

/**
 * Told to the booking widget through the public handler's \`emailsEnabled\`:
 * true only when an email would actually leave (RESEND_API_KEY set).
 */
export const SCHEDULING_EMAILS_ENABLED: boolean = commsEmailConfigured;

/** A ${noun}'s nine visit emails, added if absent (never over its edit). */
export async function ensureSchedulingEmailTemplates(tenantId: string): Promise<void> {
  await schedulingComms.ensureTemplates(tenantId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a ${noun}'s schedule screens are told — their banner, and whether they
 * offer "Email the customer": is the sender configured, is the cron allowed to
 * run, did THIS ${noun}'s visit emails fail this week, and are ITS reminders
 * sitting unsent past their time.
 */
export async function schedulingDelivery(tenantId: string): Promise<DeliveryStatus> {
  let failedLastWeek = 0;
  let overdueReminders = 0;
  let overdueSince: Date | null = null;
  let timeZone = "UTC";
  try {
    timeZone = (await getSchedulingSettings(db, tenantId)).timeZone;
    const [failed] = await db
      .select({ n: count() })
      .from(commsMessages)
      .where(
        and(
          eq(commsMessages.tenantId, tenantId),
          eq(commsMessages.status, "failed"),
          like(commsMessages.templateKey, "visit_%"),
          gte(commsMessages.createdAt, new Date(Date.now() - 7 * DAY_MS)),
        ),
      );
    failedLastWeek = Number(failed?.n ?? 0);
    const [late] = await db
      .select({ n: count(), oldest: min(commsScheduled.sendAt) })
      .from(commsScheduled)
      .where(
        and(
          eq(commsScheduled.tenantId, tenantId),
          eq(commsScheduled.status, "pending"),
          eq(commsScheduled.refType, SCHEDULING_COMMS_REF_TYPE),
          lt(commsScheduled.sendAt, new Date(Date.now() - 26 * 60 * 60 * 1000)),
        ),
      );
    overdueReminders = Number(late?.n ?? 0);
    overdueSince = late?.oldest ? new Date(late.oldest) : null;
  } catch (error) {
    log.warn({ err: error, tenantId }, "scheduling: couldn't read the delivery log for the staff banner");
  }
  return schedulingDeliveryStatus({
    commsInstalled: true,
    emailConfigured: commsEmailConfigured,
    cronSecretSet: Boolean(env.CRON_SECRET),
    reminderRuns: REMINDER_RUNS,
    failedLastWeek,
    overdueReminders,
    overdueSince,
    timeZone,
    // In a ${noun}'s words: it can't set this site's keys (review T2A-BO-05).
    audience: "company",
  });
}
${dispatch}`;
}

/** `src/server/estimator-notify.ts`, companies mode. */
export function renderEstimatorNotifyCompanies(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const alerts = answers.includeNotifications;
  // ALERTS FIRST (Tenancy 2b-1, 4.5), inside an arrow (13.10 rule 3).
  const alertListener = alerts ? ["(event) => alertOnEstimatorEvent(event)"] : [];
  const header = `/**
 * Who hears about each estimate, in every ${noun} — the listeners every
 * estimator event is handed to, after the write that caused it committed.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with. Add your own listener to LISTENERS; each is awaited in turn, and one
 * that throws is logged without stopping the others or failing the request.
 * An event carries no quote token and no cost, so it is safe to log.
 */`;
  const dispatch = `
/** The \`onEvent\` both estimator route handlers and the cron are given. Never throws. */
export async function onEstimatorEvent(event: EstimatorEvent): Promise<void> {
  for (const listener of LISTENERS) {
    try {
      await listener(event);
    } catch (error) {
      log.error({ err: error, eventId: event.id, type: event.type }, "an estimator listener failed");
    }
  }
}
`;
  if (!answers.includeComms) {
    return `import type { EstimatorDelivery, EstimatorEvent, EstimatorEventListener } from "${scope}/estimator";
${alerts ? `import { alertOnEstimatorEvent } from "@/server/alerts";\n` : ""}import { estimatorDeliveryStatus } from "@/server/estimator-config";
import { log } from "@/server/logger";

${header}

/**
 * ${alerts ? "THE ALERTS ONLY" : "EMPTY"}: ${answers.projectName} was generated without ${scope}/comms, so no
 * email is sent about an estimate. New leads wait in each ${noun}'s
 * /app/estimates${alerts ? " (and its people get the alerts, in the app)" : ""}, and staff copy a quote's link to the customer themselves.
 */
const LISTENERS: readonly EstimatorEventListener[] = [${alertListener.join(", ")}];

/** False: the estimate page promises no email. */
export const ESTIMATOR_EMAILS_ENABLED: boolean = false;

/** No comms, so no email templates to add for a ${noun}. */
export async function ensureEstimatorEmailTemplates(_tenantId: string): Promise<void> {}

/** What a ${noun}'s estimate screens are told: no email leaves this project. */
export async function estimatorDelivery(_tenantId: string): Promise<EstimatorDelivery> {
  return estimatorDeliveryStatus({ commsInstalled: false, emailConfigured: false, cronSecretSet: false, audience: "company" });
}
${dispatch}`;
  }
  const bookUrl = answers.includeScheduling
    ? "\n  bookUrl: async (estimate, tenantId) => (await companyLinks(tenantId)).bookVisit(estimate.id),"
    : "";
  return `import type { EstimatorDelivery, EstimatorEvent, EstimatorEventListener } from "${scope}/estimator";
import { createEstimatorCommsListener } from "${scope}/estimator/comms";
import { db } from "@/db";
import { env } from "@/env";
${alerts ? `import { alertOnEstimatorEvent, officeRecipientsFor, officeSentFor } from "@/server/alerts";\n` : ""}import { commsEmailConfigured, commsSenders } from "@/server/comms-senders";
import { companyLinks } from "@/server/company-links";
import { estimatorDeliveryStatus } from "@/server/estimator-config";
import { log } from "@/server/logger";
import { tenancy } from "@/server/tenancy";

${header}

/**
 * When the comms cron runs (vercel.json, daily at ${commsRunAt()} UTC): a
 * follow-up is queued for the last run at or before its day.
 */
const FOLLOW_UP_RUNS = { dailyAtUtc: "${commsRunAt()}" } as const;

/**
 * The estimate emails, through ${scope}/comms — EACH ONE THE ${noun.toUpperCase()}'S
 * (Tenancy 2a, D8): its name, contact and dates in its zone (\`company\`); the
 * quote link to /t/{web address}/quote/…; the office's link to the estimate
 * through the switch route${answers.includeScheduling ? "; \"pick a time for the work\" to its own booking page" : ""}; sent
 * under its name with its reply-to; and the new-lead notices to ${alerts ? "the people it\n * chose in Alert settings (its owner, at the business email, until it chooses;\n * Tenancy 2b-1)" : "the addresses\n * it set in Estimate settings, else its own inbox"} — never the platform owner.
 */
export const estimatorComms = createEstimatorCommsListener({
  db,
  senders: commsSenders,
  company: (tenantId) => tenancy.companyProfile(tenantId),
  quoteUrl: async (token, tenantId) => (await companyLinks(tenantId)).quote(token),
  adminEstimateUrl: async (estimateId, tenantId) =>
    (await companyLinks(tenantId)).app(\`/app/estimates/\${encodeURIComponent(estimateId)}\`),${bookUrl}
  staffEmails: async (tenantId) => (await tenancy.companyProfile(tenantId))?.inbox ?? [],${alerts ? `
  // WHO GETS THE OFFICE EMAIL (Tenancy 2b-1, D6): the people Alert settings
  // name for new estimate requests and quote answers, and their extra addresses — the ONE place the owner
  // chooses — each claimed once (src/server/alerts.ts \`officeRecipientsFor\`),
  // so the same event handed over twice is never two emails. The saved
  // per-feature list is no longer read; \`staffEmails\` above is read ONLY when
  // this throws (alerts unreachable), so the office still hears at the
  // business email (review BO-02).
  officeRecipients: (notice) => officeRecipientsFor(notice),
  // A failed office email goes back to the alerts cron, sent once as a team
  // alert (review BO-02).
  officeSent: (notice, result) => officeSentFor(notice, result),` : ""}
  followUpRuns: FOLLOW_UP_RUNS,
  onError: (error, context) => log.error({ err: error, ...context }, "estimator: an email step failed"),
});

const LISTENERS: readonly EstimatorEventListener[] = [${[...alertListener, "estimatorComms.onEvent"].join(", ")}];

/** Told to the estimate page: true only when an email would actually leave (RESEND_API_KEY set). */
export const ESTIMATOR_EMAILS_ENABLED: boolean = commsEmailConfigured;

/** A ${noun}'s seven estimate emails, added if absent (never over its edit). */
export async function ensureEstimatorEmailTemplates(tenantId: string): Promise<void> {
  await estimatorComms.ensureTemplates(tenantId);
}

/** What a ${noun}'s estimate screens are told: is the sender configured, may the follow-up cron run. */
export async function estimatorDelivery(_tenantId: string): Promise<EstimatorDelivery> {
  return estimatorDeliveryStatus({
    commsInstalled: true,
    emailConfigured: commsEmailConfigured,
    cronSecretSet: Boolean(env.CRON_SECRET),
    // In a ${noun}'s words: it can't set this site's keys (review T2A-BO-05).
    audience: "company",
  });
}
${dispatch}`;
}

/** `src/server/estimator-features.ts`, companies mode: where an estimate's booking button goes. */
export function renderEstimatorFeaturesCompanies(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  const fn = answers.includeScheduling
    ? `/**
 * Where "Book a visit to measure" (after a customer saves an estimate) and
 * "Pick a time for the work" (after they accept a quote) go: the ${noun}'s
 * OWN booking page, under its public address. The widget adds
 * ?estimate=<id>, so the visit is tied to the estimate and listed on it.
 */
export function estimateBookHref(publicPath: string): string | undefined {
  return \`\${publicPath}/book-visit\`;
}`
    : `/**
 * Where "Book a visit to measure" and "Pick a time for the work" would go.
 * Nowhere: ${answers.projectName} was generated without scheduling, so neither
 * button is shown — the customer is told the ${noun} will be in touch.
 * \`add scheduling\` points this at each ${noun}'s booking page.
 */
export function estimateBookHref(_publicPath: string): string | undefined {
  return undefined;
}`;
  return `/**
 * What this project's estimator is wired to, for each ${noun}'s public pages.
 *
 * Generated by create-adminigloo-app from the answers this project was created
 * with; \`add\` rewrites it when a feature it names is added later. Pure, so the
 * estimate page and the quote page can import it without pulling a database,
 * a model or a blob store into their render. Two variants and no \`if\`.
 */

${fn}
`;
}

// ---------------------------------------------------------------------------
// DEPLOYMENT.md — what a companies project's operator needs to know
// ---------------------------------------------------------------------------

/** Where DEPLOYMENT.md's generated notes go. */
export const COMPANY_CRONS_MARKER = "<!-- adminigloo:company-crons -->";
export const COMPANY_EMAIL_MARKER = "<!-- adminigloo:company-email -->";
/** Where the "run them every 15 minutes" example goes: it lists exactly this project's crons. */
export const PRO_CRONS_MARKER = "<!-- adminigloo:pro-crons -->";

/**
 * The template's single-business paragraphs, each between
 * `<!-- adminigloo:single:{name}:begin -->` and `…:end -->`: a single business
 * keeps them (markers stripped); a companies project gets its own words
 * instead (review TB-6). They name /admin paths, the staff Crew role and the
 * zone variables, none of which a companies project uses — and DEPLOYMENT.md
 * is what the developer setting up a buyer's site follows.
 */
export const DEPLOYMENT_SINGLE_REGIONS = ["estimator-setup", "scheduling-setup", "crews"] as const;
export type DeploymentRegion = (typeof DEPLOYMENT_SINGLE_REGIONS)[number];

/** Replace (or, with null, keep) one marked single-business region of DEPLOYMENT.md. */
export function replaceDeploymentRegion(text: string, name: DeploymentRegion, replacement: string | null): string {
  const begin = `<!-- adminigloo:single:${name}:begin -->\n`;
  const end = `\n<!-- adminigloo:single:${name}:end -->`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from < 0 || to < from) return text;
  const kept = replacement ?? text.slice(from + begin.length, to);
  return text.slice(0, from) + kept + text.slice(to + end.length);
}

export interface DeploymentNotes {
  readonly crons: string;
  readonly email: string;
  readonly proCrons: string;
  /** A companies project's words for each single-business region; null keeps the template's. */
  readonly regions: Readonly<Record<DeploymentRegion, string | null>>;
}

/**
 * DEPLOYMENT.md's Tenancy 2a notes, generated so a single-business project's
 * copy says nothing about companies and a companies project's says exactly
 * what its crons, emails, pages and roles do. Empty strings where they don't
 * apply.
 */
export function renderDeploymentCompanyNotes(answers: Answers): DeploymentNotes {
  const noun = tenantLabel(answers).toLowerCase();
  const plural = tenantLabelPlural(answers).toLowerCase();
  const companies = companiesMode(answers);

  // THE WHOLE ARRAY, every cron vercel.json has (review BUY-07): a reader
  // pastes this over vercel.json's `crons`, so a cron left out of it is a cron
  // switched off. The files cron stays once a day (its work is a daily
  // clean-up), at vercel.json's own schedule; versions.test-style drift is
  // caught by the generator test that compares the two.
  const proCronList: ReadonlyArray<{ readonly path: string; readonly schedule: string }> = [
    ...(answers.includeComms ? [{ path: "/api/cron/comms", schedule: "*/15 * * * *" }] : []),
    ...(answers.includeScheduling ? [{ path: "/api/cron/scheduling", schedule: "*/15 * * * *" }] : []),
    ...(answers.includeEstimator ? [{ path: "/api/cron/estimator", schedule: "*/15 * * * *" }] : []),
    // Tenancy 2b-1: alert emails retried within the hour.
    ...(answers.includeNotifications ? [{ path: "/api/cron/alerts", schedule: "*/15 * * * *" }] : []),
    // Tenancy 2b-1: the purge, the move to private, the private-store check.
    ...(answers.includeStorage ? [{ path: "/api/cron/files", schedule: "45 14 * * *" }] : []),
  ];
  const proCrons =
    proCronList.length > 0
      ? [
          "```json",
          '"crons": [',
          proCronList.map((cron) => `  { "path": "${cron.path}", "schedule": "${cron.schedule}" }`).join(",\n"),
          "]",
          "```",
          "",
          `That is the whole \`crons\` array: paste it over the one in \`vercel.json\`.${answers.includeStorage ? " The files cron stays once a day." : ""}`,
        ].join("\n")
      : "";

  const crons =
    companies && (answers.includeScheduling || answers.includeEstimator || answers.includeComms)
      ? `
**Every ${noun}, every run.** Each cron serves EVERY active ${noun}: the
scheduling and estimator crons process the ${plural} a few at a time, and the
comms drain sends every active ${noun}'s due messages and only theirs. A
suspended ${noun} is skipped — its reminders wait, and expire after 48 hours
rather than going out late. One ${noun}'s failure is reported in the run's
\`failed\` list (and the error log) while the rest still run. A run that reaches
its time budget lists the ${plural} it didn't reach in \`deferred\`, logs them as
an error and reports them to \`/admin/errors\`; the starting ${noun} is different
every run, so it is never the same ${plural} left out day after day.
${
  answers.includeComms
    ? `
**Once a day is not enough for many ${plural}.** The comms drain sends one
email per call to Resend, inside the 45 seconds the route allows itself — a few
hundred messages a run at most (Resend's default is about two requests a
second). On the daily Hobby schedule that is the most the WHOLE PLATFORM sends
in a day, across every ${noun}. The ${plural} take turns — each run sends every
${noun}'s oldest due message, then every ${noun}'s second, and so on — so a busy
${noun} never holds back a quiet one's only reminder; but anything left over
waits a day, and a reminder more than 48 hours late is dropped. Each ${noun}'s
Messages screen says when its messages missed a run, and the cron reports it
to \`/admin/errors\`. With more than a handful of ${plural}, run
\`/api/cron/comms\` every 15 minutes: Vercel Pro (the example above), or any
outside scheduler (cron-job.org, GitHub Actions, your own server) calling
\`https://<your site>/api/cron/comms\` with the header \`x-cron-secret:
<CRON_SECRET>\`. Then set \`REMINDER_RUNS\` (src/server/scheduling-notify.ts) and
\`FOLLOW_UP_RUNS\` (src/server/estimator-notify.ts) to \`{ everyMinutes: 15 }\`.
`
    : ""
}`
      : "";

  const email =
    companies && answers.includeComms && answers.includeEmail
      ? `
**Each ${noun}'s emails go out as the ${noun}.** Every customer email shows the
${noun}'s name on \`EMAIL_FROM\`'s address — the one sending domain you verify at
Resend serves every ${noun}, so verify it once — and its replies go to the
${noun}'s contact email (else its owner's), never to \`EMAIL_REPLY_TO\`. Office
notices (a new request, a new lead) go to ${
        answers.includeNotifications
          ? `the people the ${noun}'s owner names in Alert
settings (the owner's copy at the business email in ${noun} settings)`
          : `the addresses the ${noun} saved, else
to its own inbox`
      } — never to you — and a reply to one reaches the customer it is
about. Each ${noun} sees in Messages who its emails went out as.

**Each ${noun} has a sending allowance.** Because every ${noun}'s mail leaves
from your one domain, one ${noun} sending thousands of messages could get that
domain throttled or suspended for all of them. So each ${noun} may send 100
emails an hour and 500 a day (20 and 100 in its first week); past that its
emails are held — logged as held in its Messages, never lost from the queue —
and you are told in \`/admin/errors\`. Its team's own emails (office notices${answers.includeNotifications ? " and\nalert emails" : ""}) count apart, 60 an hour and 300 a day, so a busy morning never
holds a customer's invoice. The numbers are \`COMMS_SEND_ALLOWANCE\` in
\`src/server/comms-senders.ts\`; they count in Upstash once it is configured.
`
      : "";

  const estimatorSetup = companies
    ? `Each ${noun}'s tax rate, quote rules and who hears about new leads are set by
its owner in \`/app/estimates/settings\`; its name, contact, time zone, logo and
colour come from its ${noun} settings (\`/settings/company\`), typed once for every
feature. Until a ${noun} has saved its tax rate, its \`/t/{web address}/estimate\`
page says instant estimates aren't available and no quote can be sent. Its
price book starts empty: the owner builds it, or loads the sample for their
trade (lawn care, cleaning or ramps), at \`/app/price-book\`; every product
stays off the estimate page until the owner turns it on. Each ${noun}'s photo
reading is capped at a dollar a day, and the whole site at five
(\`ESTIMATOR_AI_CEILING_CENTS\` and \`ESTIMATOR_AI_SITE_CEILING_CENTS\` in
\`src/server/estimator-config.ts\`).

On their own website a ${noun} uses the button or page frame Estimate settings
gives it ("Your website"): plain HTML that works on Wix, Squarespace, WordPress
or any site. The keyed React component there is for React sites only, and
needs @adminigloo/estimator-widget — a private package your ${noun}'s developer
gets access to from you.`
    : null;

  const schedulingSetup = companies
    ? `Each ${noun}'s services, crews and hours are set by its owner in
\`/app/schedule/settings\`; its name, contact and time zone come from its ${noun}
settings (\`/settings/company\`). \`SCHEDULING_TIME_ZONE\` only chooses the zone a
${noun} starts in before its owner has set one. Online booking starts **off**,
and can't be switched on until the ${noun} has set its time zone — so nobody
books on a clock that isn't the business's; the ${noun}'s schedule lists what
is left to set up.`
    : null;

  const crews = companies
    ? `A crew member needs no developer. The owner invites them from the Team page
(\`/settings/team\`) as a **Crew member**: a ${noun} role whose only permission is
\`schedule.route\` — their crew's route for TODAY at \`/app/schedule/today\`,
Start, Complete and "Couldn't do it", nothing else (no other day, no calendar,
no settings, no Messages). When the ${noun} has a single crew with nobody on it,
they are put on it as they join; otherwise the schedule names them until the
owner picks their crew in Schedule settings → Crews ("Who opens this crew's
route").`
    : null;

  return { crons, email, proCrons, regions: { "estimator-setup": estimatorSetup, "scheduling-setup": schedulingSetup, crews } };
}

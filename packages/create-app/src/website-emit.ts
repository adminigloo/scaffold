/**
 * The Tenancy 2b-4a renderers for WEBSITE VISITS (--analytics):
 *
 *   src/server/website.ts            the glue between the project and
 *                                    @adminigloo/analytics + audience: the one
 *                                    analytics instance, one audience per
 *                                    company, and every handler's builder
 *   src/components/SiteAnalyticsSlot.tsx   this site's own beacon on its own
 *                                    pages, in EVERY project (two variants)
 *   app/api/cron/analytics/route.ts  the daily tidy-up: salts, retention, and
 *                                    each audience's rules re-applied
 *
 * Who counts whose visits:
 *
 *   each company's own   its pages here (/t/{web address}, the beacon in
 *                        <PublicCompanyGate>) and its own website (the
 *                        snippet, /api/w), read at /app/website over
 *                        /api/app/{id}/website and /api/app/{id}/audience
 *   this site's own      its own pages (the (site) layout's slot) and any
 *                        website it registers, read at /admin/analytics over
 *                        /api/admin/analytics and /api/admin/audience — "*"
 *
 * In its own module because emit.ts is long enough already (the
 * features-emit.ts precedent). No emitted `if` asks about an answer: the
 * file is written per mode; the `if`s that ARE emitted are about runtime data
 * (whose website a beacon is for, whether a crawler is asking), each saying so.
 */

import { tenantLabel, type Answers } from "./answers.js";
import { plansEnforced } from "./plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** Does this project count website visits? */
export function hasAnalytics(answers: Answers): boolean {
  return answers.includeAnalytics;
}

/** The parts both modes share: the secret, the people, the instance, this site's own handlers. */
function shared(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `/**
 * THIS SITE'S OWN numbers: the tenant its own beacon, reports and audience
 * use${companies ? ` — "*", which can never be a ${noun} id (those are UUIDs). Every
 * ${noun}'s numbers are under its own id` : " — the one business this project runs"}.
 */
export const SITE_ANALYTICS = ANALYTICS_PLATFORM_SITE;

/**
 * The day the visitor keys turn over on (each day's random salt), for every
 * beacon here. One zone for the whole site: a visitor key is only ever
 * compared within one day, so the zone decides only when "today" starts.
 */
export const ANALYTICS_SALT_ZONE = "UTC";

/**
 * Route shapes whose last segment is a customer's key (a quote, a visit, an
 * invoice, an invitation): collapsed before anything is stored, so a key never
 * sits in an analytics row. The package also redacts anything token-shaped.
 */
const PATH_PATTERNS: readonly PathPattern[] = [
  { pattern: /^\\/t\\/([^/]+)\\/(quote|visit|invoice)\\/[^/]+/, replace: "/t/$1/$2/:token" },
  { pattern: /^\\/(quote|visit|invoice|invite)\\/[^/]+/, replace: "/$1/:token" },
];

/**
 * The key the audience's visitor links and "leave this person out" marks are
 * made with: AUDIENCE_SECRET, else one made from CLERK_SECRET_KEY —
 * HMAC-SHA256(CLERK_SECRET_KEY, "adminigloo:audience:v1"), which a deployment
 * already requires — else, on a laptop with neither, a fixed local key.
 * Rotating Clerk's secret key (with no AUDIENCE_SECRET) means a person named
 * in a rule reaches only the visits made after the rotation.
 */
function audienceSecret(): string {
  if (env.AUDIENCE_SECRET) return env.AUDIENCE_SECRET;
  if (env.CLERK_SECRET_KEY) return createHmac("sha256", env.CLERK_SECRET_KEY).update("adminigloo:audience:v1").digest("hex");
  return "local-only-audience-key:3f9a7c2e5b1d8046";
}

/** Someone the audience asks about: their id, address, and whether they are one of this tenant's own. */
interface WebsitePerson extends AudienceUser {
  readonly id: string;
  readonly email: string | null;
  readonly internal: boolean;
}

/** Holds a staff role here (a firm-wide principal_role in the staff scope): the test /admin's layout uses. */
const isStaffSql = sql<boolean>\`exists (
  select 1 from \${principalRole}
  where \${principalRole.principalId} = \${users.id} and \${principalRole.scope} = 'staff' and \${principalRole.tenantId} = \${FIRM_WIDE}
)\`;

/** THIS SITE'S people: everyone with a staff role is its own (and BOOTSTRAP_ADMIN_EMAIL, before the grant lands). */
function sitePeople() {
  const bootstrap = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || null;
  const columns = { id: users.id, email: users.email, isStaff: isStaffSql };
  const person = (row: { id: string; email: string | null; isStaff: unknown }): WebsitePerson => ({
    id: row.id,
    email: row.email,
    internal: Boolean(row.isStaff) || (bootstrap !== null && row.email?.trim().toLowerCase() === bootstrap),
  });
  return {
    codeRule: "Anyone with a staff role on this site",
    getUser: async (id: string) => {
      const [row] = await db.select(columns).from(users).where(eq(users.id, id)).limit(1);
      return row ? person(row) : null;
    },
    // Everyone, deleted accounts included: a person named after they left
    // still had visits, and the rule should still find them.
    listUsers: async () => (await db.select(columns).from(users)).map(person),
  };
}
${companies ? companyPeople(answers) : ""}
/**
 * ONE AUDIENCE PER ${companies ? noun.toUpperCase() : "SITE"} (@adminigloo/audience 0.2): each one's rules,
 * marks and run history are its own, and its own people are left out of ITS
 * numbers only. The cookieless visitor key changes daily ("rotating"), so a
 * person rule reaches the days they were signed in. Links are pseudonymous:
 * a signed-in visit links that day's key to an HMAC of the person's id, never
 * the id. The non-production host default is off: a laptop's or a preview's
 * own visits are what the person testing it wants to see.
 */
export const audiences = createAudiences<WebsitePerson>({
  store: createDrizzleAudienceStore({ db }),
  secret: audienceSecret(),
  visitorIds: "rotating",
  link: "pseudonymous",
  defaults: { hosts: false },
  forTenant: (tenantId) => ({
    ...(${companies ? "tenantId === SITE_ANALYTICS ? sitePeople() : companyPeople(tenantId)" : "sitePeople()"}),
    isInternal: (person: WebsitePerson) => (person.internal ? ${companies ? `(tenantId === SITE_ANALYTICS ? "staff" : "team")` : `"staff"`} : false),
    sessions: audienceSessionsSource({ tenantId }),
    // "Internal rule added (…): 12 visits left out back to …", a note on the
    // trend chart, so a drop explains itself.
    annotate: async ({ at, label }) => {
      await analytics.addAnnotation({ tenantId, day: dayIn(at, ANALYTICS_SALT_ZONE), label, kind: "audience" });
    },
  }),
  // Intake never throws: a failure is reported here and the visit counts.
  onError: (error, where) => reportWebsiteError(error, { tenantId: null, route: \`audience:\${where}\` }),
});

/**
 * THE analytics instance: every beacon, report, conversion and the cron go
 * through it, with each tenant's audience. Crawler claims are checked against
 * the operators' published IP ranges (cached a day per server).
 */
export const analytics = createAnalytics({
  db,
  audience: (tenantId) => audiences.for(tenantId),
  crawlerVerifier: true,
});

/** An error the handlers didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
export function reportWebsiteError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "website", route: context.route } });
}

/**
 * Who is signed in, as this project's own user id — what the audience keys
 * people by. Cached a minute (a person's every page view would otherwise cost
 * the same lookup). Null for anyone signed out, and with no Clerk set up.
 */
const signedInCache = new Map<string, { readonly at: number; readonly id: string | null }>();
async function signedInUserId(): Promise<string | null> {
  if (!env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) return null;
  try {
    const { userId: externalId } = await auth();
    if (!externalId) return null;
    const hit = signedInCache.get(externalId);
    if (hit && Date.now() - hit.at < 60_000) return hit.id;
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.externalId, externalId)).limit(1);
    const id = row?.id ?? null;
    signedInCache.set(externalId, { at: Date.now(), id });
    if (signedInCache.size > 1000) signedInCache.delete(signedInCache.keys().next().value as string);
    return id;
  } catch {
    return null;
  }
}

/**
 * Every recorded page view asks the tenant's audience about the visit: its
 * own people are marked (left out of every number, kept in the table), the
 * rest count. The IP is matched against network rules in memory and dropped.
 */
async function observeVisit(visit: AnalyticsSessionContext): Promise<string | null> {
  return audiences.for(visit.tenantId).observe({
    visitorId: visit.visitorId,
    sessionId: visit.sessionId,
    userId: await signedInUserId(),
    host: visit.host,
    userAgent: visit.userAgent,
    headers: visit.headers,
    ip: visit.ip,
  });
}

/** The visitor's address, as this site's other limits read it (only ever inside a key). */
function visitorIp(req: Request): string | null {
  return clientIpFromHeaders(req.headers);
}

/** What every beacon endpoint here shares. */
const BEACON = {
  clientIp: visitorIp,
  resolveCountry: (req: Request) => req.headers.get("x-vercel-ip-country"),
  timeZone: ANALYTICS_SALT_ZONE,
  pathPatterns: PATH_PATTERNS,
  onSession: observeVisit,
  onError: (error: unknown, where: string) => reportWebsiteError(error, { tenantId: null, route: \`beacon:\${where}\` }),
};

/** This deployment's public address (NEXT_PUBLIC_APP_URL), as a host: none until it is set. */
function appHosts(): string[] {
  try {
    return env.NEXT_PUBLIC_APP_URL ? [new URL(env.NEXT_PUBLIC_APP_URL).host] : [];
  } catch {
    // A malformed address counts nothing here.
    return [];
  }
}

/**
 * The addresses this deployment's own pages are on: its public address
 * (NEXT_PUBLIC_APP_URL) and, in development on a laptop (not deployed, not a
 * production build), whatever address it is being run at — localhost on any
 * port. A production build run locally (\`next start\`) counts only the address
 * NEXT_PUBLIC_APP_URL names, like a deployed one. A beacon from anywhere else
 * is dropped.
 */
function ownHosts(req: Request): string[] {
  const hosts = new Set<string>(appHosts());
  if (!isDeployed() && process.env.NODE_ENV !== "production") {
    // The address the request came in on: Next names a laptop's server
    // "localhost" in the request's URL even when the browser is at 127.0.0.1,
    // so the Host header the browser sent is asked too.
    hosts.add(new URL(req.url).host);
    const asked = req.headers.get("host");
    if (asked) hosts.add(asked.toLowerCase());
  }
  return [...hosts];
}

/**
 * What a website may not be: this app's own address (its pages here are
 * already counted) and, on a deployed app, an address on someone's own
 * computer (localhost). On a laptop both are allowed, so a test site can be
 * counted.
 */
function websiteAddressRules() {
  return isDeployed() ? { hosts: appHosts(), local: true } : { hosts: [] };
}

/** The snippet's script, absolute: what a website's one pasted line loads. Null until this site knows its own address. */
function scriptUrl(): string | null {
  return env.NEXT_PUBLIC_APP_URL ? new URL("/api/w/v1/beacon.js", env.NEXT_PUBLIC_APP_URL).toString() : null;
}

/**
 * THIS SITE'S OWN pages' beacon (/api/analytics/v1/collect, from
 * <SiteAnalytics> in the (site) layout): every page view of this site,
 * counted for this site.
 */
export function buildSiteBeaconHandlers() {
  return createAnalyticsPublicHandlers({
    analytics,
    ...BEACON,
    resolveSite: (req) => ({ tenantId: SITE_ANALYTICS, siteId: null, allowedHosts: ownHosts(req) }),
  });
}

/**
 * THE staff keys this site's own numbers are checked against (both modes):
 *
 *   staff.analytics.view     the numbers, and the websites list
 *   staff.analytics.manage   add and remove this site's websites, "these are my visits"
 *   staff.audience.manage    who is left out of the numbers
 */
export const ANALYTICS_STAFF_KEYS: Readonly<Record<AnalyticsPermission, string>> = {
  "analytics.view": "staff.analytics.view",
  "analytics.manage": "staff.analytics.manage",
};
export const AUDIENCE_STAFF_KEYS: Readonly<Record<AudiencePermission, string>> = {
  "audience.manage": "staff.audience.manage",
};

/** THIS SITE'S OWN numbers and websites, for its staff (/admin/analytics over /api/admin/analytics). */
export function buildPlatformAnalyticsHandlers() {
  return createAnalyticsAdminHandlers({
    analytics,
    tenantId: SITE_ANALYTICS,
    authorize: authorizeStaffFor(ANALYTICS_STAFF_KEYS, "Sign in to see this site's visits."),
    timeZone: ANALYTICS_SALT_ZONE,
    scriptUrl: scriptUrl(),
    addressRules: websiteAddressRules,
    ownPages: () => ({ label: \`\${SITE_NAME}'s own pages\`, url: env.NEXT_PUBLIC_APP_URL ?? null }),
    clientIp: visitorIp,
    saltTimeZone: ANALYTICS_SALT_ZONE,
    onError: reportWebsiteError,
  });
}

/** Who is left out of THIS SITE'S OWN numbers, for its staff (/api/admin/audience). */
export function buildPlatformAudienceHandlers() {
  return createAudienceAdminHandlers({
    audienceFor: (tenantId) => audiences.for(tenantId),
    tenantId: SITE_ANALYTICS,
    authorize: authorizeStaffFor(AUDIENCE_STAFF_KEYS, "Sign in to change who is left out of this site's visits."),
    onError: reportWebsiteError,
  });
}

/**
 * A crawler reading one of this site's own pages (the proxy asks, after the
 * answer has gone — create-app 0.40), recorded for this site. Never fails the
 * request it describes; with no database there is nothing to record it in,
 * and nothing to report.
 */
export async function recordSiteCrawlerHit(input: { userAgent: string | null; path: string; ip: string | null; country: string | null }): Promise<void> {
  if (!isDbConfigured(db)) return;
  try {
    await analytics.recordCrawlerHit({ tenantId: SITE_ANALYTICS, ...input, pathPatterns: PATH_PATTERNS });
  } catch (error) {
    reportWebsiteError(error, { tenantId: SITE_ANALYTICS, route: "crawler" });
  }
}

/**
 * The daily tidy-up (app/api/cron/analytics): yesterday's salts deleted (after
 * which no stored key can be linked to anyone), past throttle windows emptied,
 * rows older than 13 months deleted — and each audience's rules re-applied, so
 * a person's devices linked since are left out too.
 */
export async function maintainWebsiteNumbers() {
  const maintenance = await analytics.runMaintenance({ timeZone: ANALYTICS_SALT_ZONE });
  const site = await audiences.for(SITE_ANALYTICS).maintain();
  return { maintenance, site };
}
`;
}

function companyPeople(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `
/**
 * A ${noun.toUpperCase()}'S people: its own team is everyone who has joined it (an active
 * member, any role) — their browsing is never the ${noun}'s numbers.
 *
 * ONLY ITS OWN PEOPLE ARE EVER READ: its members and the people it has
 * invited (an invitation it hasn't withdrawn, matched by email). A rule naming
 * an address finds that person only if they belong to this ${noun}; anyone else
 * — an account on another ${noun}, or on none — is never found, never counted
 * and never left out, so a rule's preview can't tell an owner whether an
 * address has an account anywhere else.
 */
function companyPeople(tenantId: string) {
  const isMember = sql<boolean>\`exists (
    select 1 from \${tenantMembers}
    where \${tenantMembers.tenantId} = \${tenantId} and \${tenantMembers.userId} = \${users.id} and \${tenantMembers.status} = 'active'
  )\`;
  const isInvited = sql<boolean>\`exists (
    select 1 from \${tenantInvitations}
    where \${tenantInvitations.tenantId} = \${tenantId} and \${tenantInvitations.email} = lower(trim(\${users.email})) and \${tenantInvitations.revokedAt} is null
  )\`;
  const belongs = sql\`(\${isMember} or \${isInvited})\`;
  const columns = { id: users.id, email: users.email, isMember };
  const person = (row: { id: string; email: string | null; isMember: unknown }): WebsitePerson => ({ id: row.id, email: row.email, internal: Boolean(row.isMember) });
  return {
    codeRule: "Everyone on your team (anyone who has joined the ${noun})",
    // Someone signed in: one of this ${noun}'s own, or nobody it can name.
    getUser: async (id: string) => {
      const [row] = await db.select(columns).from(users).where(sql\`\${users.id} = \${id} and \${belongs}\`).limit(1);
      return row ? person(row) : null;
    },
    // The rule says whom it names, so only they are read — and only among the
    // ${noun}'s own people. A pass over every rule at once (rule: null, the
    // daily job) reads them all.
    listUsers: async ({ rule }: { rule: { kind: string; value: string } | null }) => {
      const named =
        rule?.kind === "email"
          ? sql\`lower(\${users.email}) = \${rule.value.toLowerCase()}\`
          : rule?.kind === "email_domain"
            ? sql\`lower(\${users.email}) like \${\`%@\${rule.value.toLowerCase()}\`}\`
            : rule?.kind === "user"
              ? eq(users.id, rule.value)
              : sql\`true\`;
      return (await db.select(columns).from(users).where(sql\`\${named} and \${belongs}\`)).map(person);
    },
  };
}
`;
}

export function renderWebsiteGlue(answers: Answers): string {
  return companiesMode(answers) ? renderCompanies(answers) : renderSingle(answers);
}

function imports(answers: Answers, extra: { tenancy: boolean }): string {
  const scope = answers.scope;
  return [
    `import { createHmac } from "node:crypto";`,
    `import { auth } from "@clerk/nextjs/server";`,
    `import { eq, sql } from "drizzle-orm";`,
    `import {
  ANALYTICS_PLATFORM_SITE,
  audienceSessionsSource,
  createAnalytics,
  createAnalyticsAdminHandlers,
  createAnalyticsPublicHandlers,
  dayIn,
  type AnalyticsPermission,
  type AnalyticsSessionContext,
  type PathPattern,
} from "${scope}/analytics";`,
    `import {
  createAudienceAdminHandlers,
  createAudiences,
  createDrizzleAudienceStore,
  type AudiencePermission,
  type AudienceUser,
} from "${scope}/audience";`,
    `import { users } from "${scope}/auth/schema";`,
    `import { isDbConfigured } from "${scope}/db";`,
    `import { isDeployed } from "${scope}/env";`,
    `import { clientIpFromHeaders } from "${scope}/observability/request";`,
    `import { FIRM_WIDE } from "${scope}/permissions";`,
    `import { principalRole } from "${scope}/permissions/schema";`,
    ...(extra.tenancy ? [`import { tenantInvitations, tenantMembers } from "${scope}/tenancy/schema";`] : []),
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    `import { SITE_NAME } from "@/seo";`,
  ].join("\n");
}

function renderSingle(answers: Answers): string {
  const scope = answers.scope;
  return `${imports(answers, { tenancy: false })}
import { reportError } from "@/server/error-reporter";
import { authorizeStaffFor } from "@/server/staff-access";

/**
 * The app's side of ${scope}/analytics and ${scope}/audience for this single
 * business (Tenancy 2b-4a): ONE site — this one — counted the way
 * adminigloo.com counts its own. Its pages' visits arrive through the
 * beacon in the (site) layout; any other website it registers (a site on
 * Wix or WordPress) through the one line it pastes (/api/w). Its staff are
 * left out of the numbers, and its owner reads them at /admin/analytics. The
 * package's own handlers and screens, so a fix reaches this project with
 * \`pnpm update\`.
 */

${shared(answers)}
/**
 * Every website's beacon (/api/w/v1/collect?site=…, and the snippet's own
 * script at /api/w/v1/beacon.js): the key names the website, and the page
 * must be on one of its addresses.
 */
export function buildWebsiteBeaconHandlers() {
  return createAnalyticsPublicHandlers({ analytics, ...BEACON, resolveSite: analytics.siteResolver() });
}

/** The tenants the daily job re-applies rules for: this one business. */
export async function maintainEveryAudience() {
  return maintainWebsiteNumbers();
}
`;
}

function renderCompanies(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  return `${imports(answers, { tenancy: true })}
import { runForEachCompany } from "${scope}/tenancy/server";
import { admitPublic, companyAuthorizer, companyRoutes, resolvePublicTenant, type FeatureHandlerOverrides } from "@/server/company-routes";
import { companyLinksFor } from "@/server/company-links";
import { reportError } from "@/server/error-reporter";
import { websiteQuota } from "@/server/plan-gate";
import { authorizeStaffFor } from "@/server/staff-access";
import { tenancy } from "@/server/tenancy";

/**
 * The app's side of ${scope}/analytics and ${scope}/audience in a COMPANIES
 * project (Tenancy 2b-4a). One deployment counts every ${noun}'s visits:
 *
 *   its pages here       /t/{web address}: the beacon <PublicCompanyGate>
 *                        mounts posts to /api/t/{web address}/website — the
 *                        web address decides whose; a suspended ${noun}, or
 *                        one whose plan ended, isn't counted
 *   its own website      the one line it pastes (/app/website) loads
 *                        /api/w/v1/beacon.js, which posts to
 *                        /api/w/v1/collect?site={its key} — the key names the
 *                        website, and the page must be on one of the
 *                        website's addresses
 *   its numbers          /app/website over /api/app/{${noun} id}/website and
 *                        /audience — the id in the PATH decides, asked on
 *                        every call (analytics.view to look, analytics.manage
 *                        for its websites and "these are my visits",
 *                        audience.manage for who is left out); another
 *                        ${noun}'s website or rule is "not found"
 *   this site's own      its own pages and websites, at /admin/analytics,
 *                        on staff keys ("*")
 *
 * Each ${noun}'s own team is left out of its numbers (its audience), the
 * plan's websites are checked when one is added (src/server/plan-gate.ts), and
 * a closed plan keeps the numbers readable while adding websites waits.
 *
 * IMPORT ORDER: company-routes → company-setup → … → this module →
 * company-routes is a cycle by design, safe while every cross-module use
 * happens INSIDE a function (the builders run when a route file calls them).
 */

${shared(answers)}
/**
 * Is this website's ${noun} being counted? THIS SITE'S OWN websites always are
 * (runtime data: whose website the key names, not a feature switch); a
 * ${noun}'s, when it is taking requests (\`admitPublic\`: not suspended, its
 * plan open).
 */
async function admitWebsite(tenantId: string, req: Request): Promise<boolean> {
  if (tenantId === SITE_ANALYTICS) return true;
  return (await admitPublic(tenantId, req)).open;
}

/**
 * Every website's beacon (/api/w/v1/collect?site=…, and the snippet's own
 * script at /api/w/v1/beacon.js): a ${noun}'s own website or this site's.
 */
export function buildWebsiteBeaconHandlers() {
  return createAnalyticsPublicHandlers({ analytics, ...BEACON, resolveSite: analytics.siteResolver({ admit: admitWebsite }) });
}

/**
 * A ${noun}'s pages here (/api/t/{web address}/website/v1/collect): the web
 * address in the path names the ${noun}; the page must be on this deployment.
 */
export function buildCompanyBeaconHandlers() {
  return createAnalyticsPublicHandlers({
    analytics,
    ...BEACON,
    resolveSite: async (req) => {
      const tenantId = await resolvePublicTenant(req);
      if (tenantId === null) return null;
      if (!(await admitPublic(tenantId, req)).open) return null;
      // Only its own pages: /t/{the web address this beacon posted to} and
      // below — another ${noun}'s page posting here counts nothing.
      const slug = decodeURIComponent(new URL(req.url).pathname.split("/")[3] ?? "");
      return { tenantId, siteId: null, allowedHosts: ownHosts(req), pathPrefix: \`/t/\${slug}\` };
    },
  });
}

/**
 * A ${noun}'s numbers and websites, for its own people, one ${noun} per
 * request. \`overrides.principal\` is how the project's isolation proof calls
 * it as somebody else.
 */
export function buildAnalyticsAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createAnalyticsAdminHandlers({
    analytics,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    // The ${noun}'s own zone (company settings): its days start at its midnight.
    timeZone: async (tenantId) => (await tenancy.companyProfile(tenantId))?.timeZone ?? null,
    scriptUrl: scriptUrl(),
    addressRules: websiteAddressRules,
    // How many websites its plan includes (none in a project that doesn't sell plans).
    websiteLimit: (tenantId) => websiteQuota(tenantId),
    ownPages: async (tenantId) => {
      const profile = await tenancy.companyProfile(tenantId);
      return { label: \`Your pages on \${SITE_NAME}\`, url: profile ? companyLinksFor(profile.slug).home : null };
    },
    clientIp: visitorIp,
    saltTimeZone: ANALYTICS_SALT_ZONE,
    onError: reportWebsiteError,
  });
}

/** Who is left out of a ${noun}'s numbers, for its owners and admins. */
export function buildAudienceAdminHandlers(overrides: FeatureHandlerOverrides = {}) {
  return createAudienceAdminHandlers({
    audienceFor: (tenantId) => audiences.for(tenantId),
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    onError: reportWebsiteError,
  });
}

/**
 * A crawler reading one of a ${noun}'s pages here (<PublicCompanyGate> asks,
 * after the page is sent), recorded for that ${noun}. A website of its own
 * can't see crawlers: they don't run the snippet. Never fails the page.
 */
export async function recordCompanyCrawlerHit(
  tenantId: string,
  input: { userAgent: string | null; path: string; ip: string | null; country: string | null },
): Promise<void> {
  try {
    await analytics.recordCrawlerHit({ tenantId, ...input, pathPatterns: PATH_PATTERNS });
  } catch (error) {
    reportWebsiteError(error, { tenantId, route: "crawler" });
  }
}

/**
 * The daily job's second half: every active ${noun}'s rules re-applied (the
 * starting ${noun} differs every run; one ${noun}'s failure doesn't stop the
 * rest), after this site's own.
 */
export async function maintainEveryAudience() {
  const own = await maintainWebsiteNumbers();
  const companies = await runForEachCompany(tenancy, async (tenantId) => {
    await audiences.for(tenantId).maintain();
  }, {
    timeBudgetMs: 30_000,
    onError: (error, tenantId) => reportWebsiteError(error, { tenantId, route: "cron" }),
  });
  return { ...own, companies };
}
`;
}

// ---------------------------------------------------------------------------
// src/components/SiteAnalyticsSlot.tsx — every project
// ---------------------------------------------------------------------------

export function renderSiteAnalyticsSlot(answers: Answers): string {
  if (!answers.includeAnalytics) {
    return `import type { ReactNode } from "react";

/**
 * This site's own visit counter, on every page of the (site) layout. Nothing:
 * this project was generated without website visits (--analytics). GENERATED
 * in two variants; \`create-app add analytics\` writes the other.
 */
export function SiteAnalyticsSlot(): ReactNode {
  return null;
}
`;
  }
  return `import type { ReactNode } from "react";
import { SiteAnalytics } from "@/components/SiteAnalytics";

/**
 * This site's own visit counter (Tenancy 2b-4a), on every page of the (site)
 * layout: cookieless, honouring Global Privacy Control, Do Not Track and a
 * visitor's own opt-out (\`?analytics=off\`). Its signed-in screens are not
 * counted (src/components/SiteAnalytics.tsx), and its staff's visits are
 * left out of the numbers by the audience. GENERATED in two variants.
 */
export function SiteAnalyticsSlot(): ReactNode {
  return <SiteAnalytics />;
}
`;
}

// ---------------------------------------------------------------------------
// app/api/cron/analytics/route.ts
// ---------------------------------------------------------------------------

export function renderAnalyticsCron(answers: Answers): string {
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  return `import { NextResponse } from "next/server";
import { env } from "@/env";
import { log } from "@/server/logger";
import { maintainEveryAudience } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The daily website-numbers tidy-up (Tenancy 2b-4a):
 *
 *   1. yesterday's salts deleted — after which no stored visitor key can be
 *      linked to anyone, by anyone;
 *   2. past throttle windows emptied, and rows older than 13 months deleted;
 *   3. who is left out, re-applied: this site's own${companies ? ` and every active ${noun}'s
 *      (one ${noun}'s failure doesn't stop the rest)` : ""}, so a person's
 *      devices linked since are left out too.
 *
 * SCHEDULED IN vercel.json; refuses every call while CRON_SECRET is unset.
 */
async function handle(request: Request): Promise<Response> {
  const secret = env.CRON_SECRET;
  const provided =
    request.headers.get("x-cron-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await maintainEveryAudience();
  log.info({ maintenance: result.maintenance }, "analytics cron: tidied");
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;
`;
}

/** The websites quota (src/plans.ts) is sold only where plans are enforced AND visits are counted. */
export function websitesQuota(answers: Answers): boolean {
  return plansEnforced(answers) && answers.includeAnalytics;
}

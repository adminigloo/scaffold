/**
 * The Tenancy 2b-4a renderers for SEARCH BASICS (--seo): the same three files
 * every project has — src/seo.ts, app/robots.ts, app/sitemap.ts — written
 * on @adminigloo/seo instead of by hand, and, with companies, each company's
 * public pages put into search:
 *
 *   src/seo.ts       the site, defined once (its address, name, description,
 *                    whether this deployment may be indexed) and the ONE path
 *                    list robots.txt, the noindex tags and the sitemap share —
 *                    with each company's token pages (/t/{*}/quote …) private
 *   app/robots.ts    from that list, naming every AI crawler (the analytics
 *                    package's own list when it is installed)
 *   app/sitemap.ts   this site's own pages, and every active company's
 *                    public pages, read from the database per request
 *
 * A company's page's own title, canonical address and LocalBusiness details
 * are in src/components/PublicCompanyGate.tsx (features-emit.ts). Without
 * --seo, emit.ts writes today's hand-rolled versions and a company's pages
 * stay out of search (Tenancy 2a, D17).
 */

import { tenantLabel, tenantLabelPlural, type Answers } from "./answers.js";
import { displayNameOf, robotsDisallowed, sitemapPages } from "./emit.js";
import { plansEnforced } from "./plans-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** A company's token pages, by installed feature: each URL is one customer's key. */
export function companyTokenPaths(answers: Answers): string[] {
  return [
    ...(answers.includeEstimator ? ["/t/*/quote"] : []),
    ...(answers.includeScheduling ? ["/t/*/visit"] : []),
    ...(answers.includeInvoicing ? ["/t/*/invoice"] : []),
  ];
}

/** robots.txt's private list for the seo package: today's, with a company's token pages in place of all of /t/. */
function privatePaths(answers: Answers): string[] {
  const companies = companiesMode(answers);
  const list = robotsDisallowed(answers)
    .map((entry) => entry.path)
    .filter((path) => !(companies && path === "/t/"))
    // Sign-in and sign-up are fetched but not listed (noindex, below), so a
    // crawler sees their noindex.
    .filter((path) => path !== "/sign-in" && path !== "/sign-up");
  return [...list, ...(companies ? companyTokenPaths(answers) : [])];
}

export function renderSeoPackageModule(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  const publicPages = sitemapPages(answers).map((page) => page.path);
  const quoted = (list: readonly string[]) => list.map((path) => `    ${JSON.stringify(path)},`).join("\n");
  return `import type { Metadata } from "next";
import { definePaths, defineSite, siteMetadata as buildSiteMetadata } from "${scope}/seo";
import { resolveAppEnv } from "${scope}/env";
import { env } from "@/env";

/**
 * What this site is called and what it says it is — and everything search
 * engines and AI assistants read from it, through ${scope}/seo (Tenancy 2b-4a).
 *
 * SITE_NAME starts as the project's name, title-cased: make it the name your
 * customers know. SITE_DESCRIPTION is placeholder copy and the one string here
 * you must replace — what a search result, a shared link and an AI answer
 * quote: one sentence for a person who has never heard of this product.
 */
export const SITE_NAME = ${JSON.stringify(displayNameOf(answers.projectName))};

export const SITE_DESCRIPTION =
  "One sentence about what ${answers.projectName} does and who it is for. " +
  "Replace this: it is the line search results and shared links show.";

/**
 * May this deployment be indexed? PRODUCTION ONLY — \`resolveAppEnv()\`, which
 * calls an unlabelled production build "staging", never \`isDeployed()\`. ONE
 * value behind the robots meta tag, robots.txt and the sitemap, so the page
 * and the files can't disagree.
 */
export const INDEXABLE: boolean = resolveAppEnv() === "production";

/**
 * THE ONE PATH LIST: robots.txt, the noindex tags and the sitemap all read
 * it, so a page added here lands in all three and a private area can't be
 * listed in one and forgotten in another.
 *
 *   public    this site's own pages worth finding (the sitemap lists them)
 *   private   no crawler should fetch them: signed-in areas, the API,${companies ? `
 *             and each ${noun}'s token pages (\`/t/{*}/quote\` written with the
 *             plain asterisk: one ${noun}'s web address, any one) — each is one
 *             customer's key` : ""}
 *   noindex   fetched, never listed: the sign-in pages
 *${companies ? `
 * Each ${noun}'s other public pages (its home, estimate, booking and feedback
 * pages) are in no list: indexable, and listed by app/sitemap.ts from the
 * database.
 *` : ""}
 */
export const paths = definePaths({
  public: [
${quoted(publicPages)}
  ],
  private: [
${quoted(privatePaths(answers))}
  ],
  noindex: ["/sign-in", "/sign-up"],
});

/**
 * The site, defined once. A build without NEXT_PUBLIC_APP_URL (CI) still
 * loads, at localhost — which INDEXABLE already refuses.
 */
export const site = defineSite({
  url: env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  name: SITE_NAME,
  description: SITE_DESCRIPTION,
  indexable: INDEXABLE,
  // "Pricing · ${displayNameOf(answers.projectName)}", the brand once.
  titleSeparator: " · ",
  // A copy decision, made once (US English): change it with the rest of the copy.
  locale: "en_US",
  paths,
});

/**
 * Inherited by every page: the address relative share links resolve
 * against, the title, the description, the share card, and noindex off
 * production. NO canonical here, on purpose — a page sets its own, or every
 * page would point at the home page. (A page's own: \`pageMetadata(site, …)\`.)
 */
export const siteMetadata: Metadata = buildSiteMetadata(site) as Metadata;
`;
}

export function renderSeoRobots(answers: Answers): string {
  const scope = answers.scope;
  const crawlers = answers.includeAnalytics;
  return `import type { MetadataRoute } from "next";
import { robotsPolicy } from "${scope}/seo";
${crawlers ? `import { KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "${scope}/analytics/crawlers";\n` : ""}import { site } from "@/seo";

/**
 * /robots.txt, from the one path list in src/seo.ts (Tenancy 2b-4a).
 *
 * Off production it refuses everything. On production: \`Allow: /\`, each
 * private path blocked by whole segments (\`/admin\` never blocks
 * \`/admin-guide\`), and one group per AI crawler — training, AI search and
 * the assistants that fetch a page because a person asked — every one
 * allowed, so AI answers can find and quote this site. To refuse training
 * but keep answers: \`robotsPolicy(site, { ai: { training: "deny" } })\`.
 *${crawlers ? `
 * The bots are the installed analytics package's own list, so the crawlers
 * this site lets in and the crawlers its numbers count are one list.
 *` : ""}
 */
export default function robots(): MetadataRoute.Robots {
  return robotsPolicy(site${crawlers ? ", { crawlers: [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS] }" : ""}) as MetadataRoute.Robots;
}
`;
}

export function renderSeoSitemap(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const noun = tenantLabel(answers).toLowerCase();
  if (!companies) {
    return `import type { MetadataRoute } from "next";
import { pathEntries, sitemapEntries, toNextSitemap } from "${scope}/seo";
import { site } from "@/seo";

/**
 * /sitemap.xml: this site's public pages, from the one path list in
 * src/seo.ts (Tenancy 2b-4a). Absolute addresses on this site's own origin;
 * empty off production. No "last changed" date is made up: a page whose date
 * isn't known is listed without one.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return toNextSitemap(sitemapEntries(site, pathEntries(site))) as MetadataRoute.Sitemap;
}
`;
  }
  const plans = plansEnforced(answers);
  const estimator = answers.includeEstimator;
  const nouns = tenantLabelPlural(answers).toLowerCase();
  const imports = [
    `import type { MetadataRoute } from "next";`,
    `import { and, asc, eq, isNull } from "drizzle-orm";`,
    `import { isDbConfigured } from "${scope}/db";`,
    ...(estimator ? [`import { getEstimatorSettings, publicEstimatesOpen } from "${scope}/estimator";`] : []),
    `import { pathEntries, sitemapEntries, toNextSitemap, type SitemapEntryInput } from "${scope}/seo";`,
    `import { tenants } from "${scope}/tenancy/schema";`,
    `import { db } from "@/db";`,
    `import { site } from "@/seo";`,
    ...(plans ? [`import { planStandingOf } from "@/server/plan-gate";`] : []),
    `import { PUBLIC_COMPANY_PAGES } from "@/tenancy";`,
  ];
  return `${imports.join("\n")}

/** Read when asked, never at build: the ${nouns} change as they sign up. */
export const dynamic = "force-dynamic";

/** Past this many ${nouns}, split the sitemap (\`buildSitemaps\` in ${scope}/seo). */
const MAX_COMPANIES = 10_000;
/** How many ${nouns} are looked at side by side. */
const AT_ONCE = 20;
${plans ? `
/**
 * Is the ${noun} taking requests? Its plan open — one whose trial ended, or
 * that has no plan, is shut to the public, its pages noindex, so it isn't
 * listed either (the same rule <PublicCompanyGate> follows).
 */
async function open(tenantId: string): Promise<boolean> {
  return (await planStandingOf(tenantId)).open;
}
` : ""}
/**
 * A public page that is only worth listing once the ${noun} has set it up.
 * A page not named here is listed for every ${noun} taking requests.
 */
const READY: Readonly<Record<string, (tenantId: string) => Promise<boolean>>> = {${estimator ? `
  // The instant estimate answers customers only once it is switched on and
  // the business is set up (saved its estimate settings, with its name).
  "/estimate": async (tenantId) => publicEstimatesOpen(await getEstimatorSettings(db, tenantId)),` : ""}
};

/** The pages one ${noun} has to list: its home, and each public page it has set up. */
async function pagesOf(tenantId: string, slug: string): Promise<SitemapEntryInput[]> {${plans ? `
  if (!(await open(tenantId))) return [];` : ""}
  const paths = [""];
  for (const page of PUBLIC_COMPANY_PAGES) {
    const ready = READY[page.path];
    if (!ready || (await ready(tenantId))) paths.push(page.path);
  }
  return paths.map((path) => ({ url: \`/t/\${encodeURIComponent(slug)}\${path}\`, lastModified: null }));
}

/**
 * Every ${noun}'s public pages that are taking requests (Tenancy 2b-4a): its
 * home at /t/{web address} and each public page this site gives every ${noun}
 * (PUBLIC_COMPANY_PAGES) that it has set up. A suspended or deleted ${noun}
 * isn't listed${plans ? ", nor one whose plan has closed" : ""}; token pages never are (src/seo.ts
 * makes them private, and the sitemap refuses them). A database that can't be
 * read leaves them out rather than failing the file.
 */
async function companyPages(): Promise<SitemapEntryInput[]> {
  if (!isDbConfigured(db)) return [];
  try {
    const rows = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(and(eq(tenants.kind, "org"), isNull(tenants.suspendedAt), isNull(tenants.deletedAt)))
      .orderBy(asc(tenants.slug))
      .limit(MAX_COMPANIES);
    const out: SitemapEntryInput[] = [];
    for (let i = 0; i < rows.length; i += AT_ONCE) {
      const batch = await Promise.all(rows.slice(i, i + AT_ONCE).map(({ id, slug }) => pagesOf(id, slug)));
      for (const pages of batch) out.push(...pages);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * /sitemap.xml: this site's own public pages (the path list in src/seo.ts)
 * and every ${noun}'s that is taking requests. Absolute addresses on this
 * site's own origin; empty off production. A row that fails a check is
 * skipped, never a broken file.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries = sitemapEntries(site, [...pathEntries(site), ...(await companyPages())], { onInvalid: () => {} });
  return toNextSitemap(entries) as MetadataRoute.Sitemap;
}
`;
}

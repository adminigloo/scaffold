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
    ...(answers.includeBooking ? ["/t/*/book/manage"] : []),
    // Getting paid, part 2: the thank-you page names the customer's checkout.
    ...(answers.includeStore ? ["/t/*/store/thanks"] : []),
  ];
}

/** robots.txt's private list for the seo package: today's, with a company's token pages in place of all of /t/. */
export function privatePaths(answers: Answers): string[] {
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
  return `import type { Metadata } from "next";
import { defineSite, isIndexable, pageMetadata, siteMetadata as buildSiteMetadata, type PageInput } from "${scope}/seo";
import { resolveAppEnv } from "${scope}/env";
import { env } from "@/env";
import { paths } from "@/seo-paths";

/**
 * What this site is called and what it says it is — and everything search
 * engines and AI assistants read from it, through ${scope}/seo (Tenancy 2b-4a).
 *
 * SITE_NAME starts as the project's name, title-cased: make it the name your
 * customers know. SITE_DESCRIPTION is placeholder copy and the one string here
 * you must replace — what a search result, a shared link, llms.txt and an AI
 * answer quote: one sentence for a person who has never heard of this product.
 */
export const SITE_NAME = ${JSON.stringify(displayNameOf(answers.projectName))};

export const SITE_DESCRIPTION =
  "One sentence about what ${answers.projectName} does and who it is for. " +
  "Replace this: it is the line search results and shared links show.";

/**
 * A line this site has to carry wherever it describes itself, when it is built
 * around somebody else's work (create-app 0.43, from Hinderstap): "An
 * unofficial fan site; not affiliated with the author or publisher." llms.txt
 * and llms-full.txt print it under the summary, the footer shows it, and the
 * terms say it. Leave it undefined when the site is about your own work.
 */
export const SITE_DISCLAIMER: string | undefined = undefined;

/**
 * May this deployment be indexed? PRODUCTION ONLY — \`resolveAppEnv()\`, which
 * calls an unlabelled production build "staging", never \`isDeployed()\` — AND
 * ONLY AT A REAL PUBLIC ADDRESS (create-app 0.43): \`isIndexable\` refuses a
 * production build whose NEXT_PUBLIC_APP_URL is localhost, an IP address or a
 * *.vercel.app address, so a production whose app URL was never set can't put
 * its platform address in search. ONE value behind the robots meta tag,
 * robots.txt, the sitemap and llms.txt, so the page and the files can't
 * disagree. Every other host this production answers to (www., the project's
 * *.vercel.app aliases) is sent to NEXT_PUBLIC_APP_URL's by proxy.ts.
 */
export const INDEXABLE: boolean = isIndexable({ env: resolveAppEnv(), host: env.NEXT_PUBLIC_APP_URL ?? "" });

/**
 * THE ONE PATH LIST lives in src/seo-paths.ts (create-app 0.40), where the
 * proxy can read it without loading the environment: its public pages are
 * src/site-pages.ts's.${companies ? ` Each ${noun}'s other public pages (its home, estimate,
 * booking and feedback pages) are in no list: indexable, and listed by
 * app/sitemap.ts from the database.` : ""}
 */
export { paths };

/**
 * The share card every page without its own shows (create-app 0.40): the
 * route at app/og.png, a FIXED address — Next 16 serves a root
 * opengraph-image.tsx under a hashed name this record couldn't name.
 */
export const SHARE_IMAGE = { url: "/og.png", width: 1200, height: 630, alt: SITE_NAME } as const;

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
  image: SHARE_IMAGE,
  paths,
  disclaimer: SITE_DISCLAIMER,
  // Search Console's and Bing's HTML-tag verification (create-app 0.43): set
  // the tokens on production and press Verify. Empty is skipped.
  verification: { google: env.GOOGLE_SITE_VERIFICATION, bing: env.BING_SITE_VERIFICATION },
});

/**
 * Inherited by every page: the address relative share links resolve
 * against, the title, the description, the share card, and noindex off
 * production. NO canonical here, on purpose — a page sets its own, or every
 * page would point at the home page.
 */
export const siteMetadata: Metadata = buildSiteMetadata(site) as Metadata;

/**
 * A page's own metadata (create-app 0.40), what every generated public page
 * exports: \`export const metadata = metadataFor({ path: "/pricing", title:
 * "Pricing", description })\`. ${scope}/seo's \`pageMetadata\`: its canonical
 * is the page itself, the brand is in the title once, the share card is the
 * page's (\`image\`) or the site's, and noindex follows the path list and the
 * deployment. A page with its own opengraph-image.tsx passes \`ownImage: true\`.
 */
export function metadataFor(page: PageInput): Metadata {
  return pageMetadata(site, page) as Metadata;
}
`;
}

export function renderSeoRobots(answers: Answers): string {
  const scope = answers.scope;
  const crawlers = answers.includeAnalytics;
  return `import type { MetadataRoute } from "next";
import { robotsPolicy } from "${scope}/seo";
${crawlers ? `import { KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "${scope}/analytics/crawlers";\n` : ""}import { site } from "@/seo";

/**
 * /robots.txt, from the one path list in src/seo-paths.ts (Tenancy 2b-4a).
 *
 * Off production it refuses everything. On production: \`Allow: /\`, each
 * private path blocked by whole segments (\`/admin\` never blocks
 * \`/admin-guide\`), and every AI crawler — training, AI search and the
 * assistants that fetch a page because a person asked — named and allowed,
 * so AI answers can find and quote this site. ONE GROUP (create-app 0.40,
 * \`combine\`): the bots are listed in the \`*\` group itself, its rules
 * written once, where one group per bot repeated them all (a 900-line file).
 * To refuse training but keep answers:
 * \`robotsPolicy(site, { ai: { training: "deny" }, combine: true })\` (the
 * refused bots get one \`Disallow: /\` group of their own).
 *${crawlers ? `
 * The bots are the installed analytics package's own list, so the crawlers
 * this site lets in and the crawlers its numbers count are one list.
 *` : ""}
 */
export default function robots(): MetadataRoute.Robots {
  return robotsPolicy(site, { ${crawlers ? "crawlers: [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS], " : ""}combine: true }) as MetadataRoute.Robots;
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
import { dynamicPages } from "@/dynamic-pages";
import { site } from "@/seo";

/**
 * /sitemap.xml: this site's public pages, from the one path list
 * (src/seo-paths.ts, whose public pages are src/site-pages.ts's), and the
 * database-backed ones (src/dynamic-pages.ts). Absolute addresses on this
 * site's own origin; empty off production. No "last changed" date is made
 * up: a page whose date isn't known is listed without one, and a private
 * page is never listed.
 *
 * CACHED FOR AN HOUR, then built again (create-app 0.40): without it Next
 * builds this once, at \`next build\`, and the database-backed pages freeze.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const more = await dynamicPages().catch(() => []);
  const pages = more.map((page) => ({ url: page.path, lastModified: page.lastModified ?? null }));
  return toNextSitemap(sitemapEntries(site, [...pathEntries(site), ...pages], { onInvalid: () => {} })) as MetadataRoute.Sitemap;
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
    `import { dynamicPages } from "@/dynamic-pages";`,
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
  // And the database-backed pages of this site's own (src/dynamic-pages.ts, create-app 0.40).
  const more = (await dynamicPages().catch(() => [])).map((page) => ({ url: page.path, lastModified: page.lastModified ?? null }));
  const entries = sitemapEntries(site, [...pathEntries(site), ...more, ...(await companyPages())], { onInvalid: () => {} });
  return toNextSitemap(entries) as MetadataRoute.Sitemap;
}
`;
}

// ---------------------------------------------------------------------------
// IndexNow (create-app 0.43, from Hinderstap)
// ---------------------------------------------------------------------------

/** app/indexnow-key.txt/route.ts: the key file, at an address that never changes. */
export function renderIndexNowKeyRoute(answers: Answers): string {
  const scope = answers.scope;
  return `import { indexNowKeyFile, isIndexNowKey } from "${scope}/seo";
import { env } from "@/env";

/**
 * INDEXNOW'S KEY FILE (create-app 0.43). The engines fetch it to check that a
 * submission really comes from this site, and \`pnpm seo:indexnow\` names it as
 * the key's location, so it lives at this one fixed address rather than at
 * /{key}.txt. Its folder is the site's root, so it covers every page.
 *
 * Public by design: the key is published here and in every submission. Unset
 * (INDEXNOW_KEY), it is a 404 and the script refuses.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  const key = env.INDEXNOW_KEY;
  if (!key || !isIndexNowKey(key)) {
    return new Response("Not found\\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const file = indexNowKeyFile(key);
  return new Response(file.body, { headers: { "Content-Type": file.contentType, "Cache-Control": "public, max-age=3600" } });
}
`;
}

/** scripts/indexnow.ts: announce the live site's pages, by hand, after a launch. */
export function renderIndexNowScript(answers: Answers): string {
  const scope = answers.scope;
  return `/**
 * Tell Bing, Yandex, Seznam, Naver and the other IndexNow engines about every
 * page the LIVE site's sitemap lists (create-app 0.43, from Hinderstap). Google
 * doesn't take part; it reads the sitemap.
 *
 *   pnpm seo:indexnow --origin https://example.com --dry-run   what would be sent
 *   pnpm seo:indexnow --origin https://example.com             send it
 *
 * BY HAND, AFTER A LAUNCH, NEVER AUTOMATICALLY: once when the production site
 * is live, then after a batch of new pages if you like. Engines throttle a host
 * that submits too often (a 429), so not on every deploy.
 *
 * PRODUCTION ONLY, three ways. It needs the production origin said out loud
 * (--origin). It sends only what that live site's sitemap lists, and the
 * sitemap is empty on any deployment that isn't production. And it checks the
 * live key file (/indexnow-key.txt) answers with this key before sending,
 * because an engine that can't read it answers 403.
 *
 * WHAT IT SENDS is filtered again through the one path list (src/seo-paths.ts):
 * \`submitUrls\` throws on a private page and leaves a noindex one out.
 *
 * THE KEY is INDEXNOW_KEY, from the environment or .env.local: the same value
 * production serves. It is public by design.
 */
import { defineSite, indexNowKeyFile, isIndexNowKey, submitUrls } from "${scope}/seo";
import { paths } from "../src/seo-paths";

/** At most this many sitemap files are read: an index, then the sitemaps it names. */
const MAX_SITEMAPS = 50;

/** The key file's fixed address (app/indexnow-key.txt/route.ts). */
const KEY_LOCATION = "/indexnow-key.txt";

// tsx does not read .env.local; Node does, when asked. Missing is fine: the
// key can come from the environment.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local.
}

function fail(message: string): never {
  console.error(\`indexnow: \${message}\`);
  process.exit(1);
}

/** Every <loc> in a sitemap, or in each sitemap a sitemap index names. */
async function sitemapUrls(url: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(url) || seen.size >= MAX_SITEMAPS) return [];
  seen.add(url);
  const res = await fetch(url, { headers: { accept: "application/xml" } });
  if (!res.ok) fail(\`\${url} answered \${res.status}\`);
  const xml = await res.text();
  // XML's five escapes, &amp; last so "&amp;lt;" stays "&lt;".
  const locs = [...xml.matchAll(/<loc>\\s*([^<]+?)\\s*<\\/loc>/g)].map((m) =>
    m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"),
  );
  if (!/<sitemapindex[\\s>]/.test(xml)) return locs;
  const nested: string[] = [];
  for (const loc of locs) nested.push(...(await sitemapUrls(loc, seen)));
  return nested;
}

function argument(name: string): string | undefined {
  const args = process.argv.slice(2);
  const inline = args.find((arg) => arg.startsWith(\`--\${name}=\`));
  if (inline) return inline.slice(name.length + 3);
  const at = args.indexOf(\`--\${name}\`);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    console.log("pnpm seo:indexnow --origin https://example.com [--dry-run]");
    return;
  }
  const raw = argument("origin");
  if (!raw) fail("say which live site to announce: --origin https://example.com (this runs by hand, after a launch).");
  let origin: string;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") fail(\`\${raw} is not https: announce the production site.\`);
    origin = parsed.origin;
  } catch {
    fail(\`\${raw} is not a web address.\`);
  }
  const key = process.env.INDEXNOW_KEY?.trim() ?? "";
  if (!isIndexNowKey(key)) fail("INDEXNOW_KEY is missing or malformed (8 to 128 letters, digits or dashes; the same value production serves).");

  const file = indexNowKeyFile(key);
  const live = await fetch(\`\${origin}\${KEY_LOCATION}\`, { redirect: "manual" }).catch(() => null);
  if (!live || live.status !== 200) fail(\`\${origin}\${KEY_LOCATION} answered \${live ? live.status : "nothing"}: set INDEXNOW_KEY on production first.\`);
  if ((await live.text()).trim() !== file.body) fail(\`\${origin}\${KEY_LOCATION} holds a different key from INDEXNOW_KEY here.\`);

  const urls = await sitemapUrls(\`\${origin}/sitemap.xml\`);
  if (urls.length === 0) fail(\`\${origin}/sitemap.xml lists nothing: is it the production site?\`);
  const site = defineSite({ url: origin, name: origin, indexable: true, paths });
  if (args.has("--dry-run")) {
    console.log(\`indexnow: would send \${urls.length} URLs from \${origin}:\`);
    for (const url of urls) console.log(\`  \${url}\`);
    return;
  }
  const result = await submitUrls(site, urls, { key, keyLocation: KEY_LOCATION });
  for (const batch of result.batches) console.log(\`indexnow: \${batch.count} URLs, answered \${batch.status ?? "nothing"}\${batch.error ? \` (\${batch.error})\` : ""}\`);
  if (result.excluded?.length) console.log(\`indexnow: left out \${result.excluded.length} noindex URLs\`);
  if (!result.ok) process.exit(1);
  console.log(\`indexnow: sent \${result.submitted} URLs\`);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
`;
}

/** docs/content-for-answer-engines.md: the prose the package can't write for you (create-app 0.43). */
export function renderAnswerEngineGuide(): string {
  return `# Writing pages that search and AI answers quote

The SEO package writes the plumbing: titles, canonicals, JSON-LD, robots,
sitemap, llms.txt. It deliberately writes no prose. What wins a search result or
an AI answer is the text on the page, and these are the habits that worked on
Hinderstap's guide pages (its keepers' pages ranked on the books' own names):

1. **Lead with the answer.** The first paragraph answers the question the page
   is named for ("What is X?") in two or three plain sentences. Answer engines
   quote first paragraphs; a lead that warms up first gets skipped.
2. **An FAQ in the questions people actually type.** Not "Our mission"; "How
   many books are there?", "Where do I start?". Put the same list in the page
   and in \`webPage({ faq })\`, so the FAQ markup and the visible text never
   disagree.
3. **Facts stated plainly, with where they come from.** A date, a count, a
   name, and the source (a chapter, a page, a dataset). A claim an answer engine
   can check is a claim it repeats.
4. **Label what you made up.** A fan site's invented characters, a product's
   roadmap, an estimate: say so in the sentence. Mixing invention into fact is
   how a page gets quoted wrongly, and then not at all.
5. **One page per question worth asking.** A guide, a glossary entry, a dated
   archive page: each its own address, title and summary, in the sitemap and in
   llms-full.txt (src/site-pages.ts, src/dynamic-pages.ts). A daily archive is a
   promise of permanent addresses: never delete what became a public page.
6. **The summary is the page's elevator line.** It's the meta description, the
   llms.txt line and the standfirst above the body in llms-full.txt. Write it
   for someone who has never heard of the site.
7. **Somebody else's world? Say whose.** Set \`SITE_DISCLAIMER\` in src/seo.ts
   ("An unofficial fan site; not affiliated with …"): the footer and both llms
   files carry it.
`;
}

/**
 * SEO BY DEFAULT (create-app 0.40), in EVERY project — the parts the review of
 * the founder's Almanac found missing or hand-written ("Fix in AdminIgloo",
 * item 9):
 *
 *   src/brand.ts                the brand colours, for what can't read CSS
 *   src/brand-images.tsx        the mark (the name's first letter on the brand
 *                               colour) and the default share card
 *   app/icon.tsx                the browser-tab icon (Next writes the tag)
 *   app/apple-icon.tsx          the home-screen icon on an iPhone
 *   app/icon-192.png, -512.png  the install manifest's icons, at fixed addresses
 *   app/manifest.ts             /manifest.webmanifest: name, colours, icons
 *   app/og.png/route.ts         the site's default share card at a FIXED address
 *                               (Next 16 serves a root opengraph-image under a
 *                               hashed name the site record can't name)
 *   src/site-pages.ts           this site's public pages, ONE list: the sitemap,
 *                               llms.txt and llms-full.txt read it, and with
 *                               --seo src/seo-paths.ts's public list is it
 *   src/dynamic-pages.ts        `dynamicPages()`: database-backed pages, added
 *                               to the sitemap and llms.txt in one place
 *   src/seo-paths.ts            the private and noindex paths, with no
 *                               environment and no database, so the proxy can
 *                               read them: `robotsHeaderFor(path)`
 *   proxy.ts                    X-Robots-Tag from that list on every answer,
 *                               and (with --analytics) every AI crawler's read
 *                               logged after the answer, a person costing one
 *                               user-agent test
 *   src/llms.ts, app/llms.txt   llms.txt from the same site record and page
 *   app/llms-full.txt           list, and llms-full.txt next to it
 *
 * Two variants where --seo changes the answer (the package's builders, or the
 * project's own thinner versions); no emitted file asks which.
 */
import { personEmails, type Answers } from "./answers.js";
import { displayNameOf, indentedComment, robotsDisallowed, sitemapPages } from "./emit.js";
import { privatePaths } from "./seo-emit.js";
import { companiesMode } from "./tenancy-emit.js";

/** What llms.txt calls each page this generator can write, and the line it reads. */
const PAGE_WORDS: Readonly<Record<string, { readonly title: string; readonly summary: string }>> = {
  "/": { title: "Home", summary: "What this is, who it is for, and how to start." },
  "/pricing": { title: "Pricing", summary: "Plans and pricing." },
  "/book-visit": { title: "Book a visit", summary: "Book a visit: pick a service and a time; we come to you." },
  "/store": { title: "Store", summary: "What we sell and what it costs; you pay on Stripe's secure page." },
  "/book": { title: "Book a call", summary: "Book a call: pick a time that suits you." },
  "/estimate": { title: "Instant estimate", summary: "Instant estimate: a price from our own price book for what you can count or measure." },
  "/products": { title: "Products", summary: "Published products available to buy." },
  "/privacy": { title: "Privacy policy", summary: "Privacy policy; the list of who else sees your data comes from the software this site actually runs." },
  "/terms": { title: "Terms of service", summary: "Terms of service." },
};

// ---------------------------------------------------------------------------
// The brand
// ---------------------------------------------------------------------------

export function renderBrand(_answers: Answers): string {
  return `/**
 * THE BRAND, for everything that can't read CSS (create-app 0.40): the
 * browser-tab icon, the home-screen icons, the install manifest and the share
 * card a link shows (src/brand-images.tsx). The mark is the first letter of
 * SITE_NAME (src/seo.ts) on ACCENT.
 *
 * KEEP THESE IN STEP WITH app/globals.css when you rebrand: \`accent\` is
 * \`--color-accent\`, \`background\` is \`--color-canvas\`. Or replace the icons
 * with your own art: put icon.png and apple-icon.png in app/ and delete
 * app/icon.tsx and app/apple-icon.tsx.
 */
export const BRAND = {
  /** The brand colour: the icons, the share card's accent, the manifest's theme colour. */
  accent: "#0f766e",
  /** Text and the letter on the accent. */
  onAccent: "#ffffff",
  /** The page background: the manifest's splash screen. */
  background: "#f5f7f9",
  /** The share card: a dark card reads in every feed, light mode or dark. */
  card: { background: "#0e161c", foreground: "#e8edf1", muted: "#93a2ae", panel: "#16222b", accent: "#45c4ad" },
} as const;
`;
}

export function renderBrandImages(answers: Answers): string {
  const seo = answers.includeSeo;
  const scope = answers.scope;
  const card = seo
    ? `
/**
 * The site's default share card (app/og.png): the name, the one-sentence
 * description and the address, on ${scope}/seo's card template. Built once, at
 * build time.
 */
export function shareCard(): Promise<ImageResponse> {
  return shareImageResponse({
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    footer: hostOf(env.NEXT_PUBLIC_APP_URL),
    theme: {
      background: BRAND.card.background,
      foreground: BRAND.card.foreground,
      muted: BRAND.card.muted,
      panel: BRAND.card.panel,
      accent: BRAND.card.accent,
      onAccent: BRAND.card.background,
    },
  });
}
`
    : `
/**
 * The site's default share card (app/og.png): the name, the one-sentence
 * description and the address on a dark card. Built once, at build time.
 * Every box with more than one child is display:flex, as next/og requires.
 */
export function shareCard(): ImageResponse {
  const footer = hostOf(env.NEXT_PUBLIC_APP_URL);
  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: "100%", height: "100%", padding: "64px 80px", backgroundColor: BRAND.card.background, color: BRAND.card.foreground, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", width: 72, height: 6, backgroundColor: BRAND.card.accent }} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800, lineHeight: 1.08 }}>{SITE_NAME}</div>
          <div style={{ display: "flex", marginTop: 24, fontSize: 30, lineHeight: 1.35, color: BRAND.card.muted, maxHeight: 82, overflow: "hidden" }}>{SITE_DESCRIPTION}</div>
        </div>
        <div style={{ display: "flex", fontSize: 22, color: BRAND.card.muted }}>{footer}</div>
      </div>
    ),
    SHARE_CARD_SIZE,
  );
}
`;
  return `import { ImageResponse } from "next/og";
${seo ? `import { shareImageResponse } from "${scope}/seo/og";\n` : ""}import { BRAND } from "@/brand";
import { env } from "@/env";
import { SITE_DESCRIPTION, SITE_NAME } from "@/seo";

/**
 * THE BRAND'S IMAGES (create-app 0.40), drawn from the project's name and
 * brand colour (src/brand.ts) — so a new project has a tab icon, home-screen
 * icons and a share card on its first deploy, and a link to it on X, Discord
 * or iMessage shows a card instead of a bare address.
 */

/** The share card's size: what every platform crops to. */
export const SHARE_CARD_SIZE = { width: 1200, height: 630 } as const;

/** "alma.com", for the card's footer; "" before the site knows its address. */
function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * The mark: the first letter of the site's name on the brand colour. Rounded
 * for a tab or a launcher; square for Apple, which rounds its own corners.
 */
export function brandIcon(size: number, shape: "rounded" | "square" = "rounded"): ImageResponse {
  const letter = SITE_NAME.trim().charAt(0).toUpperCase() || "•";
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          backgroundColor: BRAND.accent,
          color: BRAND.onAccent,
          fontSize: Math.round(size * 0.62),
          fontWeight: 700,
          fontFamily: "sans-serif",
          borderRadius: shape === "rounded" ? Math.round(size * 0.22) : 0,
        }}
      >
        {letter}
      </div>
    ),
    { width: size, height: size },
  );
}
${card}`;
}

export function renderIcon(): string {
  return `import { brandIcon } from "@/brand-images";

/**
 * The browser-tab icon (create-app 0.40): the mark at 48 px — a multiple of
 * 48 is what Google shows beside a search result. Next writes the <link> tag
 * itself. Your own art instead: put an icon.png here and delete this file.
 */
export const size = { width: 48, height: 48 };
export const contentType = "image/png";

export default function Icon() {
  return brandIcon(48);
}
`;
}

export function renderAppleIcon(): string {
  return `import { brandIcon } from "@/brand-images";

/**
 * The home-screen icon on an iPhone or iPad (create-app 0.40): the mark at
 * 180 px, square (iOS rounds the corners itself).
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return brandIcon(180, "square");
}
`;
}

export function renderIconRoute(size: 192 | 512): string {
  return `import { brandIcon } from "@/brand-images";

/**
 * /icon-${size}.png (create-app 0.40): the install manifest's ${size} px icon, at an
 * address that never changes (app/manifest.ts names it). Built once, at build.
 */
export const dynamic = "force-static";

export function GET(): Response {
  return brandIcon(${size});
}
`;
}

export function renderWebManifest(): string {
  return `import type { MetadataRoute } from "next";
import { BRAND } from "@/brand";
import { SITE_DESCRIPTION, SITE_NAME } from "@/seo";

/**
 * /manifest.webmanifest (create-app 0.40): what a phone shows when someone
 * adds this site to their home screen — its name, its colours and its icons
 * (src/brand.ts). Next links it from every page.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE_NAME,
    short_name: SITE_NAME.length > 12 ? SITE_NAME.split(" ")[0]!.slice(0, 12) : SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: BRAND.background,
    theme_color: BRAND.accent,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
`;
}

export function renderShareCardRoute(): string {
  return `import { shareCard } from "@/brand-images";

/**
 * /og.png (create-app 0.40): the site's default share card, for every page
 * without its own — src/seo.ts names it as the site's image. A route at a
 * FIXED address, because Next 16 serves a root opengraph-image.tsx under a
 * hashed name the site record can't know. Built once, at build time.
 */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  return shareCard();
}
`;
}

// ---------------------------------------------------------------------------
// The page list and the dynamic pages
// ---------------------------------------------------------------------------

export function renderSitePages(answers: Answers): string {
  const entries = sitemapPages(answers)
    .map((page) => {
      const words = PAGE_WORDS[page.path] ?? { title: page.path, summary: page.path };
      return `${indentedComment(page.why)}  { path: ${JSON.stringify(page.path)}, title: ${JSON.stringify(words.title)}, summary: ${JSON.stringify(words.summary)} },\n`;
    })
    .join("\n");
  return `/**
 * THIS SITE'S PUBLIC PAGES, IN ONE PLACE (create-app 0.40): the sitemap lists
 * them, llms.txt and llms-full.txt describe them to answer engines${answers.includeSeo ? ", and\n * src/seo-paths.ts's public list (robots.txt, the noindex tags) is these paths" : ""}.
 * GENERATED from what you installed; add a page here and it lands in all of
 * them. A database-backed page (one per city, one per day) goes in
 * src/dynamic-pages.ts instead.
 *
 * IMPORTS NOTHING, on purpose: the proxy reads src/seo-paths.ts, which reads
 * this, on every request.
 */
export interface SitePage {
  /** The page's own path ("/pricing"). */
  readonly path: string;
  /** Its name, as a link reads ("Pricing"). */
  readonly title: string;
  /** One sentence: what the page answers. Answer engines read it in llms.txt. */
  readonly summary: string;
  /** Its words for llms-full.txt (Markdown is fine). The summary when there are none. */
  readonly body?: string;
  /** When its content last changed, if you know. Never the build's clock. */
  readonly lastModified?: Date | null;
  /** The heading it is listed under in llms.txt ("Cities"). Default "Pages". */
  readonly section?: string;
}

export const SITE_PAGES: readonly SitePage[] = [
${entries}];
`;
}

export function renderDynamicPages(answers: Answers): string {
  return `import type { SitePage } from "@/site-pages";

/**
 * DATABASE-BACKED PAGES, IN ONE PLACE (create-app 0.40): a page per row — a
 * city, a product, a result per day — added to /sitemap.xml, /llms.txt and
 * /llms-full.txt by this one function. Return each page's path, title and
 * one-sentence summary (and its date when you know it, its words for
 * llms-full.txt, a section to list it under):
 *
 *   import { isDbConfigured } from "${answers.scope}/db";
 *   import { db } from "@/db";
 *
 *   export async function dynamicPages(): Promise<readonly SitePage[]> {
 *     if (!isDbConfigured(db)) return [];
 *     const rows = await db.select({ slug: cities.slug, name: cities.name, updatedAt: cities.updatedAt }).from(cities);
 *     return rows.map((row) => ({
 *       path: \`/weather/\${row.slug}\`,
 *       title: \`\${row.name} daily high\`,
 *       summary: \`Today's readings and yesterday's official high in \${row.name}.\`,
 *       lastModified: row.updatedAt,
 *       section: "Cities",
 *     }));
 *   }
 *
 * WHEN IT RUNS. The sitemap and both llms files are cached for an hour and
 * read again after; they are also built once by \`next build\`, where there may
 * be no database — so guard it as above, and return [] rather than throw. (A
 * throw is caught: the files go out without these pages.)
 *
 * NEVER A PRIVATE PAGE. A path under a private or noindex path
 * (src/seo-paths.ts) is left out of every file, so a mistake here can't list
 * someone's account page.
 */
export async function dynamicPages(): Promise<readonly SitePage[]> {
  return [];
}
`;
}

// ---------------------------------------------------------------------------
// src/seo-paths.ts
// ---------------------------------------------------------------------------

export function renderSeoPaths(answers: Answers): string {
  if (answers.includeSeo) {
    const scope = answers.scope;
    const companies = companiesMode(answers);
    const quoted = (list: readonly string[]) => list.map((path) => `    ${JSON.stringify(path)},`).join("\n");
    return `import { definePaths, robotsHeader } from "${scope}/seo";
import { SITE_PAGES } from "@/site-pages";

/**
 * THE ONE PATH LIST (create-app 0.40: moved here from src/seo.ts, which
 * re-exports it): robots.txt, the noindex tags, the X-Robots-Tag header and
 * the sitemap all read it, so a page added here lands in all four and a
 * private area can't be listed in one and forgotten in another.
 *
 *   public    this site's own pages worth finding: src/site-pages.ts, by path
 *   private   no crawler should fetch them: signed-in areas, the API${companies ? `,
 *             and each company's token pages (\`/t/{*}/quote\`, the plain
 *             asterisk: one web address, any one) — each is one customer's key` : ""}
 *   noindex   fetched, never listed: the sign-in pages
 *
 * NO ENVIRONMENT AND NO DATABASE, on purpose: the proxy (proxy.ts) reads this
 * on every request.
 */
export const paths = definePaths({
  public: SITE_PAGES.map((page) => page.path),
  private: [
${quoted(privatePaths(answers))}
  ],
  noindex: ["/sign-in", "/sign-up"],
});

/**
 * The X-Robots-Tag for a request path, from the same list: a private path
 * \`noindex, nofollow\`, a noindex path \`noindex\`, anything else none. The
 * proxy sends it on every answer — a crawler that never reads a page's HTML
 * (a redirect, a JSON answer, a file) still gets it. Off production every
 * page also says noindex in its own robots tag and robots.txt refuses
 * everything (src/seo.ts's INDEXABLE); this header reads no environment.
 */
export function robotsHeaderFor(pathname: string): string | null {
  return robotsHeader({ indexable: true, paths }, pathname);
}
`;
  }
  const entries = robotsDisallowed(answers)
    .map((entry) => `${indentedComment(entry.why)}  ${JSON.stringify(entry.path)},\n`)
    .join("\n");
  return `/**
 * THE ROUTES NO CRAWLER SHOULD INDEX (create-app 0.40: moved here from
 * app/robots.ts, which reads it): robots.txt disallows each one, and the
 * proxy sends \`X-Robots-Tag: noindex, nofollow\` on every answer under one,
 * so a crawler that never reads a page's HTML (a redirect, a JSON answer)
 * still gets it. A generated array: a route that was never installed
 * contributes no entry.
 *
 * NO ENVIRONMENT AND NO DATABASE, on purpose: the proxy (proxy.ts) reads this
 * on every request.
 */
export const PRIVATE_PATHS: readonly string[] = [
${entries}];

/** Does an entry cover a path, by whole segments? "/setup" covers "/setup/start", never "/setup-guide". */
function covers(entry: string, pathname: string): boolean {
  const prefix = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return pathname === prefix || pathname.startsWith(\`\${prefix}/\`);
}

/** The X-Robots-Tag for a request path: \`noindex, nofollow\` under a private route, else none. */
export function robotsHeaderFor(pathname: string): string | null {
  return PRIVATE_PATHS.some((entry) => covers(entry, pathname)) ? "noindex, nofollow" : null;
}
`;
}

// ---------------------------------------------------------------------------
// proxy.ts
// ---------------------------------------------------------------------------

export function renderProxy(answers: Answers): string {
  const scope = answers.scope;
  const counted = answers.includeAnalytics;
  const companies = companiesMode(answers);
  const crawlerLog = counted
    ? `
/**
 * EVERY AI CRAWLER'S READ, LOGGED (create-app 0.40, Tenancy 2b-4a's verified
 * crawler log): which assistants, AI search engines and training crawlers
 * read which pages — on every page, not only /llms.txt. Cheap for people: a
 * request is tested against the crawler list (a few string matches, no
 * database), and only a crawler's is recorded — after the answer has gone
 * (\`after\`), from a module loaded only then, so a person's request never
 * waits for it and never loads the database here. The API's routes are left
 * out (webhooks and the beacon are not page reads)${companies ? `, and so are each company's
 * pages (/t/…), which <PublicCompanyGate> logs for that company` : ""}.
 */
function logCrawler(req: NextRequest): void {
  const userAgent = req.headers.get("user-agent");
  if (!classifyCrawler(userAgent)) return;
  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/")${companies ? ` || path.startsWith("/t/")` : ""}) return;
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  if (isOwnTraffic(req, ip)) return;
  const facts = { userAgent, path, ip, country: req.headers.get("x-vercel-ip-country") };
  after(async () => {
    const { recordSiteCrawlerHit } = await import("@/server/website");
    await recordSiteCrawlerHit(facts);
  });
}

/** What \`pnpm test:pages\` sends on every request (tests/pages/public-pages.test.ts). */
const TEST_TRAFFIC_HEADER = "x-test-traffic";

/**
 * THIS PROJECT'S OWN TRAFFIC, NEVER A CRAWLER'S READ: \`pnpm test:pages\`
 * (which asks as GPTBot, and says so in TEST_TRAFFIC_HEADER), a curl from this
 * machine, anything from a loopback or private-network address. A request
 * that names no address at all (\`next start\` on a laptop passes none) is
 * judged by the address it was sent to: localhost is this machine. A real
 * crawler reads the site from a public address, by the site's own name.
 * Without this every project's own tests filled its crawler log — one
 * Almanac run wrote 286,123 rows.
 */
function isOwnTraffic(req: NextRequest, ip: string | null): boolean {
  if (req.headers.has(TEST_TRAFFIC_HEADER)) return true;
  if (ip) return isPrivateAddress(ip);
  const host = (req.headers.get("host") ?? "").trim().toLowerCase();
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\\d+$/, "");
  return name === "localhost" || name.endsWith(".localhost") || isPrivateAddress(name);
}

/** Loopback, private-network, link-local or unspecified: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, ::1, ::, fc00::/7, fe80::/10. */
function isPrivateAddress(address: string): boolean {
  const ip = address.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\\d{1,3})\\.(\\d{1,3})\\.\\d{1,3}\\.\\d{1,3}(?::\\d+)?$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = ip.replace(/^\\[|\\](?::\\d+)?$/g, "");
  return v6 === "::1" || v6 === "::" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}
`
    : "";
  return `import { clerkMiddleware } from "@clerk/nextjs/server";
import { ${counted ? "after, " : ""}NextResponse, type NextRequest } from "next/server";
${counted ? `import { classifyCrawler } from "${scope}/analytics/crawlers";\n` : ""}import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "${scope}/observability/request";
import { robotsHeaderFor } from "@/seo-paths";

/**
 * Root proxy — Next 16's rename of \`middleware.ts\`. The old filename still
 * works and warns on every build, which is noise you learn to scroll past.
 *
 * This hydrates the Clerk session so downstream \`auth()\` calls resolve, and
 * does NOT gate routes. Route gating lives in the pages and procedures that
 * consume protected data: a matcher here is a second place for authorization to
 * live, and the two drift.
 *
 * GENERATED (create-app 0.40): every answer also carries the X-Robots-Tag its
 * path deserves (src/seo-paths.ts)${counted ? ", and an AI crawler's read is logged" : ""}.
 *
 * NOTHING HEAVY AT THE TOP OF THIS FILE. It runs before every request, so
 * everything it imports is loaded by every instance: the request id from an
 * import-free subpath, the path list from a module that reads no environment
 * and no database${counted ? ", the crawler test from analytics' dependency-free\n * ./crawlers" : ""}. \`@/env\` would pull in every package's fragment and the
 * database driver behind it.
 *
 * THE ONE PLACE OUTSIDE \`src/env.ts\` THAT READS process.env, and it is worth
 * saying why. \`NEXT_PUBLIC_*\` values are inlined at build time, so the line
 * below is a compile-time constant rather than a runtime lookup, and the rule
 * it bends is about runtime configuration drift, which cannot happen here.
 *
 * Without the check, a project with no Clerk account yet 500s on EVERY request
 * — clerkMiddleware throws on a missing publishable key, before layout, before
 * the page, before /setup can tell you Clerk is what is missing. The first
 * thing you would see after generating a project is a stack trace.
 */
const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

/**
 * Stamp one id onto the request, and echo it back on the response.
 *
 * THE ONLY PLACE THIS IS MINTED. Everything downstream reads the header —
 * \`createScaffoldContext\` puts it on \`ctx.requestId\`, \`requestLog\` puts it on
 * every log line, \`reportError\` puts it in the \`error_log\` row — so a page
 * render, the tRPC call that page makes and the error either of them reports
 * all carry the same value. Minting per handler instead would give every hop a
 * different id, and an error row whose id appears nowhere else joins to
 * nothing.
 *
 * FROM THE PACKAGE, over an import-free subpath, and not from a copy kept
 * here. \`${scope}/observability/request\` imports nothing at all — no pino, no
 * \`node:crypto\` — precisely so this file can use it; the barrel would drag the
 * logger in behind it. This project used to keep its own dependency-free copy
 * for that reason, and the copy drifted exactly where it mattered: it never
 * validated the inbound header, so a newline in \`x-request-id\` became two
 * records in a line-delimited log and the second one said whatever the caller
 * wanted. \`resolveRequestId\` bounds the length, restricts the characters and
 * replaces anything that fails rather than refusing the request.
 *
 * An incoming id is kept rather than replaced. A load balancer, a client SDK or
 * an internal caller that already assigned one is describing a trace that
 * started before us, and overwriting it severs this app from the front of it.
 * \`x-vercel-id\` is promoted into the header when nothing else set one, because
 * Vercel stamps it on every inbound request and a real id from the platform
 * beats a fresh one that joins to nothing outside this process.
 *
 * On the response as well as the request, because that header is what a person
 * reporting a problem can actually copy out of their browser's network tab.
 */
function withRequestId(req: NextRequest): NextResponse {
  const forwarded = new Headers(req.headers);
  const platform = forwarded.get("x-vercel-id");
  if (!forwarded.get(REQUEST_ID_HEADER) && platform) {
    forwarded.set(REQUEST_ID_HEADER, platform);
  }
  const requestId = resolveRequestId(forwarded);
  forwarded.set(REQUEST_ID_HEADER, requestId);

  // \`NextResponse.next({ request })\` is the only way to change what the route
  // below sees. Setting the header on the response alone would echo an id that
  // no handler could read, which is the version of this that looks like it
  // works.
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  // Sign-in, the account, the admin, the API, /setup …: never in a search
  // result, said on the answer itself (src/seo-paths.ts).
  const robots = robotsHeaderFor(req.nextUrl.pathname);
  if (robots) response.headers.set("X-Robots-Tag", robots);
  return response;
}
${crawlerLog}
/** Every request: ${counted ? "the crawler log, then " : ""}the request id and the robots header. */
function handle(req: NextRequest): NextResponse {${counted ? `
  logCrawler(req);` : ""}
  return withRequestId(req);
}

export default clerkConfigured
  ? clerkMiddleware((_auth, req) => handle(req))
  : handle;

export const config = {
  matcher: [
    // Everything except static assets. Webhook routes stay INCLUDED on purpose:
    // clerkMiddleware attaches auth state, it does not require a session, and
    // excluding them is how a route ends up unable to read its own headers.
    "/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};
`;
}

/** src/__tests__/proxy.test.ts: the proxy itself, as Next runs it on every request. */
export function renderProxyTest(answers: Answers): string {
  const counted = answers.includeAnalytics;
  const crawlerMocks = counted
    ? `
/** What reached the crawler log, and whether its module was ever loaded. */
const logged = vi.hoisted(() => ({ loaded: false, hits: [] as Array<{ path: string; ip: string | null }> }));
vi.mock("@/server/website", () => {
  logged.loaded = true;
  return { recordSiteCrawlerHit: async (facts: { path: string; ip: string | null }) => void logged.hits.push({ path: facts.path, ip: facts.ip }) };
});
`
    : "";
  const crawlerTests = counted
    ? `
describe("the crawler log", () => {
  it("a person's request is one user-agent test: nothing is logged, and the log's module is never loaded", async () => {
    expect(await ask("/", { "user-agent": PERSON, "x-real-ip": "203.0.113.7" })).toBe(0);
    expect(logged.loaded).toBe(false);
  });

  it("an AI crawler's read is logged after the answer, from a module loaded only then", async () => {
    expect(await ask("/", { "user-agent": GPTBOT, "x-forwarded-for": "20.171.206.17, 10.0.0.1" })).toBe(1);
    expect(logged.hits).toEqual([{ path: "/", ip: "20.171.206.17" }]);
    expect(logged.loaded).toBe(true);
  });

  it("a crawler that reaches the server by the site's own name, naming no address, is still logged", async () => {
    await ask("/", { "user-agent": GPTBOT });
    expect(logged.hits).toEqual([{ path: "/", ip: null }]);
  });

  it.each([
    ["test:pages, which says so", { "x-test-traffic": "test:pages", "x-real-ip": "20.171.206.17" }],
    ["this machine", { "x-forwarded-for": "127.0.0.1" }],
    ["this machine over IPv6", { "x-forwarded-for": "::1" }],
    ["this machine, IPv4 in IPv6", { "x-real-ip": "::ffff:127.0.0.1" }],
    ["the office network", { "x-real-ip": "192.168.1.20" }],
    ["a container beside it", { "x-forwarded-for": "172.18.0.4" }],
    ["a private IPv6 network", { "x-forwarded-for": "fd12:3456:789a::1" }],
    ["a laptop's next start, which names no address", { host: "localhost:3000" }],
    ["the same, asked at 127.0.0.1", { host: "127.0.0.1:3000" }],
  ])("never logs this project's own traffic: %s", async (_label, headers) => {
    expect(await ask("/", { "user-agent": GPTBOT, ...headers })).toBe(0);
    expect(logged.hits).toEqual([]);
  });
});
`
    : "";
  return `import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import proxy from "../../proxy";

/**
 * THE PROXY, AS NEXT RUNS IT ON EVERY REQUEST (create-app 0.40): every answer
 * under a private route says X-Robots-Tag, a public page's says nothing${counted ? `;
 * an AI crawler's read is logged after the answer, from a module loaded only
 * then, and this project's own traffic — test:pages, a curl from this
 * machine, a private-network address — never is` : ""}.
 */
const tasks = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // What runs after the answer has gone: kept here, and run by ask().
  after: (task: () => unknown) => void tasks.push(task),
}));
// Clerk's wrapper as a pass-through: what is tested is the proxy's own work.
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (handler: (auth: unknown, req: NextRequest) => unknown) => (req: NextRequest) => handler({}, req),
}));
${crawlerMocks}
${counted ? `const PERSON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";

` : ""}let response: Response | null = null;

/** One request through the proxy, and what it left to run after the answer (run here). How many there were. */
async function ask(path: string, headers: Record<string, string> = {}): Promise<number> {
  const handle = proxy as unknown as (req: NextRequest) => Response | Promise<Response>;
  response = await handle(new NextRequest(\`https://alma.example.com\${path}\`, { headers: { host: "alma.example.com", ...headers } }));
  const after = tasks.splice(0);
  for (const task of after) await task();
  return after.length;
}

beforeEach(() => {
  tasks.length = 0;${counted ? `
  logged.hits.length = 0;` : ""}
});

describe("X-Robots-Tag", () => {
  it("is on every answer under a private route, and on no public page", async () => {
    await ask("/setup/start");
    expect(response?.headers.get("x-robots-tag")).toMatch(/^noindex/);
    await ask("/");
    expect(response?.headers.get("x-robots-tag")).toBeNull();
  });
});
${crawlerTests}`;
}

// ---------------------------------------------------------------------------
// llms.txt and llms-full.txt
// ---------------------------------------------------------------------------

/** Does this project's pricing page sell plans (so llms.txt lists them)? */
function pricingInLlms(answers: Answers): boolean {
  return answers.includeMarketing && (answers.businessModel === "subscription" || answers.businessModel === "both");
}

export function renderLlmsModule(answers: Answers): string {
  const scope = answers.scope;
  if (answers.includeSeo) {
    const pricing = pricingInLlms(answers);
    const pricingBlock = pricing
      ? `
/**
 * The plans, from src/plans.ts — the same record the pricing page draws: each
 * tier that is on sale or coming soon, at its monthly price (and its yearly
 * one in the note), and each line's free tier. Prices are written as the
 * pricing page writes them ("$10"), never computed here.
 */
function pricingPlans(): LlmsPricingPlan[] {
  const out: LlmsPricingPlan[] = [];
  const several = plans.lines.length > 1;
  for (const line of plans.lines) {
    if (line.free) out.push({ name: several ? \`\${line.name}: \${line.free.name}\` : line.free.name, price: "Free", ...(line.free.description ? { description: line.free.description } : {}) });
    for (const tier of line.tiers) {
      if (!tier.isActive || tier.onSale === false) continue;
      const name = several ? \`\${line.name}: \${tier.name}\` : tier.name;
      if (tier.onSale === "coming") {
        out.push({ name, price: "Coming soon", ...(tier.description ? { description: tier.description } : {}) });
        continue;
      }
      const monthly = tier.prices.month?.[DEFAULT_CURRENCY];
      const yearly = tier.prices.year?.[DEFAULT_CURRENCY];
      if (monthly === undefined && yearly === undefined) continue;
      const note = [tier.description, monthly !== undefined && yearly !== undefined ? \`Or \${formatPrice(yearly, DEFAULT_CURRENCY)} a year.\` : null].filter(Boolean).join(" ");
      out.push({
        name,
        price: formatPrice(monthly ?? yearly!, DEFAULT_CURRENCY),
        interval: monthly !== undefined ? "month" : "year",
        ...(note ? { description: note } : {}),
      });
    }
  }
  return out;
}
`
      : "";
    return `import { pathRule, type LlmsItem, type LlmsRegistry${pricing ? ", type LlmsPricingPlan" : ""} } from "${scope}/seo";
${pricing ? `import { formatPrice } from "${scope}/billing";\n` : ""}import { dynamicPages } from "@/dynamic-pages";
${pricing ? `import { DEFAULT_CURRENCY, plans } from "@/plans";\n` : ""}import { SITE_DESCRIPTION, site } from "@/seo";
import { SITE_PAGES, type SitePage } from "@/site-pages";

/**
 * WHAT /llms.txt AND /llms-full.txt SAY (create-app 0.40), from the same
 * records as every other page: the site's own description (src/seo.ts), its
 * public pages (src/site-pages.ts), the database-backed ones
 * (src/dynamic-pages.ts)${pricing ? " and the plans (src/plans.ts)" : ""}. ${scope}/seo writes the
 * files — the index and the full text, each within its byte budget — and
 * never lists a private page. Off production both answer 404, like the
 * sitemap is empty there.
 */

/** Every page to list: this site's own, then the database's (never a private or noindex one). */
async function pages(): Promise<SitePage[]> {
  const more = await dynamicPages().catch(() => [] as readonly SitePage[]);
  return [...SITE_PAGES, ...more].filter((page) => {
    const rule = pathRule(site.paths, page.path);
    return rule !== "private" && rule !== "noindex";
  });
}
${pricingBlock}
/** The registry both files are written from. */
export async function llmsRegistry(): Promise<LlmsRegistry> {
  const sections = new Map<string, LlmsItem[]>();
  for (const page of await pages()) {
    const title = page.section ?? "Pages";
    const items = sections.get(title) ?? [];
    items.push({ title: page.title, path: page.path, summary: page.summary, ...(page.body ? { body: page.body } : {}) });
    sections.set(title, items);
  }
  return {
    summary: SITE_DESCRIPTION,
    sections: [...sections].map(([title, items]) => ({ title, items })),${pricing ? `
    pricing: { path: "/pricing", plans: pricingPlans() },` : ""}
  };
}
`;
  }
  return `import { dynamicPages } from "@/dynamic-pages";
import { env } from "@/env";
import { SITE_DESCRIPTION, SITE_NAME } from "@/seo";
import { robotsHeaderFor } from "@/seo-paths";
import { SITE_PAGES, type SitePage } from "@/site-pages";

/**
 * WHAT /llms.txt AND /llms-full.txt SAY (create-app 0.40), from the same
 * records as every other page: the site's name and description (src/seo.ts),
 * its public pages (src/site-pages.ts) and the database-backed ones
 * (src/dynamic-pages.ts). The index is links with one line each, the shape
 * llmstxt.org's parser reads; the full text is every page's own words. A
 * private page is never listed.
 */

function base(): string {
  return (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\\/+$/, "");
}

function oneLine(text: string): string {
  return text.replace(/\\s+/g, " ").trim();
}

/** Link text with its brackets escaped. */
function linkText(text: string): string {
  return oneLine(text).replace(/([[\\]\\\\])/g, "\\\\$1");
}

async function pages(): Promise<SitePage[]> {
  const more = await dynamicPages().catch(() => [] as readonly SitePage[]);
  return [...SITE_PAGES, ...more].filter((page) => robotsHeaderFor(page.path) === null);
}

function bySection(list: readonly SitePage[]): Map<string, SitePage[]> {
  const sections = new Map<string, SitePage[]>();
  for (const page of list) {
    const title = page.section ?? "Pages";
    sections.set(title, [...(sections.get(title) ?? []), page]);
  }
  return sections;
}

/** /llms.txt: the title, the one-sentence answer to "what is this?", then the pages. */
export async function llmsText(): Promise<string> {
  const url = base();
  const out = [\`# \${oneLine(SITE_NAME)}\`, "", \`> \${oneLine(SITE_DESCRIPTION)}\`, "", \`- [Full text](\${url}/llms-full.txt)\`, \`- [Sitemap](\${url}/sitemap.xml)\`];
  for (const [title, list] of bySection(await pages())) {
    out.push("", \`## \${oneLine(title)}\`, "");
    for (const page of list) out.push(\`- [\${linkText(page.title)}](\${url}\${page.path}): \${oneLine(page.summary)}\`);
  }
  return \`\${out.join("\\n")}\\n\`;
}

/** /llms-full.txt: the same, with every page's own words. */
export async function llmsFullText(): Promise<string> {
  const url = base();
  const out = [\`# \${oneLine(SITE_NAME)}\`, "", \`> \${oneLine(SITE_DESCRIPTION)}\`, "", \`- [Index](\${url}/llms.txt)\`, \`- [Sitemap](\${url}/sitemap.xml)\`];
  for (const [title, list] of bySection(await pages())) {
    out.push("", \`## \${oneLine(title)}\`);
    for (const page of list) out.push("", \`### [\${linkText(page.title)}](\${url}\${page.path})\`, "", (page.body ?? page.summary).trim());
  }
  return \`\${out.join("\\n")}\\n\`;
}
`;
}

export function renderLlmsRoute(answers: Answers, which: "index" | "full"): string {
  const name = which === "index" ? "/llms.txt" : "/llms-full.txt";
  if (answers.includeSeo) {
    const builder = which === "index" ? "llmsTxt" : "llmsFullTxt";
    return `import { ${builder}, llmsResponse } from "${answers.scope}/seo";
import { llmsRegistry } from "@/llms";
import { site } from "@/seo";

/**
 * ${name} (create-app 0.40): ${which === "index" ? "the index answer engines read first — the one-sentence\n * answer to \"what is this?\", then every public page with one line each" : "the full text an assistant can quote from — every\n * public page's own words, the plans and the steps"}, from
 * src/llms.ts (the site's description, src/site-pages.ts, src/dynamic-pages.ts).
 * ${answers.scope}/seo writes it within its byte budget; off production it is a 404,
 * like the sitemap is empty there.
 *
 * CACHED FOR AN HOUR, then read again: the database-backed pages change. ${answers.includeAnalytics ? "Every\n * AI crawler's read of it is still logged: the proxy logs before the cache\n * answers." : ""}
 */
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  return llmsResponse(${builder}(site, await llmsRegistry()));
}
`;
  }
  const builder = which === "index" ? "llmsText" : "llmsFullText";
  return `import { ${builder} } from "@/llms";

/**
 * ${name} (create-app 0.40): ${which === "index" ? "the index answer engines read first — the site's\n * name and its one-sentence description, then every public page with one line" : "the full text an assistant can quote from — every\n * public page's own words"}, from src/llms.ts (src/seo.ts, src/site-pages.ts,
 * src/dynamic-pages.ts). Kept out of search results itself (X-Robots-Tag), where it
 * would compete with the pages it describes; answer engines read it all the same.
 *
 * CACHED FOR AN HOUR, then read again: the database-backed pages change.${answers.includeAnalytics ? " Every\n * AI crawler's read of it is still logged: the proxy logs before the cache\n * answers." : ""}
 */
export const revalidate = 3600;

export async function GET(): Promise<Response> {
  return new Response(await ${builder}(), {
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
`;
}

// ---------------------------------------------------------------------------
// The generated proof
// ---------------------------------------------------------------------------

export function renderSeoDefaultsTest(answers: Answers): string {
  const seo = answers.includeSeo;
  const name = displayNameOf(answers.projectName);
  const privateList = (seo ? privatePaths(answers) : robotsDisallowed(answers).map((entry) => entry.path)).filter((path) => !path.includes("*"));
  const expectNoindex = ["/sign-in", "/sign-up"];
  const welcome = answers.includeAnalytics || personEmails(answers);
  return `import { describe, expect, it } from "vitest";
${seo ? `import { defineSite, llmsFullTxt, llmsTxt } from "${answers.scope}/seo";\nimport { llmsRegistry } from "@/llms";\nimport { SITE_DESCRIPTION, SITE_NAME, paths } from "@/seo";` : `import { llmsFullText, llmsText } from "@/llms";\nimport { SITE_DESCRIPTION } from "@/seo";`}
import { robotsHeaderFor } from "@/seo-paths";
import { SITE_PAGES } from "@/site-pages";

/**
 * SEO BY DEFAULT (create-app 0.40), held on this project's own files: every
 * private route answers with X-Robots-Tag (the proxy sends robotsHeaderFor's
 * value), no public page does, and llms.txt says what src/seo.ts says and
 * lists every public page — never a private one.
 */
describe("the robots header the proxy sends", () => {
  it.each(${JSON.stringify([...privateList, ...(seo ? expectNoindex : [])])})("%s is never indexed", (path) => {
    expect(robotsHeaderFor(path)).toMatch(/^noindex/);
    expect(robotsHeaderFor(\`\${path.replace(/\\/$/, "")}/anything\`)).toMatch(/^noindex/);
  });

  it("the routes the review named are covered", () => {
    for (const path of ${JSON.stringify(["/sign-in", "/sign-up", "/api/trpc", "/setup", ...(answers.adminShell !== "none" ? ["/admin"] : []), ...(answers.businessModel !== "none" || personEmails(answers) ? ["/account"] : []), ...(welcome ? ["/welcome"] : [])])}) {
      expect(robotsHeaderFor(path), path).toMatch(/^noindex/);
    }
  });

  it("no public page carries it", () => {
    for (const page of SITE_PAGES) expect(robotsHeaderFor(page.path), page.path).toBeNull();
  });
});

describe("llms.txt and llms-full.txt", () => {
  ${seo ? `const live = defineSite({ url: "https://example.com", name: SITE_NAME, description: SITE_DESCRIPTION, indexable: true, paths });

  it("say what src/seo.ts says, and list every public page", async () => {
    const index = llmsTxt(live, await llmsRegistry()).text;
    const full = llmsFullTxt(live, await llmsRegistry()).text;
    expect(index).toContain(\`# \${SITE_NAME}\`);
    expect(index).toContain(SITE_DESCRIPTION);
    expect(index).toContain("https://example.com/llms-full.txt");
    for (const page of SITE_PAGES) {
      expect(index).toContain(\`https://example.com\${page.path === "/" ? "/" : page.path}\`);
      expect(full).toContain(page.summary);
    }
    for (const path of paths.private) expect(index).not.toContain(\`https://example.com\${path}\`);
  });` : `it("say what src/seo.ts says, and list every public page", async () => {
    const index = await llmsText();
    const full = await llmsFullText();
    expect(index).toContain(${JSON.stringify(`# ${name}`)});
    expect(index).toContain(SITE_DESCRIPTION);
    expect(index).toContain("/llms-full.txt");
    for (const page of SITE_PAGES) {
      expect(index).toContain(\`](\`);
      expect(index).toContain(page.summary);
      expect(full).toContain(page.summary);
    }
  });`}
});
`;
}

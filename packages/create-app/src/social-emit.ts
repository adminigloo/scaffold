/**
 * SOCIAL POSTS (create-app 0.41, --social), through @adminigloo/social 0.1:
 * the app writes each post into a queue, one draft per platform in that
 * platform's own format; a person edits and approves; a person (or an agent
 * in their browser) posts them by hand and marks each one posted. Nothing in
 * the generated project posts anything or calls any platform.
 *
 *   this site's own   /admin/posts over /api/admin/posts, on staff keys
 *                     (staff.social.view, staff.social.manage) — "*", in both
 *                     modes, wherever there's an admin panel to hold it
 *   each company's    /app/posts over /api/app/{company id}/posts, on its own
 *                     keys (social.view, social.manage), in a companies project
 *   the cards         /api/social/card?…&sig=…: public and signed, every image
 *                     of every draft (a company's in its own name and colour)
 *
 * THE GLUE (src/server/social.ts) is generated, not copied: whose posts a
 * route is, the brand a card is drawn in, and whether the words around the
 * facts come from a metered model (--ai) are questions about OTHER answers.
 * No emitted `if` asks about an answer; the ones that are emitted ask about
 * runtime data (a key that isn't set, a company that has no brand colour).
 */

import { tenantLabel, type Answers } from "./answers.js";
import { companiesMode } from "./tenancy-emit.js";

/** This site's own posts have a page: there's an admin panel to put it in. */
export function socialSiteScreens(answers: Answers): boolean {
  return answers.includeSocial && answers.adminShell !== "none";
}

/** Every file social posts write, by path (POSIX separators; emit.ts joins them). */
export function socialFiles(answers: Answers): ReadonlyArray<readonly [string, string]> {
  if (!answers.includeSocial) return [];
  const files: Array<readonly [string, string]> = [
    ["src/server/social.ts", renderSocialGlue(answers)],
    ["app/api/social/card/route.tsx", renderSocialCardRoute(answers)],
  ];
  if (socialSiteScreens(answers)) {
    files.push(["app/api/admin/posts/[...path]/route.ts", renderSocialRoute(answers, "site")], ["app/admin/posts/page.tsx", renderSitePostsPage(answers)]);
  }
  if (companiesMode(answers)) {
    files.push(["app/api/app/[tenantId]/posts/[...path]/route.ts", renderSocialRoute(answers, "company")], ["app/(site)/app/posts/page.tsx", renderCompanyPostsPage(answers)]);
  }
  return files;
}

// ---------------------------------------------------------------------------
// src/server/social.ts
// ---------------------------------------------------------------------------

function renderSocialGlue(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  const site = socialSiteScreens(answers);
  const ai = answers.includeAi;
  const noun = tenantLabel(answers).toLowerCase();
  const imports = [
    `import { createHmac, randomBytes } from "node:crypto";`,
    `import { isDeployed } from "${scope}/env";`,
    `import { genericHonesty, launchSource, PLATFORM_IDS, type Complete, type DraftImage, type Platform, type PostSource, type WriterOptions } from "${scope}/social";`,
    `import { createSocialAdminHandlers, dayIn, type ComposeRequest } from "${scope}/social/server";`,
    `import { ${companies ? "cardBrand, " : ""}cardFormatSets, cardImage, draftCards, launchCarousel, quoteCard, sampleCardSets, type CardBrandWords, type CardByline, type CardSigning, type CardSpec, type CardTheme } from "${scope}/social/cards";`,
    ...(ai
      ? [
          `import { createAnthropicComplete, DEFAULT_SOCIAL_MODEL, SOCIAL_POST_OPERATION, type PostSpend } from "${scope}/social/anthropic";`,
          `import { reserveAiAllowance, settleAiReservation, type AiAllowanceUsage } from "${scope}/ai/server";`,
        ]
      : []),
    `import { BRAND } from "@/brand";`,
    `import { db } from "@/db";`,
    `import { env } from "@/env";`,
    `import { SITE_NAME } from "@/seo";`,
    ...(ai ? [`import { AI_SITE_DAILY_CENTS, alertSiteCeiling, anthropic, MODEL_RATES } from "@/server/ai";`] : []),
    ...(companies ? [`import { companyAuthorizer, companyRoutes, type FeatureHandlerOverrides } from "@/server/company-routes";`] : []),
    `import { reportError } from "@/server/error-reporter";`,
    ...(ai ? [`import { log } from "@/server/logger";`] : []),
    ...(site ? [`import { authorizeStaffFor } from "@/server/staff-access";`] : []),
    ...(companies ? [`import { tenancy } from "@/server/tenancy";`] : []),
  ];

  const header = `/**
 * SOCIAL POSTS (create-app 0.41, ${scope}/social): the app writes each post
 * into a queue — one draft per platform, in that platform's own format, with
 * its images — a person edits and approves, and a person posts them BY HAND
 * and marks each one posted with its link. Nothing here posts anything or
 * calls any platform.
 *
 * Code writes every fact: a post is the person's own words (what they typed
 * on the posts screen), laid out for each platform by the package.${ai ? ` The AI
 * (Claude Haiku 4.5, the cheapest capable model) writes only the line on the
 * images and a short sign-off, using only the facts' numbers, every word
 * checked against the generic honesty list — and every call is held against
 * the ${companies ? `${noun}'s` : "site's"} month before it's asked (SOCIAL_AI_POSTS_A_MONTH).` : ` This
 * project has no AI (--ai), so every draft is the person's own words, with
 * the first sentence as the line on the images; \`create-app add ai\` adds the
 * hook and sign-off, metered.`}
 *
${site ? ` *   this site's own   /admin/posts over /api/admin/posts, on staff keys ("*")\n` : ""}${companies ? ` *   each ${noun}'s     /app/posts over /api/app/{${noun} id}/posts, on its own keys\n` : ""} *   the cards         /api/social/card?…&sig=… (public, signed with SOCIAL_CARD_SECRET)
 */`;

  const common = `
/** THIS SITE'S OWN posts: "*"${companies ? `, which can never be a ${noun}'s id (those are UUIDs)` : ""}. */
export const SOCIAL_SITE = "*";

/**
 * Where every post goes: every platform the package knows, each in its own
 * format. Take out the ones the business doesn't use; a draft is written for
 * each one left.
 */
export const SOCIAL_PLATFORMS: readonly Platform[] = PLATFORM_IDS;

/** This deployment's address, without a trailing slash (the cards' addresses, a post's default link). */
function appUrl(): string {
  return (env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\\/+$/, "");
}

/** "example.com", for a card's footer; the address as given when it doesn't parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "Oct 27", from a day (YYYY-MM-DD). */
function shortDay(day: string): string {
  return new Date(\`\${day}T12:00:00Z\`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** An error the handler didn't expect: a fixed sentence for the caller, the error in /admin/errors. */
function reportSocialError(error: unknown, context: { tenantId: string | null; route: string }): void {
  void reportError({ error, source: "route", tenantId: context.tenantId, context: { feature: "social", route: context.route } });
}

// --- The cards --------------------------------------------------------------

const LOCAL_CARD_KEY = "local-only-social-card-key:adminigloo";
const PROCESS_CARD_KEY = randomBytes(32).toString("hex");

/**
 * What every card's address is signed with: SOCIAL_CARD_SECRET, else one
 * made from CLERK_SECRET_KEY (which a deployment already requires) —
 * HMAC-SHA256(CLERK_SECRET_KEY, "adminigloo:social-card:v1"), never the
 * secret itself. A laptop with neither signs with a fixed local key (its
 * cards are only ever its own); a deployment with neither, with a key made
 * when the server starts and written down nowhere. Changing the key retires
 * the images of drafts not yet posted (write the post again).
 */
export function socialCardSecret(): string {
  if (env.SOCIAL_CARD_SECRET) return env.SOCIAL_CARD_SECRET;
  if (env.CLERK_SECRET_KEY) return createHmac("sha256", env.CLERK_SECRET_KEY).update("adminigloo:social-card:v1").digest("hex");
  return isDeployed() ? PROCESS_CARD_KEY : LOCAL_CARD_KEY;
}

/** This site's own byline: what a card without a company's brand says. */
export function siteByline(): CardByline {
  const host = hostOf(appUrl());
  return { name: SITE_NAME, handle: host, site: host };
}

/** A colour's soft glow (the stat slides' light), from a "#rrggbb" accent. */
function glowOf(hex: string): string | undefined {
  return /^#[0-9a-f]{6}$/i.test(hex) ? \`\${hex}29\` : undefined;
}

/**
 * THE CARDS' LOOK, from src/brand.ts's share card: its dark ground, its
 * light words and its accent. A ${companies ? `${noun}'s card brings its own name and brand
 * colour in its signed address, and is drawn in those` : "card is drawn in this site's name"}.
 */
export const SOCIAL_CARD_THEME: CardTheme = {
  ground: BRAND.card.background,
  text: BRAND.card.foreground,
  muted: BRAND.card.muted,
  faint: BRAND.card.panel,
  accent: BRAND.card.accent,
  onAccent: BRAND.card.background,
  ...(glowOf(BRAND.card.accent) ? { glow: glowOf(BRAND.card.accent) } : {}),
};

/** Where cards are drawn, and the key they're signed with. */
export function cardSigning(): CardSigning {
  return { base: \`\${appUrl()}/api/social/card\`, secret: socialCardSecret(), byline: siteByline() };
}

/** A card as a draft keeps it: the signed address, the alt text, the size. */
export function socialCardImage(spec: CardSpec): DraftImage {
  return cardImage(spec, cardSigning());
}

/**
 * A post's images for one platform, in its shape: a quote card with the hook
 * (1:1, LinkedIn 4:5), or the carousel — the hook, the person's own words,
 * the call — at 4:5 (Instagram, Facebook) or 9:16 (TikTok). None for Reddit.
 */
function imagesFor(brand: CardBrandWords | undefined, facts: string, day: string): (platform: Platform, hook: string) => DraftImage[] {
  const date = shortDay(day);
  const own = brand ? { brand } : {};
  return (platform, hook) =>
    draftCards(platform, {
      quote: (size) => quoteCard(hook, size, { date, ...own }),
      carousel: (size) => launchCarousel({ hook, text: facts, eyebrow: \`News · \${date}\`, call: "Read more", ...own }, size),
    }).map(socialCardImage);
}

/** The voice the AI writes a business's hook and sign-off in. Change it to sound like you. */
export function socialVoice(name: string): string {
  return [
    \`You write \${name}'s own social posts, in its own voice: plain, warm and brief, the way someone who works there would say it.\`,
    "No hype, no exclamation marks, no emoji.",
    \`Your own world is \${name}'s everyday work: the shop or office, the team, the tools, the regulars.\`,
  ].join(" ");
}
`;

  const aiPart = ai
    ? `
// --- The AI: the hook and the sign-off, metered ----------------------------

/**
 * The model posts are written with: Claude Haiku 4.5 — the founder's rule,
 * the cheapest model that does the job. Its price must be in MODEL_RATES
 * (src/server/ai.ts): an unpriced model couldn't be metered, so posts are
 * then written in the person's own words and the server log says why.
 */
export const SOCIAL_MODEL: string = DEFAULT_SOCIAL_MODEL;

/**
 * THE MONTH'S AI-WRITTEN POSTS for ${companies ? `each ${noun} (and for this site's own)` : "this site"}: one post
 * is one call (a hook and two sign-offs, about 350 tokens out), at most a
 * cent each at Haiku's price, so 60 a month is at most 60 cents. Past it,
 * posts are still written, in the person's own words, and the card says why.
 */
export const SOCIAL_AI_POSTS_A_MONTH = 60;
const SOCIAL_WORST_CASE_CENTS = 1;
/** One ${companies ? noun : "account"}'s share of the site's day, so nobody spends it all. */
const SOCIAL_DAILY_SHARE_CENTS = Math.max(1, Math.floor(AI_SITE_DAILY_CENTS / 10));
/** Posts' own day across ${companies ? `every ${noun}` : "the site"}: never more than a fifth of the site's, so they can't switch off the rest. */
const SOCIAL_DAILY_CENTS = Math.max(1, Math.min(100, Math.floor(AI_SITE_DAILY_CENTS / 5)));

function resetsOn(usage: AiAllowanceUsage | null): string {
  return (usage?.resetsAt ?? new Date()).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Every limit a post's call is held against, in the posts' own words. */
function allowanceInput(tenantId: string) {
  return {
    tenantId,
    operations: [SOCIAL_POST_OPERATION],
    allowance: { monthlyMessages: SOCIAL_AI_POSTS_A_MONTH, monthlyCents: SOCIAL_AI_POSTS_A_MONTH * SOCIAL_WORST_CASE_CENTS, dailyCents: SOCIAL_DAILY_SHARE_CENTS },
    operationsDailyCents: SOCIAL_DAILY_CENTS,
    siteDailyCents: AI_SITE_DAILY_CENTS,
    onSiteCeiling: alertSiteCeiling,
    words: {
      company_messages: (usage: AiAllowanceUsage | null) => \`This month's AI-written posts are used up. They start again on \${resetsOn(usage)}\`,
      company_spend: (usage: AiAllowanceUsage | null) => \`This month's AI-written posts reached their spending limit. They start again on \${resetsOn(usage)}\`,
      company_day: () => "Today's share of this site's AI is used up. It starts again at midnight UTC",
      feature_day: () => "Posts have used today's share of this site's AI. It starts again at midnight UTC",
      site_ceiling: () => "This site's AI has reached its limit for today. It starts again at midnight UTC",
      unavailable: () => "The AI allowance couldn't be checked right now, so nothing was asked",
    },
  };
}

/**
 * EVERY CALL IS METERED on ${scope}/ai's ledger, as operation "social_post":
 * held before it's asked (inside one lock, so posts written at once see each
 * other), settled after with the PROVIDER's counts — never the model's word,
 * never left free. A failed call keeps its hold (over, never under).
 */
const socialSpend: PostSpend = {
  async reserve({ tenantId, userId, model, reserveMicros }) {
    const verdict = await reserveAiAllowance(db, { ...allowanceInput(tenantId), userId, operation: SOCIAL_POST_OPERATION, model, reserveMicros });
    return verdict.ok ? { ok: true, reservationId: verdict.reservationId } : { ok: false, message: verdict.message };
  },
  async settle(reservationId, outcome) {
    await settleAiReservation(db, MODEL_RATES, reservationId, { usage: outcome.usage, status: outcome.status, latencyMs: outcome.latencyMs, error: outcome.error }, {
      onError: (error) => log.error({ err: error instanceof Error ? error.message : String(error) }, "social: a post's AI use couldn't be recorded"),
    });
  },
};

/** One ${companies ? noun : "account"}'s metered call, or null: no ANTHROPIC_API_KEY, or a model with no price (fail closed). */
export function socialComplete(tenantId: string, userId: string | null): Complete | null {
  if (!anthropic) return null;
  const rate = MODEL_RATES[SOCIAL_MODEL];
  if (!rate) {
    log.error({ model: SOCIAL_MODEL }, "social: AI-written posts are off — MODEL_RATES in src/server/ai.ts has no price for this model");
    return null;
  }
  return createAnthropicComplete({ client: anthropic, model: SOCIAL_MODEL, rate, spend: socialSpend, tenantId, userId });
}
`
    : `
// --- The AI: none ------------------------------------------------------------

/**
 * No model: ${answers.projectName} was generated without --ai, so every post
 * is the person's own words, the first sentence on the images.
 * \`create-app add ai\` wires Claude Haiku 4.5 here, metered.
 */
export function socialComplete(_tenantId: string, _userId: string | null): Complete | null {
  return null;
}
`;

  const writer = `
/** What a test swaps: the model (the project's own tests never call a real one). */
export interface SocialOverrides {
  readonly complete?: Complete | null;
}

/** How the AI writes: only the hook and a sign-off ("aside"), the generic honesty list on every word. */
function writerFor(overrides: SocialOverrides) {
  return ({ tenantId, userId }: { readonly tenantId: string; readonly userId: string | null }): WriterOptions => ({
    complete: overrides.complete !== undefined ? overrides.complete : socialComplete(tenantId, userId),
    honesty: genericHonesty,
    mode: "aside",
  });
}
`;

  const sitePart = site
    ? `
// --- This site's own posts ----------------------------------------------------

/** The staff keys this site's own posts are asked against: one key per job. */
export const SOCIAL_STAFF_KEYS = { "social.view": "staff.social.view", "social.manage": "staff.social.manage" } as const;

/** What "today" means on /admin/posts: an IANA zone ("America/New_York"). Change it to yours. */
export const SITE_TIME_ZONE = "UTC";

/** A post from this site's own words: its name, its voice, its home page by default. */
function siteCompose(input: ComposeRequest): PostSource {
  return launchSource({
    key: input.key,
    facts: input.facts,
    author: SITE_NAME,
    voice: socialVoice(SITE_NAME),
    day: input.day,
    link: input.link ?? \`\${appUrl()}/\`,
    hashtags: input.hashtags,
    platforms: SOCIAL_PLATFORMS,
    images: imagesFor(undefined, input.facts, input.day),
  });
}

/**
 * THIS SITE'S OWN posts, for its staff (/admin/posts over /api/admin/posts):
 * staff.social.view to look, staff.social.manage to write, approve, skip and
 * mark posted. Never a ${companies ? noun : "customer"}'s: the posts are fixed to "*".
 */
export function buildSiteSocialHandlers(overrides: SocialOverrides = {}) {
  return createSocialAdminHandlers({
    db,
    tenantId: SOCIAL_SITE,
    authorize: authorizeStaffFor(SOCIAL_STAFF_KEYS, "Sign in to see posts."),
    compose: siteCompose,
    writer: writerFor(overrides),
    cardFormats: () => cardFormatSets(sampleCardSets(), socialCardImage),
    today: (_tenantId, now) => dayIn(SITE_TIME_ZONE, now),
    onError: reportSocialError,
  });
}
`
    : "";

  const companyPart = companies
    ? `
// --- Each ${noun}'s own posts ---------------------------------------------------

/** A ${noun}'s card brand and page: its name, its page here, its brand colour, its time zone. */
async function companyOf(tenantId: string) {
  const profile = await tenancy.companyProfile(tenantId);
  if (!profile) throw new Error(\`There is no ${noun} \${tenantId} to write posts for.\`);
  const home = \`\${appUrl()}\${profile.publicPath}\`;
  return {
    name: profile.name,
    home,
    timeZone: profile.timeZone,
    brand: cardBrand({ name: profile.name, site: home, accent: profile.brandColor, onAccent: profile.onBrandColor }),
  };
}

/**
 * A ${noun.toUpperCase()}'S OWN POSTS (/app/posts over /api/app/{${noun} id}/posts):
 * social.view to look, social.manage to write, approve, skip and mark
 * posted. The ${noun} is the one in the path, asked on every call; another
 * ${noun}'s post is "not found". Its cards are drawn in its own name and brand
 * colour, its posts point at its own page, and "today" is in its own time
 * zone. \`overrides\` is how the project's isolation proof calls it as
 * somebody else, with no model.
 */
export function buildSocialAdminHandlers(overrides: FeatureHandlerOverrides & SocialOverrides = {}) {
  return createSocialAdminHandlers({
    db,
    resolveTenant: companyRoutes.resolveTenant,
    authorize: companyAuthorizer(overrides),
    compose: async (input) => {
      const company = await companyOf(input.tenantId);
      return launchSource({
        key: input.key,
        facts: input.facts,
        author: company.name,
        voice: socialVoice(company.name),
        day: input.day,
        link: input.link ?? company.home,
        hashtags: input.hashtags,
        platforms: SOCIAL_PLATFORMS,
        images: imagesFor(company.brand, input.facts, input.day),
      });
    },
    writer: writerFor(overrides),
    cardFormats: async (tenantId) => cardFormatSets(sampleCardSets((await companyOf(tenantId)).brand), socialCardImage),
    today: async (tenantId, now) => dayIn((await tenancy.companyProfile(tenantId))?.timeZone ?? null, now),
    onError: reportSocialError,
  });
}
`
    : "";

  return `${imports.join("\n")}

${header}
${common}${aiPart}${writer}${sitePart}${companyPart}`;
}

// ---------------------------------------------------------------------------
// app/api/social/card/route.tsx
// ---------------------------------------------------------------------------

function renderSocialCardRoute(answers: Answers): string {
  const scope = answers.scope;
  const companies = companiesMode(answers);
  return `import { ImageResponse } from "next/og";
import { createCardRoute } from "${scope}/social/cards";
import { cardFonts, CARD_SANS, CARD_SERIF } from "${scope}/social/fonts";
import { siteByline, socialCardSecret, SOCIAL_CARD_THEME } from "@/server/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/social/card?kind=…&size=…&text=…&sig=…: ONE SOCIAL CARD AS A PNG
 * (${scope}/social draws it; src/server/social.ts signs the addresses when a
 * draft is written). Public, so the picture opens wherever the draft is —
 * the posts screen, a posting session — and signed, so nobody can make a card
 * say something the business didn't${companies ? ", or draw one in a company's name" : ""}: a query whose
 * signature doesn't match its words is a 403, one that names no card a 400.
 * A card can't change once signed, so it's cached for a day (a year at the CDN).
 */
export const GET = createCardRoute({
  secret: socialCardSecret,
  assets: () => {
    const byline = siteByline();
    return {
      fonts: cardFonts(),
      serif: CARD_SERIF,
      sans: CARD_SANS,
      theme: SOCIAL_CARD_THEME,
      author: { name: byline.name, handle: byline.handle },
      brand: { name: byline.name, site: byline.site },
    };
  },
  paint: ImageResponse,
});
`;
}

// ---------------------------------------------------------------------------
// The API routes
// ---------------------------------------------------------------------------

function renderSocialRoute(answers: Answers, which: "site" | "company"): string {
  const noun = tenantLabel(answers).toLowerCase();
  const builder = which === "site" ? "buildSiteSocialHandlers" : "buildSocialAdminHandlers";
  const where =
    which === "site"
      ? "This site's own posts: /admin/posts calls /api/admin/posts/v1/admin/…"
      : `A ${noun}'s posts: /app/posts calls /api/app/{${noun} id}/posts/v1/admin/…`;
  return `import { ${builder} } from "@/server/social";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Writing a post is one AI call at most (20 seconds, no retry): well inside a minute. */
export const maxDuration = 60;

/**
 * ${where} —
 * the queue, a post from the person's own facts, edits, approve, mark posted,
 * skip, the posting session's list (GET …/v1/admin/approved: every approved
 * post with what to paste, attach and comment) and the card formats
 * (SOCIAL_ADMIN_ROUTES). Never cross-origin. Nothing here posts anything.
 */
const { handle } = ${builder}();

export const GET = handle;
export const POST = handle;
`;
}

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

function renderSitePostsPage(answers: Answers): string {
  const scope = answers.scope;
  return `import { isDbConfigured } from "${scope}/db";
import { PostsAdmin } from "${scope}/social/ui";
import { db } from "@/db";
import { EmptyState, Notice, PageHeader } from "@/components/ui";
import { SITE_NAME } from "@/seo";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN POSTS (create-app 0.41): every post drafted for this site's
 * own social accounts, one card per platform in that platform's format —
 * today's, drafts waiting from earlier days, what's ready to post (with the
 * posting session's list as JSON), a post from your own facts, the history,
 * and every card format. Approved posts are posted BY HAND and marked posted
 * with their link: nothing on this page posts anything. The page checks the
 * staff key first so someone without it gets a sentence; the routes check
 * again on every call.
 */
export default async function PostsPage() {
  if (!isDbConfigured(db)) {
    return (
      <>
        <PageHeader title="Posts" />
        <EmptyState title="No database yet">
          Posts are kept in this site&rsquo;s own database. Set DATABASE_URL and run the migrations.
        </EmptyState>
      </>
    );
  }
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;
  if (!can?.can("staff.social.view")) {
    return (
      <>
        <PageHeader title="Posts" />
        <Notice tone="warn">You don&rsquo;t have permission to see posts.</Notice>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Posts"
        description={\`\${SITE_NAME}'s own posts, written for each platform: edit, approve, then post them by hand. Nothing here posts anything.\`}
      />
      <PostsAdmin baseUrl="/api/admin/posts" canManage={can.can("staff.social.manage")} businessName={SITE_NAME} />
    </>
  );
}
`;
}

function renderCompanyPostsPage(answers: Answers): string {
  const noun = tenantLabel(answers).toLowerCase();
  return `import { PostsAdmin } from "${answers.scope}/social/ui";
import { CompanyGate } from "@/components/CompanyGate";
import { PageHeader, WORK_MAIN } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The ${noun}'s posts (create-app 0.41): drafts for its own social accounts,
 * one card per platform in that platform's format and in its own name and
 * brand colour — today's, earlier drafts, what's ready to post, a post from
 * its own facts, the history, and every card format. The package's screen
 * over /api/app/{id}/posts, which checks the person's permission on every
 * call: social.view to look, social.manage to write, approve and mark posted.
 * Approved posts are posted BY HAND: nothing here posts anything.
 */
export default async function CompanyPostsPage() {
  return (
    <CompanyGate path="/app/posts" permission="social.view">
      {({ company, can }) => (
        <main className={WORK_MAIN}>
          <PageHeader
            title="Posts"
            description="Posts for your own social accounts, written for each platform: edit, approve, then post them by hand."
          />
          <PostsAdmin baseUrl={\`/api/app/\${company.id}/posts\`} canManage={can.includes("social.manage")} businessName={company.name} />
        </main>
      )}
    </CompanyGate>
  );
}
`;
}

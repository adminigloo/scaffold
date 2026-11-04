import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/**
 * `npx adminigloo-social init` (social 0.3): ONE COMMAND THAT WIRES THE POSTS
 * SCREEN INTO A NEXT.JS APP on Drizzle and Postgres. It finds the app's own
 * pieces (its app directory, its database, its Drizzle schema, its AI
 * library), writes the few files the package needs beside them, and never
 * overwrites one the app already has. Planned here, written by ./main.ts.
 *
 * What it writes:
 *   lib/social-posts.ts                  the glue: the handler, the cards, the AI, the rules
 *   app/api/admin/posts/[...path]/route  the screen's server route
 *   app/api/social/card/route            the card images (signed, public)
 *   app/admin/posts/page                 the posts screen
 *   + one line in the Drizzle schema     the table, for drizzle-kit to migrate
 *   + SOCIAL_CARD_SECRET in .env.local   the key the card addresses are signed with
 *
 * SAFE BY DEFAULT: the screen is closed to everyone until the app's own
 * staff check is wired into `authorize` (one function, marked WIRE 1).
 */

export type AiChoice = "openai" | "ai-sdk-openai" | "ai-sdk-anthropic" | "anthropic" | "none";

export interface InitOptions {
  /** The app's root (where package.json is). */
  readonly root: string;
  /** Which AI the posts use; found from the app's dependencies when left out. */
  readonly ai?: AiChoice;
  /** The admin path the screen lives at. Default /admin/posts. */
  readonly adminPath?: string;
  /** The key for the card addresses: a new random one unless given (tests). */
  readonly secret?: string;
}

/** One file the command writes, or one it adds a line to. */
export interface PlannedFile {
  readonly path: string;
  readonly contents: string;
  /** "create": a new file (skipped if one is there); "append": lines added to a file (skipped if already there). */
  readonly mode: "create" | "append";
  /** For "append": the text that shows it's already done. */
  readonly marker?: string;
  /** Never shown in output: it holds a secret. */
  readonly secret?: boolean;
}

export interface InitPlan {
  readonly files: readonly PlannedFile[];
  readonly ai: AiChoice;
  readonly found: { readonly appDir: string; readonly db: string | null; readonly schema: string | null };
  readonly warnings: readonly string[];
  readonly next: readonly string[];
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

/** An import path from one file to another, without its extension, always starting "./" or "../". */
export function importPath(fromFile: string, toFile: string): string {
  const rel = relative(dirname(fromFile), toFile).split(sep).join("/").replace(/\.(tsx?|mts|js)$/, "").replace(/\/index$/, "");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** The app's dependencies, dev ones included. */
function dependencies(root: string): Record<string, string> {
  const pkg = JSON.parse(read(join(root, "package.json")) ?? "{}") as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/** Which AI the app already uses: its AI SDK provider, the Anthropic SDK, or an OpenAI key; none otherwise. */
export function detectAi(root: string): AiChoice {
  const deps = dependencies(root);
  if (deps.ai && deps["@ai-sdk/anthropic"]) return "ai-sdk-anthropic";
  if (deps.ai && deps["@ai-sdk/openai"]) return "ai-sdk-openai";
  if (deps["@anthropic-ai/sdk"]) return "anthropic";
  const env = `${read(join(root, ".env.local")) ?? ""}\n${read(join(root, ".env")) ?? ""}`;
  if (deps.openai || /^OPENAI_API_KEY=/m.test(env)) return "openai";
  return "none";
}

/** The file that exports the app's Drizzle `db`, from the usual places. */
export function findDb(root: string): string | null {
  const candidates = ["db/client.ts", "db/index.ts", "lib/db.ts", "lib/db/index.ts", "server/db.ts", "server/db/index.ts", "src/server/db/index.ts", "src/server/db.ts", "src/db/index.ts", "src/lib/db.ts", "src/lib/db/index.ts", "src/db.ts", "db.ts"];
  for (const c of candidates) {
    const text = read(join(root, c));
    if (text && /export\s+const\s+db\b/.test(text)) return join(root, c);
  }
  return null;
}

/** The Drizzle schema file drizzle.config names (its `schema:`), when it's one file. */
export function findSchema(root: string): string | null {
  for (const name of ["drizzle.config.ts", "drizzle.config.mts", "drizzle.config.js", "drizzle.config.mjs"]) {
    const text = read(join(root, name));
    const match = text && /schema:\s*["'`]([^"'`]+)["'`]/.exec(text);
    if (match?.[1] && /\.(ts|mts|js)$/.test(match[1])) {
      const path = join(root, match[1]);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The app's name, for the cards until SOCIAL_SITE_NAME is set. */
function appName(root: string): string {
  const pkg = JSON.parse(read(join(root, "package.json")) ?? "{}") as { name?: string };
  return (pkg.name ?? "Our business").replace(/^@[^/]+\//, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const AI: Record<AiChoice, { readonly imports: string; readonly body: string; readonly env: string }> = {
  openai: {
    imports: `import { createOpenAIComplete, openAIFetchClient } from "@adminigloo/social/openai";`,
    body: `  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.SOCIAL_AI_MODEL;
  if (!apiKey || !model) return null;
  return createOpenAIComplete({
    client: openAIFetchClient({ apiKey }),
    model,
    rate: SOCIAL_AI_RATE,
    tenantId: "*",
    // A reasoning model (the gpt-5 family) thinks out of the same small bound: give it room, keep its effort low.
    ...(process.env.SOCIAL_AI_REASONING ? { reasoningTokens: 1000, extraBody: { reasoning_effort: process.env.SOCIAL_AI_REASONING } } : {}),
  });`,
    env: "OPENAI_API_KEY (yours already) and SOCIAL_AI_MODEL (the OpenAI model the posts use; leave it out for no AI)",
  },
  "ai-sdk-openai": {
    imports: `import { openai } from "@ai-sdk/openai";\nimport { generateText } from "ai";\nimport { createAiSdkComplete } from "@adminigloo/social/ai-sdk";`,
    body: `  const model = process.env.SOCIAL_AI_MODEL;
  if (!process.env.OPENAI_API_KEY || !model) return null;
  return createAiSdkComplete({ generateText, model: openai(model), rate: SOCIAL_AI_RATE, tenantId: "*" });`,
    env: "OPENAI_API_KEY (yours already) and SOCIAL_AI_MODEL (the model the posts use; leave it out for no AI)",
  },
  "ai-sdk-anthropic": {
    imports: `import { anthropic } from "@ai-sdk/anthropic";\nimport { generateText } from "ai";\nimport { createAiSdkComplete } from "@adminigloo/social/ai-sdk";`,
    body: `  if (!process.env.ANTHROPIC_API_KEY) return null;
  // Claude Haiku 4.5 by default: the cheapest model that does the job ($1 in, $5 out per million tokens).
  return createAiSdkComplete({ generateText, model: anthropic(process.env.SOCIAL_AI_MODEL ?? "claude-haiku-4-5"), rate: SOCIAL_AI_RATE, tenantId: "*" });`,
    env: "ANTHROPIC_API_KEY (yours already); SOCIAL_AI_MODEL to change the model (Claude Haiku 4.5 by default)",
  },
  anthropic: {
    imports: `import Anthropic from "@anthropic-ai/sdk";\nimport { createAnthropicComplete } from "@adminigloo/social/anthropic";`,
    body: `  if (!process.env.ANTHROPIC_API_KEY) return null;
  return createAnthropicComplete({ client: new Anthropic(), rate: SOCIAL_AI_RATE, tenantId: "*", ...(process.env.SOCIAL_AI_MODEL ? { model: process.env.SOCIAL_AI_MODEL } : {}) });`,
    env: "ANTHROPIC_API_KEY (yours already); SOCIAL_AI_MODEL to change the model (Claude Haiku 4.5 by default)",
  },
  none: {
    imports: "",
    body: `  // No AI: every post is the person's own words, the first sentence on the images.
  return null;`,
    env: "nothing: there's no AI (run init again with --ai to add one)",
  },
};

function glueFile(o: { readonly dbImport: string | null; readonly name: string; readonly ai: AiChoice; readonly adminPath: string }): string {
  const ai = AI[o.ai];
  const dbLine = o.dbImport ? `import { db } from "${o.dbImport}";` : `// WIRE 0: init couldn't find your Drizzle \`db\`. Import it here.\nimport { db } from "./db";`;
  return `/**
 * SOCIAL POSTS (@adminigloo/social), wired by \`npx adminigloo-social init\`.
 *
 * The posts screen is ${o.adminPath}. The app drafts a post for each platform
 * from what a person types; a person approves it and posts it by hand (or
 * sends a TikTok's pictures or video to the app from a phone).
 *
 * Yours to finish, marked WIRE:
 *   1. authorize: who may see and write posts. CLOSED TO EVERYONE until you wire it.
 *   2. the AI: ${ai.env}.
 *   3. the site: SOCIAL_SITE_URL and SOCIAL_SITE_NAME (the cards and the links).
 */
import { combineHonesty, genericHonesty, launchSource, PLATFORM_IDS, smell, type Complete, type DraftImage, type Platform, type PostLife } from "@adminigloo/social";
import { cardFormatSets, cardImage, draftCards, launchCarousel, quoteCard, sampleCardSets, type CardSpec, type CardTheme } from "@adminigloo/social/cards";
import { createSocialAdminHandlers, dayIn, type SocialAuthorizeResult } from "@adminigloo/social/server";
${ai.imports ? `${ai.imports}\n` : ""}${dbLine}

/** WIRE 3: the site, as the cards and the links name it. */
export const SOCIAL_SITE_NAME = process.env.SOCIAL_SITE_NAME ?? ${JSON.stringify(o.name)};
export const SOCIAL_SITE_URL = (process.env.SOCIAL_SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\\/+$/, "");
/** The business's own time zone: what "today" means on the posts screen. */
const SOCIAL_TIME_ZONE = process.env.SOCIAL_TIME_ZONE ?? "America/Denver";

/** The key the card addresses are signed with (init put one in .env.local; add it to your host too). */
export function socialCardSecret(): string {
  const secret = process.env.SOCIAL_CARD_SECRET;
  if (!secret) throw new Error("Set SOCIAL_CARD_SECRET: npx adminigloo-social init wrote one to .env.local.");
  return secret;
}

/** Who the cards say posted: the name, the handle and the address. */
export const SOCIAL_BYLINE = { name: SOCIAL_SITE_NAME, handle: process.env.SOCIAL_HANDLE ?? SOCIAL_SITE_NAME, site: SOCIAL_SITE_URL.replace(/^https?:\\/\\//, "") };

/** The cards' colours: change them to your brand's. */
export const SOCIAL_CARD_THEME: CardTheme = { ground: "#14181f", text: "#f5f6f8", muted: "#aab3bf", faint: "#5b6472", accent: "#e0a43a", onAccent: "#14181f" };

const image = (spec: CardSpec): DraftImage => cardImage(spec, { base: \`\${SOCIAL_SITE_URL}/api/social/card\`, secret: socialCardSecret(), byline: SOCIAL_BYLINE });
const shortDay = (day: string) => new Date(\`\${day}T12:00:00Z\`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A post's images for one platform: a quote card, or a carousel (TikTok's at 9:16, inside its safe zone). */
function imagesFor(facts: string, day: string) {
  const date = shortDay(day);
  return (platform: Platform, hook: string) =>
    draftCards(platform, {
      quote: (size) => quoteCard(hook, size, { date }),
      carousel: (size) => launchCarousel({ hook, text: facts, eyebrow: \`News · \${date}\`, call: "Read more" }, size),
    }).map(image);
}

/**
 * WIRE 1: WHO MAY SEE AND WRITE POSTS. Return \`{ userId }\` for your staff,
 * \`false\` for everyone else. \`permission\` is "social.view" (to look) or
 * "social.manage" (to write, approve, skip and mark posted).
 */
async function authorize(_req: Request, _permission: string): Promise<SocialAuthorizeResult> {
  // Closed until you wire your own staff check here.
  return false;
}

/** The AI's price per million tokens, in millionths of a dollar ($0.25 is 250_000): what a call is held at, when you meter it. */
const SOCIAL_AI_RATE = { inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 5_000_000 };

/** WIRE 2: THE AI. Null is no AI: posts in the person's own words. */
function socialComplete(): Complete | null {
${ai.body}
}

/** How long a post is worth posting: about a week from its day. */
const SOCIAL_LIFE: PostLife = ({ day }) => ({ until: new Date(Date.parse(\`\${day}T00:00:00Z\`) + 8 * 86_400_000), label: "about a week" });

/** The AI's words held to the generic honesty list and, for its sign-offs, the AI-smell check. */
const SOCIAL_HONESTY = combineHonesty(genericHonesty, (text, part) => (part === "aside" ? smell(text, { names: false }) : null));

/** The handler behind the posts screen: the site's own posts ("*"). */
export function socialHandlers() {
  return createSocialAdminHandlers({
    db,
    tenantId: "*",
    authorize,
    compose: (input) =>
      launchSource({
        key: input.key,
        facts: input.facts,
        author: SOCIAL_SITE_NAME,
        voice: \`You write \${SOCIAL_SITE_NAME}'s own social posts, in its own voice: plain, warm and brief. No hype, no exclamation marks, no emoji.\`,
        day: input.day,
        link: input.link ?? SOCIAL_SITE_URL,
        hashtags: input.hashtags,
        platforms: PLATFORM_IDS,
        images: imagesFor(input.facts, input.day),
      }),
    writer: () => ({ complete: socialComplete(), honesty: SOCIAL_HONESTY, mode: "aside", tagLinks: true }),
    cardFormats: () => cardFormatSets(sampleCardSets(), image),
    today: (_tenantId, now) => dayIn(SOCIAL_TIME_ZONE, now),
    life: SOCIAL_LIFE,
  });
}
`;
}

/** Everything init would write in this app, without writing it. */
export function planInit(options: InitOptions): InitPlan {
  const root = options.root;
  const warnings: string[] = [];
  if (!read(join(root, "package.json"))) throw new Error(`No package.json in ${root}: run init in your app's folder.`);
  const deps = dependencies(root);
  if (!deps.next) warnings.push("This doesn't look like a Next.js app (no next in package.json): the routes and the page are written for Next's app directory.");
  if (!deps["drizzle-orm"]) warnings.push("No drizzle-orm in package.json: the posts table is a Drizzle table on Postgres.");
  const src = existsSync(join(root, "src", "app")) ? join(root, "src") : root;
  const appDir = join(src, "app");
  if (!existsSync(appDir)) warnings.push(`No app directory at ${relative(root, appDir) || "app"}: it's created.`);
  const adminPath = (options.adminPath ?? "/admin/posts").replace(/\/+$/, "");
  const ai = options.ai ?? detectAi(root);
  const db = findDb(root);
  if (!db) warnings.push("Couldn't find your Drizzle `db` export: wire its import in lib/social-posts.ts (WIRE 0).");
  const schema = findSchema(root);
  if (!schema) warnings.push("Couldn't find your Drizzle schema file: add `export { socialPosts } from \"@adminigloo/social/schema\";` to it, then generate a migration.");

  const glue = join(src, "lib", "social-posts.ts");
  const apiRoute = join(appDir, "api", "admin", "posts", "[...path]", "route.ts");
  const cardRoute = join(appDir, "api", "social", "card", "route.tsx");
  const page = join(appDir, ...adminPath.split("/").filter(Boolean), "page.tsx");
  const files: PlannedFile[] = [
    { path: glue, mode: "create", contents: glueFile({ dbImport: db ? importPath(glue, db) : null, name: appName(root), ai, adminPath }) },
    {
      path: apiRoute,
      mode: "create",
      contents: `import { socialHandlers } from "${importPath(apiRoute, glue)}";

/** The posts screen's server route (@adminigloo/social): every call checked by authorize in lib/social-posts.ts. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const { handle } = socialHandlers();
export const GET = handle;
export const POST = handle;
`,
    },
    {
      path: cardRoute,
      mode: "create",
      contents: `import { ImageResponse } from "next/og";
import { createCardRoute } from "@adminigloo/social/cards";
import { cardFonts, CARD_SANS, CARD_SERIF } from "@adminigloo/social/fonts";
import { SOCIAL_BYLINE, SOCIAL_CARD_THEME, socialCardSecret } from "${importPath(cardRoute, glue)}";

/** One social card as a PNG (@adminigloo/social): public, so a platform can fetch it, and signed, so only your posts' words are drawn. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = createCardRoute({
  secret: socialCardSecret,
  assets: () => ({ fonts: cardFonts(), serif: CARD_SERIF, sans: CARD_SANS, theme: SOCIAL_CARD_THEME, author: { name: SOCIAL_BYLINE.name, handle: SOCIAL_BYLINE.handle }, brand: { name: SOCIAL_BYLINE.name, site: SOCIAL_BYLINE.site } }),
  paint: ImageResponse,
});
`,
    },
    {
      path: page,
      mode: "create",
      contents: `import { PostsAdmin } from "@adminigloo/social/ui";
import { SOCIAL_SITE_NAME } from "${importPath(page, glue)}";

/** The posts screen (@adminigloo/social). Your admin layout's own sign-in gate applies; the server route checks authorize too. */
export const dynamic = "force-dynamic";

export default function PostsPage() {
  return <PostsAdmin baseUrl="/api/admin/posts" canManage businessName={SOCIAL_SITE_NAME} />;
}
`,
    },
  ];
  if (schema) files.push({ path: schema, mode: "append", marker: "@adminigloo/social/schema", contents: `\n// Social posts (@adminigloo/social): the posts table, for drizzle-kit to migrate.\nexport { socialPosts } from "@adminigloo/social/schema";\n` });
  const secret = options.secret ?? randomBytes(32).toString("base64url");
  files.push({ path: join(root, ".env.local"), mode: "append", marker: "SOCIAL_CARD_SECRET=", contents: `\n# Social posts (@adminigloo/social): the key the card addresses are signed with. Add the same value to your host.\nSOCIAL_CARD_SECRET=${secret}\n`, secret: true });

  const next = [
    `Wire authorize in ${relative(root, glue)} (WIRE 1): the screen is closed to everyone until you do.`,
    `The AI: ${AI[ai].env}.`,
    "Set SOCIAL_SITE_URL and SOCIAL_SITE_NAME (and SOCIAL_HANDLE, SOCIAL_TIME_ZONE if you like) in your environment.",
    "Generate the migration your usual way (npm run db:generate), review it, and apply it your usual way.",
    "Add SOCIAL_CARD_SECRET to your host's environment (the value init wrote to .env.local).",
    `Add a link to ${adminPath} in your admin menu.`,
  ];
  return { files, ai, found: { appDir: relative(root, appDir) || ".", db: db ? relative(root, db) : null, schema: schema ? relative(root, schema) : null }, warnings, next };
}

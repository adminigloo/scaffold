import { AI_KIND_OPTIONS, ROBOTS_BOTS, TOKENLESS_BOT_NAMES, type BotKind, type RobotsBot } from "./bots.js";
import { Issues, SeoError } from "./errors.js";
import type { PathList } from "./paths.js";
import { absoluteUrl, type Site } from "./site.js";
import { asArray, isHttpUrl } from "./util.js";

/**
 * robots.txt as a policy, built from the site's ONE path list and the shared
 * bot list. What it guarantees, each a defect it replaces:
 *
 *   - Off production (`site.indexable` false) it is `Disallow: /` for everyone
 *     and nothing else: no sitemap line advertising the staging origin. The
 *     trade-off: a crawler that may not fetch a page never sees its noindex,
 *     so a staging host that is ALREADY in an index cannot drop out while it
 *     is disallowed. For that host, serve an allow-all robots.txt
 *     (`robotsTxt({ rules: { userAgent: "*", allow: "/" } })`) until it has
 *     dropped out; every page there already carries `noindex, nofollow`.
 *   - `/_next/` is never disallowed (`definePaths` refuses it): trailcards'
 *     `Disallow: /_next/` hid every optimised image and the CSS and JS Google
 *     renders pages with.
 *   - A private path blocks exactly what the path list means by it: the
 *     path, everything under it and its query strings, never a page that only
 *     starts with the same letters. Robots rules are prefixes, so `/e` alone
 *     would also block `/elm-street-church/spring-hunt` (an org slug) and
 *     `/admin` would block `/admin-guide`. Each private path is written as
 *     three rules instead: `Disallow: /e$` (the path itself; `$` is RFC 9309,
 *     read by Google and Bing), `Disallow: /e/` and `Disallow: /e?`. So
 *     `/checkout` blocks `/checkout`, `/checkout/`, `/checkout/pay` and
 *     `/checkout?step=2` (trailcards' `/checkout/` did not block `/checkout`),
 *     and robots.txt, the noindex header and the sitemap agree on every path.
 *   - noindex paths are NOT disallowed: a page a crawler may not fetch is a
 *     page whose noindex it never sees.
 *   - AI bots are named from the analytics list (current names: OAI-SearchBot,
 *     Claude-SearchBot, Claude-User, Perplexity-User…; never the retired
 *     Claude-Web), each allowed or refused by what it does: `training`
 *     (GPTBot, ClaudeBot, CCBot, Google-Extended…), `search` (OAI-SearchBot,
 *     Claude-SearchBot, PerplexityBot…) or `userFetch` (ChatGPT-User,
 *     Claude-User, Perplexity-User: a person asked an assistant about you).
 *   - A bot named in its own group ignores the `*` group, so an allowed bot's
 *     group repeats every private rule; one group per token, so even a naive
 *     parser reads it right (seo-reports 0.1 mis-reads multi-agent groups).
 */

export type Access = "allow" | "deny";

export interface RobotsPolicyOptions {
  /**
   * By what the bot does. Each defaults to "allow". Some training crawlers
   * also feed answers (Google-Extended: Gemini's grounding; Meta-ExternalAgent:
   * Meta AI; Amazonbot: Alexa), so `training: "deny"` costs those too unless
   * `bots` lets them back in.
   */
  ai?: { training?: Access; search?: Access; userFetch?: Access };
  /** Googlebot, Bingbot, Applebot, DuckDuckBot… Default "allow". */
  searchEngines?: Access;
  /** Link previewers (Twitterbot, facebookexternalhit…). Default "allow". */
  social?: Access;
  /** AhrefsBot, SemrushBot… Default "allow". */
  seoTools?: Access;
  /**
   * Per bot, by analytics name or robots token (case-insensitive), winning
   * over its class: `{ GPTBot: "deny", "Google-Extended": "deny" }`. A token
   * the list does not know gets its own group (letters, digits, `_` and `-`
   * only). A bot the list knows but that has no robots.txt token (WhatsApp,
   * "Other bot") is refused: nothing could be written for it.
   */
  bots?: Readonly<Record<string, Access>>;
  /** Write an explicit group for each ALLOWED AI bot, so a reader sees them named. Default true. */
  nameAiBots?: boolean;
  /** One group with several User-agent lines per distinct rule set, instead of one group per token. Default false. */
  combine?: boolean;
  /** Sitemap paths or URLs. Default ["/sitemap.xml"]; false for none. */
  sitemaps?: readonly string[] | false;
  /**
   * The bot list. Default: the analytics list compiled into this build
   * (ROBOTS_BOTS). An app that runs @adminigloo/analytics too passes
   * `[...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS]` from it, and robots.txt
   * follows the installed analytics exactly.
   */
  crawlers?: readonly RobotsBot[];
  /** Default: the site's path list. */
  paths?: PathList;
}

export interface RobotsGroup {
  userAgent: string | string[];
  allow?: string[];
  disallow?: string[];
}

/** The shape Next's `app/robots.ts` returns (`MetadataRoute.Robots`), and what `robotsTxt()` writes. */
export interface RobotsPolicy {
  rules: RobotsGroup[];
  sitemap?: string[];
}

function classAccess(kind: BotKind, options: RobotsPolicyOptions): Access | null {
  if (kind in AI_KIND_OPTIONS) {
    const option = AI_KIND_OPTIONS[kind as keyof typeof AI_KIND_OPTIONS];
    return options.ai?.[option] ?? "allow";
  }
  if (kind === "search") return options.searchEngines ?? "allow";
  if (kind === "social") return options.social ?? "allow";
  if (kind === "seo-tool") return options.seoTools ?? "allow";
  return null;
}

/** An RFC 9309 product token, plus digits (MJ12bot, AI2Bot), which every crawler that uses them matches. */
const TOKEN = /^[A-Za-z0-9_-]+$/;

/** The rules that block a private path and nothing that merely starts with the same letters. */
export function privatePathRules(path: string): string[] {
  return [`${path}$`, `${path}/`, `${path}?`];
}

export function robotsPolicy(site: Site, options: RobotsPolicyOptions = {}): RobotsPolicy {
  if (!site.indexable) return { rules: [{ userAgent: "*", disallow: ["/"] }] };

  const issues = new Issues("robotsPolicy", "invalid_config");
  const paths = options.paths ?? site.paths;
  const disallow = paths.private.flatMap(privatePathRules);
  const allow = ["/"];
  const crawlers = options.crawlers ?? ROBOTS_BOTS;

  const overrides = new Map<string, Access>();
  for (const [key, access] of Object.entries(options.bots ?? {})) {
    const token = key.trim();
    const known = crawlers.find((bot) => [bot.name, ...bot.robotsTokens].some((k) => k.toLowerCase() === token.toLowerCase()));
    const tokenless = known ? known.robotsTokens.length === 0 : TOKENLESS_BOT_NAMES.some((name) => name.toLowerCase() === token.toLowerCase());
    if (token === "*") issues.add('bots["*"] is not allowed: close a whole site with defineSite({ indexable: false })');
    else if (tokenless) issues.add(`bots: "${key}" has no robots.txt token, so robots.txt cannot name it`);
    else if (!known && !TOKEN.test(token)) issues.add(`bots: "${key}" is not a robots.txt user-agent token (letters, digits, _ and - only)`);
    if (access !== "allow" && access !== "deny") issues.add(`bots["${key}"] must be "allow" or "deny"`);
    overrides.set(token.toLowerCase(), access);
  }
  for (const [name, value] of Object.entries({ ...options.ai, searchEngines: options.searchEngines, social: options.social, seoTools: options.seoTools })) {
    if (value !== undefined && value !== "allow" && value !== "deny") issues.add(`${name} must be "allow" or "deny"`);
  }
  issues.throwIfAny();

  const groups: RobotsGroup[] = [{ userAgent: "*", allow: [...allow], disallow: [...disallow] }];
  const named = new Set<string>(["*"]);
  const push = (token: string, access: Access): void => {
    if (named.has(token.toLowerCase())) return;
    named.add(token.toLowerCase());
    groups.push(access === "deny" ? { userAgent: token, disallow: ["/"] } : { userAgent: token, allow: [...allow], disallow: [...disallow] });
  };

  for (const bot of crawlers) {
    const override = [bot.name, ...bot.robotsTokens].map((key) => overrides.get(key.toLowerCase())).find((value) => value !== undefined);
    const access = override ?? classAccess(bot.kind, options);
    if (access === null) continue;
    const isAi = bot.kind in AI_KIND_OPTIONS;
    if (access === "allow" && override === undefined && !(isAi && options.nameAiBots !== false)) continue;
    for (const token of bot.robotsTokens) push(token, access);
    for (const key of [bot.name, ...bot.robotsTokens]) overrides.delete(key.toLowerCase());
  }
  for (const [key, access] of Object.entries(options.bots ?? {})) {
    if (overrides.has(key.trim().toLowerCase())) push(key.trim(), access);
  }

  const sitemaps = options.sitemaps === false ? [] : (options.sitemaps ?? ["/sitemap.xml"]).map((s) => absoluteUrl(site, s));
  for (const sitemap of sitemaps) if (!isHttpUrl(sitemap)) throw new SeoError("invalid_config", "robotsPolicy", [`sitemap ${sitemap} is not an http(s) URL`]);

  const rules = options.combine ? combineGroups(groups) : groups;
  return sitemaps.length > 0 ? { rules, sitemap: sitemaps } : { rules };
}

function combineGroups(groups: RobotsGroup[]): RobotsGroup[] {
  const [star, ...rest] = groups;
  const byRules = new Map<string, RobotsGroup>();
  for (const group of rest) {
    const key = JSON.stringify([group.allow ?? [], group.disallow ?? []]);
    const existing = byRules.get(key);
    if (existing) (existing.userAgent as string[]).push(...asArray(group.userAgent));
    else byRules.set(key, { ...group, userAgent: [...asArray(group.userAgent)] });
  }
  return [star!, ...byRules.values()];
}

/**
 * robots.txt text for a policy (or any Next-shaped robots object). A group
 * with no rules gets an empty `Disallow:`, because under RFC 9309 a run of
 * User-agent lines with no rule between them joins the NEXT group's agents.
 */
export interface RobotsRuleInput {
  userAgent?: string | readonly string[];
  allow?: string | readonly string[];
  disallow?: string | readonly string[];
  crawlDelay?: number;
}

export function robotsTxt(policy: { rules: RobotsRuleInput | readonly RobotsRuleInput[]; sitemap?: string | readonly string[]; host?: string }): string {
  const lines: string[] = [];
  const rules: readonly RobotsRuleInput[] = Array.isArray(policy.rules) ? policy.rules : [policy.rules as RobotsRuleInput];
  for (const group of rules) {
    const agents = asArray(group.userAgent ?? "*");
    for (const agent of agents.length > 0 ? agents : ["*"]) lines.push(`User-agent: ${agent}`);
    const allows = asArray(group.allow);
    const disallows = asArray(group.disallow);
    for (const path of allows) lines.push(`Allow: ${path}`);
    for (const path of disallows) lines.push(`Disallow: ${path}`);
    if (allows.length === 0 && disallows.length === 0) lines.push("Disallow:");
    if (group.crawlDelay !== undefined) lines.push(`Crawl-delay: ${group.crawlDelay}`);
    lines.push("");
  }
  for (const sitemap of asArray(policy.sitemap)) lines.push(`Sitemap: ${sitemap}`);
  if (policy.host) lines.push(`Host: ${policy.host}`);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

interface ParsedGroup {
  agents: string[];
  rules: Array<{ allow: boolean; pattern: string }>;
}

function parseRobots(source: string): ParsedGroup[] {
  const groups: ParsedGroup[] = [];
  let current: ParsedGroup | null = null;
  let inAgentRun = false;
  for (const raw of source.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || !inAgentRun) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgentRun = true;
    } else if (key === "allow" || key === "disallow") {
      if (current) current.rules.push({ allow: key === "allow", pattern: value });
      inAgentRun = false;
    }
  }
  return groups;
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

/**
 * Would a crawler with this product token be allowed to fetch this path,
 * per RFC 9309: the groups naming the token (case-insensitive) or else `*`,
 * merged; the longest matching rule wins, and `Allow` wins a tie; `*` and a
 * trailing `$` are honoured; `/robots.txt` itself is always allowed.
 * `path` may carry a query ("/checkout?step=2"), which rules match too.
 *
 * A crawler that obeys more than one token passes them most specific first:
 * Google's image crawler is `["Googlebot-Image", "Googlebot"]`, so with no
 * `Googlebot-Image` group it follows the `Googlebot` group, and only then
 * `*`. Matching is exact per token, never by prefix.
 */
export function isAllowedByRobots(source: string, token: string | readonly string[], path: string): boolean {
  if (path === "/robots.txt") return true;
  const groups = parseRobots(source);
  let matched: ParsedGroup[] = [];
  for (const one of typeof token === "string" ? [token] : token) {
    const want = one.trim().toLowerCase();
    matched = groups.filter((group) => group.agents.includes(want));
    if (matched.length > 0) break;
  }
  if (matched.length === 0) matched = groups.filter((group) => group.agents.includes("*"));
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of matched.flatMap((group) => group.rules)) {
    if (rule.pattern === "" || !patternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { length, allow: rule.allow };
  }
  return best ? best.allow : true;
}

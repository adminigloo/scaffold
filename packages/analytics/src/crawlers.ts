/**
 * Who, among the non-humans, is reading the site — from the request's
 * User-Agent, server-side. Crawlers do not run JavaScript, so a client beacon
 * can never see them (which is why trailcards' AI-bot panel was structurally
 * empty); the app logs them from its own request handling instead.
 *
 * The kinds are the story an owner cares about:
 *  - ai-assistant: fetched live because a person asked an AI about you — the
 *    most direct signal that you are being cited.
 *  - ai-search: building an AI answer engine's search index.
 *  - ai-training: collecting pages for model training.
 *  - search / social / seo-tool: the classic crawlers, link previews and audit tools.
 *
 * A User-Agent can be spoofed. These counts say "requests that CLAIMED to be
 * GPTBot", and every surface that shows them should say so; verifying by
 * reverse DNS or published IP ranges is a later, injected step.
 */

export const CRAWLER_KINDS = ["ai-assistant", "ai-search", "ai-training", "search", "social", "seo-tool", "other"] as const;
export type CrawlerKind = (typeof CRAWLER_KINDS)[number];

export const CRAWLER_KIND_LABELS: Record<CrawlerKind, string> = {
  "ai-assistant": "AI assistant, answering someone",
  "ai-search": "AI search index",
  "ai-training": "AI training crawler",
  search: "Search engine",
  social: "Link preview",
  "seo-tool": "SEO tool",
  other: "Other bot",
};

export interface CrawlerMatch {
  name: string;
  kind: CrawlerKind;
  /** Who runs it, for display. */
  operator: string;
}

/**
 * A crawler as robots.txt sees it: the classifier's match plus the product
 * tokens a `User-agent:` line names it by. @adminigloo/seo builds its
 * robots.txt groups from this list, so the bots a site lets in or keeps out
 * and the bots its crawler log counts are one list and cannot drift.
 */
export interface KnownCrawler extends CrawlerMatch {
  /**
   * The bot's current robots.txt product tokens (RFC 9309), never a retired
   * one: `Claude-Web` and `anthropic-ai` are still matched as ClaudeBot for
   * the log, but nothing writes a robots.txt group for them. Empty when there
   * is no token worth naming: a fetcher that ignores robots.txt, or the
   * catch-all.
   */
  robotsTokens: readonly string[];
}

/**
 * Specific before generic: "ChatGPT-User" must win over "GPTBot", and every
 * named bot over the bare "bot" catch-all. Google-Extended and
 * Applebot-Extended are robots.txt tokens, not User-Agents, so they are not
 * here; they are in ROBOTS_CONTROL_TOKENS below.
 *
 * The third column is the bot's robots.txt tokens (KnownCrawler.robotsTokens).
 *
 * A kind is what the bot is FOR. Several training crawlers feed answers too,
 * and blocking them costs those answers: Google-Extended also controls
 * grounding in Gemini Apps, Meta-ExternalAgent also indexes for Meta AI, and
 * Amazonbot also feeds Alexa. @adminigloo/seo's README says so where a site
 * chooses to refuse training.
 */
const PATTERNS: Array<[RegExp | readonly RegExp[], CrawlerMatch, readonly string[]]> = [
  // OpenAI
  [/ChatGPT-User/i, { name: "ChatGPT-User", kind: "ai-assistant", operator: "OpenAI" }, ["ChatGPT-User"]],
  [/OAI-SearchBot/i, { name: "OAI-SearchBot", kind: "ai-search", operator: "OpenAI" }, ["OAI-SearchBot"]],
  [/GPTBot/i, { name: "GPTBot", kind: "ai-training", operator: "OpenAI" }, ["GPTBot"]],
  // Anthropic
  [/Claude-User/i, { name: "Claude-User", kind: "ai-assistant", operator: "Anthropic" }, ["Claude-User"]],
  [/Claude-SearchBot/i, { name: "Claude-SearchBot", kind: "ai-search", operator: "Anthropic" }, ["Claude-SearchBot"]],
  [/ClaudeBot|anthropic-ai|Claude-Web/i, { name: "ClaudeBot", kind: "ai-training", operator: "Anthropic" }, ["ClaudeBot"]],
  // Perplexity
  [/Perplexity-User/i, { name: "Perplexity-User", kind: "ai-assistant", operator: "Perplexity" }, ["Perplexity-User"]],
  [/PerplexityBot/i, { name: "PerplexityBot", kind: "ai-search", operator: "Perplexity" }, ["PerplexityBot"]],
  // Others in the AI set
  [/MistralAI-User/i, { name: "MistralAI-User", kind: "ai-assistant", operator: "Mistral" }, ["MistralAI-User"]],
  [/DuckAssistBot/i, { name: "DuckAssistBot", kind: "ai-assistant", operator: "DuckDuckGo" }, ["DuckAssistBot"]],
  [/meta-externalfetcher/i, { name: "Meta-ExternalFetcher", kind: "ai-assistant", operator: "Meta" }, ["Meta-ExternalFetcher"]],
  [/meta-externalagent/i, { name: "Meta-ExternalAgent", kind: "ai-training", operator: "Meta" }, ["Meta-ExternalAgent"]],
  [/meta-webindexer/i, { name: "Meta-WebIndexer", kind: "ai-search", operator: "Meta" }, ["Meta-WebIndexer"]],
  [/FacebookBot/i, { name: "FacebookBot", kind: "ai-training", operator: "Meta" }, ["FacebookBot"]],
  [/Amzn-User/i, { name: "Amzn-User", kind: "ai-assistant", operator: "Amazon" }, ["Amzn-User"]],
  [/Amzn-SearchBot/i, { name: "Amzn-SearchBot", kind: "ai-search", operator: "Amazon" }, ["Amzn-SearchBot"]],
  [/Amazonbot/i, { name: "Amazonbot", kind: "ai-training", operator: "Amazon" }, ["Amazonbot"]],
  [/Google-CloudVertexBot/i, { name: "Google-CloudVertexBot", kind: "ai-search", operator: "Google" }, ["Google-CloudVertexBot"]],
  [/Applebot/i, { name: "Applebot", kind: "search", operator: "Apple" }, ["Applebot"]],
  [/CCBot/i, { name: "CCBot", kind: "ai-training", operator: "Common Crawl" }, ["CCBot"]],
  [/Bytespider/i, { name: "Bytespider", kind: "ai-training", operator: "ByteDance" }, ["Bytespider"]],
  [/cohere-ai|cohere-training/i, { name: "cohere-ai", kind: "ai-training", operator: "Cohere" }, ["cohere-ai", "cohere-training-data-crawler"]],
  [/Diffbot/i, { name: "Diffbot", kind: "ai-training", operator: "Diffbot" }, ["Diffbot"]],
  [/YouBot/i, { name: "YouBot", kind: "ai-search", operator: "You.com" }, ["YouBot"]],
  [/AI2Bot/i, { name: "AI2Bot", kind: "ai-training", operator: "Ai2" }, ["AI2Bot"]],
  [/Timpibot/i, { name: "Timpibot", kind: "ai-training", operator: "Timpi" }, ["Timpibot"]],
  [/PanguBot/i, { name: "PanguBot", kind: "ai-training", operator: "Huawei" }, ["PanguBot"]],
  [/TikTokSpider/i, { name: "TikTokSpider", kind: "ai-training", operator: "ByteDance" }, ["TikTokSpider"]],
  [/PetalBot/i, { name: "PetalBot", kind: "search", operator: "Huawei" }, ["PetalBot"]],
  // Search engines
  [/Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google|Mediapartners-Google/i, { name: "Googlebot", kind: "search", operator: "Google" }, ["Googlebot"]],
  // Google's general fetcher for its product teams' one-off and research crawls: not a training control (that is Google-Extended).
  [/GoogleOther/i, { name: "GoogleOther", kind: "other", operator: "Google" }, ["GoogleOther"]],
  [/bingbot|BingPreview|adidxbot/i, { name: "Bingbot", kind: "search", operator: "Microsoft" }, ["Bingbot"]],
  [/DuckDuckBot/i, { name: "DuckDuckBot", kind: "search", operator: "DuckDuckGo" }, ["DuckDuckBot"]],
  [/YandexBot|YandexImages/i, { name: "YandexBot", kind: "search", operator: "Yandex" }, ["YandexBot"]],
  [/Baiduspider/i, { name: "Baiduspider", kind: "search", operator: "Baidu" }, ["Baiduspider"]],
  [/SeznamBot/i, { name: "SeznamBot", kind: "search", operator: "Seznam" }, ["SeznamBot"]],
  // Link previews
  [/facebookexternalhit|facebookcatalog/i, { name: "Facebook preview", kind: "social", operator: "Meta" }, ["facebookexternalhit"]],
  [/Twitterbot/i, { name: "Twitterbot", kind: "social", operator: "X" }, ["Twitterbot"]],
  [/LinkedInBot/i, { name: "LinkedInBot", kind: "social", operator: "LinkedIn" }, ["LinkedInBot"]],
  [/Slackbot/i, { name: "Slackbot", kind: "social", operator: "Slack" }, ["Slackbot"]],
  [/Discordbot/i, { name: "Discordbot", kind: "social", operator: "Discord" }, ["Discordbot"]],
  [/WhatsApp/i, { name: "WhatsApp", kind: "social", operator: "Meta" }, []],
  [/TelegramBot/i, { name: "TelegramBot", kind: "social", operator: "Telegram" }, ["TelegramBot"]],
  [/Pinterestbot/i, { name: "Pinterestbot", kind: "social", operator: "Pinterest" }, ["Pinterestbot"]],
  [/redditbot/i, { name: "redditbot", kind: "social", operator: "Reddit" }, ["redditbot"]],
  // SEO tools
  [/AhrefsBot|AhrefsSiteAudit/i, { name: "AhrefsBot", kind: "seo-tool", operator: "Ahrefs" }, ["AhrefsBot", "AhrefsSiteAudit"]],
  [/SemrushBot|SiteAuditBot/i, { name: "SemrushBot", kind: "seo-tool", operator: "Semrush" }, ["SemrushBot", "SiteAuditBot"]],
  [/MJ12bot/i, { name: "MJ12bot", kind: "seo-tool", operator: "Majestic" }, ["MJ12bot"]],
  [/DotBot/i, { name: "DotBot", kind: "seo-tool", operator: "Moz" }, ["DotBot"]],
  [/Screaming Frog/i, { name: "Screaming Frog", kind: "seo-tool", operator: "Screaming Frog" }, ["Screaming Frog SEO Spider"]],
  [/Chrome-Lighthouse|PageSpeed/i, { name: "Lighthouse", kind: "seo-tool", operator: "Google" }, []],
  [/adminigloo-seo-reports/i, { name: "AdminIgloo audit", kind: "seo-tool", operator: "AdminIgloo" }, ["adminigloo-seo-reports"]],
  [/ImagesiftBot/i, { name: "ImagesiftBot", kind: "other", operator: "ImageSift" }, ["ImagesiftBot"]],
  // Generic, last. The second pattern is case-SENSITIVE on purpose: it catches
  // a CamelCase "…Bot" product token ("SomeSearchBot/1.0") that `\bbot\b`
  // cannot, without counting a phone whose model name ends in "BOT" (a CUBOT
  // handset) or a page-running monitor ("UptimeRobot", which @adminigloo/audience
  // leaves out as automation) as a crawler.
  [
    [/\bbot\b|crawler|spider|crawl|slurp|HeadlessChrome|python-requests|curl\/|wget|Go-http-client|axios\//i, /[a-z]Bot\b/],
    { name: "Other bot", kind: "other", operator: "Unknown" },
    [],
  ],
];

function matches(pattern: RegExp | readonly RegExp[], userAgent: string): boolean {
  return pattern instanceof RegExp ? pattern.test(userAgent) : pattern.some((one) => one.test(userAgent));
}

/**
 * Every crawler the classifier names, in match order, with its robots.txt
 * tokens. Data for robots.txt builders (@adminigloo/seo) and admin screens;
 * classifying a request stays `classifyCrawler`, whose answers are unchanged.
 */
export const KNOWN_CRAWLERS: readonly KnownCrawler[] = /* @__PURE__ */ PATTERNS.map(([, match, robotsTokens]) => ({ ...match, robotsTokens }));

/**
 * robots.txt tokens that are not User-Agents. No request ever carries them,
 * so the crawler log never sees them, but they are how a site keeps its pages
 * out of Google's and Apple's AI training while staying in their search:
 * Googlebot and Applebot keep crawling, and the content is not used to train.
 */
export const ROBOTS_CONTROL_TOKENS: readonly KnownCrawler[] = [
  { name: "Google-Extended", kind: "ai-training", operator: "Google", robotsTokens: ["Google-Extended"] },
  { name: "Applebot-Extended", kind: "ai-training", operator: "Apple", robotsTokens: ["Applebot-Extended"] },
];

export function classifyCrawler(userAgent: string | null | undefined): CrawlerMatch | null {
  if (!userAgent) return null;
  for (const [pattern, match] of PATTERNS) if (matches(pattern, userAgent)) return match;
  return null;
}

export function isAiCrawlerKind(kind: CrawlerKind): boolean {
  return kind === "ai-assistant" || kind === "ai-search" || kind === "ai-training";
}

/**
 * The name `classifyCrawler` gives @adminigloo/seo-reports' own fetcher
 * (`adminigloo-seo-reports/0.1`): the site auditing itself. It is a bot, so it
 * never becomes a visit; its crawler rows are still recorded, and the crawler
 * reports leave them out unless a call asks for `includeInternal`.
 */
export const SEO_AUDIT_BOT_NAME = "AdminIgloo audit";

/** Bot names the crawler reports leave out by default (`createAnalytics({ excludeBots })` replaces the list). */
export const DEFAULT_EXCLUDED_BOTS: readonly string[] = [SEO_AUDIT_BOT_NAME];

/**
 * The live-fetch bot behind each AI engine — the request an assistant makes
 * because a person asked it about you. Pairs "ChatGPT-User fetched /pricing
 * 14 times" with "6 visits came from ChatGPT" in `getAiAssistantTraffic`.
 */
export const ASSISTANT_BOT_ENGINES: Readonly<Record<string, string>> = {
  "ChatGPT-User": "chatgpt",
  "Claude-User": "claude",
  "Perplexity-User": "perplexity",
  "MistralAI-User": "mistral",
  DuckAssistBot: "duckai",
  "Meta-ExternalFetcher": "meta",
};

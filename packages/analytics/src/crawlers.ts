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
 * Specific before generic: "ChatGPT-User" must win over "GPTBot", and every
 * named bot over the bare "bot" catch-all. Google-Extended and
 * Applebot-Extended are robots.txt tokens, not User-Agents, so they are not here.
 */
const PATTERNS: Array<[RegExp, CrawlerMatch]> = [
  // OpenAI
  [/ChatGPT-User/i, { name: "ChatGPT-User", kind: "ai-assistant", operator: "OpenAI" }],
  [/OAI-SearchBot/i, { name: "OAI-SearchBot", kind: "ai-search", operator: "OpenAI" }],
  [/GPTBot/i, { name: "GPTBot", kind: "ai-training", operator: "OpenAI" }],
  // Anthropic
  [/Claude-User/i, { name: "Claude-User", kind: "ai-assistant", operator: "Anthropic" }],
  [/Claude-SearchBot/i, { name: "Claude-SearchBot", kind: "ai-search", operator: "Anthropic" }],
  [/ClaudeBot|anthropic-ai|Claude-Web/i, { name: "ClaudeBot", kind: "ai-training", operator: "Anthropic" }],
  // Perplexity
  [/Perplexity-User/i, { name: "Perplexity-User", kind: "ai-assistant", operator: "Perplexity" }],
  [/PerplexityBot/i, { name: "PerplexityBot", kind: "ai-search", operator: "Perplexity" }],
  // Others in the AI set
  [/MistralAI-User/i, { name: "MistralAI-User", kind: "ai-assistant", operator: "Mistral" }],
  [/DuckAssistBot/i, { name: "DuckAssistBot", kind: "ai-assistant", operator: "DuckDuckGo" }],
  [/meta-externalfetcher/i, { name: "Meta-ExternalFetcher", kind: "ai-assistant", operator: "Meta" }],
  [/meta-externalagent/i, { name: "Meta-ExternalAgent", kind: "ai-training", operator: "Meta" }],
  [/Amazonbot/i, { name: "Amazonbot", kind: "ai-training", operator: "Amazon" }],
  [/Applebot/i, { name: "Applebot", kind: "search", operator: "Apple" }],
  [/CCBot/i, { name: "CCBot", kind: "ai-training", operator: "Common Crawl" }],
  [/Bytespider/i, { name: "Bytespider", kind: "ai-training", operator: "ByteDance" }],
  [/cohere-ai|cohere-training/i, { name: "cohere-ai", kind: "ai-training", operator: "Cohere" }],
  [/Diffbot/i, { name: "Diffbot", kind: "ai-training", operator: "Diffbot" }],
  [/YouBot/i, { name: "YouBot", kind: "ai-search", operator: "You.com" }],
  [/PetalBot/i, { name: "PetalBot", kind: "search", operator: "Huawei" }],
  // Search engines
  [/Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google|Mediapartners-Google/i, { name: "Googlebot", kind: "search", operator: "Google" }],
  [/GoogleOther/i, { name: "GoogleOther", kind: "ai-training", operator: "Google" }],
  [/bingbot|BingPreview|adidxbot/i, { name: "Bingbot", kind: "search", operator: "Microsoft" }],
  [/DuckDuckBot/i, { name: "DuckDuckBot", kind: "search", operator: "DuckDuckGo" }],
  [/YandexBot|YandexImages/i, { name: "YandexBot", kind: "search", operator: "Yandex" }],
  [/Baiduspider/i, { name: "Baiduspider", kind: "search", operator: "Baidu" }],
  [/SeznamBot/i, { name: "SeznamBot", kind: "search", operator: "Seznam" }],
  // Link previews
  [/facebookexternalhit|facebookcatalog/i, { name: "Facebook preview", kind: "social", operator: "Meta" }],
  [/Twitterbot/i, { name: "Twitterbot", kind: "social", operator: "X" }],
  [/LinkedInBot/i, { name: "LinkedInBot", kind: "social", operator: "LinkedIn" }],
  [/Slackbot/i, { name: "Slackbot", kind: "social", operator: "Slack" }],
  [/Discordbot/i, { name: "Discordbot", kind: "social", operator: "Discord" }],
  [/WhatsApp/i, { name: "WhatsApp", kind: "social", operator: "Meta" }],
  [/TelegramBot/i, { name: "TelegramBot", kind: "social", operator: "Telegram" }],
  [/Pinterestbot/i, { name: "Pinterestbot", kind: "social", operator: "Pinterest" }],
  [/redditbot/i, { name: "redditbot", kind: "social", operator: "Reddit" }],
  // SEO tools
  [/AhrefsBot|AhrefsSiteAudit/i, { name: "AhrefsBot", kind: "seo-tool", operator: "Ahrefs" }],
  [/SemrushBot|SiteAuditBot/i, { name: "SemrushBot", kind: "seo-tool", operator: "Semrush" }],
  [/MJ12bot/i, { name: "MJ12bot", kind: "seo-tool", operator: "Majestic" }],
  [/DotBot/i, { name: "DotBot", kind: "seo-tool", operator: "Moz" }],
  [/Screaming Frog/i, { name: "Screaming Frog", kind: "seo-tool", operator: "Screaming Frog" }],
  [/Chrome-Lighthouse|PageSpeed/i, { name: "Lighthouse", kind: "seo-tool", operator: "Google" }],
  [/adminigloo-seo-reports/i, { name: "AdminIgloo audit", kind: "seo-tool", operator: "AdminIgloo" }],
  // Generic, last
  [/\bbot\b|crawler|spider|crawl|slurp|HeadlessChrome|python-requests|curl\/|wget|Go-http-client|axios\//i, { name: "Other bot", kind: "other", operator: "Unknown" }],
];

export function classifyCrawler(userAgent: string | null | undefined): CrawlerMatch | null {
  if (!userAgent) return null;
  for (const [pattern, match] of PATTERNS) if (pattern.test(userAgent)) return match;
  return null;
}

export function isAiCrawlerKind(kind: CrawlerKind): boolean {
  return kind === "ai-assistant" || kind === "ai-search" || kind === "ai-training";
}

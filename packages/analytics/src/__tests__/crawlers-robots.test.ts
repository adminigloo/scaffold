import { describe, expect, it } from "vitest";
import { classifyCrawler, isAiCrawlerKind, KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "../crawlers.js";

/**
 * The bot list as robots.txt builders read it (@adminigloo/seo's robots
 * groups come from KNOWN_CRAWLERS). The classifier is the source of truth;
 * these pin that the robots tokens agree with it.
 */
describe("KNOWN_CRAWLERS", () => {
  it("lists every crawler once, by the name the classifier gives it", () => {
    const names = KNOWN_CRAWLERS.map((crawler) => crawler.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("GPTBot");
    expect(names.at(-1)).toBe("Other bot");
  });

  it("names every robots token back to its own crawler when the token is sent as a User-Agent", () => {
    for (const crawler of KNOWN_CRAWLERS) {
      for (const token of crawler.robotsTokens) {
        expect([token, classifyCrawler(`Mozilla/5.0 (compatible; ${token}/1.0)`)?.name]).toEqual([token, crawler.name]);
      }
    }
  });

  it("gives every AI crawler a token, and carries the current AI names", () => {
    for (const crawler of KNOWN_CRAWLERS) {
      if (isAiCrawlerKind(crawler.kind)) expect([crawler.name, crawler.robotsTokens.length > 0]).toEqual([crawler.name, true]);
    }
    const tokens = KNOWN_CRAWLERS.flatMap((crawler) => crawler.robotsTokens);
    for (const current of ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "ClaudeBot", "Perplexity-User", "PerplexityBot"]) {
      expect(tokens).toContain(current);
    }
  });

  it("never writes a retired token, though the classifier still recognises the old User-Agents", () => {
    const tokens = [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS].flatMap((crawler) => crawler.robotsTokens.map((t) => t.toLowerCase()));
    expect(tokens).not.toContain("claude-web");
    expect(tokens).not.toContain("anthropic-ai");
    expect(classifyCrawler("Claude-Web/1.0")?.name).toBe("ClaudeBot");
  });

  it("does not change what classifyCrawler returns (no robots tokens leak into a stored match)", () => {
    expect(classifyCrawler("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toEqual({
      name: "GPTBot",
      kind: "ai-training",
      operator: "OpenAI",
    });
  });
});

describe("ROBOTS_CONTROL_TOKENS", () => {
  it("are the training opt-outs that are not User-Agents", () => {
    expect(ROBOTS_CONTROL_TOKENS.map((t) => t.robotsTokens[0])).toEqual(["Google-Extended", "Applebot-Extended"]);
    for (const control of ROBOTS_CONTROL_TOKENS) expect(control.kind).toBe("ai-training");
    expect(classifyCrawler("Google-Extended")).toBeNull();
  });
});

describe("current AI crawlers, from the operators' own documentation", () => {
  it("names the Amazon, Google, Meta and other AI crawlers that 0.2 counted as human visits", () => {
    const cases: Array<[string, string, string]> = [
      ["Mozilla/5.0 (compatible; Amzn-SearchBot/1.0; +https://developer.amazon.com/amazonbot)", "Amzn-SearchBot", "ai-search"],
      ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amzn-User/0.1) Chrome/119.0 Safari/537.36", "Amzn-User", "ai-assistant"],
      ["Mozilla/5.0 (compatible; Google-CloudVertexBot; +https://cloud.google.com/enterprise-search)", "Google-CloudVertexBot", "ai-search"],
      ["meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)", "Meta-WebIndexer", "ai-search"],
      ["Mozilla/5.0 (compatible; FacebookBot/1.0; +https://developers.facebook.com/docs/sharing/webmasters/facebookbot/)", "FacebookBot", "ai-training"],
      ["Mozilla/5.0 (compatible) AI2Bot (+https://www.allenai.org/crawler)", "AI2Bot", "ai-training"],
      ["Timpibot/0.8 (+http://www.timpi.io)", "Timpibot", "ai-training"],
      ["Mozilla/5.0 (compatible; PanguBot/1.0)", "PanguBot", "ai-training"],
      ["Mozilla/5.0 (compatible; TikTokSpider; ttspider-feedback@tiktok.com)", "TikTokSpider", "ai-training"],
    ];
    for (const [userAgent, name, kind] of cases) expect([userAgent, classifyCrawler(userAgent)]).toEqual([userAgent, { name, kind, operator: expect.any(String) }]);
    const tokens = KNOWN_CRAWLERS.flatMap((crawler) => crawler.robotsTokens);
    for (const [, name] of cases) expect(tokens).toContain(name);
  });

  it("files GoogleOther as Google's general fetcher, not a training control", () => {
    expect(classifyCrawler("Mozilla/5.0 (compatible; GoogleOther)")).toMatchObject({ name: "GoogleOther", kind: "other" });
  });

  it("counts any CamelCase …Bot product token as a bot, but not a phone whose model ends in BOT or a page-running monitor", () => {
    expect(classifyCrawler("Mozilla/5.0 (compatible; SomeNewSearchBot/2.0)")).toMatchObject({ name: "Other bot" });
    expect(classifyCrawler("Mozilla/5.0 (Linux; Android 13; CUBOT KINGKONG 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36")).toBeNull();
    // A visit to analytics; @adminigloo/audience leaves it out as automation.
    expect(classifyCrawler("Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)")).toBeNull();
  });
});

import { KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "@adminigloo/analytics/crawlers";
import { describe, expect, it } from "vitest";
import { definePaths, defineSite, isAllowedByRobots, pathRule, robotsPolicy, robotsTxt, ROBOTS_BOTS, SeoError, type RobotsPolicyOptions } from "../index.js";
import { NOINDEX_PREFIXES, paths, site, SITE_INPUT, staging } from "./fixtures.js";

const txt = (options?: RobotsPolicyOptions) => robotsTxt(robotsPolicy(site, options));

const TRAINING = ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "Applebot-Extended", "Meta-ExternalAgent", "Bytespider", "Amazonbot", "FacebookBot", "AI2Bot"];
const AI_SEARCH = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "YouBot", "Amzn-SearchBot", "Meta-WebIndexer"];
const USER_FETCH = ["ChatGPT-User", "Claude-User", "Perplexity-User", "MistralAI-User", "DuckAssistBot", "Meta-ExternalFetcher", "Amzn-User"];

describe("the bot list is @adminigloo/analytics' list", () => {
  it("names every AI crawler analytics classifies, plus the training opt-out tokens, and nothing else invented", () => {
    const fromAnalytics = [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS].filter((bot) => bot.robotsTokens.length > 0);
    expect(ROBOTS_BOTS.map((bot) => [bot.name, bot.kind, [...bot.robotsTokens]])).toEqual(fromAnalytics.map((bot) => [bot.name, bot.kind, [...bot.robotsTokens]]));
  });

  it("carries the current names and never the retired Claude-Web", () => {
    const tokens = ROBOTS_BOTS.flatMap((bot) => bot.robotsTokens);
    for (const current of ["OAI-SearchBot", "Claude-SearchBot", "Claude-User", "Perplexity-User", "ChatGPT-User", "GPTBot", "ClaudeBot", "Amzn-SearchBot"]) {
      expect(tokens).toContain(current);
    }
    expect(tokens.map((t) => t.toLowerCase())).not.toContain("claude-web");
    expect(txt()).not.toMatch(/claude-web/i);
  });
});

/**
 * Paths that START with the same letters as a private path but are not
 * under it: Riddler Go's org-slug event pages (`/{orgSlug}/{eventSlug}`, in
 * no list) and pages next to a private area. Every one is public by the path
 * list, so robots.txt must let it be crawled.
 */
const LOOKALIKES = [
  "/elm-street-church/spring-hunt",
  "/e2e-labs/kickoff",
  "/eventful-co/gala",
  "/events-preview",
  "/qr-codes-co/hunt",
  "/dev-team/offsite",
  "/developers",
  "/playground-pals/hunt",
  "/played",
  "/apiary",
  "/api-docs",
  "/staffing-agency/hunt",
  "/setup-crew/party",
  "/shared-joy/reunion",
  "/invited-guests/party",
  "/settingsville/fair",
  "/admin-guide",
  "/adminigloo/demo",
  "/dashboards-weekly/x",
  "/event-builders-guild/meetup",
  "/sso-callbacks/x",
];

describe("default policy: everyone in, private areas out", () => {
  const body = txt();

  it("writes each private path as three segment-exact rules (never a bare prefix), and the sitemap", () => {
    expect(
      body.startsWith(
        "User-agent: *\nAllow: /\nDisallow: /admin$\nDisallow: /admin/\nDisallow: /admin?\nDisallow: /dashboard$\nDisallow: /dashboard/\nDisallow: /dashboard?\nDisallow: /events$\n",
      ),
    ).toBe(true);
    expect(body).not.toMatch(/^Disallow: \/e$/m);
    expect(body).not.toMatch(/^Allow: \/(?!$)/m);
    expect(body.trimEnd().endsWith("Sitemap: https://riddlergo.com/sitemap.xml")).toBe(true);
  });

  it("agrees with the path list on every path: blocked exactly when pathRule says private (the X-Robots-Tag and the sitemap read the same list)", () => {
    const probes = [
      ...LOOKALIKES,
      ...paths.private.flatMap((p) => [p, `${p}/`, `${p}/x`, `${p}/x/y`, `${p}?step=2`, `${p}/?a=b`, `${p}-guide`, `${p}x/y`, `${p}.json`]),
      ...paths.noindex.flatMap((p) => [p, `${p}/sso-callback`]),
      ...paths.public.map((p) => p.path),
      "/templates/bridal-shower",
      "/riddler/hunt?utm_source=x",
      "/",
    ];
    for (const bot of ["Googlebot", "Bingbot", "GPTBot", "Claude-User", "Twitterbot"]) {
      for (const path of probes) {
        expect([bot, path, isAllowedByRobots(body, bot, path)]).toEqual([bot, path, pathRule(paths, path) !== "private"]);
      }
    }
  });

  it("negative control: the bare-prefix form Riddler Go writes today blocks the org-slug pages, so the agreement test can tell", () => {
    const bare = `User-agent: *\n${NOINDEX_PREFIXES.map((p) => `Disallow: ${p}`).join("\n")}\n`;
    const blocked = LOOKALIKES.filter((path) => !isAllowedByRobots(bare, "Googlebot", path));
    expect(blocked).toContain("/elm-street-church/spring-hunt");
    expect(blocked).toContain("/qr-codes-co/hunt");
    expect(blocked.length).toBeGreaterThan(10);
  });

  it("never blocks /_next/ (optimised images, CSS and JS)", () => {
    expect(body).not.toContain("/_next");
    for (const bot of ["*", "Googlebot", "GPTBot", "Twitterbot"]) {
      expect(isAllowedByRobots(body, bot, "/_next/image?url=%2Fhero.png&w=1080&q=75")).toBe(true);
      expect(isAllowedByRobots(body, bot, "/_next/static/css/app.css")).toBe(true);
    }
    expect(() => definePaths({ private: ["/_next/"] })).toThrow(/_next/);
    expect(() => definePaths({ private: ["/_next/image"] })).toThrow(/_next/);
  });

  it("is trailing-slash safe: /api/ in the list blocks /api, /api/, /api/x and /api?x=1", () => {
    for (const path of ["/api", "/api/", "/api/trpc/x", "/api?x=1", "/checkout", "/checkout/", "/checkout?step=2"]) {
      const list = definePaths({ private: ["/api/", "/checkout/"] });
      const local = robotsTxt(robotsPolicy(defineSite({ ...SITE_INPUT, paths: list })));
      expect([path, isAllowedByRobots(local, "Googlebot", path)]).toEqual([path, false]);
    }
  });

  it("leaves noindex paths crawlable, so the crawler can see the noindex", () => {
    for (const path of ["/sign-in", "/sign-up", "/sign-in/sso-callback"]) expect(isAllowedByRobots(body, "Googlebot", path)).toBe(true);
    expect(isAllowedByRobots(body, "Googlebot", "/e/ABC123")).toBe(false);
    expect(isAllowedByRobots(body, "Googlebot", "/e")).toBe(false);
  });

  it("names every allowed AI bot in its own group that repeats the private rules", () => {
    for (const bot of [...TRAINING, ...AI_SEARCH, ...USER_FETCH]) {
      expect(body).toContain(`User-agent: ${bot}\nAllow: /\nDisallow: /admin$\nDisallow: /admin/\n`);
      expect([bot, isAllowedByRobots(body, bot, "/pricing")]).toEqual([bot, true]);
      expect([bot, isAllowedByRobots(body, bot, "/elm-street-church/spring-hunt")]).toEqual([bot, true]);
      expect([bot, isAllowedByRobots(body, bot, "/admin")]).toEqual([bot, false]);
    }
    expect(body).not.toContain("User-agent: Googlebot");
  });

  it("can stay quiet about allowed bots", () => {
    expect(txt({ nameAiBots: false })).not.toContain("GPTBot");
  });
});

describe("per class and per bot", () => {
  it("training: deny keeps GPTBot, ClaudeBot, CCBot, Google-Extended out while search and assistants stay in", () => {
    const body = txt({ ai: { training: "deny" } });
    for (const bot of TRAINING) expect([bot, isAllowedByRobots(body, bot, "/pricing")]).toEqual([bot, false]);
    for (const bot of [...AI_SEARCH, ...USER_FETCH, "Googlebot", "Applebot", "Bingbot"]) {
      expect([bot, isAllowedByRobots(body, bot, "/pricing")]).toEqual([bot, true]);
    }
    expect(body).toContain("User-agent: Google-Extended\nDisallow: /\n");
  });

  it("GoogleOther is Google's general fetcher, not a training control: training deny leaves it under *", () => {
    const body = txt({ ai: { training: "deny" } });
    expect(body).not.toContain("User-agent: GoogleOther");
    expect(isAllowedByRobots(body, "GoogleOther", "/pricing")).toBe(true);
  });

  it("training: deny with the dual-use bots let back in keeps Gemini grounding, Meta AI and Alexa answers", () => {
    const body = txt({ ai: { training: "deny" }, bots: { "Google-Extended": "allow", "Meta-ExternalAgent": "allow", Amazonbot: "allow" } });
    for (const bot of ["Google-Extended", "Meta-ExternalAgent", "Amazonbot"]) expect([bot, isAllowedByRobots(body, bot, "/pricing")]).toEqual([bot, true]);
    for (const bot of ["GPTBot", "ClaudeBot", "CCBot"]) expect([bot, isAllowedByRobots(body, bot, "/pricing")]).toEqual([bot, false]);
  });

  it("search: deny keeps the AI search indexes out only", () => {
    const body = txt({ ai: { search: "deny" } });
    for (const bot of AI_SEARCH) expect([bot, isAllowedByRobots(body, bot, "/")]).toEqual([bot, false]);
    for (const bot of [...TRAINING, ...USER_FETCH]) expect([bot, isAllowedByRobots(body, bot, "/")]).toEqual([bot, true]);
  });

  it("userFetch: deny keeps assistants fetching for a person out only", () => {
    const body = txt({ ai: { userFetch: "deny" } });
    for (const bot of USER_FETCH) expect([bot, isAllowedByRobots(body, bot, "/")]).toEqual([bot, false]);
    for (const bot of [...TRAINING, ...AI_SEARCH]) expect([bot, isAllowedByRobots(body, bot, "/")]).toEqual([bot, true]);
  });

  it("search engines, link previews and SEO tools by class", () => {
    const body = txt({ searchEngines: "deny", social: "deny", seoTools: "deny" });
    for (const bot of ["Googlebot", "Bingbot", "Applebot", "DuckDuckBot", "Twitterbot", "facebookexternalhit", "AhrefsBot", "SemrushBot", "SiteAuditBot"]) {
      expect([bot, isAllowedByRobots(body, bot, "/")]).toEqual([bot, false]);
    }
    expect(isAllowedByRobots(txt(), "Twitterbot", "/opengraph-image")).toBe(true);
  });

  it("one bot by name or token beats its class, either way", () => {
    const body = txt({ ai: { training: "deny" }, bots: { gptbot: "allow", "Claude-SearchBot": "deny", "Facebook preview": "deny" } });
    expect(isAllowedByRobots(body, "GPTBot", "/")).toBe(true);
    expect(isAllowedByRobots(body, "GPTBot", "/admin")).toBe(false);
    expect(isAllowedByRobots(body, "ClaudeBot", "/")).toBe(false);
    expect(isAllowedByRobots(body, "Claude-SearchBot", "/")).toBe(false);
    expect(isAllowedByRobots(body, "facebookexternalhit", "/")).toBe(false);
  });

  it("an unknown token gets its own group", () => {
    const body = txt({ bots: { NewAIBot: "deny" } });
    expect(body).toContain("User-agent: NewAIBot\nDisallow: /\n");
    expect(isAllowedByRobots(body, "NewAIBot", "/")).toBe(false);
  });

  it("refuses an override robots.txt cannot express: a bot with no token, a token with spaces, *, a bad value", () => {
    expect(() => robotsPolicy(site, { bots: { WhatsApp: "deny" } })).toThrow(/"WhatsApp" has no robots.txt token/);
    expect(() => robotsPolicy(site, { bots: { "Other bot": "deny" } })).toThrow(/"Other bot" has no robots.txt token/);
    expect(() => robotsPolicy(site, { crawlers: [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS], bots: { Lighthouse: "deny" } })).toThrow(/no robots.txt token/);
    expect(() => robotsPolicy(site, { bots: { "My Bot": "deny" } })).toThrow(/"My Bot" is not a robots.txt user-agent token/);
    expect(() => robotsPolicy(site, { bots: { "*": "deny" } })).toThrow(/indexable: false/);
    expect(() => robotsPolicy(site, { bots: { "Bad:Bot": "deny" } })).toThrow(SeoError);
    expect(() => robotsPolicy(site, { bots: { GPTBot: "block" as never } })).toThrow(/"allow" or "deny"/);
    expect(() => robotsPolicy(site, { ai: { training: "no" as never } })).toThrow(/training must be/);
  });

  it("follows the analytics list an app passes in (the full list, tokenless bots included)", () => {
    const body = robotsTxt(robotsPolicy(site, { crawlers: [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS], ai: { training: "deny" } }));
    expect(body).toBe(txt({ ai: { training: "deny" } }));
  });

  it("combine: one group per rule set, agents listed together, same answers", () => {
    const options: RobotsPolicyOptions = { ai: { training: "deny" }, combine: true };
    const policy = robotsPolicy(site, options);
    const separate = txt({ ai: { training: "deny" } });
    const combined = robotsTxt(policy);
    expect(policy.rules).toHaveLength(3);
    for (const bot of [...TRAINING, ...AI_SEARCH, ...USER_FETCH, "Googlebot"]) {
      for (const path of ["/", "/admin", "/admin-guide", "/elm-street-church/spring-hunt"]) {
        expect([bot, path, isAllowedByRobots(combined, bot, path)]).toEqual([bot, path, isAllowedByRobots(separate, bot, path)]);
      }
    }
  });
});

describe("off production: everything blocked", () => {
  it("is Disallow: / for every bot, with no sitemap line naming the staging origin", () => {
    const body = robotsTxt(robotsPolicy(staging, { ai: { training: "allow" }, bots: { GPTBot: "allow" } }));
    expect(body).toBe("User-agent: *\nDisallow: /\n");
    for (const bot of ["Googlebot", "GPTBot", "Claude-User", "Twitterbot"]) expect(isAllowedByRobots(body, bot, "/")).toBe(false);
  });
});

describe("sitemaps", () => {
  it("absolute, several, or none", () => {
    expect(robotsPolicy(site, { sitemaps: ["/sitemap.xml", "https://cdn.riddlergo.com/sitemap-images.xml"] }).sitemap).toEqual([
      "https://riddlergo.com/sitemap.xml",
      "https://cdn.riddlergo.com/sitemap-images.xml",
    ]);
    expect(robotsPolicy(site, { sitemaps: false })).not.toHaveProperty("sitemap");
  });
});

describe("robotsTxt", () => {
  it("writes an empty Disallow for a group with no rules, so it cannot join the next group's agents", () => {
    const body = robotsTxt({ rules: [{ userAgent: "A" }, { userAgent: "B", disallow: "/" }] });
    expect(body).toBe("User-agent: A\nDisallow:\n\nUser-agent: B\nDisallow: /\n");
    expect(isAllowedByRobots(body, "A", "/x")).toBe(true);
    expect(isAllowedByRobots(body, "B", "/x")).toBe(false);
  });

  it("accepts a Next-shaped object with a single rule and host", () => {
    expect(robotsTxt({ rules: { userAgent: "*", allow: "/" }, sitemap: "https://x.com/s.xml", host: "https://x.com" })).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://x.com/s.xml\nHost: https://x.com\n",
    );
  });
});

describe("isAllowedByRobots (RFC 9309)", () => {
  it("reads a multi-agent group, the case seo-reports 0.1 gets wrong", () => {
    const body = "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect(isAllowedByRobots(body, "GPTBot", "/")).toBe(false);
    expect(isAllowedByRobots(body, "claudebot", "/")).toBe(false);
    expect(isAllowedByRobots(body, "Googlebot", "/")).toBe(true);
  });

  it("longest match wins, Allow wins a tie, * and $ work, comments are ignored, robots.txt is always allowed", () => {
    const body = "# policy\nUser-agent: *\nDisallow: /a\nAllow: /a/b\nDisallow: /*.pdf$\nAllow: /x\nDisallow: /x\n";
    expect(isAllowedByRobots(body, "Bot", "/a/c")).toBe(false);
    expect(isAllowedByRobots(body, "Bot", "/a/b/c")).toBe(true);
    expect(isAllowedByRobots(body, "Bot", "/files/doc.pdf")).toBe(false);
    expect(isAllowedByRobots(body, "Bot", "/files/doc.pdf?x=1")).toBe(true);
    expect(isAllowedByRobots(body, "Bot", "/x")).toBe(true);
    expect(isAllowedByRobots("User-agent: *\nDisallow: /\n", "Bot", "/robots.txt")).toBe(true);
  });

  it("merges two groups for one agent", () => {
    const body = "User-agent: Bot\nDisallow: /a\n\nUser-agent: Bot\nDisallow: /b\n";
    expect(isAllowedByRobots(body, "Bot", "/a")).toBe(false);
    expect(isAllowedByRobots(body, "Bot", "/b")).toBe(false);
    expect(isAllowedByRobots(body, "Bot", "/c")).toBe(true);
  });

  it("follows a crawler's fallback tokens, most specific first (Googlebot-Image obeys the Googlebot group), never a prefix match", () => {
    const body = "User-agent: Googlebot\nDisallow: /private-images\n\nUser-agent: *\nAllow: /\n";
    expect(isAllowedByRobots(body, ["Googlebot-Image", "Googlebot"], "/private-images/a.png")).toBe(false);
    expect(isAllowedByRobots(body, "Googlebot-Image", "/private-images/a.png")).toBe(true);
    const own = `${body}\nUser-agent: Googlebot-Image\nDisallow: /\n`;
    expect(isAllowedByRobots(own, ["Googlebot-Image", "Googlebot"], "/public.png")).toBe(false);
  });

  it("allows everything with no matching group", () => {
    expect(isAllowedByRobots("User-agent: Other\nDisallow: /\n", "Bot", "/")).toBe(true);
    expect(isAllowedByRobots("", "Bot", "/")).toBe(true);
  });
});

describe("a site with no path list", () => {
  it("allows everything and still names the AI bots", () => {
    const bare = defineSite({ url: SITE_INPUT.url, name: SITE_INPUT.name, indexable: true });
    const body = robotsTxt(robotsPolicy(bare));
    expect(body.startsWith("User-agent: *\nAllow: /\n\n")).toBe(true);
    expect(isAllowedByRobots(body, "GPTBot", "/anything")).toBe(true);
  });
});

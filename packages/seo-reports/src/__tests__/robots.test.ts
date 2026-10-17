import { describe, expect, it } from "vitest";
import { parseRobots, robotsBlocks, robotsVerdict } from "../robots.js";

/**
 * robots.txt FIXTURES (0.2): each one a shape real sites serve, with the
 * verdict Google's and OpenAI's documented rules give. The first is the 0.1
 * false pass — two agents sharing one group.
 */
const FIXTURES: readonly { name: string; txt: string; cases: readonly [agent: string, path: string, blocked: boolean][] }[] = [
  {
    name: "two agents share one group (0.1 said GPTBot was allowed)",
    txt: "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /",
    cases: [
      ["GPTBot", "/", true],
      ["ClaudeBot", "/", true],
      ["PerplexityBot", "/", false],
      ["Googlebot", "/", false],
    ],
  },
  {
    name: "an agent's own group frees it from the * group",
    txt: "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /",
    cases: [
      ["GPTBot", "/", false],
      ["ClaudeBot", "/", true],
    ],
  },
  {
    name: "an agent's own group that blocks only a folder leaves the home page open, whatever * says",
    txt: "User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /private",
    cases: [
      ["ClaudeBot", "/", false],
      ["ClaudeBot", "/private/notes", true],
      ["GPTBot", "/", true],
    ],
  },
  {
    name: "the longest rule wins (Allow /$ over Disallow /)",
    txt: "User-agent: *\nDisallow: /\nAllow: /$",
    cases: [
      ["Googlebot", "/", false],
      ["Googlebot", "/prices", true],
    ],
  },
  {
    name: "a longer Disallow beats a shorter Allow",
    txt: "User-agent: *\nAllow: /\nDisallow: /admin",
    cases: [
      ["Googlebot", "/", false],
      ["Googlebot", "/admin/users", true],
    ],
  },
  {
    name: "on a tie, Allow wins",
    txt: "User-agent: *\nDisallow: /\nAllow: /",
    cases: [["GPTBot", "/", false]],
  },
  {
    name: "an empty Disallow blocks nothing",
    txt: "User-agent: *\nDisallow:",
    cases: [["GPTBot", "/", false]],
  },
  {
    name: "a wildcard Disallow blocks everything",
    txt: "User-agent: *\nDisallow: /*",
    cases: [["Bingbot", "/", true]],
  },
  {
    name: "agent names ignore case and a version, comments and CRLF",
    txt: "﻿# robots\r\nuser-agent: gptbot/1.2 # the crawler\r\nDISALLOW: / \r\n",
    cases: [
      ["GPTBot", "/", true],
      ["ClaudeBot", "/", false],
    ],
  },
  {
    name: "Google-Extended is its own token; Googlebot is untouched",
    txt: "User-agent: Google-Extended\nDisallow: /\n\nUser-agent: *\nAllow: /",
    cases: [
      ["Google-Extended", "/", true],
      ["Googlebot", "/", false],
    ],
  },
  {
    name: "two groups naming the same agent are combined",
    txt: "User-agent: GPTBot\nAllow: /blog\n\nUser-agent: Bingbot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /",
    cases: [
      ["GPTBot", "/", true],
      ["GPTBot", "/blog/post", false],
      ["Bingbot", "/", true],
    ],
  },
  {
    name: "rules before any User-agent line belong to nobody",
    txt: "Disallow: /\nUser-agent: *\nAllow: /",
    cases: [["GPTBot", "/", false]],
  },
  {
    name: "a $ anchors the end",
    txt: "User-agent: *\nDisallow: /*.pdf$",
    cases: [
      ["Googlebot", "/menu.pdf", true],
      ["Googlebot", "/menu.pdf.html", false],
    ],
  },
  {
    name: "a file with no groups lets everyone in",
    txt: "Sitemap: https://example.com/sitemap.xml",
    cases: [["GPTBot", "/", false]],
  },
];

describe("robotsVerdict, from fixtures", () => {
  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      for (const [agent, path, blocked] of fixture.cases) {
        expect(robotsBlocks(fixture.txt, agent, path), `${agent} ${path}`).toBe(blocked);
      }
    });
  }

  it("names the rule that decided, and whose group it was", () => {
    const verdict = robotsVerdict("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /", "ClaudeBot");
    expect(verdict).toEqual({ allowed: false, rule: "Disallow: /", by: "agent" });
    expect(robotsVerdict("User-agent: *\nDisallow: /x", "GPTBot")).toEqual({ allowed: true, rule: null, by: "everyone" });
  });

  it("reads Sitemap lines", () => {
    expect(parseRobots("Sitemap: https://a.example/s.xml\nUser-agent: *\nDisallow:").sitemaps).toEqual(["https://a.example/s.xml"]);
  });
});

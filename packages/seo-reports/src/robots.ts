/**
 * robots.txt, READ THE WAY CRAWLERS READ IT (0.2; RFC 9309, the rules Google,
 * OpenAI and Anthropic document). 0.1's reader turned a group's `applies` off
 * at each `User-agent` line, so
 *
 *   User-agent: GPTBot
 *   User-agent: ClaudeBot
 *   Disallow: /
 *
 * said GPTBot was ALLOWED — a false pass on the one check whose whole point
 * is "can AI assistants read you". The rules, as implemented here:
 *
 *   GROUPS     one or more `User-agent` lines in a row, then the rules under
 *              them, until a `User-agent` line follows a rule. Rules before any
 *              `User-agent` line belong to nobody.
 *   WHO        a crawler obeys the groups naming it (its product token, any
 *              case, a "/1.0" version ignored) — all of them, combined — and
 *              only when none names it, the `*` groups. A GPTBot group with
 *              `Allow: /` frees GPTBot from a `*` group's `Disallow: /`.
 *   WHICH RULE the longest pattern that matches the path wins; on a tie,
 *              Allow wins. `*` matches anything, a final `$` anchors the end,
 *              and an empty `Disallow:` blocks nothing.
 *
 * Pure: text in, verdicts out, so every case is a fixture in the tests.
 */

export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  /** The product tokens the group names, lower-cased ("gptbot", "*"). */
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

export interface ParsedRobots {
  readonly groups: readonly RobotsGroup[];
  /** `Sitemap:` lines, as written. */
  readonly sitemaps: readonly string[];
}

/** "GPTBot/1.2 (+https://openai.com/gptbot)" → "gptbot". */
export function productToken(value: string): string {
  return (value.trim().split(/[\s/]/)[0] ?? "").toLowerCase();
}

export function parseRobots(text: string): ParsedRobots {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  // True once the current group has a rule: the next User-agent starts a new group.
  let sawRule = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!current || sawRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      const token = value === "*" ? "*" : productToken(value);
      if (token && !current.agents.includes(token)) current.agents.push(token);
    } else if (key === "allow" || key === "disallow") {
      if (!current) continue; // a rule before any User-agent line belongs to nobody
      sawRule = true;
      // An empty Disallow blocks nothing; an empty Allow allows nothing new.
      if (value === "") continue;
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "sitemap") {
      if (value) sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Does a robots pattern match this path (and query)? `*` is anything; a final `$` is the end. */
export function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

export interface RobotsVerdict {
  readonly allowed: boolean;
  /** The rule that decided, as written ("Disallow: /"), or null when none matched. */
  readonly rule: string | null;
  /** Whose group decided: the agent's own, the `*` group, or none at all. */
  readonly by: "agent" | "everyone" | "none";
}

/** May `agent` fetch `path` (path and query, starting with "/")? */
export function robotsVerdict(robots: ParsedRobots | string, agent: string, path = "/"): RobotsVerdict {
  const parsed = typeof robots === "string" ? parseRobots(robots) : robots;
  const token = productToken(agent);
  const own = parsed.groups.filter((group) => group.agents.includes(token));
  const groups = own.length > 0 ? own : parsed.groups.filter((group) => group.agents.includes("*"));
  const by: RobotsVerdict["by"] = own.length > 0 ? "agent" : groups.length > 0 ? "everyone" : "none";
  let best: RobotsRule | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!patternMatches(rule.pattern, path)) continue;
      if (
        best === null ||
        rule.pattern.length > best.pattern.length ||
        (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
  }
  return {
    allowed: best === null || best.allow,
    rule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.pattern}` : null,
    by,
  };
}

/** Is `agent` kept off `path` (default the home page) by this robots.txt? */
export function robotsBlocks(robotsTxt: string, agent: string, path = "/"): boolean {
  return !robotsVerdict(robotsTxt, agent, path).allowed;
}

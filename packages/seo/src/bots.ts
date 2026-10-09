import { KNOWN_CRAWLERS, ROBOTS_CONTROL_TOKENS } from "@adminigloo/analytics/crawlers";

/**
 * The bots robots.txt can name: @adminigloo/analytics' crawler list (the
 * same list its crawler log classifies requests with) plus the two training
 * opt-out tokens that are never User-Agents (Google-Extended,
 * Applebot-Extended). It is compiled into this package at build time from
 * analytics' `src/crawlers.ts`, so the two packages ship the same list from
 * the same commit and this one needs no runtime dependency on analytics.
 *
 * An app that runs analytics too can pass analytics' own `KNOWN_CRAWLERS`
 * (plus `ROBOTS_CONTROL_TOKENS`) as `robotsPolicy({ crawlers })`, and robots.txt
 * then follows whatever analytics version is installed.
 */

export const BOT_KINDS = ["ai-training", "ai-search", "ai-assistant", "search", "social", "seo-tool", "other"] as const;
export type BotKind = (typeof BOT_KINDS)[number];

export interface RobotsBot {
  /** The name the analytics crawler log uses. */
  readonly name: string;
  readonly kind: BotKind;
  readonly operator: string;
  /** The `User-agent:` tokens a robots.txt group names it by. */
  readonly robotsTokens: readonly string[];
}

/** Every bot with at least one robots.txt token, in analytics' match order, then the control tokens. */
export const ROBOTS_BOTS: readonly RobotsBot[] = /* @__PURE__ */ (() =>
  Object.freeze(
    [...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS]
      .filter((bot) => bot.robotsTokens.length > 0)
      .map((bot): RobotsBot => Object.freeze({ name: bot.name, kind: bot.kind, operator: bot.operator, robotsTokens: Object.freeze([...bot.robotsTokens]) })),
  ))();

/** Bots the crawler log names that robots.txt cannot (no token): WhatsApp, Lighthouse, "Other bot". */
export const TOKENLESS_BOT_NAMES: readonly string[] = /* @__PURE__ */ (() =>
  Object.freeze(KNOWN_CRAWLERS.filter((bot) => bot.robotsTokens.length === 0).map((bot) => bot.name)))();

/**
 * A short, stable fingerprint of a bot list: what robots.txt would be built
 * from (each bot's name, kind and tokens, in order; bots with no token are
 * left out, as robots.txt leaves them out). Two lists with the same
 * fingerprint write the same robots.txt.
 */
export function botListFingerprint(crawlers: ReadonlyArray<Pick<RobotsBot, "name" | "kind" | "robotsTokens">>): string {
  const text = crawlers
    .filter((bot) => bot.robotsTokens.length > 0)
    .map((bot) => `${bot.name}\u0001${bot.kind}\u0001${bot.robotsTokens.join("\u0002")}`)
    .join("\n");
  // FNV-1a, 32-bit, twice with different seeds: no Node crypto on the edge, and collisions do not matter here.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

declare const __ADMINIGLOO_ANALYTICS_VERSION__: string | undefined;

/**
 * Which @adminigloo/analytics list this build of the package carries: the
 * analytics version it was compiled from and the list's fingerprint. An app
 * that also runs analytics either passes analytics' own list as
 * `robotsPolicy({ crawlers })` (robots.txt then follows the installed
 * analytics exactly) or compares `fingerprint` with
 * `botListFingerprint([...KNOWN_CRAWLERS, ...ROBOTS_CONTROL_TOKENS])`.
 */
export const ROBOTS_BOTS_SOURCE: { readonly analytics: string; readonly fingerprint: string } = /* @__PURE__ */ (() =>
  Object.freeze({
    analytics: typeof __ADMINIGLOO_ANALYTICS_VERSION__ === "string" ? __ADMINIGLOO_ANALYTICS_VERSION__ : "workspace",
    fingerprint: botListFingerprint(ROBOTS_BOTS),
  }))();

/** The AI kinds, as the policy's `ai` option names them. */
export const AI_KIND_OPTIONS = {
  "ai-training": "training",
  "ai-search": "search",
  "ai-assistant": "userFetch",
} as const satisfies Partial<Record<BotKind, string>>;

import type { HonestyCheck } from "./writer.js";

/**
 * THE GENERIC HONESTY LIST: words an AI reaches for that no business should
 * post without meaning them. It runs on every word the AI writes (a hook, an
 * aside, a platform's words), beside the number guard; a draft whose AI words
 * hit one goes out in the app's own words instead, with the reason on its
 * card. Nothing here judges a person's own words: a person can type anything,
 * and reads every draft before it's approved.
 *
 * A STARTING LIST, NOT A POLICY. Each app adds its own rules on top
 * (`combineHonesty(genericHonesty, honestyFrom(myRules))`): a clinic's "no
 * medical claims", a shop's "never say free". The rules for one kind of
 * business stay in that business's app.
 */

/** One rule: what it catches, and the reason a card shows ("it read as a guarantee"). */
export type HonestyRule = readonly [pattern: RegExp, reads: string];

export const GENERIC_HONESTY_RULES: readonly HonestyRule[] = [
  [/\bguarantee(?:s|d)?\b/i, "a guarantee"],
  [/\brisk[- ]free\b|\bno risk\b|\bzero risk\b/i, "a promise of no risk"],
  [/\brevolution(?:ary|ise|ize|ising|izing)\b/i, "hype (revolutionary)"],
  [/\bgame[- ]?chang(?:er|ers|ing)\b/i, "hype (game-changing)"],
  [/\blife[- ]changing\b|\bmind[- ]blowing\b|\bjaw[- ]dropping\b|\binsane(?:ly)?\b/i, "hype"],
  [/\b(?:best|greatest) (?:ever|in the world|in town|on the planet)\b|\bworld[- ]class\b|\bunbeatable\b|\bunmatched\b|\bunrivall?ed\b|\bsecond to none\b/i, "a claim to be the best"],
  [/\bact (?:now|fast)\b|\bdon'?t miss (?:out|it)\b|\blast chance\b|\bhurry\b|\bbefore it'?s (?:too late|gone)\b|\bwhile (?:stocks|supplies) last\b/i, "pressure to buy"],
  [/\bcures?\b|\bmiracle\b/i, "a health or miracle claim"],
  [/\bget rich\b|\bpassive income\b|\bdouble your money\b/i, "a money claim"],
  [/!{2,}/, "shouting (!!)"],
];

/** A check from a list of rules: the first rule a text breaks, as "it read as …", or null. */
export function honestyFrom(rules: readonly HonestyRule[]): HonestyCheck {
  return (text) => {
    const broken = rules.find(([pattern]) => pattern.test(text));
    return broken ? `it read as ${broken[1]}` : null;
  };
}

/** The generic list as a check: what create-app's glue hands the writer. */
export const genericHonesty: HonestyCheck = honestyFrom(GENERIC_HONESTY_RULES);

/** Several checks as one: the first reason any of them gives. */
export function combineHonesty(...checks: readonly (HonestyCheck | null | undefined)[]): HonestyCheck {
  const present = checks.filter((check): check is HonestyCheck => typeof check === "function");
  return (text) => {
    for (const check of present) {
      const reason = check(text);
      if (reason) return reason;
    }
    return null;
  };
}

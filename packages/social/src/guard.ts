import type { Facts } from "./types.js";

/**
 * THE NUMBER GUARD: every number in the AI's words must be one the facts
 * already contain. The model writes words; code counts. A number the facts
 * don't have is arithmetic, a rounding, a conversion or a guess, and the
 * platform gets the app's own words instead (./writer.ts).
 *
 * Numbers are compared by value, the way a reader would: "70¢", "70%" and
 * "70" are all 70; "$1" and "$1.00" are both 1; "17 of 24" is 17 and 24;
 * "71°" is 71; "1,204" is 1204; "9-5" is 9 and 5 (a hyphen there is a
 * range, not a minus). A clock time is one number ("6:51"), so a "6" can't
 * be borrowed from it. "$0.70" is 0.7, NOT 70: changing a price's unit is
 * a calculation, and it's refused like one.
 */

/**
 * Spelled-out numbers, which would otherwise slip a count past the guard
 * ("two of three"). Not "one": "no one", "the one" and "one more" are
 * everywhere in plain English, and a person reads every draft before it
 * goes out.
 */
const SPELLED: Readonly<Record<string, number>> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000, dozen: 12,
};

const NUMBER = /\d{1,2}:\d{2}(?!\d)|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** One number as the guard compares it: "05" is "5", "1.50" is "1.5", "1,204" is "1204", "6:51" stays "6:51". */
function normal(raw: string): string {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (clock) return `${Number(clock[1])}:${clock[2]}`;
  return String(Number(raw.replace(/,/g, "")));
}

/** Every number in a text, normalized, spelled ones included. */
export function numbersIn(text: string): string[] {
  const out = (text.match(NUMBER) ?? []).map(normal);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const n = SPELLED[word];
    if (n !== undefined) out.push(String(n));
  }
  return out;
}

/** The numbers a post may use: every number in its facts, the title's too. */
export function allowedNumbers(facts: Facts): ReadonlySet<string> {
  return new Set(numbersIn([facts.title, ...facts.lines].join("\n")));
}

/** The numbers in a text that its facts don't have, once each. Empty: the text passes. */
export function inventedNumbers(text: string, facts: Facts): string[] {
  const allowed = allowedNumbers(facts);
  return [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
}

import { z } from "zod";

/**
 * COPIED FROM @adminigloo/scheduling's text.ts (`singleLine`, `publicLine`,
 * `oneLine`, `defang`, `forEmail`, `greetingName`); change both or neither.
 *
 * What a customer can type, and what of it reaches an email. Pure.
 *
 * THE PROBLEM THIS SOLVES. The estimate form is anonymous, and the person
 * filling it in picks the recipient (the email field) and part of the content
 * (the name and address, echoed back in the copy of their estimate). Without
 * these rules the address field takes line breaks and web addresses, comms
 * turns blank lines into paragraphs and URLs into links, and the business's
 * own verified domain sends the result — "IMPORTANT: your card was declined,
 * update it here https://…" — to anybody. A mail provider that sees that
 * traffic suspends the account, and every quote and follow-up stops with it.
 *
 * So, two layers:
 *
 *   1. AT THE DOOR (zod): a name, phone or address is ONE line (no control
 *      characters, no Unicode line separators), and on the public form a name
 *      or address that carries a web address is refused, with a sentence on
 *      the field. No real name or street address contains one.
 *   2. ON THE WAY OUT (`forEmail`): whatever the database holds — an older row,
 *      a staff-typed value — is collapsed to one line and, in a customer
 *      email, any link-shaped text is broken ("evil[.]example/pay") so no mail
 *      client makes it clickable.
 */

/** Control characters (CR, LF and TAB included) and the Unicode line and paragraph separators. */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Text a mail client would turn into a link: a scheme (`https://`, `ftp://`),
 * `www.`, a domain followed by a path, or a bare domain on a common top-level
 * domain. Street addresses never match ("St. Louis", "P.O. Box 12" don't).
 */
export const LINKISH =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|io|co|me|us|app|link|xyz|site|online|top|click|shop|store|live|ru|cn|tk|ly|gg|zip|mov)\b)/i;

const ONE_LINE = "Keep this on one line.";

/** A trimmed, single-line string of at most `max` characters. */
export function singleLine(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), ONE_LINE);
}

/** A single-line public field that must not carry a web address ("Leave web addresses out of your name."). */
export function publicLine(max: number, what: string) {
  return singleLine(max).refine((value) => !LINKISH.test(value), `Leave web addresses out of ${what}.`);
}

/** Every control character and line separator becomes a space; runs of spaces become one. */
export function oneLine(value: string): string {
  return value.replace(new RegExp(CONTROL_CHARS.source, "g"), " ").replace(/\s{2,}/g, " ").trim();
}

/** Break every link-shaped run so no mail client links it: "https://evil.example/pay" → "https[:]//evil[.]example/pay". */
export function defang(value: string): string {
  const global = new RegExp(LINKISH.source, "gi");
  return value.replace(global, (match) => match.replace(/:\/\//g, "[:]//").replace(/\./g, "[.]"));
}

/**
 * A stored value as an email may print it: one line, and — for a customer
 * email, which goes to an address nobody verified — never a link.
 */
export function forEmail(value: string, audience: "customer" | "staff"): string {
  const line = oneLine(value);
  return audience === "customer" ? defang(line) : line;
}

/** A first name an email may greet: letters (any script), apostrophes, dots and dashes, 1–40 of them. */
const FIRST_NAME = /^[\p{L}\p{M}'’.-]{1,40}$/u;

/** "Pat" from "Pat Visitor"; "there" when the first word isn't a plain name ("https://…", "@@@"). */
export function greetingName(customerName: string | null | undefined): string {
  const first = oneLine(customerName ?? "").split(" ")[0] ?? "";
  return FIRST_NAME.test(first) && !LINKISH.test(first) ? first : "there";
}

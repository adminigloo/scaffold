/**
 * What a customer typed is never a link (D18). Pure.
 *
 * Alert titles and bodies carry what a customer typed into a public form (a
 * name, an address, a note). In the app they are rendered as text. In an
 * email copy, a mail client turns anything link-shaped into a link on its
 * own, so a lead whose "name" is `Pay now at evil.example/invoice` would put a
 * clickable link into a staff member's inbox, sent from the company's own
 * address. So the email copy breaks every link-shaped run before the host's
 * email seam sees it: the only link in an alert email is the one the host
 * builds to the alert's own page.
 *
 * COPIED FROM @adminigloo/scheduling's text.ts (`LINKISH`, `defang`), the rule
 * its customer emails use (`forEmail`); change both or neither. Line breaks
 * are kept (a body may have them); only link-shaped runs change.
 */

/**
 * Text a mail client would turn into a link: a scheme (`https://`, `ftp://`),
 * `www.`, a domain followed by a path, or a bare domain on a common top-level
 * domain. Street addresses never match ("St. Louis", "P.O. Box 12" don't).
 */
export const LINKISH =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|info|biz|io|co|me|us|app|link|xyz|site|online|top|click|shop|store|live|ru|cn|tk|ly|gg|zip|mov)\b)/i;

/**
 * Breaks link-shaped text (scheme://…, www.…, a bare domain with a path) so a
 * mail client won't make it a link: "https://evil.example/pay" →
 * "https[:]//evil[.]example/pay". Pure, and harmless twice (a broken run no
 * longer looks like a link).
 */
export function breakLinks(text: string): string {
  if (typeof text !== "string" || text === "") return "";
  const global = new RegExp(LINKISH.source, "gi");
  return text.replace(global, (match) => match.replace(/:\/\//g, "[:]//").replace(/\./g, "[.]"));
}

/**
 * D18's pattern for an `href`: a same-site path. No `//` (another host), no
 * `/\` (browsers read a backslash as a slash), no backslash, whitespace or
 * control character anywhere (review G15).
 */
export const SAME_SITE_PATH = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;

/** One line: no CR, LF, U+2028 or U+2029 (a title becomes an email Subject). */
export const LINE_BREAKS = /[\r\n\u2028\u2029]/;

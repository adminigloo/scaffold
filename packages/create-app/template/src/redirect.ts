/**
 * The one rule for "send them back where they came from".
 *
 * A return path arrives in a query string, which means it arrives from whoever
 * wrote the link — and an unchecked one is an open redirect: an attacker mails
 * `/sign-in?redirect_url=https://evil.example/login`, the victim signs in on
 * OUR domain, sees our sign-in page succeed, and is handed to a copy of it that
 * asks them to "confirm" their password. The phishing page inherits the
 * credibility of the redirect that reached it.
 *
 * So this refuses anything that could leave the site. A value must begin with a
 * single slash and nothing else: `//evil.example` is a protocol-relative URL
 * that browsers resolve as an absolute one, `/\evil.example` is the same trick
 * with a backslash that several parsers normalise into a slash, and anything
 * with a scheme is absolute by definition. Control characters are refused for
 * the same reason a mail header refuses them — a CR or LF inside a value that
 * later reaches a header ends it and starts one nobody wrote.
 *
 * Returns null rather than throwing, and null means "no return path", not "bad
 * input". A tampered link should still let somebody sign in; it just should not
 * decide where they land. Throwing would turn a nuisance into a broken sign-in
 * page, which is a denial of service anybody can trigger with a URL.
 *
 * WHY THIS FILE EXISTS RATHER THAN A CHECK AT EACH CALL SITE: there are three
 * call sites — sign-in, sign-up, and whatever the next feature adds — and the
 * one that gets written in a hurry is the one that skips the check. A named
 * function is also the thing a security review can grep for.
 */
export function safeReturnPath(value: string | readonly string[] | undefined): string | null {
  // Next hands over `string[]` when a parameter is repeated. Two return paths
  // is not a request with an ambiguity to resolve, it is a request nobody
  // legitimate made, so it gets no return path at all.
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value;
}

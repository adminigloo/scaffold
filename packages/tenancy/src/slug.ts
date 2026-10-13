/**
 * Names and web addresses (slugs): the rules every company name and address
 * is checked against (contract 5.1).
 *
 * Client-safe and dependency-free: the onboarding form runs the same rules in
 * the browser (`@adminigloo/tenancy-widget` keeps a copy, and its parity test
 * checks the two agree on 500 generated names), while the server stays the
 * authority — every address is checked again in `checkSlug` and
 * `createCompany`, against the host's own reserved words too.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;
export const COMPANY_NAME_MAX = 80;

/** Kept for the site itself: a route, a subdomain we might want, or plain confusion would collide. Lowercase. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(
  `about access account accounts admin adminigloo api app apps assets auth billing
blog book book-visit careers cart checkout companies company contact dashboard
docs email estimate estimates files help home igloo images invite invites
invoice invoices jobs legal login logout mail me new null oauth onboarding
organization organizations people press pricing products public quote quotes
register root schedule security settings setup shop sign-in sign-up signin
signup staff static status store support system t team teams terms undefined
visit webhooks workspace workspaces www you _next`
    .split(/\s+/)
    .filter(Boolean),
);

export type SlugProblem = "too-short" | "too-long" | "invalid" | "reserved";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The personal-workspace prefix (`personalWorkspaceSlug`): never a company's address. */
const PERSONAL_PREFIX = "ws-";

/**
 * What's wrong with `slug` as a web address, or null. The checks run in a
 * fixed order (too-short, too-long, invalid, reserved), so the message an owner
 * reads is the first thing to fix.
 */
export function validateSlug(slug: string, options: { readonly reserved?: Iterable<string> } = {}): SlugProblem | null {
  if (slug.length < SLUG_MIN) return "too-short";
  if (slug.length > SLUG_MAX) return "too-long";
  if (!SLUG_RE.test(slug) || slug.startsWith(PERSONAL_PREFIX)) return "invalid";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  if (options.reserved) for (const word of options.reserved) if (word.toLowerCase() === slug) return "reserved";
  return null;
}

/**
 * A web address suggested from a name: "Café & Co." → "cafe-and-co".
 * It never returns an invalid address (a property test runs 1 000 names).
 * Making it UNIQUE is the server's job (`-2`, `-3`, …, in createCompany).
 *
 * A result that would start with "ws-" (the personal-workspace prefix, which
 * `validateSlug` refuses) is PREFIXED "co-", not suffixed: "WS Lawn Services"
 * → "co-ws-lawn-services". Appending "-co" (the contract's first draft) can't
 * make it valid — "ws-lawn-services-co" still starts with the prefix — and
 * the owner would be told "Use lowercase letters, numbers and single dashes"
 * about an address they never typed. The widget's copy does the same; the
 * parity test holds them together.
 */
export function suggestSlug(name: string): string {
  let slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.startsWith(PERSONAL_PREFIX)) slug = `co-${slug}`;
  if (slug.length > SLUG_MAX) {
    const dash = slug.lastIndexOf("-", SLUG_MAX);
    slug = (dash > 0 ? slug.slice(0, dash) : slug.slice(0, SLUG_MAX)).replace(/-+$/, "");
  }
  for (let i = 0; i < 2 && slug.length < SLUG_MIN; i += 1) slug = slug ? `${slug}-co` : "co";
  // "ws" + "-co" lands back on the personal prefix: move it out of the way again.
  if (slug.startsWith(PERSONAL_PREFIX)) slug = `co-${slug}`;
  if (RESERVED_SLUGS.has(slug)) slug = `${slug}-co`;
  return slug;
}

/** The plain sentence for a web-address problem (contract 5.1). */
export function slugProblemMessage(problem: SlugProblem | "taken", noun = "company"): string {
  switch (problem) {
    case "reserved":
      return "That web address is kept for the site itself. Try another, like acme-plumbing.";
    case "taken":
      return `That web address is already used by another ${noun}.`;
    case "too-short":
      return `Use at least ${SLUG_MIN} letters or numbers.`;
    case "too-long":
      return `Keep it to ${SLUG_MAX} characters or fewer.`;
    default:
      return "Use lowercase letters, numbers and single dashes, like summit-window-co.";
  }
}

/** Trimmed, with every run of whitespace one space. */
export function normaliseCompanyName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export type CompanyNameProblem = "too-short" | "too-long" | "invalid";

/** What's wrong with a company name, or null (checked on the normalised name). */
export function companyNameProblem(name: string): CompanyNameProblem | null {
  const normalised = normaliseCompanyName(name);
  if (normalised.length < 2) return "too-short";
  if (normalised.length > COMPANY_NAME_MAX) return "too-long";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(normalised) || !/[\p{L}\p{N}]/u.test(normalised)) return "invalid";
  return null;
}

export function companyNameProblemMessage(problem: CompanyNameProblem, noun = "company"): string {
  switch (problem) {
    case "too-short":
      return `Give your ${noun} a name of at least 2 characters.`;
    case "too-long":
      return `Keep the name to ${COMPANY_NAME_MAX} characters or fewer.`;
    default:
      return "Use letters or numbers in the name.";
  }
}

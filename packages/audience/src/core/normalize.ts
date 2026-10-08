import { canonicalCidr } from "./cidr.js";
import { RULE_KINDS, type RuleKind } from "./labels.js";
import type { AudienceRuleInput } from "./types.js";

/**
 * Normalisation: the one place an email, a domain, a host or a rule value is
 * turned into the form that is stored and compared. A rule and an actor go
 * through the SAME function, so "Jane@Gmail.com " typed by an admin matches
 * "jane@gmail.com" signing in.
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/** RFC 5321's limit on a whole address. Longer input is not an address. */
export const EMAIL_MAX = 254;

/**
 * A domain in the form a rule stores and compares: lower-case ASCII, an
 * internationalised name turned into its punycode ("bücher.de" →
 * "xn--bcher-kva.de"), so the Unicode and the ASCII spelling of one domain
 * match each other. Returns the input lower-cased when it cannot be read.
 */
export function asciiDomain(domain: string): string {
  const lower = domain.toLowerCase();
  if (/^[\x00-\x7f]*$/.test(lower)) return lower;
  try {
    return new URL(`http://${lower}`).hostname || lower;
  } catch {
    return lower;
  }
}

/**
 * Trimmed, Unicode-normalised (NFKC, so a full-width "ｊane" is "jane") and
 * lower-cased, with the domain in ASCII. Returns null for anything without
 * exactly one "@" and text on both sides, or longer than 254 characters.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const value = email
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    // "İ".toLowerCase() is "i" plus a combining dot; in an address it means a plain i.
    .replace(/i\u0307/g, "i");
  if (value.length > EMAIL_MAX) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || value.indexOf("@") !== at) return null;
  if (/\s/.test(value)) return null;
  return `${value.slice(0, at)}@${asciiDomain(value.slice(at + 1))}`;
}

/**
 * The address as Gmail delivers it: dots in the local part and a `+tag` are
 * ignored, and googlemail.com is gmail.com. Other providers are left alone —
 * plus-addressing is common, but whether `a+b@x` reaches `a@x` is the
 * provider's choice, and folding a stranger's address into staff's would
 * hide a customer.
 */
export function foldEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return email;
  const plus = local.indexOf("+");
  const base = (plus >= 0 ? local.slice(0, plus) : local).replace(/\./g, "");
  // "+abc@gmail.com" has no mailbox left once folded. Compare it as typed,
  // not as "@gmail.com", which every such address would share.
  if (!base) return email;
  return `${base}@gmail.com`;
}

/** The comparison key for an exact `email` rule. */
export function emailKey(email: string | null | undefined, fold: boolean): string | null {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return fold ? foldEmail(normalized) : normalized;
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * A domain as typed in a rule: "@RiddlerGo.com", "*.test", "riddlergo.com."
 * all become the bare suffix ("riddlergo.com", "test"). Matching is the
 * domain itself or any subdomain of it.
 */
export function normalizeDomain(value: string): string | null {
  let domain = value.normalize("NFKC").trim().toLowerCase();
  if (domain.startsWith("@")) domain = domain.slice(1);
  if (domain.startsWith("*.")) domain = domain.slice(2);
  else if (domain.startsWith(".")) domain = domain.slice(1);
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  domain = asciiDomain(domain);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain)) return null;
  return domain;
}

/** `domain` equals `suffix` or is a subdomain of it. */
export function domainMatches(domain: string, suffix: string): boolean {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

/**
 * A request host: lower-cased, port dropped, brackets off an IPv6 literal,
 * trailing dot gone. Accepts a full URL too.
 */
export function normalizeHost(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let host = value.trim().toLowerCase();
  if (!host) return null;
  if (host.includes("://")) {
    try {
      host = new URL(host).host;
    } catch {
      return null;
    }
  }
  const slash = host.indexOf("/");
  if (slash >= 0) host = host.slice(0, slash);
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else if ((host.match(/:/g) ?? []).length === 1) {
    host = host.slice(0, host.indexOf(":"));
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host || null;
}

/**
 * A host pattern from a rule or a default list: an exact host ("localhost",
 * "::1", "www.example.com") or a "*.suffix" that matches subdomains only.
 */
export function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/**
 * Does `text` match a glob? `*` is any run, `?` one character, everything
 * else literal; whole-string, case-insensitive.
 *
 * A linear two-pointer matcher, NOT a regular expression. `*a*a*a…b` turned
 * into `.*a.*a.*a…b` backtracks exponentially in V8 (ten stars against a
 * 46-character address took 45 seconds), and this runs on every signed-in
 * beacon. Here the worst case is length(text) × length(glob).
 */
export function globMatches(text: string, glob: string): boolean {
  const s = text.toLowerCase();
  const p = glob.toLowerCase();
  let si = 0;
  let pi = 0;
  let star = -1;
  let resume = 0;
  while (si < s.length) {
    if (pi < p.length && p[pi] !== "*" && (p[pi] === "?" || p[pi] === s[si])) {
      si += 1;
      pi += 1;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      resume = si;
      pi += 1;
    } else if (star >= 0) {
      pi = star + 1;
      resume += 1;
      si = resume;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

export function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

/** An email pattern: a glob over the whole (lower-cased, unfolded) address, or a substring. */
export function emailPatternMatches(email: string, pattern: string): boolean {
  return isGlob(pattern) ? globMatches(email, pattern) : email.includes(pattern);
}

/** The longest id (user, org, event, order, visitor, session) the package accepts. */
export const ID_MAX = 200;

/**
 * An id as the package stores it: a string (a numeric id becomes its digits),
 * trimmed, at most 200 characters, no control characters, or null. Ids reach
 * the package from cookies and request bodies, so a junk value is refused
 * rather than written into a mark.
 */
export function cleanId(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > ID_MAX || /[\u0000-\u001f\u007f]/.test(id)) return null;
  return id;
}

/** Why a rule value was refused, in words an admin can act on. */
export class RuleValueError extends Error {
  readonly name = "RuleValueError";
}

/**
 * Validate and normalise a rule's value for its kind. Throws RuleValueError
 * with a sentence for the form. The returned value is what is stored.
 */
export function normalizeRuleValue(kind: RuleKind, raw: string): string {
  if (!RULE_KINDS.includes(kind)) throw new RuleValueError(`Unknown rule kind "${String(kind)}".`);
  if (typeof raw !== "string") throw new RuleValueError("A rule needs a value.");
  const value = raw.trim();
  if (!value) throw new RuleValueError("A rule needs a value.");
  switch (kind) {
    case "email": {
      const email = normalizeEmail(value);
      if (!email) throw new RuleValueError(`"${value}" is not an email address.`);
      return email;
    }
    case "email_domain": {
      const domain = normalizeDomain(value);
      if (!domain) throw new RuleValueError(`"${value}" is not a domain (try riddlergo.com).`);
      return domain;
    }
    case "email_pattern": {
      const pattern = value.normalize("NFKC").toLowerCase();
      if (pattern.length < 3) throw new RuleValueError("A pattern needs at least 3 characters, or it matches almost everyone.");
      if (pattern.length > ID_MAX) throw new RuleValueError("That pattern is too long.");
      if (/^[*?]+$/.test(pattern)) throw new RuleValueError("A pattern of only wildcards would exclude everyone.");
      return pattern;
    }
    case "network": {
      const cidr = canonicalCidr(value);
      if (!cidr) throw new RuleValueError(`"${value}" is not an IP address or CIDR range (try 203.0.113.0/24).`);
      if (/\/0$/.test(cidr)) throw new RuleValueError("A /0 range would exclude every visitor.");
      return cidr;
    }
    case "host": {
      const wildcard = value.startsWith("*.");
      const host = normalizeHost(wildcard ? value.slice(2) : value);
      if (!host || !/^[a-z0-9.:-]+$/.test(host)) throw new RuleValueError(`"${value}" is not a host name.`);
      return wildcard ? `*.${host}` : host;
    }
    case "user_agent": {
      if (value.length < 3) throw new RuleValueError("A user-agent rule needs at least 3 characters.");
      if (value.length > ID_MAX) throw new RuleValueError("That user-agent text is too long.");
      return value.toLowerCase();
    }
    default: {
      // user, org, event, order, visitor: an opaque id, kept as typed (trimmed).
      if (value.length > ID_MAX) throw new RuleValueError("That id is too long.");
      if (/[\u0000-\u001f]/.test(value)) throw new RuleValueError("That id contains control characters.");
      return value;
    }
  }
}

/** A Date from a Date, an ISO string or YYYY-MM-DD (read as UTC midnight); null when empty. */
export function toDateOrNull(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) throw new RuleValueError(`"${String(value)}" is not a date.`);
  return date;
}

const LABEL_MAX = 120;
const NOTE_MAX = 500;

/** The whole input, normalised — what `addRule` and `preview` both act on. */
export function normalizeRuleInput(input: AudienceRuleInput): {
  kind: RuleKind;
  value: string;
  reasonLabel: string | null;
  note: string | null;
  appliesFrom: Date | null;
} {
  const kind = input.kind;
  const value = normalizeRuleValue(kind, input.value);
  const reasonLabel = trimOrNull(input.reasonLabel, LABEL_MAX, "label");
  const note = trimOrNull(input.note, NOTE_MAX, "note");
  return { kind, value, reasonLabel, note, appliesFrom: toDateOrNull(input.appliesFrom) };
}

function trimOrNull(value: string | null | undefined, max: number, what: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new RuleValueError(`The ${what} is too long (${max} characters at most).`);
  return trimmed;
}

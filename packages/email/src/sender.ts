/**
 * Sender and recipient addresses, parsed by hand rather than by `z.email()`.
 *
 * `z.string().email()` validates an addr-spec and nothing else, so it rejects
 * `Riddler Go <hello@riddlergo.com>` — the only form that puts a display name
 * in an inbox, and the exact string riddler-go shipped as its own fallback
 * `EMAIL_FROM`. Setting the correct, deliverability-friendly value therefore
 * took the server down at boot, and the whole of the error was "Invalid email",
 * which accuses the value instead of the validator that could not read it.
 *
 * So both forms are parsed here. Loose where looseness is harmless — dots,
 * apostrophes and parentheses in a display name are fine — and strict exactly
 * where the wrong character changes how a mail server reads the header: an
 * unquoted comma or semicolon splits one `From:` into two addresses, and a CR
 * or LF ends the header and starts one the caller never wrote.
 */
export interface SenderAddress {
  /** Display name, or null when the value was a bare address. */
  readonly name: string | null;
  /** The addr-spec, without angle brackets. */
  readonly email: string;
}

export class InvalidSenderAddressError extends Error {
  readonly name = "InvalidSenderAddressError";
  constructor(
    readonly value: string,
    readonly variable: string,
  ) {
    super(
      `${variable} is not a usable email address: ${JSON.stringify(value)}. ` +
        `Two forms are accepted — a bare address ("hello@example.com") and a ` +
        `display name with the address in angle brackets ` +
        `("Riddler Go <hello@example.com>"). Quote a display name that contains ` +
        `a comma or a colon, because an unquoted one makes the header parse as ` +
        `two separate addresses.`,
    );
  }
}

/**
 * Parse `hello@x.com`, `Riddler Go <hello@x.com>` or `"Riddler, Go" <hello@x.com>`.
 *
 * Returns null rather than throwing, because the two callers want different
 * things from a bad value: a Zod refinement needs a boolean, and
 * `createEmailSender` needs a typed error that names the variable to fix.
 *
 * Accepts null/undefined because what it reads are optional environment
 * variables. A call site forced to guard first is a call site that forgets.
 */
export function parseSenderAddress(
  value: string | null | undefined,
): SenderAddress | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // The angle-bracket form, matched on the LAST `<` so a display name that
  // legitimately contains one (`"a<b" <x@y.com>`) still yields the address.
  if (trimmed.endsWith(">")) {
    const open = trimmed.lastIndexOf("<");
    if (open === -1) return null;
    const email = trimmed.slice(open + 1, -1).trim();
    if (!isAddrSpec(email)) return null;
    const name = parseDisplayName(trimmed.slice(0, open));
    return name === null ? null : { name: name.value, email };
  }

  // A bracket on one side only is a truncated header, not a bare address.
  // Accepting `Riddler Go <hello@x.com` as an address would send from a
  // syntactically broken From, and the provider's rejection names the whole
  // string rather than the missing character.
  if (trimmed.includes("<") || trimmed.includes(">")) return null;

  return isAddrSpec(trimmed) ? { name: null, email: trimmed } : null;
}

/**
 * The inverse of `parseSenderAddress`. `parse(format(a))` equals `a` for every
 * address `parse` can produce.
 *
 * Throws rather than emit something unparseable, because the result goes
 * straight into a `From:` header. A display name carrying a CR or LF is not a
 * formatting nuisance, it is header injection: a provider that does not reject
 * it lets the caller append their own `Bcc:` line.
 */
export function formatSenderAddress(
  address: SenderAddress,
  variable = "sender address",
): string {
  if (!isAddrSpec(address.email)) {
    throw new InvalidSenderAddressError(address.email, variable);
  }

  const name = address.name === null ? "" : address.name.trim();
  if (name.length === 0) return address.email;
  if (hasControlCharacter(name)) {
    throw new InvalidSenderAddressError(address.name ?? "", variable);
  }

  if (!needsQuoting(name)) return `${name} <${address.email}>`;
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}" <${address.email}>`;
}

interface DisplayName {
  readonly value: string | null;
}

/** null is "malformed"; `{ value: null }` is "there wasn't one". */
function parseDisplayName(raw: string): DisplayName | null {
  const text = raw.trim();
  if (text.length === 0) return { value: null };
  if (hasControlCharacter(text)) return null;

  if (text.startsWith('"')) {
    if (text.length < 2 || !text.endsWith('"')) return null;
    const inner = unescapeQuoted(text.slice(1, -1));
    if (inner === null) return null;
    return { value: inner.length > 0 ? inner : null };
  }

  // Unquoted, so only the characters that would re-parse the header are
  // refused. `.`, `'` and `()` are deliberately allowed — rejecting
  // `Acme Inc. <hi@acme.com>` is the same over-validation this parser exists
  // to undo.
  return UNQUOTED_SPECIALS.test(text) ? null : { value: text };
}

const UNQUOTED_SPECIALS = /["<>,;:@\\]/;

function unescapeQuoted(inner: string): string | null {
  let out = "";
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === undefined) return null;
    if (char === "\\") {
      const next = inner[i + 1];
      // A trailing backslash means the closing quote we matched was itself
      // escaped, so the quoted string never actually ended.
      if (next === undefined) return null;
      out += next;
      i += 1;
      continue;
    }
    if (char === '"') return null;
    out += char;
  }
  return out;
}

function needsQuoting(name: string): boolean {
  return UNQUOTED_SPECIALS.test(name);
}

/**
 * CR and LF are the characters that matter — they terminate a header, which
 * is how a display name appends one the caller never wrote — but the whole C0
 * range plus DEL is refused. A control character is never meaningful in a
 * display name, and a narrower list is a list somebody has to keep correct.
 *
 * Written as a scan rather than a regex so the source file contains no
 * literal control characters of its own.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** RFC 5321's ceiling on what can appear in a MAIL FROM. */
const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const MAX_DOMAIN_LENGTH = 253;

function isAddrSpec(email: string): boolean {
  if (email.length === 0 || email.length > MAX_ADDRESS_LENGTH) return false;

  const at = email.indexOf("@");
  // `at <= 0` covers both "no @ at all" and an empty local part. The second
  // test rejects `a@@b.com` and `a@b@c.com`, which would otherwise satisfy the
  // domain check on their final segment alone.
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;

  return isLocalPart(email.slice(0, at)) && isDomain(email.slice(at + 1));
}

function isLocalPart(local: string): boolean {
  if (local.length === 0 || local.length > MAX_LOCAL_LENGTH) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return false;
  }
  return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local);
}

function isDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return false;

  const labels = domain.split(".");
  // At least two labels. A sender at `localhost`, or at a bare internal
  // hostname, can never receive the bounce, so accepting it only relocates the
  // failure to somewhere with no error message.
  if (labels.length < 2) return false;

  const tld = labels[labels.length - 1];
  if (tld === undefined) return false;
  // Letters, or punycode. Not digits: `user@192.168.0.1` satisfies every other
  // rule here and is never a real sender.
  if (!/^[A-Za-z]{2,}$/.test(tld) && !/^xn--[A-Za-z0-9-]+$/i.test(tld)) {
    return false;
  }

  return labels.every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
  );
}

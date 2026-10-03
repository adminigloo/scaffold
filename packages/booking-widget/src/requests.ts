import type { BookingErrorCode, BookRequest, Medium } from "./types.js";

/**
 * The form's rules, the request it becomes, and what the server's errors mean
 * to a person — pure, so every branch is a unit test rather than a click-path.
 *
 * The client-side checks MIRROR the server's (name 1–120, a plausible email, a
 * phone with its country code — or the deployment's default one — and 7–15
 * digits, required for a phone call, notes ≤ 1000) so a visitor hears about a
 * problem before the round trip. They are a courtesy, not the gate:
 * the server re-validates everything, and its `invalid` issues are mapped back
 * onto the same fields below.
 */

// ---------------------------------------------------------------------------
// Copy that belongs to the contract
// ---------------------------------------------------------------------------

export interface MediumCopy {
  /** The radio's title — the spec's wording. */
  title: string;
  /** One supporting line under it. */
  blurb: string;
  /** The bare medium, for the confirmation's "How we meet" line, which says the rest itself. */
  short: string;
}

export const MEDIUM_COPY: Record<Medium, MediumCopy> = {
  video: {
    title: "Video call — we send the link",
    blurb: "You'll get a link to join at the time you pick.",
    short: "Video call",
  },
  phone: {
    title: "Phone call — we call you",
    blurb: "No link, no software. We call the number you give below.",
    short: "Phone call",
  },
  prospect_hosted: {
    // Exists because corporate IT at plenty of companies blocks meeting links
    // from outside vendors — the invite is theirs to send.
    title: "Your meeting link — you send the invite",
    blurb: "If your company restricts outside meeting links, send us an invite from your own system.",
    short: "Your meeting link",
  },
};

/** Render order for the radios; the type's own list is filtered through it. */
export const MEDIUM_ORDER: readonly Medium[] = ["video", "phone", "prospect_hosted"];

export function orderedMedia(media: readonly Medium[]): Medium[] {
  return MEDIUM_ORDER.filter((medium) => media.includes(medium));
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export const LIMITS = {
  name: 120,
  email: 254,
  /** Not pinned by the spec; the reference server allows 120. */
  company: 120,
  notes: 1000,
  /** Cancel reason. Not pinned by the spec either. */
  reason: 500,
} as const;

export interface BookFormValues {
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
  medium: Medium | null;
}

export type BookField = "name" | "email" | "phone" | "company" | "notes" | "medium";

export type FieldErrors = Partial<Record<BookField, string>>;

export const EMPTY_FORM: BookFormValues = {
  name: "",
  email: "",
  phone: "",
  company: "",
  notes: "",
  medium: null,
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_CHARS = /^(\+|00)?[\d\s().-]+$/;

export interface PhoneOptions {
  /**
   * The country calling code ("1", "44") assumed for a number typed WITHOUT
   * a leading "+" or "00". Omitted (or not a calling code): "+" required.
   */
  defaultCallingCode?: string | null | undefined;
}

/**
 * "1", "+1", " 44 " → "1", "44". Null for anything that is not a country
 * calling code: one to three digits, never starting with 0. The server
 * applies the same test, so a prop the server would refuse is refused here.
 */
export function normalizeCallingCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^\+/, "");
  return /^[1-9]\d{0,2}$/.test(value) ? value : null;
}

/** Codes whose national numbers keep their leading 0 (Italy, San Marino: +39 06 …). */
const LEADING_ZERO_KEPT = new Set(["39", "378"]);

/**
 * A North American (NANP, calling code 1) national number: exactly ten
 * digits, the area code and the exchange each starting 2-9. Neither can
 * start with 0 or 1, so ten digits that do are not a US or Canadian number.
 */
const NANP_NATIONAL = /^[2-9]\d{2}[2-9]\d{6}$/;
const NANP_E164_DIGITS = /^1[2-9]\d{2}[2-9]\d{6}$/;

/**
 * The default code put in front of a national number. Null when the digits
 * cannot be a number in that country — never a guess that dials a stranger.
 *
 * Code 1 (NANP) is its own case, because the generic "drop one 0 trunk
 * prefix" rule is WRONG there: North America has no 0 trunk prefix, so a
 * leading 0 means the visitor typed some other country's number without its
 * code. UK "020 7946 0958" used to become +12079460958 — a valid-looking
 * Maine number belonging to a stranger. Now it is refused, with a message
 * that says how to write an international number. The one NANP trunk
 * prefix is the "1" leading an ELEVEN-digit entry ("1 801 555 0143"); after
 * dropping it the ten national digits must be NANP-shaped.
 *
 * Every other code drops one leading "0" trunk prefix (UK "020 …" with code
 * 44 → +44 20 …), except where the 0 belongs to the number (Italy, San
 * Marino); a second 0 after the trunk prefix is no number anywhere, so it
 * is refused. The server's rule, line for line.
 */
function withCallingCode(national: string, code: string): string | null {
  let digits = national;
  if (code === "1") {
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    return NANP_NATIONAL.test(digits) ? `1${digits}` : null;
  }
  if (!LEADING_ZERO_KEPT.has(code)) {
    if (digits.startsWith("0")) digits = digits.slice(1);
    if (digits.startsWith("0")) return null;
  }
  return `${code}${digits}`;
}

/**
 * "+44 (0) 20 7946 0958" → "+44 20 7946 0958". The "(0)" right after a
 * leading country code is the trunk prefix shown for callers inside the
 * country, never part of the international number; kept, it made +44 020 …,
 * which does not exist. Italy and San Marino keep the 0 (it is part of
 * their numbers): there only the brackets go. Same expression as the server.
 */
function dropBracketedTrunkZero(text: string): string {
  return text.replace(/^(\+|00)(\s*)(\d{1,3})[\s.-]*\(\s*0\s*\)/, (_match, lead: string, gap: string, code: string) =>
    LEADING_ZERO_KEPT.has(code) ? `${lead}${gap}${code} 0` : `${lead}${gap}${code} `,
  );
}

/**
 * How a number was written: with its country code ("+", "00", or — for a
 * deployment whose default code is 1 — the North American exit code "011",
 * how that audience dials abroad), or as a national number to read in the
 * default country. The digits come back without the exit code.
 */
function readPhone(trimmed: string, code: string | null): { international: boolean; digits: string } {
  const text = dropBracketedTrunkZero(trimmed);
  let international = text.startsWith("+") || text.startsWith("00");
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("00")) {
    digits = digits.slice(2);
  } else if (!international && code === "1" && digits.startsWith("011")) {
    digits = digits.slice(3);
    international = true;
  }
  return { international, digits };
}

/**
 * A phone number cleaned for the wire, E.164-ish: one leading "+", then 7-15
 * digits (E.164's upper bound), the first never 0. Separators people type
 * are dropped; a leading "00" (or "011" when the default code is 1) reads as
 * "+", and a "(0)" right after the country code is dropped. A number in
 * country code 1 must be a real North American shape, however it was typed.
 * Null when it is not dialable by those rules.
 *
 * By default the "+" is REQUIRED, as the server requires it: guessing a
 * country code turns "801 555 0143" into a call to somewhere in the 80x
 * range. With `defaultCallingCode` (the widget prop, or the server's config)
 * a number typed without "+" or "00" is read in that country instead — the
 * same rule the server applies, so the widget sends what the server would
 * have made of it. Checking here means the visitor hears about a problem
 * before the round trip.
 */
export function normalizePhone(raw: string, options: PhoneOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !PHONE_CHARS.test(trimmed)) return null;
  const code = normalizeCallingCode(options.defaultCallingCode);
  const read = readPhone(trimmed, code);
  let digits = read.digits;
  if (!read.international) {
    if (!code || digits.length === 0) return null;
    const withCode = withCallingCode(digits, code);
    if (!withCode) return null;
    digits = withCode;
  }
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  // +1 is North America, whose numbers are always ten digits after the 1.
  if (digits.startsWith("1") && !NANP_E164_DIGITS.test(digits)) return null;
  return `+${digits}`;
}

/**
 * Why a number was refused, in words that say how to fix it — or null when
 * `normalizePhone` accepts it (or there is nothing to check). The specific
 * cases are the ones a default code of 1 used to swallow silently (a leading
 * 0, the wrong digit count), where "7 to 15 digits" would tell nobody what
 * went wrong.
 */
export function phoneProblem(raw: string, options: PhoneOptions = {}): string | null {
  const trimmed = raw.trim();
  if (!trimmed || normalizePhone(trimmed, options)) return null;
  const code = normalizeCallingCode(options.defaultCallingCode);
  if (!PHONE_CHARS.test(trimmed)) {
    return code
      ? `Use digits only (spaces, dots, dashes and brackets are fine). Outside +${code}, start with + and the country code.`
      : `Use digits only, and include the country code, like ${PHONE_EXAMPLE} (7 to 15 digits).`;
  }
  const { international, digits } = readPhone(trimmed, code);
  if (international && digits.startsWith("1")) {
    return `A +1 number has ten digits after the 1, like ${PHONE_EXAMPLE}.`;
  }
  if (!international && code === "1") {
    return digits.startsWith("0")
      ? "US and Canadian numbers don't start with 0. Outside +1, start with + and the country code (or 011)."
      : "Enter a 10-digit US or Canadian number, like 801 555 0143. Outside +1, start with + and the country code.";
  }
  return code
    ? `Enter a number we can dial (7 to 15 digits). Outside +${code}, start with + and the country code.`
    : `Include the country code, like ${PHONE_EXAMPLE} (7 to 15 digits).`;
}

/** The example every phone message and placeholder uses. */
export const PHONE_EXAMPLE = "+1 801 555 0143";

export function isValidEmail(raw: string): boolean {
  const value = raw.trim();
  return value.length > 0 && value.length <= LIMITS.email && EMAIL_PATTERN.test(value);
}

/**
 * Field-by-field problems, empty when the form can be sent. `media` is the
 * picked type's list: a medium outside it is an error, and so is no medium
 * when there is a choice to make. `options.defaultCallingCode` relaxes the
 * phone rule the way the server's option does.
 */
export function validateBookForm(
  values: BookFormValues,
  media: readonly Medium[],
  options: PhoneOptions = {},
): FieldErrors {
  const errors: FieldErrors = {};
  const name = values.name.trim();
  if (!name) errors.name = "Enter your name.";
  else if (name.length > LIMITS.name) errors.name = `Keep your name under ${LIMITS.name} characters.`;

  if (!values.email.trim()) errors.email = "Enter your email address.";
  else if (!isValidEmail(values.email)) errors.email = "Enter a valid email address, like you@company.com.";

  if (!values.medium || !media.includes(values.medium)) errors.medium = "Choose how you'd like to meet.";

  const phone = values.phone.trim();
  const problem = phoneProblem(phone, options);
  if (values.medium === "phone" && !phone) {
    errors.phone = "Enter the number we should call.";
  } else if (problem) {
    errors.phone = problem;
  }

  if (values.company.trim().length > LIMITS.company) {
    errors.company = `Keep the company name under ${LIMITS.company} characters.`;
  }
  if (values.notes.trim().length > LIMITS.notes) {
    errors.notes = `Keep notes under ${LIMITS.notes} characters.`;
  }
  return errors;
}

/** The first invalid field in visual order — where focus goes on a failed submit. */
export function firstInvalidField(errors: FieldErrors): BookField | null {
  const order: BookField[] = ["name", "email", "medium", "phone", "company", "notes"];
  return order.find((field) => errors[field]) ?? null;
}

/**
 * The body for `POST /v1/book`: trimmed, optional fields omitted when empty
 * (an empty string is a value to a server validator; absent is "not given"),
 * the phone normalized — with the default calling code when there is one, so
 * the server receives "+1…" even if it was not told the code itself — and
 * the hold token only when there is one.
 */
export function buildBookRequest(input: {
  type: string;
  start: string;
  holdToken?: string | null;
  values: BookFormValues;
  medium: Medium;
  timezone: string;
  source?: string | null;
  defaultCallingCode?: string | null;
}): BookRequest {
  const { values } = input;
  const request: BookRequest = {
    type: input.type,
    start: input.start,
    name: values.name.trim(),
    email: values.email.trim(),
    medium: input.medium,
    timezone: input.timezone,
  };
  if (input.holdToken) request.holdToken = input.holdToken;
  const phone = values.phone.trim();
  if (phone) request.phone = normalizePhone(phone, { defaultCallingCode: input.defaultCallingCode }) ?? phone;
  const company = values.company.trim();
  if (company) request.company = company;
  const notes = values.notes.trim();
  if (notes) request.notes = notes;
  const source = input.source ? scrubSource(input.source) : undefined;
  if (source) request.source = source;
  return request;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * A campaign tag made safe to store: printable, short (the server keeps ≤ 100),
 * nothing that could be markup. The server scrubs again; this keeps a hostile
 * query string from ever leaving the browser in the first place.
 */
export function scrubSource(raw: string): string | undefined {
  const cleaned = raw
    .replace(/[^A-Za-z0-9 ._:/-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return cleaned || undefined;
}

/** `?src=` wins; else the UTM trio joined, e.g. "newsletter/email/october". */
export function sourceFromSearch(search: string): string | undefined {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return undefined;
  }
  const src = params.get("src");
  if (src) return scrubSource(src);
  const utm = ["utm_source", "utm_medium", "utm_campaign"]
    .map((key) => params.get(key))
    .filter((value): value is string => Boolean(value));
  return utm.length > 0 ? scrubSource(utm.join("/")) : undefined;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The server's codes plus the two failures that never reach it. */
export type ClientErrorCode = BookingErrorCode | "network" | "server";

export interface BookingIssue {
  path: string[];
  message: string;
}

export interface BookingError {
  code: ClientErrorCode;
  /** The server's message (or ours). For logs; people see `friendlyError`. */
  message: string;
  /** HTTP status; 0 when the request never got an answer. */
  status: number;
  issues: BookingIssue[];
}

const SERVER_CODES = new Set<BookingErrorCode>([
  "not_found",
  "slot_taken",
  "hold_expired",
  "already_booked",
  "invalid",
  "rate_limited",
  "unlicensed",
]);

const STATUS_CODES: Record<number, BookingErrorCode> = {
  400: "invalid",
  402: "unlicensed",
  404: "not_found",
  409: "slot_taken",
  429: "rate_limited",
};

/**
 * The spec says `invalid` carries `issues` without pinning their shape. Accept
 * the two a zod-validating server produces: the raw issue list
 * (`[{ path, message }]`) and `flatten()`'s `{ fieldErrors: { name: [...] } }`.
 */
export function normalizeIssues(raw: unknown): BookingIssue[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item): BookingIssue[] => {
      if (!item || typeof item !== "object") return [];
      const { path, message } = item as { path?: unknown; message?: unknown };
      const parts = Array.isArray(path)
        ? path.map(String)
        : typeof path === "string"
          ? path.split(".").filter(Boolean)
          : [];
      return [{ path: parts, message: typeof message === "string" ? message : "Invalid value." }];
    });
  }
  if (raw && typeof raw === "object" && "fieldErrors" in raw) {
    const fieldErrors = (raw as { fieldErrors?: unknown }).fieldErrors;
    if (fieldErrors && typeof fieldErrors === "object") {
      return Object.entries(fieldErrors as Record<string, unknown>).flatMap(([field, messages]) =>
        (Array.isArray(messages) ? messages : [messages])
          .filter((message): message is string => typeof message === "string")
          .map((message) => ({ path: [field], message })),
      );
    }
  }
  return [];
}

/** A non-2xx response as an error value. Tolerates bodies that are not the contract's. */
export function toBookingError(status: number, body: unknown): BookingError {
  const error = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (error && typeof error === "object") {
    const { code, message, issues } = error as { code?: unknown; message?: unknown; issues?: unknown };
    if (typeof code === "string" && SERVER_CODES.has(code as BookingErrorCode)) {
      return {
        code: code as BookingErrorCode,
        message: typeof message === "string" ? message : code,
        status,
        issues: normalizeIssues(issues),
      };
    }
  }
  const byStatus = STATUS_CODES[status];
  return {
    code: byStatus ?? "server",
    message: typeof error === "string" ? error : `request failed (${status})`,
    status,
    issues: [],
  };
}

export function networkError(detail = "could not reach the booking service"): BookingError {
  return { code: "network", message: detail, status: 0, issues: [] };
}

const FORM_FIELDS = new Set<BookField>(["name", "email", "phone", "company", "notes", "medium"]);

/** Server issues that name a form field, as the form's own error map. */
export function issuesToFieldErrors(issues: readonly BookingIssue[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const field = issue.path[0] as BookField | undefined;
    if (field && FORM_FIELDS.has(field) && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Email honesty
// ---------------------------------------------------------------------------

/**
 * What the host's server says about email, from its config. A deployment
 * with no mail provider still takes bookings — and then every "check your
 * confirmation email" is a promise nobody keeps, so the copy below asks
 * these two facts before it makes one.
 */
export interface EmailFacts {
  /** False when the server sends no email at all. Absent means true (older servers always claimed it). */
  emailsEnabled?: boolean | undefined;
  /** A human address the host app chooses to show instead, when it has one. */
  contactEmail?: string | null | undefined;
}

/** Whether the visitor will actually get email. Only an explicit `false` says no. */
export function emailsOn(facts: EmailFacts | null | undefined): boolean {
  return facts?.emailsEnabled !== false;
}

/**
 * Where a person goes when the page itself can't change their booking: the
 * confirmation email (when one exists), else the host's contact address,
 * else the host by name — never an inbox that was never written to.
 */
export type ReachHost =
  | { kind: "reply" }
  | { kind: "email"; address: string }
  | { kind: "direct"; who: string };

export function reachHost(facts: EmailFacts | null | undefined, hostDisplayName: string): ReachHost {
  if (emailsOn(facts)) return { kind: "reply" };
  const address = facts?.contactEmail?.trim();
  if (address && isValidEmail(address)) return { kind: "email", address };
  return { kind: "direct", who: hostDisplayName.trim() || "the host" };
}

/** `reachHost` as the end of a sentence: "… reply to your confirmation email." */
export function reachHostText(reach: ReachHost): string {
  if (reach.kind === "reply") return "reply to your confirmation email";
  if (reach.kind === "email") return `email ${reach.address}`;
  return `contact ${reach.who} directly`;
}

/**
 * The `already_booked` answer. The first submit booked the time but its
 * answer never arrived, so this page never saw the manage link — with email
 * on, the confirmation carries it; with email off, the only honest pointer
 * is a person.
 */
export function alreadyBookedMessage(
  facts: EmailFacts | null | undefined,
  input: { sandbox: boolean; hostDisplayName: string },
): string {
  if (input.sandbox) return "You're already booked for this time. (Sandbox — nothing was emailed.)";
  const reach = reachHost(facts, input.hostDisplayName);
  if (reach.kind === "reply") {
    return "You're already booked for this time. Check your email for the confirmation — it has your link to reschedule or cancel.";
  }
  return `You're already booked for this time. To move or cancel it, ${reachHostText(reach)}.`;
}

/** The time went away under the visitor: back to the picker with fresh times. */
export function isSlotGone(error: BookingError): boolean {
  return error.code === "slot_taken" || error.code === "hold_expired";
}

export type ErrorContext = "config" | "slots" | "hold" | "book" | "manage" | "cancel" | "reschedule";

/** What a person reads for an error, by where it happened. */
export function friendlyError(error: BookingError, context: ErrorContext, facts?: EmailFacts | null): string {
  switch (error.code) {
    case "network":
      return "We couldn't reach the booking service. Check your connection and try again.";
    case "rate_limited": {
      // A ceiling can hold for longer than "a minute"; when the host app gave
      // a human address, name it so a real prospect is never just turned away.
      const wait = "That's a lot of tries in a short time. Wait a minute, then try again.";
      const address = facts?.contactEmail?.trim();
      return address && isValidEmail(address) ? `${wait} Or email ${address}.` : wait;
    }
    case "unlicensed":
      return "Online booking isn't available on this site right now.";
    case "slot_taken":
      return "Someone just booked that time. The times shown are up to date — please pick another.";
    case "hold_expired":
      return "Your hold on that time ran out and it's no longer free. The times shown are up to date — please pick another.";
    case "already_booked":
      // The form went twice (a double click, or a retry after an answer that
      // never arrived) and the first one worked: nothing to pick again.
      return "You're already booked for this time. Check your email for the confirmation — it has your link to reschedule or cancel.";
    case "not_found":
      if (context === "manage" || context === "cancel" || context === "reschedule") {
        return "This booking link is no longer valid. It may have been cancelled, or the link is incomplete.";
      }
      if (context === "config") return "There's nothing to book here right now.";
      return "That kind of call isn't offered any more. Please refresh and choose again.";
    case "invalid":
      if (context === "book") {
        return Object.keys(issuesToFieldErrors(error.issues)).length > 0
          ? "Please check the highlighted fields."
          : "Some details weren't accepted. Please check them and try again.";
      }
      if (context === "hold" || context === "reschedule") {
        return "That time can't be booked any more. Please pick another.";
      }
      if (context === "cancel") return "That cancellation couldn't be sent. Please try again.";
      return "Something about this booking link isn't right. Please refresh the page.";
    case "server":
    default:
      return "Something went wrong on our side. Please try again.";
  }
}

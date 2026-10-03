/**
 * The error vocabulary every service throws and the handler factory speaks.
 * One class with a code, not a class per failure: the HTTP mapping is a
 * table lookup, and a tRPC router in the host app can map the same codes
 * without importing anything else.
 *
 * Copy that makes a promise about email has an emails-off variant
 * (alreadyBookedMessage): a deployment without a mail provider must never
 * tell a prospect to wait for a message that is not coming.
 *
 * NOT-FOUND HAS ONE SHAPE. An unknown manage token, another tenant's token,
 * an id from the wrong tenant: all `not_found` with the same message, so
 * nothing the package says lets a caller learn whether a token or an id
 * exists somewhere it may not look.
 */

export type BookingErrorCode =
  | "not_found"
  | "slot_taken"
  | "hold_expired"
  /**
   * The same form arrived twice: its hold already became a booking (within
   * the last ten minutes). Not a failure to recover from by picking another
   * time — the first submit worked.
   */
  | "already_booked"
  | "invalid"
  | "rate_limited"
  | "unlicensed"
  /**
   * A state-changing request sent by a browser from another site (CSRF).
   * Refused by the handler factory before any work — see handlers.ts.
   */
  | "forbidden";

export const BOOKING_ERROR_STATUS: Record<BookingErrorCode, number> = {
  not_found: 404,
  slot_taken: 409,
  hold_expired: 409,
  already_booked: 409,
  invalid: 400,
  rate_limited: 429,
  unlicensed: 402,
  forbidden: 403,
};

const DEFAULT_MESSAGES: Record<BookingErrorCode, string> = {
  not_found: "Not found.",
  slot_taken: "That time was just taken. Please pick another.",
  hold_expired: "Your hold on that time expired and it is no longer free. Please pick another.",
  already_booked:
    "You're already booked for this time. Check your email for the confirmation and the link to reschedule or cancel.",
  invalid: "Some details need another look.",
  rate_limited: "Too many requests. Please slow down and try again shortly.",
  unlicensed: "This feature is not licensed for this deployment.",
  forbidden: "This request came from another site, so it was refused.",
};

/**
 * The `already_booked` sentence for a deployment that sends NO email. The
 * default one tells the prospect to check their inbox; with emails off that
 * inbox stays empty, and the only copy of the manage link is the
 * confirmation page the first submit showed (or never showed, when its
 * response was lost — the very case a second submit usually is). So this
 * points at that page, and at a person when the host app named one.
 */
export function alreadyBookedMessage(options: { emailsEnabled?: boolean; contactEmail?: string | null } = {}): string {
  if (options.emailsEnabled !== false) return DEFAULT_MESSAGES.already_booked;
  return (
    "You're already booked for this time — your first request went through. " +
    "Use the private link on your confirmation page to reschedule or cancel" +
    (options.contactEmail
      ? `. If you didn't see that page, email ${options.contactEmail} and we'll sort it out.`
      : ".")
  );
}

export interface BookingIssue {
  path: Array<string | number>;
  message: string;
  code?: string;
}

export class BookingError extends Error {
  readonly name = "BookingError";
  readonly code: BookingErrorCode;
  readonly status: number;
  readonly issues?: BookingIssue[];

  constructor(code: BookingErrorCode, message?: string, issues?: BookingIssue[]) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.code = code;
    this.status = BOOKING_ERROR_STATUS[code];
    if (issues) this.issues = issues;
  }
}

export function isBookingError(error: unknown): error is BookingError {
  return error instanceof BookingError;
}

/** The one not-found every lookup throws. */
export function notFound(): BookingError {
  return new BookingError("not_found");
}

/** Zod issues → the wire's `issues`, without leaking the input values back. */
export function issuesFrom(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code?: unknown }> }): BookingIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((part): part is string | number => typeof part !== "symbol"),
    message: issue.message,
    ...(typeof issue.code === "string" ? { code: issue.code } : {}),
  }));
}

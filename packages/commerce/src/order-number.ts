/**
 * Human-facing order numbers. Pure, deterministic, no database.
 *
 * `orders.id` is a UUID v7 and stays the primary key. This is the other thing:
 * the string on the receipt, in the subject line, and read aloud to support.
 * They are separate because they have opposite requirements — an id must be
 * unguessable and never spoken, an order number must be speakable and is
 * therefore public.
 */

/** `TC-20260828-000142-19` */
const SEQUENCE_PAD = 6;

export class InvalidOrderNumberInputError extends Error {
  readonly name = "InvalidOrderNumberInputError";
  constructor(message: string) {
    super(message);
  }
}

export interface OrderNumberInput {
  /**
   * Per-tenant, uppercase, alphanumeric. Two to four characters reads best on a
   * receipt.
   */
  readonly prefix: string;
  /**
   * A PER-TENANT counter, not a global one. This is the whole guessability
   * tradeoff below: whatever this leaks, it must only leak about one tenant.
   */
  readonly sequence: number;
  /** Defaults to now. Read in UTC — see below. */
  readonly date?: Date;
}

/**
 * `PREFIX-YYYYMMDD-NNNNNN-CC`, e.g. `TC-20260828-000142-19`.
 *
 * WHAT THIS FORMAT GIVES UP, EXPLICITLY.
 *
 * The order number is not a secret and must never be treated as one. It is
 * printed on the packing slip, quoted in a support chat and forwarded in a
 * receipt, so anyone who wants it will have it. A competitor who buys one item
 * learns the date and the tenant's order count on that date, and buying again a
 * month later measures growth — the classic sequential-invoice leak. The
 * mitigation is that the sequence is PER TENANT: the number tells you about the
 * one storefront you bought from, never the platform. A global counter would
 * hand every customer of every tenant a read on total volume, which is a
 * different and much worse disclosure.
 *
 * WHAT THE CHECK CHARACTERS ARE FOR, AND WHAT THEY ARE NOT.
 *
 * `CC` is a mod-97 checksum (ISO 7064-style, `98 - n mod 97`) over the digits.
 * It exists because order numbers are read aloud and retyped, and without it a
 * single transposed digit lands on a DIFFERENT REAL ORDER — support reads a
 * stranger's shipping address back to the caller and never knows. With it,
 * `verifyOrderNumberCheck` rejects every single-digit error and every
 * transposition of adjacent digits before a query is ever issued.
 *
 * It is NOT an authorisation token. The algorithm is public and unkeyed, so it
 * costs a competitor nothing to compute. Any route that loads an order must
 * still check the tenant and the principal; if you need an unguessable handle,
 * use `orders.id`.
 *
 * SORTABILITY. Lexicographic order matches chronological order because the date
 * leads and the sequence is zero-padded to a fixed width. Past 999,999 orders
 * in one day for one tenant the sequence outgrows the pad, widths differ, and
 * within-day lexicographic order stops matching numeric order. Cross-day order
 * still holds. A tenant at that volume has a sequence-allocation problem long
 * before it has a formatting problem.
 */
export function formatOrderNumber(input: OrderNumberInput): string {
  const prefix = input.prefix.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,8}$/.test(prefix)) {
    throw new InvalidOrderNumberInputError(
      `Order number prefix "${input.prefix}" must be 1-8 alphanumeric characters. ` +
        `The number is split on "-" by every parser that reads it back, so a ` +
        `prefix containing a hyphen or a space silently changes the segment count.`,
    );
  }

  if (!Number.isInteger(input.sequence) || input.sequence < 1) {
    throw new InvalidOrderNumberInputError(
      `Order number sequence must be a positive integer, got ${input.sequence}. ` +
        `Zero pads to "000000", which reads as "no order"; a fractional value ` +
        `means the caller is doing arithmetic on a counter.`,
    );
  }

  const date = input.date ?? new Date();
  const day = utcDay(date);
  const sequence = String(input.sequence).padStart(SEQUENCE_PAD, "0");

  return `${prefix}-${day}-${sequence}-${checkDigits(`${day}${sequence}`)}`;
}

/**
 * Does this string carry a self-consistent check?
 *
 * For the support lookup box: reject a mistyped number here instead of querying
 * for it, so "no such order" means the order does not exist rather than "you
 * transposed two digits". Returns false for anything that is not shaped like an
 * order number at all — a caller pasting a UUID gets the same answer as a
 * caller pasting a typo, and both mean "do not run this query".
 */
export function verifyOrderNumberCheck(orderNumber: string): boolean {
  const match = /^[A-Z0-9]{1,8}-(\d{8})-(\d+)-(\d{2})$/.exec(
    orderNumber.trim().toUpperCase(),
  );
  if (!match) return false;

  const [, day, sequence, check] = match;
  if (day === undefined || sequence === undefined || check === undefined) {
    return false;
  }
  return checkDigits(`${day}${sequence}`) === check;
}

/**
 * UTC components, never `getFullYear`/`getMonth`.
 *
 * Those read the host's local time, and this runs on serverless instances in
 * whichever region happened to be warm. The same order, retried from us-east-1
 * at 20:00 EDT and from eu-west-1 a second later, produces 20260828 and
 * 20260829 — two different order numbers for one order, one of which has
 * already been emailed to the customer.
 */
function utcDay(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

/**
 * `98 - (n mod 97)`, two digits, over the digit portion only.
 *
 * BigInt because the digit string is fourteen characters and only grows; as a
 * `number` it is still exact today and stops being exact the moment somebody
 * widens the date or the pad, which is the kind of change nobody re-tests the
 * checksum after. `n mod 97` lands in 0..96, so the result lands in 2..98 and
 * always renders as exactly two digits — there is no "00" that could be read as
 * "unchecked", and no single-digit case that would change the segment width.
 *
 * The prefix is excluded deliberately: mistyping the prefix produces a number
 * that fails the (tenant_id, order_number) lookup immediately, whereas
 * mistyping a digit is the error that silently finds another row.
 */
function checkDigits(digits: string): string {
  const remainder = BigInt(digits) % 97n;
  return String(98n - remainder).padStart(2, "0");
}

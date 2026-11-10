/**
 * The pure half of the wallet: what a unit is called, which amounts are real,
 * the refusals, and how a balance reads in a sentence. No drizzle and no
 * database, so a client component can import it to print "25 crowns" without
 * pulling the query builder into the browser bundle (the reason catalog keeps
 * its tables out of its root entry, too).
 */

/**
 * A unit names one kind of credit: `crowns`, `ai-credits`, `tokens`.
 *
 * A slug, and deliberately narrow. The unit is half of every balance's key and
 * of every ledger row's idempotency key, so "Crowns", "crowns " and "crowns"
 * must not be three wallets holding a third of the customer's money each. It is
 * written by staff in the product builder and by code in the spend call, and
 * the two only ever agree if neither can spell it two ways.
 *
 * NOT CALLED `currency`. Every variant and order in the catalog already has a
 * `currency` ("usd"), and a grant config whose `currency` meant "crowns" would
 * sit one field away from one that meant dollars. A unit is what the credit IS;
 * a currency is what was PAID.
 */
export const CREDIT_UNIT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The largest single credit, spend or refund. A balance column is a Postgres
 * `integer`, which stops at 2,147,483,647; one movement this size leaves room
 * for two before anything overflows, and no real pack sells a billion of
 * anything. A larger amount is a typo (an amount entered in minor units, a
 * quantity multiplied twice), and refusing it is cheaper than explaining it.
 */
export const MAX_CREDIT_AMOUNT = 1_000_000_000;

/** What a ledger row records. */
export type WalletReason = "grant" | "spend" | "refund" | "adjust";

/** Every reason, as a tuple, so a router can hand it straight to `z.enum`. */
export const WALLET_REASONS = ["grant", "spend", "refund", "adjust"] as const satisfies readonly WalletReason[];

export function isCreditUnit(value: unknown): value is string {
  return typeof value === "string" && CREDIT_UNIT_PATTERN.test(value);
}

export class InvalidCreditUnitError extends Error {
  /** An own property, as in the other packages: `instanceof` fails across two installed copies. */
  readonly name = "InvalidCreditUnitError";
  constructor(readonly unit: string) {
    super(
      `"${unit}" is not a credit unit. A unit is a lower-case slug (letters, ` +
        `digits and hyphens, starting with a letter, at most 32 characters), ` +
        `such as "crowns" or "ai-credits".`,
    );
  }
}

export class InvalidCreditAmountError extends Error {
  readonly name = "InvalidCreditAmountError";
  constructor(readonly amount: number) {
    super(
      `${amount} is not a credit amount. Credits move in whole numbers from 1 ` +
        `to ${MAX_CREDIT_AMOUNT.toLocaleString("en-US")}.`,
    );
  }
}

/**
 * Not enough to spend. Carries what IS there, so the caller can say "you have
 * 3 crowns" rather than only "no", and offer the pack that makes up the rest.
 */
export class InsufficientCreditsError extends Error {
  readonly name = "InsufficientCreditsError";
  constructor(
    readonly unit: string,
    readonly wanted: number,
    readonly balance: number,
  ) {
    super(`Not enough ${unit}: ${wanted} wanted, ${balance} held.`);
  }
}

export function assertCreditUnit(unit: string): void {
  if (!isCreditUnit(unit)) throw new InvalidCreditUnitError(unit);
}

export function assertCreditAmount(amount: number): void {
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CREDIT_AMOUNT) {
    throw new InvalidCreditAmountError(amount);
  }
}

/** How one unit is written in a sentence. */
export interface CreditUnitLabel {
  /** "crown" */
  readonly one: string;
  /** "crowns" */
  readonly many: string;
}

/**
 * "1 crown", "25 crowns", "0 ai-credits". With no label the unit itself is the
 * plural and the singular, which reads fine for most slugs and is never wrong
 * about the number.
 */
export function formatCredits(amount: number, unit: string, label?: CreditUnitLabel): string {
  const word = label ? (amount === 1 ? label.one : label.many) : unit;
  return `${amount.toLocaleString("en-US")} ${word}`;
}

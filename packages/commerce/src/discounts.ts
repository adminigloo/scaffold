import { applyDiscount } from "./cart.js";
import type { DiscountKind } from "./cart.js";

/**
 * The subset of a `discount_codes` row this module needs.
 *
 * Field names match the column names exactly, so a Drizzle select can be handed
 * straight in with no adapter. An adapter is where a field gets dropped, and a
 * dropped `endsAt` reads as "no expiry" rather than as an error.
 */
export interface DiscountCodeState {
  readonly kind: DiscountKind;
  /** Whole percent for `percent`, minor units for `fixed`. */
  readonly value: number;
  readonly isActive: boolean;
  /** NULL means live immediately. */
  readonly startsAt: Date | null;
  /** NULL means no end date — a deliberate evergreen code, not a gap. */
  readonly endsAt: Date | null;
  /** NULL means unlimited redemptions. */
  readonly maxRedemptions: number | null;
  readonly timesRedeemed: number;
  /** 0 means no minimum. Never NULL, so no caller has to branch on it. */
  readonly minSubtotalMinor: bigint;
}

export type DiscountStatus =
  | "valid"
  | "inactive"
  | "not-started"
  | "expired"
  | "exhausted"
  | "below-minimum";

export interface DiscountContext {
  /** Injected so the window boundaries are testable without faking the clock. */
  readonly now?: Date;
  /** The cart subtotal the code would apply to, in minor units. */
  readonly subtotalMinor: bigint;
}

/**
 * The one place that decides what a discount row means, given a cart.
 *
 * PRECEDENCE IS LOAD BEARING, and it is ordered by what the shopper can do
 * about the answer:
 *
 *   inactive > exhausted > not-started > expired > below-minimum > valid
 *
 *   - Inactive wins over everything. Switching a code off is a deliberate act
 *     taken with the row in view, usually to stop it being used right now. Any
 *     other message implies the code could still work — "expired" invites the
 *     shopper to ask support to extend it, and support extends a code the
 *     merchant switched off on purpose.
 *
 *   - Exhausted beats both window states. `times_redeemed` only ever goes up,
 *     so exhaustion is permanent, while a window is one admin edit away from
 *     being wrong. Reporting the recoverable condition over the unrecoverable
 *     one sends support to push out `ends_at`, after which the code still
 *     fails and the ticket is reopened.
 *
 *   - Not-started beats expired. They overlap only on a misconfigured row where
 *     `starts_at` is in the future AND `ends_at` in the past — a window nothing
 *     can ever fall inside. "Not started" points at the future date, which is
 *     the field somebody typed wrong; "expired" points at a date already gone
 *     and reads as normal.
 *
 *   - Below-minimum is LAST, and only reachable once the code is otherwise
 *     usable. It is the one state the shopper can fix, and it is the one that
 *     costs them money to fix. Telling somebody to add 20.00 to their cart to
 *     unlock a code that expired last week is the worst outcome this function
 *     can produce.
 *
 * Boundaries match `invitationState` in @adminigloo/tenancy: closed at both
 * ends. A code is live at the instant it starts and dead at the instant it
 * ends, so no code is ever valid for the one millisecond it is stamped dead.
 */
export function discountState(
  code: DiscountCodeState,
  context: DiscountContext,
): DiscountStatus {
  if (!code.isActive) return "inactive";

  if (code.maxRedemptions !== null && code.timesRedeemed >= code.maxRedemptions) {
    return "exhausted";
  }

  const now = context.now ?? new Date();

  if (code.startsAt !== null && now.getTime() < code.startsAt.getTime()) {
    return "not-started";
  }

  if (code.endsAt !== null && code.endsAt.getTime() <= now.getTime()) {
    return "expired";
  }

  if (context.subtotalMinor < code.minSubtotalMinor) return "below-minimum";

  return "valid";
}

/**
 * How much this code takes off the subtotal, in minor units.
 *
 * ARITHMETIC ONLY. It deliberately does not re-check `discountState`, and the
 * reason is reconciliation: an order placed in March against a code that ended
 * in April must still be able to recompute its own discount when a refund is
 * issued in June. A function that returned 0 for an expired code would make
 * every historical order un-reprice-able, and the refund would go out for the
 * undiscounted amount.
 *
 * So the checkout path is always two calls — `discountState` decides whether
 * the code may be used, this decides how much it is worth — and the order row
 * stores the result, because storing the code and recomputing later is how a
 * changed `value` silently rewrites what a customer already paid.
 *
 * `minSubtotalMinor` is not applied here either; it is a `below-minimum` state,
 * not a smaller discount.
 */
export function computeDiscountMinor(
  code: Pick<DiscountCodeState, "kind" | "value">,
  subtotalMinor: bigint,
): bigint {
  return subtotalMinor - applyDiscount(subtotalMinor, code);
}

/**
 * Canonical form of a code as typed by a shopper.
 *
 * Applied at the boundary, before both the insert and the lookup, for the same
 * reason `normaliseInviteEmail` exists in @adminigloo/tenancy: the unique index
 * on (tenant_id, code) compares bytes, so `spring25` and `SPRING25` would be two
 * separate rows with separate redemption counters, and a code capped at 100 uses
 * would quietly allow 200.
 *
 * Uppercase because that is how codes are printed on cards and in emails, and
 * because it removes the l/I confusion at the point where a human retypes it.
 * Internal whitespace is stripped too — codes get pasted with a trailing space
 * from a PDF, and "SPRING 25" is what a shopper types when the card shows
 * "SPRING25" in a spaced-out font.
 */
export function normaliseDiscountCode(code: string): string {
  return code.replace(/\s+/g, "").toUpperCase();
}

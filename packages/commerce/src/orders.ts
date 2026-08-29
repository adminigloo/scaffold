/**
 * THE ORDER-WRITE PROTOCOL. No database handle, no Stripe client — the
 * statements are text and the decisions are pure functions, for the same reason
 * `claimStatements` and `decideClaim` are in @adminigloo/stripe: the exact
 * conflict target and the exact `WHERE` clauses are the correctness-bearing
 * part, and a route that inlines its own version drops them silently.
 *
 * WHAT WENT WRONG BEFORE, CONCRETELY.
 *
 * The old mechanism was `INSERT … ON CONFLICT (stripe_payment_intent_id) DO
 * NOTHING` from BOTH `checkout.session.completed` and
 * `payment_intent.succeeded`. Stripe does not order those two deliveries, and
 * the statement breaks in both directions:
 *
 *   - PaymentIntent first. It inserts a row with `stripe_payment_intent_id`
 *     set and no session id — a PaymentIntent does not carry one. The session
 *     event then conflicts and DO NOTHING throws the session id away, along
 *     with the line items, the shipping address and the email that only the
 *     session event carries. The order exists and the receipt cannot be built.
 *   - Delayed notification (SEPA debit, Bacs, bank transfer). The session
 *     handler writes `stripe_payment_intent_id = NULL`, Postgres treats NULLs
 *     as distinct, so the conflict target cannot fire. The PaymentIntent event
 *     then inserts a SECOND row for the same order. Charged once, shipped
 *     twice — the exact failure the index was added to prevent.
 *
 * THE PROTOCOL THAT REPLACES IT.
 *
 * 1. `checkout.session.completed` is the SINGLE order-CREATING writer. It is
 *    the only event that carries the line items, the customer email and the
 *    addresses, so it is the only event that can write a complete order; and
 *    it carries `payment_status`, so it never needs the PaymentIntent event to
 *    know whether the money arrived.
 *
 * 2. `payment_intent.succeeded` and `checkout.session.async_payment_succeeded`
 *    may REPAIR a row — attach the PaymentIntent id, move `pending` to `paid`,
 *    stamp `placed_at` — and may NEVER insert one. A repair that matches no row
 *    is a no-op, not an insert. That is safe in every ordering:
 *      - PaymentIntent-before-session can only happen when the PaymentIntent
 *        already existed at session-completion time, which means
 *        `session.payment_intent` is populated in the session event. The
 *        session event that follows creates the row already `paid`, with the
 *        id, and nothing was lost by the no-op.
 *      - Delayed notification is repaired by
 *        `checkout.session.async_payment_succeeded`, which carries the session
 *        id and therefore the idempotency key. It never needs the PaymentIntent
 *        id to find its row, so the NULL that broke the old index is harmless.
 *
 * 3. The conflict target is `(tenant_id, idempotency_key)`, both NOT NULL. It
 *    fires in every ordering, including when the PaymentIntent id is not yet
 *    known, because the key is the checkout session id — known at session
 *    completion in every flow, delayed-notification included.
 *
 * WHY A DEDICATED KEY COLUMN AND NOT THE TWO ALTERNATIVES.
 *
 *   - A PARTIAL UNIQUE INDEX on `stripe_checkout_session_id` (`WHERE … IS NOT
 *     NULL`) closes the delayed-notification hole for Checkout orders and
 *     nothing else. Every other creation path — an admin-entered phone order, a
 *     migration back-fill, a future payment link — has no session id, so it
 *     gets no idempotency at all and the back-fill run twice writes every order
 *     twice. It also forces every caller to repeat the index predicate in its
 *     `ON CONFLICT … WHERE` clause or Postgres refuses the statement, which is
 *     one correct index and N chances to write the wrong conflict clause.
 *   - NOT NULL ON `stripe_checkout_session_id` ITSELF makes the column lie. It
 *     forbids the manual order outright, and the first person who needs one
 *     writes a sentinel — `'manual'`, which collides with the next manual
 *     order, or `'manual-' || random()`, after which the column no longer means
 *     "a Stripe Checkout Session" and every join and dashboard lookup through
 *     it is wrong. It also welds order idempotency to one payment provider.
 *   - AN EXPLICIT KEY COLUMN is NOT NULL by construction, so NULL-distinctness
 *     can never apply to it; it is provider-agnostic, so the admin order and
 *     the back-fill get the same guarantee as Checkout; and it gives one
 *     conflict target for one statement, with no predicate for a caller to
 *     re-derive. It costs one text column.
 *
 * Per-tenant rather than global, matching `orders_tenant_order_number_idx` and
 * `discount_codes_tenant_code_idx`: the key is caller-supplied on the non-
 * Stripe paths, and a global unique would make one tenant's `"import-batch-1"`
 * collide with another's — a cross-tenant failure caused by neither of them.
 */

import type { OrderStatus } from "./schema.js";

export class InvalidOrderIdempotencyKeyError extends Error {
  readonly name = "InvalidOrderIdempotencyKeyError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A repaired order whose PaymentIntent id does not match the one on the event.
 *
 * Thrown rather than swallowed because there is no safe automatic answer: two
 * PaymentIntents against one order row means either a duplicate charge or a
 * mis-keyed lookup, and both need a human before money moves. Overwriting the
 * id would destroy the evidence of which charge to refund.
 */
export class OrderPaymentIntentMismatchError extends Error {
  readonly name = "OrderPaymentIntentMismatchError";
  constructor(
    readonly idempotencyKey: string,
    readonly attachedPaymentIntentId: string,
    readonly eventPaymentIntentId: string,
  ) {
    super(
      `Order "${idempotencyKey}" already carries PaymentIntent ` +
        `"${attachedPaymentIntentId}" and event carries ` +
        `"${eventPaymentIntentId}". Two PaymentIntents on one order is a ` +
        `duplicate charge or a mis-keyed repair; refuse the write and ` +
        `reconcile in the Stripe dashboard before refunding either.`,
    );
  }
}

/**
 * Namespace prefix on the Checkout key.
 *
 * Without it, an admin tool free to choose its own key can pick a literal
 * `cs_test_…` string — copied out of a support thread, most likely — and
 * silently take over a real Checkout order's row. The prefix makes the two
 * namespaces disjoint at the value level, not by convention.
 */
export const CHECKOUT_SESSION_KEY_PREFIX = "checkout_session:";

/**
 * The idempotency key for an order created by `checkout.session.completed`.
 *
 * Throws on an empty id rather than producing `"checkout_session:"`, which is a
 * perfectly valid NOT NULL value that every session with a missing id would
 * share — collapsing every such order onto one row, which is worse than the
 * duplicate this whole protocol exists to stop.
 */
export function checkoutSessionKey(checkoutSessionId: string): string {
  const trimmed = checkoutSessionId.trim();
  if (trimmed.length === 0) {
    throw new InvalidOrderIdempotencyKeyError(
      `checkoutSessionKey requires a Stripe Checkout Session id. Got an empty ` +
        `string, which would key every such order to the same row. Read it ` +
        `from event.data.object.id on checkout.session.completed.`,
    );
  }
  return `${CHECKOUT_SESSION_KEY_PREFIX}${trimmed}`;
}

/**
 * The statements. `$1` is always `tenant_id` on the keyed ones, `$2` the key,
 * so a route cannot transpose them without the types complaining upstream.
 *
 * The guards are not decoration:
 *   - `create` conflicts on `(tenant_id, idempotency_key)`, both NOT NULL, so
 *     it fires whether or not the PaymentIntent id is known yet.
 *   - `repairByKey` uses `COALESCE($3, stripe_payment_intent_id)` so a repair
 *     carrying no id never blanks out an id already attached.
 *   - both repairs guard the status with `WHEN status = 'pending'` so a
 *     redelivered `payment_intent.succeeded` — Stripe redelivers for up to
 *     three days — cannot drag a `refunded` or `cancelled` order back to
 *     `paid` and re-trigger fulfilment on an order that was already refunded.
 *   - both repairs use `COALESCE(placed_at, $…)` so `placed_at` keeps the FIRST
 *     payment timestamp. A redelivery must not restate when the sale happened.
 */
export const orderWriteStatements = {
  create: `INSERT INTO orders
    (id, tenant_id, idempotency_key, order_number, user_id, email, status,
     subtotal_minor, shipping_minor, tax_minor, discount_minor, total_minor,
     currency, stripe_payment_intent_id, stripe_checkout_session_id,
     shipping_address, billing_address, placed_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id`,

  readByKey: `SELECT id, idempotency_key, status, stripe_payment_intent_id,
         stripe_checkout_session_id
  FROM orders WHERE tenant_id = $1 AND idempotency_key = $2`,

  readByPaymentIntent: `SELECT id, idempotency_key, status,
         stripe_payment_intent_id, stripe_checkout_session_id
  FROM orders WHERE tenant_id = $1 AND stripe_payment_intent_id = $2`,

  repairByKey: `UPDATE orders
  SET stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
      status = CASE WHEN status = 'pending' THEN $4 ELSE status END,
      placed_at = COALESCE(placed_at, $5),
      updated_at = now()
  WHERE tenant_id = $1 AND idempotency_key = $2
  RETURNING id`,

  repairByPaymentIntent: `UPDATE orders
  SET status = CASE WHEN status = 'pending' THEN $3 ELSE status END,
      placed_at = COALESCE(placed_at, $4),
      updated_at = now()
  WHERE tenant_id = $1 AND stripe_payment_intent_id = $2
  RETURNING id`,
} as const;

/** The columns the protocol decisions read. Everything else is irrelevant here. */
export interface ExistingOrderRow {
  readonly idempotencyKey: string;
  readonly status: OrderStatus;
  readonly stripePaymentIntentId: string | null;
  readonly stripeCheckoutSessionId: string | null;
}

/** Stripe's `checkout.session.payment_status`. */
export type SessionPaymentStatus = "paid" | "unpaid" | "no_payment_required";

export interface SessionWriteInput {
  /** True only if `create` RETURNING gave back a row — i.e. WE inserted it. */
  readonly insertedRow: boolean;
  /** The row `readByKey` found when the insert conflicted. */
  readonly existing: ExistingOrderRow | null;
  /** `session.payment_intent`. NULL is normal for delayed-notification methods. */
  readonly paymentIntentId: string | null;
  readonly paymentStatus: SessionPaymentStatus;
}

export interface PaymentIntentWriteInput {
  readonly paymentIntentId: string;
  /**
   * The row found by `readByPaymentIntent`, or by `readByKey` when the event
   * carries a session id (`checkout.session.async_payment_succeeded`). NULL
   * means no row matched.
   */
  readonly existing: ExistingOrderRow | null;
}

export type OrderWriteOutcome =
  /** We inserted the row. `status` is what it was written with. */
  | { readonly action: "created"; readonly status: OrderStatus }
  /** A row exists and is missing something this event knows. */
  | {
      readonly action: "repair";
      readonly setPaymentIntentId: string | null;
      readonly setStatus: OrderStatus | null;
      readonly stampPlacedAt: boolean;
    }
  /** A row exists and already says everything this event would say. */
  | { readonly action: "duplicate" }
  /**
   * No row, and this event is not allowed to create one. NOT an error: the
   * session event has not landed yet and will create the row already `paid`.
   */
  | { readonly action: "await-session" };

/**
 * `checkout.session.completed`, the only creator.
 *
 * The insert is decisive, exactly as in `decideClaim`: a returned row means
 * this process created it microseconds ago, and any `existing` handed in
 * alongside can only be a stale read.
 *
 * On conflict this is a redelivery of an event we already handled, or the
 * session event arriving after an async repair — so it repairs rather than
 * skipping, because the session carries fields (the PaymentIntent id, the paid
 * status) that a row created by an earlier partial write may still be missing.
 */
export function decideSessionWrite(input: SessionWriteInput): OrderWriteOutcome {
  const status = sessionOrderStatus(input.paymentStatus);

  if (input.insertedRow) return { action: "created", status };

  const existing = input.existing;
  // The insert conflicted but the read came back empty. Not reachable through
  // one transaction; reachable through two connections with the read outside
  // it. Treat it as "someone else owns this key" and do nothing rather than
  // guessing at a repair with no row to compare against.
  if (existing === null) return { action: "duplicate" };

  assertPaymentIntentMatches(existing, input.paymentIntentId);

  const setPaymentIntentId =
    existing.stripePaymentIntentId === null ? input.paymentIntentId : null;
  // Only `pending` moves. A row already `fulfilled` or `refunded` has advanced
  // past this event, and a redelivery must not walk it backwards.
  const setStatus =
    existing.status === "pending" && status !== "pending" ? status : null;

  if (setPaymentIntentId === null && setStatus === null) {
    return { action: "duplicate" };
  }

  return {
    action: "repair",
    setPaymentIntentId,
    setStatus,
    stampPlacedAt: setStatus === "paid",
  };
}

/**
 * `payment_intent.succeeded` and `checkout.session.async_payment_succeeded`.
 * Repairs only — this function has no `created` outcome to return, which is
 * the whole point.
 */
export function decidePaymentIntentWrite(
  input: PaymentIntentWriteInput,
): OrderWriteOutcome {
  const existing = input.existing;
  if (existing === null) return { action: "await-session" };

  assertPaymentIntentMatches(existing, input.paymentIntentId);

  const setPaymentIntentId =
    existing.stripePaymentIntentId === null ? input.paymentIntentId : null;
  const setStatus = existing.status === "pending" ? "paid" : null;

  if (setPaymentIntentId === null && setStatus === null) {
    return { action: "duplicate" };
  }

  return {
    action: "repair",
    setPaymentIntentId,
    setStatus,
    stampPlacedAt: setStatus === "paid",
  };
}

/**
 * `no_payment_required` is a 100%-off coupon or a zero total. The money
 * question is settled, so the order is `paid` — leaving it `pending` would park
 * a completed order in the "chase this customer" queue forever, since no
 * PaymentIntent event is ever coming to move it.
 */
function sessionOrderStatus(paymentStatus: SessionPaymentStatus): OrderStatus {
  return paymentStatus === "unpaid" ? "pending" : "paid";
}

function assertPaymentIntentMatches(
  existing: ExistingOrderRow,
  paymentIntentId: string | null,
): void {
  if (
    paymentIntentId !== null &&
    existing.stripePaymentIntentId !== null &&
    existing.stripePaymentIntentId !== paymentIntentId
  ) {
    throw new OrderPaymentIntentMismatchError(
      existing.idempotencyKey,
      existing.stripePaymentIntentId,
      paymentIntentId,
    );
  }
}

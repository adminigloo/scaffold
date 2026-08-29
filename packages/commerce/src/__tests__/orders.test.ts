import { describe, expect, it } from "vitest";
import {
  checkoutSessionKey,
  decidePaymentIntentWrite,
  decideSessionWrite,
  orderWriteStatements,
  CHECKOUT_SESSION_KEY_PREFIX,
  InvalidOrderIdempotencyKeyError,
  OrderPaymentIntentMismatchError,
} from "../orders.js";
import type { ExistingOrderRow, SessionPaymentStatus } from "../orders.js";
import type { OrderStatus } from "../schema.js";

/**
 * A model of the `orders` table under the statements in ./orders.ts, faithful
 * to the two SQL behaviours the findings turned on: `ON CONFLICT (a, b) DO
 * NOTHING` returns no row on conflict, and a unique index treats NULLs as
 * DISTINCT so it never conflicts on one.
 *
 * The orderings below are what a real Stripe endpoint sees, and they are not
 * reproducible against Postgres in a unit test — so they are reproduced here,
 * where a regression in the protocol fails in milliseconds instead of on a
 * delayed-notification order six months from now.
 */
interface StoredOrder {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  status: OrderStatus;
  stripePaymentIntentId: string | null;
  stripeCheckoutSessionId: string | null;
  placedAt: Date | null;
}

class UniqueViolation extends Error {
  constructor(index: string) {
    super(`duplicate key value violates unique constraint "${index}"`);
  }
}

class OrderStore {
  readonly rows: StoredOrder[] = [];
  private nextId = 1;

  /** `orderWriteStatements.create`: conflict on (tenant_id, idempotency_key). */
  create(input: {
    tenantId: string;
    idempotencyKey: string;
    status: OrderStatus;
    stripePaymentIntentId: string | null;
    stripeCheckoutSessionId: string | null;
    placedAt: Date | null;
  }): StoredOrder | null {
    const conflict = this.rows.some(
      (r) =>
        r.tenantId === input.tenantId &&
        r.idempotencyKey === input.idempotencyKey,
    );
    if (conflict) return null;

    this.assertAssertionIndexes(input.stripePaymentIntentId, null);
    this.assertSessionIndex(input.stripeCheckoutSessionId, null);

    const row: StoredOrder = { id: `ord_${this.nextId++}`, ...input };
    this.rows.push(row);
    return row;
  }

  /**
   * The mechanism this package used to ship: `ON CONFLICT
   * (stripe_payment_intent_id) DO NOTHING`. Kept only so the two findings stay
   * executable — nothing in src/ calls it.
   */
  createLegacy(input: {
    tenantId: string;
    idempotencyKey: string;
    status: OrderStatus;
    stripePaymentIntentId: string | null;
    stripeCheckoutSessionId: string | null;
    placedAt: Date | null;
  }): StoredOrder | null {
    // NULLs are distinct: a NULL payment intent id conflicts with nothing,
    // including another NULL.
    const conflict =
      input.stripePaymentIntentId !== null &&
      this.rows.some(
        (r) => r.stripePaymentIntentId === input.stripePaymentIntentId,
      );
    if (conflict) return null;

    const row: StoredOrder = { id: `ord_${this.nextId++}`, ...input };
    this.rows.push(row);
    return row;
  }

  readByKey(tenantId: string, key: string): ExistingOrderRow | null {
    return (
      this.rows.find(
        (r) => r.tenantId === tenantId && r.idempotencyKey === key,
      ) ?? null
    );
  }

  readByPaymentIntent(
    tenantId: string,
    paymentIntentId: string,
  ): ExistingOrderRow | null {
    return (
      this.rows.find(
        (r) =>
          r.tenantId === tenantId &&
          r.stripePaymentIntentId === paymentIntentId,
      ) ?? null
    );
  }

  /** `repairByKey`: COALESCE on the id and on placed_at, CASE on the status. */
  repairByKey(
    tenantId: string,
    key: string,
    patch: {
      setPaymentIntentId: string | null;
      setStatus: OrderStatus | null;
      placedAt: Date | null;
    },
  ): void {
    const row = this.rows.find(
      (r) => r.tenantId === tenantId && r.idempotencyKey === key,
    );
    if (!row) return;
    this.applyPatch(row, patch);
  }

  repairByPaymentIntent(
    tenantId: string,
    paymentIntentId: string,
    patch: {
      setPaymentIntentId: string | null;
      setStatus: OrderStatus | null;
      placedAt: Date | null;
    },
  ): void {
    const row = this.rows.find(
      (r) =>
        r.tenantId === tenantId && r.stripePaymentIntentId === paymentIntentId,
    );
    if (!row) return;
    this.applyPatch(row, patch);
  }

  private applyPatch(
    row: StoredOrder,
    patch: {
      setPaymentIntentId: string | null;
      setStatus: OrderStatus | null;
      placedAt: Date | null;
    },
  ): void {
    if (patch.setPaymentIntentId !== null) {
      this.assertAssertionIndexes(patch.setPaymentIntentId, row);
      row.stripePaymentIntentId = patch.setPaymentIntentId;
    }
    if (patch.setStatus !== null && row.status === "pending") {
      row.status = patch.setStatus;
    }
    row.placedAt = row.placedAt ?? patch.placedAt;
  }

  /** The partial unique on stripe_payment_intent_id, as an assertion. */
  private assertAssertionIndexes(
    paymentIntentId: string | null,
    self: StoredOrder | null,
  ): void {
    if (paymentIntentId === null) return;
    if (
      this.rows.some(
        (r) => r !== self && r.stripePaymentIntentId === paymentIntentId,
      )
    ) {
      throw new UniqueViolation("orders_stripe_payment_intent_idx");
    }
  }

  private assertSessionIndex(
    sessionId: string | null,
    self: StoredOrder | null,
  ): void {
    if (sessionId === null) return;
    if (
      this.rows.some(
        (r) => r !== self && r.stripeCheckoutSessionId === sessionId,
      )
    ) {
      throw new UniqueViolation("orders_stripe_checkout_session_idx");
    }
  }
}

const TENANT = "tnt_1";
const SESSION = "cs_test_delayed";
const PI = "pi_test_1";
const PAID_AT = new Date("2026-08-28T10:00:00Z");

/** The one creating writer. */
function handleSessionCompleted(
  store: OrderStore,
  event: {
    sessionId: string;
    paymentIntentId: string | null;
    paymentStatus: SessionPaymentStatus;
  },
) {
  const key = checkoutSessionKey(event.sessionId);
  const status: OrderStatus =
    event.paymentStatus === "unpaid" ? "pending" : "paid";

  const inserted = store.create({
    tenantId: TENANT,
    idempotencyKey: key,
    status,
    stripePaymentIntentId: event.paymentIntentId,
    stripeCheckoutSessionId: event.sessionId,
    placedAt: status === "paid" ? PAID_AT : null,
  });

  const outcome = decideSessionWrite({
    insertedRow: inserted !== null,
    existing: inserted === null ? store.readByKey(TENANT, key) : null,
    paymentIntentId: event.paymentIntentId,
    paymentStatus: event.paymentStatus,
  });

  if (outcome.action === "repair") {
    store.repairByKey(TENANT, key, {
      setPaymentIntentId: outcome.setPaymentIntentId,
      setStatus: outcome.setStatus,
      placedAt: outcome.stampPlacedAt ? PAID_AT : null,
    });
  }
  return outcome;
}

/** A repairer. It has no branch that inserts, by construction. */
function handlePaymentIntentSucceeded(
  store: OrderStore,
  paymentIntentId: string,
) {
  const outcome = decidePaymentIntentWrite({
    paymentIntentId,
    existing: store.readByPaymentIntent(TENANT, paymentIntentId),
  });
  if (outcome.action === "repair") {
    store.repairByPaymentIntent(TENANT, paymentIntentId, {
      setPaymentIntentId: outcome.setPaymentIntentId,
      setStatus: outcome.setStatus,
      placedAt: outcome.stampPlacedAt ? PAID_AT : null,
    });
  }
  return outcome;
}

/** The other repairer, and the one delayed notification actually needs. */
function handleAsyncPaymentSucceeded(
  store: OrderStore,
  event: { sessionId: string; paymentIntentId: string },
) {
  const key = checkoutSessionKey(event.sessionId);
  const outcome = decidePaymentIntentWrite({
    paymentIntentId: event.paymentIntentId,
    existing: store.readByKey(TENANT, key),
  });
  if (outcome.action === "repair") {
    store.repairByKey(TENANT, key, {
      setPaymentIntentId: outcome.setPaymentIntentId,
      setStatus: outcome.setStatus,
      placedAt: outcome.stampPlacedAt ? PAID_AT : null,
    });
  }
  return outcome;
}

describe("the old mechanism, so the two findings stay executable", () => {
  it("threw the session id away when the PaymentIntent event won the race", () => {
    // ON CONFLICT (stripe_payment_intent_id) DO NOTHING. The PaymentIntent
    // handler inserts first with no session id, the session event conflicts,
    // DO NOTHING discards it — and the session id is the only handle on the
    // line items, the email and the addresses.
    const store = new OrderStore();
    store.createLegacy({
      tenantId: TENANT,
      idempotencyKey: "irrelevant",
      status: "paid",
      stripePaymentIntentId: PI,
      stripeCheckoutSessionId: null,
      placedAt: PAID_AT,
    });
    const second = store.createLegacy({
      tenantId: TENANT,
      idempotencyKey: "irrelevant",
      status: "paid",
      stripePaymentIntentId: PI,
      stripeCheckoutSessionId: SESSION,
      placedAt: PAID_AT,
    });

    expect(second).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.stripeCheckoutSessionId).toBeNull();
  });

  it("wrote two rows for one order when the payment intent id was NULL", () => {
    // The delayed-notification premise: the session handler writes
    // stripe_payment_intent_id = NULL, NULLs are distinct, the conflict target
    // cannot fire. Charged once, shipped twice.
    const store = new OrderStore();
    store.createLegacy({
      tenantId: TENANT,
      idempotencyKey: "irrelevant",
      status: "pending",
      stripePaymentIntentId: null,
      stripeCheckoutSessionId: SESSION,
      placedAt: null,
    });
    store.createLegacy({
      tenantId: TENANT,
      idempotencyKey: "irrelevant",
      status: "paid",
      stripePaymentIntentId: PI,
      stripeCheckoutSessionId: null,
      placedAt: PAID_AT,
    });

    expect(store.rows).toHaveLength(2);
  });
});

describe("every delivery ordering ends at one complete order", () => {
  it("session first, then payment_intent.succeeded", () => {
    const store = new OrderStore();

    const first = handleSessionCompleted(store, {
      sessionId: SESSION,
      paymentIntentId: PI,
      paymentStatus: "paid",
    });
    const second = handlePaymentIntentSucceeded(store, PI);

    expect(first).toEqual({ action: "created", status: "paid" });
    expect(second.action).toBe("duplicate");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      status: "paid",
      stripePaymentIntentId: PI,
      stripeCheckoutSessionId: SESSION,
      placedAt: PAID_AT,
    });
  });

  it("payment_intent.succeeded first — it waits, it never creates a row", () => {
    // This is the finding-1 regression. The PaymentIntent event carries no
    // session id, so a row created from it can never be completed; the no-op
    // is safe because the session event that follows carries payment_status
    // and creates the row already paid.
    const store = new OrderStore();

    const first = handlePaymentIntentSucceeded(store, PI);
    expect(first).toEqual({ action: "await-session" });
    expect(store.rows).toHaveLength(0);

    const second = handleSessionCompleted(store, {
      sessionId: SESSION,
      paymentIntentId: PI,
      paymentStatus: "paid",
    });

    expect(second).toEqual({ action: "created", status: "paid" });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]?.stripeCheckoutSessionId).toBe(SESSION);
    expect(store.rows[0]?.stripePaymentIntentId).toBe(PI);
  });

  it("both events redelivered — Stripe retries for three days", () => {
    const store = new OrderStore();
    const outcomes = [
      handleSessionCompleted(store, {
        sessionId: SESSION,
        paymentIntentId: PI,
        paymentStatus: "paid",
      }),
      handlePaymentIntentSucceeded(store, PI),
      handleSessionCompleted(store, {
        sessionId: SESSION,
        paymentIntentId: PI,
        paymentStatus: "paid",
      }),
      handlePaymentIntentSucceeded(store, PI),
    ];

    expect(outcomes.map((o) => o.action)).toEqual([
      "created",
      "duplicate",
      "duplicate",
      "duplicate",
    ]);
    expect(store.rows).toHaveLength(1);
  });

  it("delayed notification: the payment intent id is NULL on the first write", () => {
    // This is the finding-2 regression, end to end. SEPA debit: the session
    // completes unpaid with no PaymentIntent id, so the old conflict target
    // could not fire and the later PaymentIntent event inserted a second row.
    const store = new OrderStore();

    const created = handleSessionCompleted(store, {
      sessionId: SESSION,
      paymentIntentId: null,
      paymentStatus: "unpaid",
    });
    expect(created).toEqual({ action: "created", status: "pending" });
    expect(store.rows[0]?.stripePaymentIntentId).toBeNull();

    // Days later. The PaymentIntent event cannot find the row — its id was
    // never written — and must NOT take that as licence to create one.
    const stray = handlePaymentIntentSucceeded(store, PI);
    expect(stray).toEqual({ action: "await-session" });
    expect(store.rows).toHaveLength(1);

    // The event that actually closes the flow carries the session id, so it
    // finds the row by the idempotency key with no PaymentIntent id needed.
    const repaired = handleAsyncPaymentSucceeded(store, {
      sessionId: SESSION,
      paymentIntentId: PI,
    });

    expect(repaired).toEqual({
      action: "repair",
      setPaymentIntentId: PI,
      setStatus: "paid",
      stampPlacedAt: true,
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      status: "paid",
      stripePaymentIntentId: PI,
      stripeCheckoutSessionId: SESSION,
      placedAt: PAID_AT,
    });
  });

  it("delayed notification then a redelivered async repair", () => {
    const store = new OrderStore();
    handleSessionCompleted(store, {
      sessionId: SESSION,
      paymentIntentId: null,
      paymentStatus: "unpaid",
    });
    handleAsyncPaymentSucceeded(store, {
      sessionId: SESSION,
      paymentIntentId: PI,
    });
    const again = handleAsyncPaymentSucceeded(store, {
      sessionId: SESSION,
      paymentIntentId: PI,
    });

    expect(again.action).toBe("duplicate");
    expect(store.rows).toHaveLength(1);
  });
});

describe("decidePaymentIntentWrite", () => {
  const row = (over: Partial<ExistingOrderRow> = {}): ExistingOrderRow => ({
    idempotencyKey: checkoutSessionKey(SESSION),
    status: "pending",
    stripePaymentIntentId: null,
    stripeCheckoutSessionId: SESSION,
    ...over,
  });

  it("has no outcome that creates a row, in any input", () => {
    expect(
      decidePaymentIntentWrite({ paymentIntentId: PI, existing: null }).action,
    ).toBe("await-session");
  });

  it("never drags a refunded order back to paid", () => {
    // Stripe redelivers a succeeded event for up to three days. A refund issued
    // in between must not be undone by a retry, or fulfilment re-triggers on an
    // order whose money has already gone back.
    const outcome = decidePaymentIntentWrite({
      paymentIntentId: PI,
      existing: row({ status: "refunded", stripePaymentIntentId: PI }),
    });
    expect(outcome.action).toBe("duplicate");
  });

  it("attaches the id to a refunded order without touching the status", () => {
    const outcome = decidePaymentIntentWrite({
      paymentIntentId: PI,
      existing: row({ status: "refunded" }),
    });
    expect(outcome).toEqual({
      action: "repair",
      setPaymentIntentId: PI,
      setStatus: null,
      stampPlacedAt: false,
    });
  });

  it("refuses a second PaymentIntent on one order instead of overwriting", () => {
    // Two PaymentIntents on one row is a duplicate charge or a mis-keyed
    // repair. Overwriting destroys the record of which charge to refund.
    expect(() =>
      decidePaymentIntentWrite({
        paymentIntentId: "pi_other",
        existing: row({ status: "paid", stripePaymentIntentId: PI }),
      }),
    ).toThrow(OrderPaymentIntentMismatchError);
  });
});

describe("decideSessionWrite", () => {
  it("writes a zero-total order as paid, not pending", () => {
    // no_payment_required is a 100%-off coupon. No PaymentIntent event is ever
    // coming, so left pending the order sits in the chase queue forever.
    expect(
      decideSessionWrite({
        insertedRow: true,
        existing: null,
        paymentIntentId: null,
        paymentStatus: "no_payment_required",
      }),
    ).toEqual({ action: "created", status: "paid" });
  });

  it("trusts its own insert over any row read alongside it", () => {
    expect(
      decideSessionWrite({
        insertedRow: true,
        existing: {
          idempotencyKey: checkoutSessionKey(SESSION),
          status: "refunded",
          stripePaymentIntentId: "pi_stale",
          stripeCheckoutSessionId: SESSION,
        },
        paymentIntentId: PI,
        paymentStatus: "paid",
      }),
    ).toEqual({ action: "created", status: "paid" });
  });

  it("repairs a pending row created by an earlier partial write", () => {
    expect(
      decideSessionWrite({
        insertedRow: false,
        existing: {
          idempotencyKey: checkoutSessionKey(SESSION),
          status: "pending",
          stripePaymentIntentId: null,
          stripeCheckoutSessionId: SESSION,
        },
        paymentIntentId: PI,
        paymentStatus: "paid",
      }),
    ).toEqual({
      action: "repair",
      setPaymentIntentId: PI,
      setStatus: "paid",
      stampPlacedAt: true,
    });
  });
});

describe("checkoutSessionKey", () => {
  it("namespaces the key so a caller-chosen key cannot hijack a session", () => {
    expect(checkoutSessionKey(SESSION)).toBe(
      `${CHECKOUT_SESSION_KEY_PREFIX}${SESSION}`,
    );
  });

  it("refuses an empty id rather than keying every order to one row", () => {
    expect(() => checkoutSessionKey("   ")).toThrow(
      InvalidOrderIdempotencyKeyError,
    );
  });
});

describe("orderWriteStatements", () => {
  it("conflicts on the NOT NULL pair, never on the payment intent id", () => {
    // The payment intent id is NULL for delayed-notification methods and
    // Postgres treats NULLs as distinct, so a conflict target naming it cannot
    // fire in the one case the mechanism exists for.
    expect(orderWriteStatements.create).toContain(
      "ON CONFLICT (tenant_id, idempotency_key) DO NOTHING",
    );
    expect(orderWriteStatements.create).not.toMatch(
      /ON CONFLICT\s*\(\s*stripe_payment_intent_id/,
    );
    expect(orderWriteStatements.create).toMatch(/RETURNING id/);
  });

  it("is the only statement that inserts", () => {
    const others = [
      orderWriteStatements.readByKey,
      orderWriteStatements.readByPaymentIntent,
      orderWriteStatements.repairByKey,
      orderWriteStatements.repairByPaymentIntent,
    ];
    for (const sql of others) expect(sql).not.toMatch(/INSERT/);
  });

  it("guards the status so a redelivery cannot un-refund an order", () => {
    expect(orderWriteStatements.repairByKey).toMatch(
      /CASE WHEN status = 'pending'/,
    );
    expect(orderWriteStatements.repairByPaymentIntent).toMatch(
      /CASE WHEN status = 'pending'/,
    );
  });

  it("never blanks an attached payment intent id or restates placed_at", () => {
    expect(orderWriteStatements.repairByKey).toContain(
      "COALESCE($3, stripe_payment_intent_id)",
    );
    expect(orderWriteStatements.repairByKey).toMatch(
      /placed_at = COALESCE\(placed_at, \$5\)/,
    );
    expect(orderWriteStatements.repairByPaymentIntent).toMatch(
      /placed_at = COALESCE\(placed_at, \$4\)/,
    );
  });
});

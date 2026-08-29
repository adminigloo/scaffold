import { createHmac } from "node:crypto";
import type Stripe from "stripe";
import {
  decideClaim,
  tenantIdFromEvent,
  DEFAULT_CLAIM_LEASE_MS,
  STRIPE_API_VERSION,
  type ClaimOutcome,
} from "@adminigloo/stripe";
import { deterministicId, fixedTime } from "./deterministic.js";

export interface StripeEventFixtureOverrides {
  readonly id?: string;
  /** Epoch SECONDS, as Stripe sends it. */
  readonly created?: number;
  /**
   * Defaults to false. A live-mode fixture would trip `assertEventLivemode` in
   * every non-production test, so the only reason to set this is to assert that
   * it trips.
   */
  readonly livemode?: boolean;
  readonly apiVersion?: string;
  readonly pendingWebhooks?: number;
  /** The resource under `data.object`. Replaces the default wholesale. */
  readonly object?: Record<string, unknown>;
  /**
   * Stamps `data.object.metadata.tenantId`, which is the ONLY place
   * `tenantIdFromEvent` looks — Stripe knows nothing about our tenants, so a
   * fixture that puts the tenant anywhere else ledgers as tenant-less and the
   * test proves nothing about the query that reads by tenant.
   */
  readonly tenantId?: string;
  /** Distinguishes several events in one test. Same seed, same event id. */
  readonly seed?: number;
}

/**
 * A structurally valid `Stripe.Event`.
 *
 * Hand-built and cast, exactly as @adminigloo/stripe's own tests do it:
 * `Stripe.Event` is a discriminated union with a member per event type, and
 * constructing a genuine one for a fixture would mean naming the full resource
 * shape of whichever type the test happens to use. What is under test is the
 * ledger, the registry and the route — none of which read more than `id`,
 * `type`, `livemode` and `data.object`.
 *
 * The id is derived from `type` and `seed`, not random: an assertion that fails
 * on `evt_1a2b3c` needs to be reproducible from the log, and two fixtures of
 * the same type in one test need different ids or the second silently reads as
 * a redelivery of the first.
 */
export function stripeEventFixture(
  type: string,
  overrides: StripeEventFixtureOverrides = {},
): Stripe.Event {
  const seed = overrides.seed ?? 0;
  const object: Record<string, unknown> = {
    ...(overrides.object ?? defaultObject(seed)),
  };

  if (overrides.tenantId !== undefined) {
    const metadata = object["metadata"];
    object["metadata"] = {
      ...(typeof metadata === "object" && metadata !== null ? metadata : {}),
      tenantId: overrides.tenantId,
    };
  }

  return {
    id: overrides.id ?? eventId(type, seed),
    object: "event",
    // Pinned to the same literal the client pins, so a fixture cannot claim an
    // API version the app never asked Stripe for.
    api_version: overrides.apiVersion ?? STRIPE_API_VERSION,
    created: overrides.created ?? Math.floor(fixedTime().getTime() / 1000),
    livemode: overrides.livemode ?? false,
    pending_webhooks: overrides.pendingWebhooks ?? 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

function eventId(type: string, seed: number): string {
  return `evt_${deterministicId(`event:${type}`, seed).replace(/-/g, "")}`;
}

function defaultObject(seed: number): Record<string, unknown> {
  return {
    id: `cs_test_${deterministicId("stripe-object", seed).replace(/-/g, "").slice(0, 20)}`,
    object: "checkout.session",
    amount_total: 2000,
    currency: "usd",
    metadata: {},
  };
}

/**
 * The `stripe-signature` header Stripe would have sent for this body.
 *
 * Real HMAC-SHA256 over `${timestamp}.${body}`, hex, in Stripe's
 * `t=…,v1=…` format — so a webhook test goes THROUGH `verifyStripeSignature`
 * instead of around it. A test that stubs verification asserts the handler
 * works on input the handler never receives, and leaves the two failures that
 * actually happen unexercised: a route that parsed the body before verifying,
 * and a secret from the wrong endpoint.
 *
 * The secret is used verbatim, `whsec_` prefix included, because that is what
 * stripe-node HMACs with. Stripping the prefix — which several guides show,
 * confusing Stripe's scheme with svix's — produces a header that verifies
 * nowhere and an error message that says only "no signatures found".
 *
 * `body` must be the SAME string handed to the route. Re-serialising the object
 * between signing and verifying changes key order and number formatting, and
 * the resulting failure is indistinguishable from a forged request.
 */
export function signStripePayload(
  body: string,
  secret: string,
  timestamp: Date = new Date(),
): string {
  const seconds = Math.floor(timestamp.getTime() / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${seconds}.${body}`, "utf8")
    .digest("hex");
  return `t=${seconds},v1=${signature}`;
}

export type IdempotentHandler = (event: Stripe.Event) => unknown;

export interface ExpectIdempotentOptions {
  /**
   * Reads the running count of side effects — orders created, emails queued,
   * credits granted. Whatever the handler is supposed to do exactly once.
   *
   * Omit it and the probe can only observe throws, which is a far weaker
   * property: "the redelivery did not fail" passes cleanly for a handler that
   * writes a second order every single time. Inject the counter.
   */
  readonly sideEffects?: () => number;
  /** Deliveries to fire. Two is what Stripe does; more exercises a retry storm. */
  readonly deliveries?: number;
  /** Side effects the whole sequence may produce. Almost always 1. */
  readonly expected?: number;
}

export interface IdempotencyReport {
  readonly deliveries: number;
  readonly before: number | null;
  readonly after: number | null;
  readonly effects: number | null;
  /** One entry per delivery; `null` where that delivery returned normally. */
  readonly errors: readonly unknown[];
}

export class IdempotencyViolationError extends Error {
  readonly name = "IdempotencyViolationError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * Deliver the same event twice and insist on one side effect.
 *
 * This is the test both source repos were missing. riddler-go tracks seen
 * events in a process-local `Set`, which is empty on every cold serverless
 * instance — two deliveries landing on two instances both do the work, and the
 * route answers 200 each time so nothing retries and nothing complains.
 * trailcards has no ledger at all and lets `checkout.session.completed` and
 * `payment_intent.succeeded` both create the order, cross-checking each other.
 * Neither bug is visible in a single-delivery test, and both are caught by the
 * five lines below.
 *
 * Throws its own error rather than calling vitest's `expect`, so the helper
 * works unchanged under vitest, node:test and a plain script — importing
 * `expect` here would make a test runner a runtime dependency of a package that
 * ships to projects that may not use it.
 */
export async function expectIdempotent(
  handler: IdempotentHandler,
  event: Stripe.Event,
  options: ExpectIdempotentOptions = {},
): Promise<IdempotencyReport> {
  const deliveries = options.deliveries ?? 2;
  const expected = options.expected ?? 1;
  const count = options.sideEffects;
  const before = count ? count() : null;
  const errors: unknown[] = [];

  for (let delivery = 1; delivery <= deliveries; delivery += 1) {
    try {
      await handler(event);
      errors.push(null);
    } catch (error) {
      errors.push(error);
    }
  }

  const after = count ? count() : null;
  const effects = before === null || after === null ? null : after - before;
  const report: IdempotencyReport = { deliveries, before, after, effects, errors };
  const label = `${event.type} (${event.id})`;

  const firstError = errors[0];
  if (firstError !== null && firstError !== undefined) {
    throw new IdempotencyViolationError(
      `expectIdempotent: the FIRST delivery of ${label} threw ${describe(firstError)}. ` +
        `Nothing about idempotency was tested — the handler cannot process this ` +
        `event at all.`,
    );
  }

  const laterError = errors.slice(1).find((error) => error !== null);
  if (laterError !== undefined && laterError !== null) {
    throw new IdempotencyViolationError(
      `expectIdempotent: ${label} was delivered ${deliveries} times; delivery 1 ` +
        `succeeded and a redelivery threw ${describe(laterError)}. A duplicate must ` +
        `answer 200, not 500: Stripe reads a 500 as "try again" and keeps ` +
        `redelivering for three days before disabling the endpoint.`,
    );
  }

  if (effects === null) {
    // No counter injected. The weak form passed; say so rather than implying a
    // guarantee this call cannot make.
    return report;
  }

  if (effects !== expected) {
    throw new IdempotencyViolationError(
      `expectIdempotent: ${label} was delivered ${deliveries} times and the ` +
        `side-effect counter went ${before} -> ${after}, i.e. ${effects} effect(s) ` +
        `where ${expected} was expected. ` +
        (effects > expected
          ? `A redelivery did work the first delivery had already done. The ledger ` +
            `claim is missing, is checked after the write instead of before, or the ` +
            `handler is keyed on something that is not the Stripe event id.`
          : `The handler skipped work it should have done — a duplicate check that ` +
            `matched on the FIRST delivery, which drops the event entirely because ` +
            `the route still answers 200 and Stripe never retries.`),
    );
  }

  return report;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `a non-Error value (${String(error)})`;
}

export interface FakeLedgerRow {
  readonly eventId: string;
  readonly type: string;
  readonly tenantId: string | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly claimedAt: Date | null;
  readonly attempts: number;
  readonly lastError: string | null;
}

export interface FakeLedgerClaimOptions {
  /** Injected so the lease boundary is testable without faking the clock. */
  readonly now?: Date;
  readonly leaseMs?: number;
}

export interface FakeLedger {
  /** The `insert … ON CONFLICT DO NOTHING` + `decideClaim` sequence, in memory. */
  claim(event: Stripe.Event, options?: FakeLedgerClaimOptions): ClaimOutcome;
  /** `claimStatements.markProcessed`. Call it only after the handler succeeded. */
  markProcessed(eventId: string, options?: { readonly now?: Date }): void;
  /** `claimStatements.release`. Call it when the handler throws. */
  release(eventId: string, error: unknown): void;
  row(eventId: string): FakeLedgerRow | undefined;
  rows(): readonly FakeLedgerRow[];
}

export class UnknownLedgerRowError extends Error {
  readonly name = "UnknownLedgerRowError";
  constructor(operation: string, eventId: string) {
    super(
      `fakeLedger.${operation}("${eventId}") — no such row. The route marked an ` +
        `event id it never claimed, which against Postgres would be an UPDATE ` +
        `matching zero rows: no error, no side effect, and a test that passes ` +
        `while the real ledger stays unfinished.`,
    );
  }
}

/**
 * The claim protocol, in memory.
 *
 * Delegates every decision to `decideClaim`, so the lease, the takeover of an
 * abandoned claim and the clock-skew guard behave exactly as they do against
 * Postgres. A double that reimplemented the branching would be a second,
 * untested copy of the one piece of this system where being wrong costs a
 * customer a duplicated charge — and it would drift the first time the real
 * rule changed.
 *
 * What it does NOT model is concurrency: it is a `Map`, so two "simultaneous"
 * claims are two sequential calls. That is the correct trade. The atomicity is
 * `ON CONFLICT DO NOTHING`'s job and belongs to an integration test against a
 * real database; what belongs here is the route's decision tree, which needs no
 * Postgres to be wrong.
 */
export function fakeLedger(): FakeLedger {
  const rows = new Map<string, FakeLedgerRow>();

  const mustFind = (operation: string, eventId: string): FakeLedgerRow => {
    const row = rows.get(eventId);
    if (!row) throw new UnknownLedgerRowError(operation, eventId);
    return row;
  };

  return {
    claim(event, options = {}) {
      const now = options.now ?? new Date();
      const leaseMs = options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
      const existing = rows.get(event.id);

      if (!existing) {
        rows.set(event.id, {
          eventId: event.id,
          type: event.type,
          tenantId: tenantIdFromEvent(event),
          receivedAt: now,
          processedAt: null,
          claimedAt: now,
          attempts: 1,
          lastError: null,
        });
        return decideClaim({ insertedRow: true, existingProcessedAt: null, now, leaseMs });
      }

      const outcome = decideClaim({
        insertedRow: false,
        existingProcessedAt: existing.processedAt,
        existingClaimedAt: existing.claimedAt,
        now,
        leaseMs,
      });

      // The takeover write, with `claimStatements.reclaim`'s guard kept in
      // place. Redundant in a single-threaded Map and deliberately still here:
      // an integration test and a unit test that disagree about whether a
      // finished row can be re-claimed would send someone hunting the
      // difference in the wrong layer.
      const takeover = outcome.action === "process" && outcome.reclaimed;
      if (takeover && existing.processedAt === null) {
        rows.set(event.id, {
          ...existing,
          claimedAt: now,
          attempts: existing.attempts + 1,
        });
      }

      return outcome;
    },

    markProcessed(eventId, options = {}) {
      const row = mustFind("markProcessed", eventId);
      rows.set(eventId, {
        ...row,
        processedAt: options.now ?? new Date(),
        claimedAt: null,
        lastError: null,
      });
    },

    release(eventId, error) {
      const row = mustFind("release", eventId);
      // `claimed_at = NULL`, so the next delivery re-claims immediately rather
      // than waiting out a lease that only exists for processes that died.
      rows.set(eventId, {
        ...row,
        claimedAt: null,
        lastError: error instanceof Error ? error.message : String(error),
      });
    },

    row: (eventId) => rows.get(eventId),
    rows: () => [...rows.values()],
  };
}

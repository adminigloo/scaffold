import type Stripe from "stripe";

/**
 * What the route should do with this delivery.
 *
 * The three outcomes are distinct on purpose, and the HTTP status attached to
 * each is the whole point:
 *
 *   process         we claimed the row — run the handler
 *   skip-duplicate  `processed_at` is set, the work is already done  -> 200
 *   retry-later     someone else claimed it and has not finished yet -> 500
 *
 * `retry-later` MUST NOT answer 200. riddler-go's route returns 200 on every
 * path it does not understand, which tells Stripe the delivery succeeded and
 * stops the retry schedule. A 500 is not a failure to be avoided here; it is
 * how you ask Stripe to deliver the event again in a few seconds, once the
 * instance that owns the row has either finished or died.
 */
/**
 * How long a claim is honoured before another delivery may take the row.
 *
 * Sized against the platform's function timeout, not the handler's expected
 * duration: the case this covers is a process that DIED mid-handler and will
 * never release its claim. Shorter than the timeout and two instances can run
 * the same handler concurrently; much longer and a crashed handler stalls
 * until Stripe has nearly given up.
 */
export const DEFAULT_CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * What the route should do with this delivery.
 *
 *   process         we own the row — run the handler
 *   skip-duplicate  `processed_at` is set, the work is done       -> 200
 *   retry-later     someone else owns it and is still running     -> 500
 *
 * `retry-later` MUST NOT answer 200. riddler-go's route returns 200 on every
 * path it does not understand, which tells Stripe the delivery succeeded and
 * stops the retry schedule. A 500 is not a failure to be avoided here; it is
 * how you ask Stripe to deliver the event again in a few seconds.
 *
 * `reclaimed` distinguishes a fresh claim from taking over an abandoned one.
 * The route needs it because the two are different writes: a fresh claim was
 * already made by the INSERT, whereas a takeover has to stamp `claimed_at`
 * and bump `attempts` itself.
 */
export type ClaimOutcome =
  | { readonly action: "process"; readonly reclaimed: boolean }
  | { readonly action: "skip-duplicate" }
  | { readonly action: "retry-later" };

export interface ClaimInput {
  /**
   * Did OUR insert create the row? True when the claiming statement returned a
   * row, false when the conflict clause swallowed it.
   */
  readonly insertedRow: boolean;
  /**
   * `processed_at` of the row that was already there, if any.
   *
   * Accepts a string as well as a Date. Reading this column through a raw
   * `db.execute` — which is exactly what `claimStatements.readExisting` is for
   * — returns the timestamptz as a STRING, because Drizzle installs an identity
   * type parser. The typed `select()` path returns a Date. Rows from `execute`
   * are untyped, so TypeScript cannot catch the difference at any call site and
   * a unit test that builds its own Dates never sees it.
   */
  readonly existingProcessedAt: Date | string | null;
  /**
   * `claimed_at` of the row that was already there. NULL means unclaimed —
   * either never claimed, or a previous handler threw and released it.
   */
  readonly existingClaimedAt?: Date | string | null;
  /** Injected so the lease boundary is testable without faking the clock. */
  readonly now?: Date;
  readonly leaseMs?: number;
}

/**
 * Decide what to do with a delivery, given the result of the claim statement.
 *
 * The SQL this models — one statement, no read-then-write:
 *
 *   INSERT INTO stripe_events
 *     (event_id, type, tenant_id, payload, claimed_at, attempts)
 *   VALUES ($1, $2, $3, $4, now(), 1)
 *   ON CONFLICT (event_id) DO NOTHING
 *   RETURNING event_id
 *   -- a returned row means WE claimed it. No in-process memory, no race.
 *
 * Then, only if nothing came back, read the existing row's `processed_at` and
 * `claimed_at` to tell "already done" from "in flight" from "abandoned".
 *
 * Kept pure so the branch that decides whether Stripe retries is unit-testable
 * with no database, rather than buried in a transaction callback nobody reads.
 */
/**
 * Timestamps arrive as a Date from `select()` and as a string from `execute()`.
 * Normalising here rather than at each call site is the difference between one
 * conversion and a crash inside a webhook retry — `claimedAt.getTime is not a
 * function`, on the path that only runs when something has already gone wrong.
 */
function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function decideClaim(input: ClaimInput): ClaimOutcome {
  // The insert is decisive. If the statement returned a row, this instance
  // created it microseconds ago and owns it — any `existingProcessedAt` handed
  // in alongside can only have come from a stale read, and trusting it would
  // skip a genuinely new event. Dropping a payment beats reprocessing one only
  // if you never have to explain it to the customer.
  if (input.insertedRow) return { action: "process", reclaimed: false };

  // Somebody got there first, and finished.
  if (asDate(input.existingProcessedAt) !== null) return { action: "skip-duplicate" };

  // Unfinished. Whether we may take it over depends entirely on the claim.
  const claimedAt = asDate(input.existingClaimedAt);

  // Released by a handler that threw, or never claimed at all. Take it.
  if (claimedAt === null) return { action: "process", reclaimed: true };

  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const age = now.getTime() - claimedAt.getTime();

  // A claim from the future is a clock skew between instances, not a licence
  // to run the handler twice. Treat it as fresh and let Stripe redeliver.
  if (age < 0) return { action: "retry-later" };

  // Older than the lease means the owner cannot still be running: the platform
  // would have killed it. Anything else is genuinely concurrent.
  return age >= leaseMs
    ? { action: "process", reclaimed: true }
    : { action: "retry-later" };
}

/**
 * The four statements the protocol needs, as text.
 *
 * Shipped as SQL rather than as functions taking a `db` handle because the
 * ordering and the exact `WHERE` clauses are the correctness-bearing part, and
 * a route that inlines its own version silently drops them. `$1` is always the
 * event id.
 *
 * The guards are not decoration:
 *   - `reclaim` carries `processed_at IS NULL` so a takeover loses the race to
 *     an owner who finished between our read and our write, instead of
 *     re-running a completed handler.
 *   - `markProcessed` is unconditional: by the time it runs the handler has
 *     succeeded, and refusing to record that would be strictly worse.
 *   - `release` sets `claimed_at = NULL` so the very next delivery re-claims
 *     without waiting out the lease. The lease exists for processes that died
 *     and never got here.
 */
export const claimStatements = {
  insert: `INSERT INTO stripe_events
    (event_id, type, tenant_id, payload, claimed_at, attempts)
  VALUES ($1, $2, $3, $4, now(), 1)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id`,

  readExisting: `SELECT processed_at, claimed_at
  FROM stripe_events WHERE event_id = $1`,

  reclaim: `UPDATE stripe_events
  SET claimed_at = now(), attempts = attempts + 1
  WHERE event_id = $1 AND processed_at IS NULL
  RETURNING event_id`,

  markProcessed: `UPDATE stripe_events
  SET processed_at = now(), claimed_at = NULL, last_error = NULL
  WHERE event_id = $1`,

  release: `UPDATE stripe_events
  SET claimed_at = NULL, last_error = $2
  WHERE event_id = $1`,
} as const;

/**
 * Which tenant an event belongs to, for the ledger's `tenant_id` column.
 *
 * Stripe has no concept of our tenants, so the only source is metadata we put
 * there ourselves at session creation — which is exactly why
 * `withTenantMetadata` copies it onto the PaymentIntent as well as the Session.
 * `payment_intent.succeeded` carries the PaymentIntent's metadata, and a
 * Session's metadata does NOT propagate to the PaymentIntent it creates.
 *
 * Returns null rather than throwing: account-level events (`payout.paid`,
 * `charge.dispute.created`) legitimately have no tenant, and refusing to ledger
 * them would leave the deliveries we most want an audit trail for unrecorded.
 */
export function tenantIdFromEvent(event: Stripe.Event): string | null {
  // `event.data.object` is a union of every Stripe resource, most but not all
  // of which carry `metadata`. Narrowing through `unknown` rather than reading
  // the property off the union keeps this honest without an `any`.
  const object: unknown = event.data.object;
  if (typeof object !== "object" || object === null) return null;

  const metadata = (object as { readonly metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return null;

  const tenantId = (metadata as { readonly tenantId?: unknown }).tenantId;
  return typeof tenantId === "string" && tenantId.length > 0 ? tenantId : null;
}

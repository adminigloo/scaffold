import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  decideClaim,
  tenantIdFromEvent,
  claimStatements,
  DEFAULT_CLAIM_LEASE_MS,
} from "../ledger.js";

const PROCESSED = new Date("2026-08-28T10:00:00Z");

describe("decideClaim — the full truth table", () => {
  it("our insert won and nothing was there: process it", () => {
    expect(decideClaim({ insertedRow: true, existingProcessedAt: null })).toEqual({
      action: "process",
      reclaimed: false,
    });
  });

  it("our insert won: processes even if a stale read reported processed_at", () => {
    // Contradictory input, and the insert is authoritative. This is the case
    // riddler-go's process-local Set gets wrong in the other direction: it
    // answers "already seen" on a cold instance's FIRST delivery and drops the
    // event for good, because the route still returns 200.
    expect(
      decideClaim({ insertedRow: true, existingProcessedAt: PROCESSED }),
    ).toEqual({ action: "process", reclaimed: false });
  });

  it("row existed and is finished: duplicate, answer 200", () => {
    expect(
      decideClaim({ insertedRow: false, existingProcessedAt: PROCESSED }),
    ).toEqual({ action: "skip-duplicate" });
  });

  it("row existed, unfinished, and someone is actively working it: retry-later", () => {
    // An ACTIVE claim is what makes this defer. Deferring on the mere absence
    // of processed_at is the wedge: the row would never be worked again, since
    // no later delivery could tell a live owner from a dead one.
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: new Date(Date.now() - 1_000),
      }),
    ).toEqual({ action: "retry-later" });
  });

  it("row existed, unfinished, and unclaimed: process it", () => {
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: null,
      }),
    ).toEqual({ action: "process", reclaimed: true });
  });

  it("never returns skip-duplicate for an unfinished row", () => {
    // The single most expensive mistake this function can make: treating a
    // crashed handler's row as done means the work never happens and no retry
    // is ever requested.
    for (const insertedRow of [true, false]) {
      const outcome = decideClaim({ insertedRow, existingProcessedAt: null });
      expect(outcome.action).not.toBe("skip-duplicate");
    }
  });
});

function eventWithObject(
  object: unknown,
  type = "payment_intent.succeeded",
): Stripe.Event {
  // A hand-built event: `Stripe.Event` is a 250-member discriminated union and
  // constructing a real one adds nothing to what is being tested here.
  return {
    id: "evt_test_1",
    object: "event",
    api_version: "2026-08-26.dahlia",
    created: 1_756_382_400,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
    data: { object },
  } as unknown as Stripe.Event;
}

describe("tenantIdFromEvent", () => {
  it("reads the tenant we stamped at session creation", () => {
    expect(tenantIdFromEvent(eventWithObject({ metadata: { tenantId: "t_42" } }))).toBe(
      "t_42",
    );
  });

  it("returns null for an account-level event with no metadata", () => {
    expect(tenantIdFromEvent(eventWithObject({ id: "po_1" }, "payout.paid"))).toBeNull();
  });

  it("returns null when metadata exists but carries no tenant", () => {
    const event = eventWithObject({ metadata: { cartId: "c_1" } });
    expect(tenantIdFromEvent(event)).toBeNull();
  });

  it("treats an empty tenant id as absent rather than as a tenant named ''", () => {
    expect(tenantIdFromEvent(eventWithObject({ metadata: { tenantId: "" } }))).toBeNull();
  });

  it("rejects a non-string tenant id instead of coercing it", () => {
    expect(tenantIdFromEvent(eventWithObject({ metadata: { tenantId: 42 } }))).toBeNull();
  });

  it("survives an object shape it has never seen", () => {
    expect(tenantIdFromEvent(eventWithObject(null))).toBeNull();
    expect(tenantIdFromEvent(eventWithObject("a string"))).toBeNull();
    expect(tenantIdFromEvent(eventWithObject({ metadata: "not an object" }))).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// Regression suite for the wedge.
//
// Without a claim lease the ledger deadlocks the first time a handler throws:
// the row exists with processed_at NULL forever, every retry reads
// insertedRow=false + processedAt=null, defers, and the handler is never
// invoked again. Stripe retries for ~3 days then disables the endpoint,
// taking every other event type down with it — the ledger reintroducing the
// exact silent loss it exists to prevent.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("decideClaim — abandoned claims", () => {
  it("takes over a claim released by a handler that threw", () => {
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: null,
        now: NOW,
      }),
    ).toEqual({ action: "process", reclaimed: true });
  });

  it("defers to an owner whose claim is still inside the lease", () => {
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: ago(DEFAULT_CLAIM_LEASE_MS - 1000),
        now: NOW,
      }),
    ).toEqual({ action: "retry-later" });
  });

  it("takes over a claim older than the lease — the crashed-instance case", () => {
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: ago(DEFAULT_CLAIM_LEASE_MS + 1000),
        now: NOW,
      }),
    ).toEqual({ action: "process", reclaimed: true });
  });

  it("treats the lease boundary itself as expired", () => {
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: ago(DEFAULT_CLAIM_LEASE_MS),
        now: NOW,
      }),
    ).toEqual({ action: "process", reclaimed: true });
  });

  it("honours a caller-supplied lease", () => {
    const input = {
      insertedRow: false as const,
      existingProcessedAt: null,
      existingClaimedAt: ago(10_000),
      now: NOW,
    };
    expect(decideClaim({ ...input, leaseMs: 5_000 })).toEqual({
      action: "process",
      reclaimed: true,
    });
    expect(decideClaim({ ...input, leaseMs: 30_000 })).toEqual({
      action: "retry-later",
    });
  });

  it("does not run the handler twice when clocks skew forward", () => {
    // A claim stamped in the future means another instance's clock is ahead,
    // not that the claim is ancient. Deferring costs one redelivery; the other
    // reading runs a paid-event handler concurrently with its owner.
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: new Date(NOW.getTime() + 60_000),
        now: NOW,
      }),
    ).toEqual({ action: "retry-later" });
  });

  it("a finished row is a duplicate no matter how stale its claim looks", () => {
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: PROCESSED,
        existingClaimedAt: ago(DEFAULT_CLAIM_LEASE_MS * 100),
        now: NOW,
      }),
    ).toEqual({ action: "skip-duplicate" });
  });

  it("survives the full failure-then-recovery sequence", () => {
    // 1. First delivery claims the row.
    expect(
      decideClaim({ insertedRow: true, existingProcessedAt: null, now: NOW }),
    ).toEqual({ action: "process", reclaimed: false });

    // 2. Handler throws. The route runs `release`, so claimed_at is NULL.
    // 3. Stripe redelivers seconds later — and it must PROCESS, not defer.
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: null,
        now: new Date(NOW.getTime() + 5_000),
      }),
    ).toEqual({ action: "process", reclaimed: true });

    // 4. Handler succeeds, `markProcessed` runs. Any further delivery is a
    //    duplicate.
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: new Date(NOW.getTime() + 6_000),
        existingClaimedAt: null,
        now: new Date(NOW.getTime() + 60_000),
      }),
    ).toEqual({ action: "skip-duplicate" });
  });
});

describe("claimStatements", () => {
  it("guards the takeover against an owner who finished mid-read", () => {
    expect(claimStatements.reclaim).toMatch(/processed_at IS NULL/);
  });

  it("releases the claim on failure so the next delivery re-claims at once", () => {
    expect(claimStatements.release).toMatch(/claimed_at = NULL/);
    expect(claimStatements.release).toMatch(/last_error = \$2/);
  });

  it("counts every attempt, so a stuck row is visible", () => {
    expect(claimStatements.insert).toMatch(/attempts/);
    expect(claimStatements.reclaim).toMatch(/attempts = attempts \+ 1/);
  });

  it("clears the claim when marking processed, leaving no phantom owner", () => {
    expect(claimStatements.markProcessed).toMatch(/processed_at = now\(\)/);
    expect(claimStatements.markProcessed).toMatch(/claimed_at = NULL/);
  });

  it("claims atomically on insert rather than reading then writing", () => {
    expect(claimStatements.insert).toMatch(/ON CONFLICT \(event_id\) DO NOTHING/);
    expect(claimStatements.insert).toMatch(/RETURNING event_id/);
  });
});

describe("timestamps as the driver actually returns them", () => {
  // `claimStatements.readExisting` is documented as the canonical way to read
  // these columns, and a raw execute returns timestamptz as a STRING because
  // Drizzle installs an identity type parser. The typed select() path returns a
  // Date. Passing the string used to crash with "claimedAt.getTime is not a
  // function" — inside a webhook, on the retry path, which only runs when
  // something has already failed once.
  const PG_STRING = "2026-08-28 12:00:00.123456+00";

  it("treats a string processed_at as processed", () => {
    expect(
      decideClaim({ insertedRow: false, existingProcessedAt: PG_STRING }),
    ).toEqual({ action: "skip-duplicate" });
  });

  it("does not throw on a string claimed_at", () => {
    expect(() =>
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: PG_STRING,
        now: new Date("2026-08-28T12:00:30Z"),
      }),
    ).not.toThrow();
  });

  it("applies the lease to a string claim exactly as to a Date", () => {
    const now = new Date("2026-08-28T13:00:00Z");
    const stale = "2026-08-28 12:00:00+00";
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: stale,
        now,
      }),
    ).toEqual({ action: "process", reclaimed: true });
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: new Date(stale),
        now,
      }),
    ).toEqual({ action: "process", reclaimed: true });
  });

  it("treats an unparseable timestamp as absent rather than crashing", () => {
    expect(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: null,
        existingClaimedAt: "not a timestamp",
      }),
    ).toEqual({ action: "process", reclaimed: true });
  });
});

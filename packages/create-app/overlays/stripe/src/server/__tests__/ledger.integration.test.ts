import { expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import {
  claimStatements,
  decideClaim,
  DEFAULT_CLAIM_LEASE_MS,
  type ClaimOutcome,
} from "__SCOPE__/stripe";
import { stripeEvents } from "__SCOPE__/stripe/schema";
import {
  db,
  describeIntegration,
  pgErrorCode,
  withRollback,
  type AppTransaction,
} from "@/test/db";

/**
 * The Stripe claim protocol, against the real `stripe_events` table.
 *
 * No mock of "@/db" here, and none needed: nothing under test reads the app's
 * handle. `claimStatements` is exported SQL text and `decideClaim` is a pure
 * function, so every statement below is issued by the test on the transaction
 * it is asserting about.
 *
 * The unit suite drives `decideClaim` against @__SCOPE_NAME__/testing's
 * `fakeLedger`, which returns whatever the fake was told to return. That proves
 * the branching and nothing about the SQL, and the two have never been run
 * against each other. Where they disagree, the disagreement is recorded here
 * rather than smoothed over — see "what the SQL actually returns" below.
 */

/**
 * Execute one of the exported statements VERBATIM, with real bind parameters.
 *
 * `claimStatements` ships as text with `$1`-style placeholders, and Drizzle
 * numbers its own parameters, so there is no way to hand the string to
 * `db.execute` and keep it parameterised. Splitting on the placeholders and
 * re-interleaving the values through `sql` preserves both: the SQL that runs is
 * character-for-character the exported string, and the values still go over the
 * wire as parameters rather than as interpolated literals.
 *
 * Retyping the statements inline here instead — which is what the webhook route
 * does — would make this suite a test of the copy, and the copy is exactly what
 * cannot be trusted to stay in step.
 */
function bindPositional(text: string, params: readonly unknown[]): SQL {
  // Even indices are literal text, odd indices are the captured `$n` digits.
  const parts = text.split(/\$(\d+)/);
  return sql.join(
    parts.map((part, index) =>
      index % 2 === 0 ? sql.raw(part) : sql`${params[Number(part) - 1]}`,
    ),
  );
}

const EVENT_ID = "evt_itest_ledger_0000000001";
const RACE_EVENT_ID = "evt_itest_ledger_0000000002";
const EVENT_TYPE = "payment_intent.succeeded";
const TENANT_ID = "itest-ledger-tenant";
const PAYLOAD = JSON.stringify({ id: EVENT_ID, object: "event", type: EVENT_TYPE });

/** One delivery of `eventId`: the claiming INSERT, exactly as exported. */
async function deliver(
  tx: AppTransaction,
  eventId: string = EVENT_ID,
): Promise<{ readonly claimed: boolean }> {
  const result = await tx.execute(
    bindPositional(claimStatements.insert, [eventId, EVENT_TYPE, TENANT_ID, PAYLOAD]),
  );
  return { claimed: result.rows.length === 1 };
}

/**
 * The follow-up read, taken THROUGH DRIZZLE rather than through
 * `claimStatements.readExisting`.
 *
 * This is what the webhook route does, and it is not interchangeable with the
 * exported statement: the raw statement returns timestamps as strings. See the
 * final block in this file, which pins that difference on purpose.
 */
async function readExistingViaOrm(
  tx: AppTransaction,
  eventId: string = EVENT_ID,
): Promise<{ processedAt: Date | null; claimedAt: Date | null }> {
  const [row] = await tx
    .select({
      processedAt: stripeEvents.processedAt,
      claimedAt: stripeEvents.claimedAt,
    })
    .from(stripeEvents)
    .where(eq(stripeEvents.eventId, eventId))
    .limit(1);
  return { processedAt: row?.processedAt ?? null, claimedAt: row?.claimedAt ?? null };
}

/** `decideClaim` fed the values this delivery actually observed. */
async function decideFor(
  tx: AppTransaction,
  claimed: boolean,
  now?: Date,
): Promise<ClaimOutcome> {
  const existing = claimed
    ? { processedAt: null, claimedAt: null }
    : await readExistingViaOrm(tx);
  return decideClaim({
    insertedRow: claimed,
    existingProcessedAt: existing.processedAt,
    existingClaimedAt: existing.claimedAt,
    leaseMs: DEFAULT_CLAIM_LEASE_MS,
    ...(now ? { now } : {}),
  });
}

async function rowState(
  tx: AppTransaction,
  eventId: string = EVENT_ID,
): Promise<{ attempts: number; lastError: string | null }> {
  const [row] = await tx
    .select({ attempts: stripeEvents.attempts, lastError: stripeEvents.lastError })
    .from(stripeEvents)
    .where(eq(stripeEvents.eventId, eventId));
  if (!row) throw new Error(`stripe_events row ${eventId} is missing`);
  return row;
}

describeIntegration("claiming a delivery", () => {
  it("gives the row to the first delivery and to nobody else", async () => {
    await withRollback(db, async (tx: AppTransaction) => {
      const first = await deliver(tx);
      expect(first.claimed).toBe(true);
      expect(await decideFor(tx, first.claimed)).toEqual({
        action: "process",
        reclaimed: false,
      });

      // The second delivery of the SAME event. `ON CONFLICT (event_id) DO
      // NOTHING` swallows it and `RETURNING` yields no row, which is the whole
      // idempotency mechanism — there is no in-process Set to consult and none
      // would survive a cold serverless instance anyway.
      const second = await deliver(tx);
      expect(second.claimed).toBe(false);

      // Unfinished and freshly claimed by someone else: 500, so Stripe
      // redelivers in a few seconds. A 200 here tells Stripe the work
      // succeeded and ends the retry schedule.
      expect(await decideFor(tx, second.claimed)).toEqual({ action: "retry-later" });

      // The claiming INSERT stamps both, and nothing else does.
      const state = await rowState(tx);
      expect(state.attempts).toBe(1);
      const existing = await readExistingViaOrm(tx);
      expect(existing.claimedAt).toBeInstanceOf(Date);
      expect(existing.processedAt).toBeNull();
    });
  });

  it("turns every later delivery into a duplicate once markProcessed has run", async () => {
    await withRollback(db, async (tx: AppTransaction) => {
      const first = await deliver(tx);
      expect(first.claimed).toBe(true);

      await tx.execute(bindPositional(claimStatements.markProcessed, [EVENT_ID]));

      const third = await deliver(tx);
      expect(third.claimed).toBe(false);
      // 200. The work is done; redelivering it would run a paid effect twice.
      expect(await decideFor(tx, third.claimed)).toEqual({ action: "skip-duplicate" });

      // markProcessed also drops the claim and clears the error, so the row
      // stops looking abandoned to the stuck-events query.
      const existing = await readExistingViaOrm(tx);
      expect(existing.processedAt).toBeInstanceOf(Date);
      expect(existing.claimedAt).toBeNull();
      expect((await rowState(tx)).lastError).toBeNull();
    });
  });

  it("lets the very next delivery re-claim immediately after a release", async () => {
    // The wedge this prevents: a handler throws, the route answers 500, and the
    // retry arrives to find a row that exists with `processed_at` still null.
    // Without `release` setting `claimed_at = NULL`, "someone is mid-flight" and
    // "the owner died an hour ago" are the same observation, every retry
    // defers, and Stripe disables the endpoint after three days — taking every
    // other event type with it.
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);
      await tx.execute(
        bindPositional(claimStatements.release, [EVENT_ID, "handler exploded"]),
      );

      const released = await readExistingViaOrm(tx);
      expect(released.claimedAt).toBeNull();
      expect(released.processedAt).toBeNull();
      expect((await rowState(tx)).lastError).toBe("handler exploded");

      const retry = await deliver(tx);
      expect(retry.claimed).toBe(false);
      // IMMEDIATELY, not after the five-minute lease.
      expect(await decideFor(tx, retry.claimed)).toEqual({
        action: "process",
        reclaimed: true,
      });

      const retaken = await tx.execute(
        bindPositional(claimStatements.reclaim, [EVENT_ID]),
      );
      expect(retaken.rows).toHaveLength(1);
      // `attempts` is the only signal that an event is failing repeatedly —
      // Stripe's dashboard shows the delivery, not our failure. A reclaim that
      // did not bump it would make a row stuck at attempt 12 look like a row
      // delivered twice.
      expect((await rowState(tx)).attempts).toBe(2);
    });
  });

  it("takes over a claim that has aged past the lease", async () => {
    // The other way a claim clears: the process DIED mid-handler and never got
    // to `release`. Only the clock can free that row.
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);
      const abandonedAt = new Date(Date.now() - DEFAULT_CLAIM_LEASE_MS - 60_000);
      await tx
        .update(stripeEvents)
        .set({ claimedAt: abandonedAt })
        .where(eq(stripeEvents.eventId, EVENT_ID));

      const retry = await deliver(tx);
      expect(retry.claimed).toBe(false);
      expect(await decideFor(tx, retry.claimed)).toEqual({
        action: "process",
        reclaimed: true,
      });

      const retaken = await tx.execute(
        bindPositional(claimStatements.reclaim, [EVENT_ID]),
      );
      expect(retaken.rows).toHaveLength(1);
    });
  });

  it("loses the reclaim to an owner who finished in between", async () => {
    // The `processed_at IS NULL` guard on `reclaim`, which is the reason it is
    // an UPDATE with a predicate rather than an unconditional one. The read
    // that said "abandoned" and the write that takes over are two statements,
    // and the owner can finish between them. Losing the takeover is the correct
    // outcome: better a skipped reclaim than a handler run twice on a paid
    // event.
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);

      const staleReading = await readExistingViaOrm(tx);
      const outcome = decideClaim({
        insertedRow: false,
        existingProcessedAt: staleReading.processedAt,
        existingClaimedAt: staleReading.claimedAt,
        // The claim has aged out as far as this instance can tell, so it is
        // about to take the row.
        now: new Date(Date.now() + DEFAULT_CLAIM_LEASE_MS + 60_000),
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
      });
      expect(outcome).toEqual({ action: "process", reclaimed: true });

      // ...and the real owner finishes first.
      await tx.execute(bindPositional(claimStatements.markProcessed, [EVENT_ID]));

      const retaken = await tx.execute(
        bindPositional(claimStatements.reclaim, [EVENT_ID]),
      );
      // No row: the guard held, and the route answers 200 duplicate instead of
      // dispatching the handler a second time.
      expect(retaken.rows).toHaveLength(0);
      expect((await rowState(tx)).attempts).toBe(1);
    });
  });
});

/**
 * The claim is arbitrated by the DATABASE, not by the process.
 *
 * Everything above runs two "deliveries" down one connection, which is a fair
 * model of two sequential retries and no model at all of two instances of the
 * function running at once. This one uses two real connections and asserts the
 * part that only exists there: the second inserter WAITS. Postgres cannot
 * decide "conflict or not" against an uncommitted primary-key entry, so it
 * blocks until the first transaction ends — which is precisely what makes
 * `ON CONFLICT DO NOTHING` a claim rather than a race.
 */
describeIntegration("two concurrent deliveries of the same event", () => {
  it("makes the second one block on the first", async () => {
    const claimed = defer();
    const finished = defer();

    const [first, second] = await Promise.all([
      withRollback(db, async (tx: AppTransaction) => {
        const result = await deliver(tx, RACE_EVENT_ID);
        claimed.resolve();
        await finished.promise;
        return result.claimed ? "claimed" : "not-claimed";
      }),
      withRollback(db, async (tx: AppTransaction) => {
        await claimed.promise;
        // Bounded, so a regression that stops the blocking fails the run in
        // under a second rather than hanging it until CI gives up.
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        try {
          const result = await deliver(tx, RACE_EVENT_ID);
          return result.claimed ? "claimed-too" : "conflicted-immediately";
        } catch (error) {
          // 55P03 = lock_not_available.
          return pgErrorCode(error) ?? "no-sqlstate";
        } finally {
          finished.resolve();
        }
      }),
    ]);

    expect(first).toBe("claimed");
    expect(second).toBe("55P03");

    const leftovers = await db
      .select({ eventId: stripeEvents.eventId })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, RACE_EVENT_ID));
    expect(leftovers).toEqual([]);
  });
});

/**
 * WHAT `claimStatements.readExisting` HANDS BACK, AND THAT THE DECIDER SURVIVES IT.
 *
 * The exported statements are documented as "the four statements the protocol
 * needs", and `decideClaim`'s own comment describes reading `processed_at` and
 * `claimed_at` straight after the insert. Do that literally and the values are
 * not Dates: Drizzle installs an identity type parser for timestamptz on the
 * connection so that its own column mapper can do the conversion, so a raw
 * `db.execute` gets `"2026-08-30 19:28:07.563276+00"` — a string, while the
 * typed `select()` path on the same row in the same transaction gets a Date.
 *
 * That divergence used to be a crash. `ClaimInput` declared `Date | null`, the
 * lease branch called `claimedAt.getTime()`, and the first delivery to land on
 * an in-flight row died with `TypeError: claimedAt.getTime is not a function` —
 * inside a webhook, on the retry path, which is the least observed code in the
 * system. TypeScript could not catch it, because `execute()` hands back untyped
 * rows and the cast at the call site is unchecked; the unit suite could not
 * catch it, because it constructs its own Dates.
 *
 * `ClaimInput` now accepts `Date | string | null` and normalises through
 * `asDate` (@__SCOPE_NAME__/stripe 0.1.2). These tests are what keeps that fix
 * honest FROM THE DRIVER'S SIDE. @__SCOPE_NAME__/stripe's own unit suite feeds
 * `decideClaim` a string literal somebody typed, which proves the branch and
 * assumes the format; only here does the string come from Postgres, so a
 * normalisation that mis-parsed the real `+00` offset — the failure that turns
 * a five-minute lease into a five-hour one, silently — fails here and nowhere
 * else. The two paths are therefore asserted to AGREE rather than merely to not
 * throw.
 */
describeIntegration("what the exported SQL actually returns", () => {
  it("returns timestamps as STRINGS, not Dates", async () => {
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);

      // Left as `Record<string, unknown>`. Casting the rows into a typed shape
      // is exactly the unchecked claim this test exists to disprove.
      const [raw] = (
        await tx.execute(bindPositional(claimStatements.readExisting, [EVENT_ID]))
      ).rows;

      expect(typeof raw?.claimed_at).toBe("string");
      expect(raw?.claimed_at).not.toBeInstanceOf(Date);
      // The same column through Drizzle, on the same row, in the same
      // transaction — this is the divergence, not a quirk of the driver.
      expect((await readExistingViaOrm(tx)).claimedAt).toBeInstanceOf(Date);
    });
  });

  it("decides the same way whether it is fed the strings or the Dates", async () => {
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);

      const [raw] = (
        await tx.execute(bindPositional(claimStatements.readExisting, [EVENT_ID]))
      ).rows;
      const typed = await readExistingViaOrm(tx);

      // `unknown as Date | null` is what the compiler has to be told at any real
      // call site, because `execute()` returns untyped rows and the declared
      // input is wider than the annotation. It used to be a lie; the assertions
      // below are what makes it true.
      const fromStrings = decideClaim({
        insertedRow: false,
        existingProcessedAt: raw?.processed_at as Date | null,
        existingClaimedAt: raw?.claimed_at as Date | null,
      });
      const fromDates = decideClaim({
        insertedRow: false,
        existingProcessedAt: typed.processedAt,
        existingClaimedAt: typed.claimedAt,
      });

      // Freshly claimed by the insert above, so both must defer.
      expect(fromStrings).toEqual({ action: "retry-later" });
      expect(fromStrings).toEqual(fromDates);
    });
  });

  it("puts the string claim at the same instant on the lease as the Date one", async () => {
    // THE ASSERTION THAT A "does not throw" TEST WOULD MISS. A parse that read
    // the `+00` offset as local time still returns a Date, still has
    // `getTime`, and still decides — wrongly, by however many hours this
    // machine is from UTC. The lease boundary is where that shows up: one
    // millisecond either side of it must flip the answer, measured from the
    // Date the ORM produced for the same column.
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);

      const [raw] = (
        await tx.execute(bindPositional(claimStatements.readExisting, [EVENT_ID]))
      ).rows;
      const claimedAt = (await readExistingViaOrm(tx)).claimedAt;
      if (claimedAt === null) throw new Error("the claiming insert left claimed_at null");

      const at = (offsetMs: number): ClaimOutcome =>
        decideClaim({
          insertedRow: false,
          existingProcessedAt: null,
          existingClaimedAt: raw?.claimed_at as Date | null,
          now: new Date(claimedAt.getTime() + offsetMs),
          leaseMs: DEFAULT_CLAIM_LEASE_MS,
        });

      expect(at(DEFAULT_CLAIM_LEASE_MS - 1)).toEqual({ action: "retry-later" });
      expect(at(DEFAULT_CLAIM_LEASE_MS)).toEqual({ action: "process", reclaimed: true });
    });
  });

  it("reads a processed_at string as processed rather than as unfinished", async () => {
    // The other column, and the more expensive direction to get wrong: a
    // `processed_at` that failed to normalise reads as null, the row looks
    // unfinished, and a completed handler runs a second time against a paid
    // event.
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);
      await tx.execute(bindPositional(claimStatements.markProcessed, [EVENT_ID]));

      const [raw] = (
        await tx.execute(bindPositional(claimStatements.readExisting, [EVENT_ID]))
      ).rows;
      expect(typeof raw?.processed_at).toBe("string");

      expect(
        decideClaim({
          insertedRow: false,
          existingProcessedAt: raw?.processed_at as Date | null,
          existingClaimedAt: raw?.claimed_at as Date | null,
        }),
      ).toEqual({ action: "skip-duplicate" });
    });
  });
});

describeIntegration("the ledger's uniqueness claim", () => {
  it("is the primary key on event_id, enforced by the database", async () => {
    // `INSERT … ON CONFLICT (event_id) DO NOTHING` is only a claim if the
    // database enforces the uniqueness. A surrogate key with the Stripe id
    // beside it would let two concurrent deliveries both insert, and every test
    // above would still pass because they run in one transaction.
    await withRollback(db, async (tx: AppTransaction) => {
      const constraints = (
        await tx.execute(sql`
          select conname, pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = 'stripe_events'::regclass and contype = 'p'
        `)
      ).rows;

      expect(constraints).toHaveLength(1);
      expect(constraints[0]?.definition).toBe("PRIMARY KEY (event_id)");
    });
  });

  it("rejects a duplicate event id outright when nothing swallows the conflict", async () => {
    await withRollback(db, async (tx: AppTransaction) => {
      await deliver(tx);

      // No ON CONFLICT clause. Last statement in the transaction: a violation
      // aborts it and anything after would fail with 25P02 instead.
      const duplicate = tx.insert(stripeEvents).values({
        eventId: EVENT_ID,
        type: EVENT_TYPE,
        tenantId: TENANT_ID,
        payload: { id: EVENT_ID },
      });

      await expect(duplicate).rejects.toSatisfy(
        (error: unknown) => pgErrorCode(error) === "23505",
      );
    });
  });
});

/** A promise plus its resolver, for ordering two live transactions. */
function defer(): { readonly promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

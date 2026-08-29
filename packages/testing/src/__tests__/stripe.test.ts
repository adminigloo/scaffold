import { describe, expect, it } from "vitest";
import Stripe from "stripe";
import {
  assertEventLivemode,
  decideClaim,
  tenantIdFromEvent,
  verifyStripeSignature,
  StripeSignatureError,
  STRIPE_API_VERSION,
  DEFAULT_CLAIM_LEASE_MS,
} from "@adminigloo/stripe";
import {
  expectIdempotent,
  fakeLedger,
  signStripePayload,
  stripeEventFixture,
  IdempotencyViolationError,
  UnknownLedgerRowError,
} from "../stripe.js";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

// A real SDK instance. `constructEvent` does the HMAC locally, so nothing here
// touches the network.
const stripe = new Stripe("sk_test_00000000000000000000000000", {
  apiVersion: STRIPE_API_VERSION,
});

describe("stripeEventFixture", () => {
  it("is accepted by the code that reads real events", () => {
    const event = stripeEventFixture("checkout.session.completed", { tenantId: "t_42" });
    expect(event.type).toBe("checkout.session.completed");
    expect(event.id).toMatch(/^evt_/);
    expect(tenantIdFromEvent(event)).toBe("t_42");
  });

  it("defaults to test mode, so assertEventLivemode passes outside production", () => {
    const event = stripeEventFixture("payout.paid");
    expect(() => assertEventLivemode(event, "staging")).not.toThrow();
  });

  it("can still produce a live event, so the mismatch guard is testable", () => {
    const live = stripeEventFixture("payout.paid", { livemode: true });
    expect(() => assertEventLivemode(live, "staging")).toThrow();
    expect(() => assertEventLivemode(live, "production")).not.toThrow();
  });

  it("gives two fixtures of the same type different ids unless the seed matches", () => {
    // Two events in one test that shared an id would make the second read as a
    // redelivery of the first, and the ledger assertions would be meaningless.
    const first = stripeEventFixture("invoice.paid", { seed: 1 });
    const second = stripeEventFixture("invoice.paid", { seed: 2 });
    expect(first.id).not.toBe(second.id);
    expect(stripeEventFixture("invoice.paid", { seed: 1 }).id).toBe(first.id);
  });

  it("pins api_version to the version the client asks Stripe for", () => {
    expect(stripeEventFixture("invoice.paid").api_version).toBe(STRIPE_API_VERSION);
  });

  it("keeps caller metadata when stamping the tenant", () => {
    const event = stripeEventFixture("checkout.session.completed", {
      object: { id: "cs_test_x", metadata: { cartId: "c_1" } },
      tenantId: "t_7",
    });
    const object = event.data.object as unknown as {
      readonly metadata: Record<string, string>;
    };
    expect(object.metadata).toEqual({ cartId: "c_1", tenantId: "t_7" });
  });

  it("has no tenant when none was asked for", () => {
    // Account-level events genuinely have no tenant, and a fixture that
    // invented one would hide the null path the ledger column allows.
    expect(tenantIdFromEvent(stripeEventFixture("payout.paid"))).toBeNull();
  });
});

describe("signStripePayload — against the real verifier", () => {
  it("produces a header verifyStripeSignature accepts", () => {
    // THE test for this helper. If the scheme were wrong — the prefix stripped
    // from the secret, base64 instead of hex, the timestamp left out of the
    // signed content — every webhook test in every generated project would be
    // asserting against a route that never verified anything.
    const body = JSON.stringify(stripeEventFixture("checkout.session.completed"));
    const signature = signStripePayload(body, SECRET);

    const event = verifyStripeSignature(body, signature, SECRET, stripe);

    expect(event.type).toBe("checkout.session.completed");
  });

  it("matches stripe-node's own test header byte for byte", () => {
    const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
    const at = new Date("2026-08-28T12:00:00.000Z");

    expect(signStripePayload(body, SECRET, at)).toBe(
      stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret: SECRET,
        timestamp: Math.floor(at.getTime() / 1000),
      }),
    );
  });

  it("fails verification when the body changed after signing", () => {
    const body = JSON.stringify(stripeEventFixture("checkout.session.completed"));
    const signature = signStripePayload(body, SECRET);
    const tampered = body.replace("2000", "1");

    expect(() => verifyStripeSignature(tampered, signature, SECRET, stripe)).toThrow(
      StripeSignatureError,
    );
  });

  it("fails verification against another endpoint's secret", () => {
    const body = JSON.stringify(stripeEventFixture("invoice.paid"));
    const signature = signStripePayload(body, "whsec_ZGlmZmVyZW50IHNlY3JldA==");

    expect(() => verifyStripeSignature(body, signature, SECRET, stripe)).toThrow(
      StripeSignatureError,
    );
  });

  it("fails verification on a body re-serialised between signing and posting", () => {
    // What a route does when it reads the request with `req.json()`. The bytes
    // change, the HMAC does not match, and the error is identical to a forgery.
    const event = stripeEventFixture("checkout.session.completed", { tenantId: "t_1" });
    const body = JSON.stringify(event);
    const signature = signStripePayload(body, SECRET);
    const reparsed = JSON.stringify(JSON.parse(body) as unknown, ["type", "id"]);

    expect(() => verifyStripeSignature(reparsed, signature, SECRET, stripe)).toThrow(
      StripeSignatureError,
    );
  });

  it("uses the secret verbatim, prefix included", () => {
    // Stripping `whsec_` is svix's rule, not Stripe's. Confusing the two
    // produces a header that verifies nowhere.
    const body = "{}";
    expect(signStripePayload(body, SECRET)).not.toBe(
      signStripePayload(body, SECRET.replace("whsec_", "")),
    );
  });
});

describe("expectIdempotent", () => {
  const event = stripeEventFixture("checkout.session.completed", { tenantId: "t_42" });

  it("passes a handler that guards on the event id", () => {
    const seen = new Set<string>();
    let orders = 0;

    return expect(
      expectIdempotent(
        (delivered) => {
          if (seen.has(delivered.id)) return;
          seen.add(delivered.id);
          orders += 1;
        },
        event,
        { sideEffects: () => orders },
      ),
    ).resolves.toMatchObject({ deliveries: 2, effects: 1 });
  });

  it("catches the handler that does the work twice", async () => {
    // trailcards' bug in miniature: no ledger, so both deliveries create an
    // order. Single-delivery tests pass; the customer is charged once and
    // shipped twice.
    let orders = 0;
    await expect(
      expectIdempotent(() => void (orders += 1), event, { sideEffects: () => orders }),
    ).rejects.toThrow(IdempotencyViolationError);
  });

  it("says what it saw, not just that it failed", async () => {
    let orders = 0;
    const error = await expectIdempotent(() => void (orders += 1), event, {
      sideEffects: () => orders,
    }).catch((thrown: unknown) => thrown);

    const message = String(error);
    expect(message).toContain("checkout.session.completed");
    expect(message).toContain(event.id);
    expect(message).toContain("delivered 2 times");
    expect(message).toContain("0 -> 2");
    expect(message).toContain("2 effect(s) where 1 was expected");
  });

  it("catches the handler that skips the FIRST delivery", async () => {
    // riddler-go's process-local Set, primed by a previous request: the very
    // first delivery of a new event is answered as a duplicate, the route
    // returns 200, and Stripe never retries. The event is gone.
    let orders = 0;
    await expect(
      expectIdempotent(
        () => {
          /* believes it has already seen this */
        },
        event,
        { sideEffects: () => orders },
      ),
    ).rejects.toThrow(/skipped work it should have done/);
  });

  it("distinguishes a handler that cannot process the event at all", async () => {
    await expect(
      expectIdempotent(() => {
        throw new Error("column tenant_id does not exist");
      }, event),
    ).rejects.toThrow(/FIRST delivery .* threw Error: column tenant_id does not exist/);
  });

  it("fails a route that answers 500 to a duplicate", async () => {
    // A 500 tells Stripe to retry, so a handler that throws on duplicates gets
    // redelivered for three days and then disables the endpoint for every other
    // event type too.
    let delivered = 0;
    await expect(
      expectIdempotent(
        () => {
          delivered += 1;
          if (delivered > 1) throw new Error("duplicate event");
        },
        event,
        { sideEffects: () => 1 },
      ),
    ).rejects.toThrow(/A duplicate must answer 200, not 500/);
  });

  it("honours a caller-supplied delivery count and expectation", async () => {
    const seen = new Set<string>();
    let orders = 0;
    const report = await expectIdempotent(
      (delivered) => {
        if (seen.has(delivered.id)) return;
        seen.add(delivered.id);
        orders += 1;
      },
      event,
      { deliveries: 5, sideEffects: () => orders },
    );
    expect(report).toMatchObject({ deliveries: 5, effects: 1, before: 0, after: 1 });
  });

  it("degrades honestly with no counter injected", async () => {
    // Weak on purpose, and documented as weak: with nothing to count, a handler
    // that writes twice cannot be distinguished from one that writes once.
    const report = await expectIdempotent(() => undefined, event);
    expect(report.effects).toBeNull();
  });
});

describe("fakeLedger", () => {
  const NOW = new Date("2026-08-28T12:00:00.000Z");
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const event = stripeEventFixture("checkout.session.completed", { tenantId: "t_42" });

  it("claims a first delivery and records the tenant", () => {
    const ledger = fakeLedger();
    expect(ledger.claim(event, { now: NOW })).toEqual({
      action: "process",
      reclaimed: false,
    });
    expect(ledger.row(event.id)).toMatchObject({
      type: "checkout.session.completed",
      tenantId: "t_42",
      attempts: 1,
      processedAt: null,
    });
  });

  it("skips a redelivery once the handler has finished", () => {
    const ledger = fakeLedger();
    ledger.claim(event, { now: NOW });
    ledger.markProcessed(event.id, { now: at(1_000) });

    expect(ledger.claim(event, { now: at(2_000) })).toEqual({ action: "skip-duplicate" });
    expect(ledger.row(event.id)?.claimedAt).toBeNull();
  });

  it("defers to an owner still inside the lease", () => {
    const ledger = fakeLedger();
    ledger.claim(event, { now: NOW });
    expect(ledger.claim(event, { now: at(DEFAULT_CLAIM_LEASE_MS - 1) })).toEqual({
      action: "retry-later",
    });
    expect(ledger.row(event.id)?.attempts).toBe(1);
  });

  it("takes over a claim older than the lease — the crashed-instance case", () => {
    const ledger = fakeLedger();
    ledger.claim(event, { now: NOW });

    expect(ledger.claim(event, { now: at(DEFAULT_CLAIM_LEASE_MS) })).toEqual({
      action: "process",
      reclaimed: true,
    });
    // The takeover is a write, exactly as `claimStatements.reclaim` is.
    expect(ledger.row(event.id)?.attempts).toBe(2);
    expect(ledger.row(event.id)?.claimedAt).toEqual(at(DEFAULT_CLAIM_LEASE_MS));
  });

  it("re-claims immediately after a handler released the row", () => {
    // The wedge, end to end and with no Postgres: claim, throw, release,
    // redelivery. Without `release` clearing claimed_at, every retry defers
    // until Stripe disables the endpoint.
    const ledger = fakeLedger();
    ledger.claim(event, { now: NOW });
    ledger.release(event.id, new Error("handler blew up"));

    expect(ledger.row(event.id)?.lastError).toBe("handler blew up");
    expect(ledger.claim(event, { now: at(5_000) })).toEqual({
      action: "process",
      reclaimed: true,
    });
  });

  it("honours a caller-supplied lease, the way decideClaim does", () => {
    const ledger = fakeLedger();
    ledger.claim(event, { now: NOW, leaseMs: 1_000 });
    expect(ledger.claim(event, { now: at(2_000), leaseMs: 1_000 })).toEqual({
      action: "process",
      reclaimed: true,
    });
  });

  it("agrees with decideClaim rather than reimplementing it", () => {
    const ledger = fakeLedger();
    ledger.claim(event, { now: NOW });
    const row = ledger.row(event.id);

    expect(ledger.claim(event, { now: at(60_000) })).toEqual(
      decideClaim({
        insertedRow: false,
        existingProcessedAt: row?.processedAt ?? null,
        existingClaimedAt: row?.claimedAt ?? null,
        now: at(60_000),
      }),
    );
  });

  it("keeps events apart", () => {
    const ledger = fakeLedger();
    const other = stripeEventFixture("checkout.session.completed", { seed: 9 });
    ledger.claim(event, { now: NOW });
    expect(ledger.claim(other, { now: NOW })).toEqual({
      action: "process",
      reclaimed: false,
    });
    expect(ledger.rows()).toHaveLength(2);
  });

  it("refuses to mark an event it never claimed", () => {
    // Against Postgres this is an UPDATE matching zero rows: no error, no
    // effect, and a test that passes while the real ledger stays unfinished.
    const ledger = fakeLedger();
    expect(() => ledger.markProcessed("evt_never_seen")).toThrow(UnknownLedgerRowError);
    expect(() => ledger.release("evt_never_seen", new Error("x"))).toThrow(
      UnknownLedgerRowError,
    );
  });

  it("drives expectIdempotent for a route with no database at all", () => {
    const ledger = fakeLedger();
    let orders = 0;

    return expect(
      expectIdempotent(
        (delivered) => {
          const outcome = ledger.claim(delivered);
          if (outcome.action !== "process") return;
          orders += 1;
          ledger.markProcessed(delivered.id);
        },
        event,
        { sideEffects: () => orders },
      ),
    ).resolves.toMatchObject({ effects: 1 });
  });
});

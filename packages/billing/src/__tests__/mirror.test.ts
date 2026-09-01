import { describe, expect, it } from "vitest";
import {
  decideSubscriptionWrite,
  subscriptionEntitlementWindow,
  PAST_DUE_GRACE_MS,
} from "../mirror.js";
import type { SubscriptionStatus } from "../status.js";

const at = (iso: string): Date => new Date(iso);

describe("decideSubscriptionWrite", () => {
  it("applies the first observation of a subscription", () => {
    expect(
      decideSubscriptionWrite({
        observedAt: at("2026-03-01T12:00:00Z"),
        observedTerminal: false,
        storedAt: null,
        storedTerminal: false,
      }),
    ).toEqual({ action: "apply" });
  });

  it("applies an observation newer than the watermark", () => {
    expect(
      decideSubscriptionWrite({
        observedAt: at("2026-03-01T12:00:05Z"),
        observedTerminal: false,
        storedAt: at("2026-03-01T12:00:00Z"),
        storedTerminal: false,
      }).action,
    ).toBe("apply");
  });

  it("SKIPS an observation older than the watermark — the out-of-order delivery", () => {
    const decision = decideSubscriptionWrite({
      observedAt: at("2026-03-01T11:59:50Z"),
      observedTerminal: false,
      storedAt: at("2026-03-01T12:00:00Z"),
      storedTerminal: false,
    });
    expect(decision.action).toBe("skip");
    // The message has to say which two instants disagreed, because the only
    // person who ever reads it is looking at a row they think is wrong.
    if (decision.action !== "skip") throw new Error("unreachable");
    expect(decision.why).toContain("2026-03-01T11:59:50");
    expect(decision.why).toContain("2026-03-01T12:00:00");
  });

  it("does not resurrect a deleted subscription on a same-second tie", () => {
    const decision = decideSubscriptionWrite({
      observedAt: at("2026-03-01T12:00:00Z"),
      observedTerminal: false,
      storedAt: at("2026-03-01T12:00:00Z"),
      storedTerminal: true,
    });
    expect(decision.action).toBe("skip");
  });

  it("lets the delete win the same tie from the other side", () => {
    expect(
      decideSubscriptionWrite({
        observedAt: at("2026-03-01T12:00:00Z"),
        observedTerminal: true,
        storedAt: at("2026-03-01T12:00:00Z"),
        storedTerminal: false,
      }).action,
    ).toBe("apply");
  });

  it("applies an equal-timestamp observation when neither side is terminal", () => {
    // Second resolution means two changes can share an instant. Applying them
    // in arrival order is the documented residue, not an oversight — the resync
    // is what repairs it.
    expect(
      decideSubscriptionWrite({
        observedAt: at("2026-03-01T12:00:00Z"),
        observedTerminal: false,
        storedAt: at("2026-03-01T12:00:00Z"),
        storedTerminal: false,
      }).action,
    ).toBe("apply");
  });

  it("still applies a delete that arrives after another delete", () => {
    expect(
      decideSubscriptionWrite({
        observedAt: at("2026-03-01T12:00:00Z"),
        observedTerminal: true,
        storedAt: at("2026-03-01T12:00:00Z"),
        storedTerminal: true,
      }).action,
    ).toBe("apply");
  });
});

describe("subscriptionEntitlementWindow", () => {
  const now = at("2026-03-01T12:00:00Z");
  const periodEnd = at("2026-03-20T00:00:00Z");

  const windowFor = (
    status: SubscriptionStatus,
    overrides: {
      cancelAtPeriodEnd?: boolean;
      currentPeriodEnd?: Date | null;
    } = {},
  ) =>
    subscriptionEntitlementWindow({
      status,
      cancelAtPeriodEnd: overrides.cancelAtPeriodEnd ?? false,
      currentPeriodEnd:
        overrides.currentPeriodEnd === undefined ? periodEnd : overrides.currentPeriodEnd,
      at: now,
    });

  it("serves a renewing subscription with no deadline at all", () => {
    for (const status of ["active", "trialing"] as const) {
      const window = windowFor(status);
      expect(window).toMatchObject({ holds: true, expiresAt: null, serving: true });
    }
  });

  it("serves a scheduled cancellation to the END OF THE PAID PERIOD", () => {
    const window = windowFor("active", { cancelAtPeriodEnd: true });
    expect(window.holds).toBe(true);
    expect(window.serving).toBe(true);
    expect(window.expiresAt).toEqual(periodEnd);
  });

  it("does not extend a scheduled cancellation past a period it cannot read", () => {
    // A live subscription always has a period, so this is unreachable in
    // practice — which is exactly why the answer must not be "no deadline".
    const window = windowFor("active", {
      cancelAtPeriodEnd: true,
      currentPeriodEnd: null,
    });
    expect(window.expiresAt).toEqual(now);
    expect(window.serving).toBe(false);
  });

  it("keeps a past-due subscription served for the dunning window", () => {
    const window = windowFor("past_due");
    expect(window.holds).toBe(true);
    expect(window.serving).toBe(true);
    expect(window.expiresAt).toEqual(new Date(now.getTime() + PAST_DUE_GRACE_MS));
  });

  it("takes the EARLIER bound when a past-due subscription is also cancelling", () => {
    const window = windowFor("past_due", { cancelAtPeriodEnd: true });
    // The period ends on the 20th; the dunning window would run to the 15th.
    expect(window.expiresAt).toEqual(new Date(now.getTime() + PAST_DUE_GRACE_MS));

    const soon = at("2026-03-02T00:00:00Z");
    const closer = subscriptionEntitlementWindow({
      status: "past_due",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: soon,
      at: now,
    });
    expect(closer.expiresAt).toEqual(soon);
  });

  it("stops serving an unpaid subscription immediately, without deleting its rows", () => {
    const window = windowFor("unpaid");
    expect(window.holds).toBe(true);
    expect(window.serving).toBe(false);
    expect(window.expiresAt).toEqual(now);
  });

  it("grants nothing for a subscription whose first payment never completed", () => {
    const window = windowFor("incomplete", { currentPeriodEnd: null });
    expect(window.holds).toBe(true);
    expect(window.serving).toBe(false);
    expect(window.expiresAt).toEqual(now);
  });

  it("removes the plan's rows only when the subscription has ended", () => {
    const window = windowFor("canceled");
    expect(window).toMatchObject({ holds: false, serving: false, expiresAt: null });

    // Every other state keeps them, because `used_value` lives on the row.
    for (const status of [
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "incomplete",
    ] as const) {
      expect(windowFor(status).holds, status).toBe(true);
    }
  });

  it("says why, in a sentence an audit row can carry", () => {
    for (const status of [
      "active",
      "trialing",
      "past_due",
      "unpaid",
      "incomplete",
      "canceled",
    ] as const) {
      expect(windowFor(status).why.length, status).toBeGreaterThan(20);
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isEntitledStatus,
  isLiveStatus,
  mapStripeSubscriptionStatus,
  LIVE_SUBSCRIPTION_STATUSES,
} from "../status.js";
import type { SubscriptionStatus } from "../status.js";

/** Every status Stripe documents for a subscription, as of API 2026-08. */
const STRIPE_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

const OUR_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
];

describe("mapStripeSubscriptionStatus — totality", () => {
  it("answers for every status Stripe documents", () => {
    for (const status of STRIPE_STATUSES) {
      expect(OUR_STATUSES, status).toContain(mapStripeSubscriptionStatus(status));
    }
  });

  it("passes through the six that mean the same thing", () => {
    for (const status of OUR_STATUSES) {
      expect(mapStripeSubscriptionStatus(status)).toBe(status);
    }
  });

  it("retires incomplete_expired to canceled, not to incomplete", () => {
    // The first payment never succeeded and Stripe will not retry. Left as
    // `incomplete` the row stays inside the live set the partial unique index
    // protects, so the tenant can never start a new subscription — one
    // abandoned checkout locks them out of the product for good.
    expect(mapStripeSubscriptionStatus("incomplete_expired")).toBe("canceled");
    expect(isLiveStatus(mapStripeSubscriptionStatus("incomplete_expired"))).toBe(false);
  });

  it("maps paused to unpaid rather than past_due", () => {
    // past_due drives dunning. Telling a customer whose collection WE paused
    // that their payment failed is a lie that arrives by email.
    expect(mapStripeSubscriptionStatus("paused")).toBe("unpaid");
    expect(isEntitledStatus(mapStripeSubscriptionStatus("paused"))).toBe(false);
  });
});

describe("mapStripeSubscriptionStatus — the default", () => {
  it("never resolves an unknown status to active", () => {
    // The single most expensive mistake here: `active` is the friendly-looking
    // default, and it hands the product to someone whose payment state we
    // cannot read. Stripe adds statuses; this is the branch that meets them.
    const unknown = [
      "",
      " active ",
      "ACTIVE",
      "active_v2",
      "grace_period",
      "pending_cancellation",
      "🙂",
    ];
    for (const status of unknown) {
      expect(mapStripeSubscriptionStatus(status), status).toBe("unpaid");
      expect(isEntitledStatus(mapStripeSubscriptionStatus(status)), status).toBe(false);
    }
  });

  it("defaults to unpaid rather than canceled, so a bad read is recoverable", () => {
    // canceled is a terminal fact that fires cancellation email and
    // offboarding. "We do not know, so do not serve" has to be undoable by the
    // next, correct webhook.
    expect(mapStripeSubscriptionStatus("something_new")).not.toBe("canceled");
  });
});

describe("isEntitledStatus", () => {
  it("entitles trialing and active, and nothing else", () => {
    expect(OUR_STATUSES.filter(isEntitledStatus)).toEqual(["trialing", "active"]);
  });

  it("does not entitle past_due", () => {
    // The one people want to add: the customer is real, the card just bounced.
    // A grace period belongs in a dunning policy with an end date — "past due
    // entitles you" never expires, so a subscription that never recovers serves
    // forever and the product keeps working while nobody pays.
    expect(isEntitledStatus("past_due")).toBe(false);
  });
});

describe("LIVE_SUBSCRIPTION_STATUSES", () => {
  it("holds every status except canceled", () => {
    expect([...LIVE_SUBSCRIPTION_STATUSES].sort()).toEqual(
      OUR_STATUSES.filter((s) => s !== "canceled").sort(),
    );
  });

  it("includes incomplete, so a second checkout cannot start beside the first", () => {
    // Without it a double-clicked upgrade creates two Stripe subscriptions for
    // one tenant, bills twice, and leaves two webhook streams racing.
    expect(isLiveStatus("incomplete")).toBe(true);
  });

  it("excludes canceled, so a tenant can resubscribe", () => {
    expect(isLiveStatus("canceled")).toBe(false);
  });

  it("contains every entitled status", () => {
    // Entitlement must be a subset of the set the unique index protects. A
    // status that entitles but is not live could be duplicated per tenant, and
    // the row the code reads would not be the row the database guarded.
    for (const status of OUR_STATUSES.filter(isEntitledStatus)) {
      expect(isLiveStatus(status), status).toBe(true);
    }
  });

  it("matches the predicate on subscriptions_tenant_live_idx, byte for byte", () => {
    // Read as TEXT, not imported: importing schema.ts would drag drizzle-orm
    // into a test that exists to stay pure, and the coupling is textual anyway
    // because the predicate is raw SQL. Enforced rather than commented, because
    // the two lists live in different files and only one of them is executable.
    const schema = readFileSync(new URL("../schema.ts", import.meta.url), "utf8");
    const predicate = schema.slice(schema.indexOf("subscriptions_tenant_live_idx"));
    const inList = /in \(([^)]+)\)/.exec(predicate)?.[1] ?? "";
    const statuses = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

    expect(statuses.sort()).toEqual([...LIVE_SUBSCRIPTION_STATUSES].sort());
  });
});

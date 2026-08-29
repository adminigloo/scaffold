import { describe, expect, it } from "vitest";
import {
  checkEntitlement,
  resolveEntitlements,
  InvalidEntitlementAmountError,
} from "../entitlements.js";
import type { EntitlementRow, EntitlementSource } from "../entitlements.js";

const NOW = new Date("2026-08-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

function row(overrides: Partial<EntitlementRow> = {}): EntitlementRow {
  return {
    feature: "seats",
    limitValue: 5,
    usedValue: 0,
    source: "plan" as EntitlementSource,
    expiresAt: null,
    ...overrides,
  };
}

describe("resolveEntitlements — expiry", () => {
  it("drops an expired row whole, limit and usage together", () => {
    // Half-dropping is the tempting bug: keep the usage "so it is not lost" and
    // the tenant is left at 3 used against a limit of 0, permanently blocked by
    // an add-on that has already lapsed.
    const resolved = resolveEntitlements(
      [row({ limitValue: 5, usedValue: 3, expiresAt: ago(1) })],
      NOW,
    );
    expect(resolved.has("seats")).toBe(false);
  });

  it("treats the expiry instant itself as expired", () => {
    // Closed boundary, matching invitationState in @adminigloo/tenancy. The
    // open form leaves the seat spendable for the millisecond it is stamped
    // dead — unobservable in production, permanently flaky in tests.
    expect(resolveEntitlements([row({ expiresAt: NOW })], NOW).has("seats")).toBe(false);
  });

  it("keeps a row that expires one millisecond from now", () => {
    expect(resolveEntitlements([row({ expiresAt: ahead(1) })], NOW).get("seats")?.limit).toBe(5);
  });

  it("never expires a row with no expiry", () => {
    expect(resolveEntitlements([row({ expiresAt: null })], NOW).get("seats")?.limit).toBe(5);
  });

  it("leaves a feature ABSENT rather than present-at-zero once its last row lapses", () => {
    // The distinction the upsell reads: absent means "your plan does not
    // include this", present-at-zero means "you have used it all". A lapsed
    // trial grant must produce the first message, not the second.
    const resolved = resolveEntitlements([row({ expiresAt: ago(1) })], NOW);
    expect(checkEntitlement(resolved, "seats").reason).toBe("no-entitlement");
  });

  it("expires every row against the same instant, whatever order they arrive in", () => {
    const rows = [
      row({ feature: "seats", expiresAt: ago(1) }),
      row({ feature: "projects", limitValue: 2, expiresAt: ahead(1) }),
    ];
    expect([...resolveEntitlements(rows, NOW).keys()]).toEqual(["projects"]);
  });
});

describe("resolveEntitlements — summing", () => {
  it("sums a plan and an add-on into one answer", () => {
    const resolved = resolveEntitlements(
      [
        row({ limitValue: 5, usedValue: 4, source: "plan" }),
        row({ limitValue: 3, usedValue: 1, source: "addon" }),
      ],
      NOW,
    );
    expect(resolved.get("seats")).toEqual({
      limit: 8,
      used: 5,
      remaining: 3,
      unlimited: false,
    });
  });

  it("lets one unlimited row win, whichever end of the list it is on", () => {
    // Order-independence is the point. Summing null as 0 would let the plan
    // beside an unlimited add-on cap it — the opposite of what was bought — and
    // whichever row happened to be read first would decide the answer.
    const unlimited = row({ limitValue: null, usedValue: 2, source: "addon" });
    const limited = row({ limitValue: 5, usedValue: 1, source: "plan" });

    for (const rows of [
      [unlimited, limited],
      [limited, unlimited],
    ]) {
      expect(resolveEntitlements(rows, NOW).get("seats")).toEqual({
        limit: null,
        used: 3,
        remaining: null,
        unlimited: true,
      });
    }
  });

  it("falls back to the limited sum when the unlimited row is the expired one", () => {
    const resolved = resolveEntitlements(
      [
        row({ limitValue: null, usedValue: 40, source: "grant", expiresAt: ago(1) }),
        row({ limitValue: 5, usedValue: 2, source: "plan" }),
      ],
      NOW,
    );
    expect(resolved.get("seats")).toEqual({ limit: 5, used: 2, remaining: 3, unlimited: false });
  });

  it("counts usage on an unlimited row, so the number does not jump when it lapses", () => {
    expect(resolveEntitlements([row({ limitValue: null, usedValue: 12 })], NOW).get("seats")?.used)
      .toBe(12);
  });

  it("gives no source precedence — an override sums like everything else", () => {
    // Provenance, not precedence. If `override` won, an override of 0 would
    // swallow a paid add-on and leave no row to point at when the customer
    // asks where their seats went.
    const resolved = resolveEntitlements(
      [row({ limitValue: 5, source: "plan" }), row({ limitValue: 0, source: "override" })],
      NOW,
    );
    expect(resolved.get("seats")?.limit).toBe(5);
  });

  it("lets a negative override reduce the total, and fails closed at zero", () => {
    const resolved = resolveEntitlements(
      [
        row({ limitValue: 5, usedValue: 0, source: "plan" }),
        row({ limitValue: -5, usedValue: 0, source: "override" }),
      ],
      NOW,
    );
    expect(resolved.get("seats")).toEqual({ limit: 0, used: 0, remaining: 0, unlimited: false });
    expect(checkEntitlement(resolved, "seats").allowed).toBe(false);
  });

  it("keeps features apart", () => {
    const resolved = resolveEntitlements(
      [row({ feature: "seats", limitValue: 5 }), row({ feature: "projects", limitValue: 2 })],
      NOW,
    );
    expect(resolved.get("seats")?.limit).toBe(5);
    expect(resolved.get("projects")?.limit).toBe(2);
  });

  it("resolves nothing from no rows", () => {
    expect(resolveEntitlements([], NOW).size).toBe(0);
  });
});

describe("resolveEntitlements — over-consumption", () => {
  it("reports the overage instead of hiding it", () => {
    // 7 seats held against a limit of 5: a downgrade, or two invitations that
    // raced the same check. The admin screen has to be able to say "7 of 5",
    // because that is the number somebody has to act on.
    const resolved = resolveEntitlements([row({ limitValue: 5, usedValue: 7 })], NOW);
    expect(resolved.get("seats")).toEqual({ limit: 5, used: 7, remaining: 0, unlimited: false });
  });

  it("never returns a negative remaining", () => {
    // A negative number is truthy, so `if (remaining)` would wave the next
    // write through at exactly the moment it must not.
    for (const usedValue of [6, 50, 5_000]) {
      expect(resolveEntitlements([row({ limitValue: 5, usedValue })], NOW).get("seats")?.remaining)
        .toBe(0);
    }
  });
});

describe("checkEntitlement", () => {
  const resolved = resolveEntitlements(
    [
      row({ feature: "seats", limitValue: 5, usedValue: 4 }),
      row({ feature: "exports", limitValue: null, usedValue: 900 }),
      row({ feature: "webhooks", limitValue: 2, usedValue: 2 }),
      row({ feature: "audit", limitValue: 3, usedValue: 9 }),
    ],
    NOW,
  );

  it("distinguishes a feature nobody has from one that is used up", () => {
    // The whole reason this returns a reason. Same boolean, two different
    // screens: one offers an upgrade, the other offers to free a seat.
    expect(checkEntitlement(resolved, "sso")).toEqual({
      allowed: false,
      remaining: 0,
      reason: "no-entitlement",
    });
    expect(checkEntitlement(resolved, "webhooks")).toEqual({
      allowed: false,
      remaining: 0,
      reason: "limit-reached",
    });
  });

  it("reports 0, never null, for a feature nobody has", () => {
    // null means UNLIMITED in this shape, so a UI rendering
    // `remaining ?? "unlimited"` would advertise unlimited access to a feature
    // the tenant has never bought.
    expect(checkEntitlement(resolved, "sso").remaining).toBe(0);
  });

  it("allows anything on an unlimited feature and says so with null", () => {
    expect(checkEntitlement(resolved, "exports", 10_000)).toEqual({
      allowed: true,
      remaining: null,
      reason: "ok",
    });
  });

  it("defaults to one unit", () => {
    expect(checkEntitlement(resolved, "seats")).toEqual({
      allowed: true,
      remaining: 1,
      reason: "ok",
    });
  });

  it("allows an exact fit and denies one more", () => {
    // The off-by-one that matters: the fifth seat of five has to go through.
    expect(checkEntitlement(resolved, "seats", 1).allowed).toBe(true);
    expect(checkEntitlement(resolved, "seats", 2)).toEqual({
      allowed: false,
      remaining: 1,
      reason: "limit-reached",
    });
  });

  it("allows a request for nothing, even on an exhausted feature", () => {
    // A bulk import that turns out to contain zero rows must not be denied.
    expect(checkEntitlement(resolved, "webhooks", 0).allowed).toBe(true);
  });

  it("reports 0 remaining, not a negative, on an over-consumed feature", () => {
    expect(checkEntitlement(resolved, "audit")).toEqual({
      allowed: false,
      remaining: 0,
      reason: "limit-reached",
    });
  });

  it("throws on an amount that is not a count", () => {
    // NaN is the real case — Number(userInput). Left unguarded it denies on a
    // limited feature and ALLOWS on an unlimited one, because every comparison
    // against NaN is false: one bad input, two paths, no error either way.
    expect(() => checkEntitlement(resolved, "seats", Number("twelve"))).toThrow(
      InvalidEntitlementAmountError,
    );
    expect(() => checkEntitlement(resolved, "exports", Number.NaN)).toThrow(
      InvalidEntitlementAmountError,
    );
    expect(() => checkEntitlement(resolved, "seats", Number.POSITIVE_INFINITY)).toThrow(
      InvalidEntitlementAmountError,
    );
    expect(() => checkEntitlement(resolved, "seats", -1)).toThrow(InvalidEntitlementAmountError);
  });

  it("throws before consulting the map, so a bad amount cannot pass as no-entitlement", () => {
    expect(() => checkEntitlement(resolved, "sso", Number.NaN)).toThrow(
      InvalidEntitlementAmountError,
    );
  });
});

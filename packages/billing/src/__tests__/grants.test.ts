import { describe, expect, it } from "vitest";
import {
  grantsForPlan,
  planGrantDiff,
  EmptyPlanKeyError,
  InvalidGrantLimitError,
  GRANT_PREFIX,
} from "../grants.js";
import type { PlanGrant } from "../grants.js";
import type { EntitlementSource } from "../entitlements.js";

const STARTER = { key: "starter" };
const PRO = { key: "pro" };

describe("grantsForPlan", () => {
  it("turns grants_* declarations into entitlement rows", () => {
    expect(grantsForPlan(PRO, { grants_seats: 5, grants_projects: null })).toEqual([
      { feature: "projects", limitValue: null, source: "plan", sourceRef: "pro" },
      { feature: "seats", limitValue: 5, source: "plan", sourceRef: "pro" },
    ]);
  });

  it("ignores every key without the prefix", () => {
    // The prefix is the whole reason a settings bag can be read for grants at
    // all. Without it, adding `sort_order` to a plan silently grants every
    // subscriber a feature called "sort_order" with that number as its limit.
    expect(grantsForPlan(PRO, { trial_days: 14, sort_order: 3, seats: 99 })).toEqual([]);
  });

  it("skips a bare prefix, which names no feature", () => {
    // A row keyed on the empty string is invisible to every lookup and
    // unrenderable on the admin screen, but it still sums in resolveEntitlements.
    expect(grantsForPlan(PRO, { [GRANT_PREFIX]: 5 })).toEqual([]);
  });

  it("keeps 0 as a real limit, distinct from unlimited", () => {
    // A feature explicitly withheld while the row stays for the audit trail.
    // Collapsing it into null would hand out unlimited access.
    expect(grantsForPlan(PRO, { grants_seats: 0 })[0]?.limitValue).toBe(0);
    expect(grantsForPlan(PRO, { grants_seats: null })[0]?.limitValue).toBeNull();
  });

  it("stamps every row with the plan key as its source ref", () => {
    // source + sourceRef is what the unique index keys on, so this is what
    // makes a redelivered webhook upsert instead of insert.
    for (const grant of grantsForPlan(STARTER, { grants_seats: 1, grants_projects: 2 })) {
      expect(grant.source).toBe("plan");
      expect(grant.sourceRef).toBe("starter");
    }
  });

  it("never emits an empty source ref", () => {
    // The unique index indexes coalesce(source_ref, ''), so an empty ref
    // collides with every manual grant that has no ref at all.
    expect(() => grantsForPlan({ key: "" }, { grants_seats: 1 })).toThrow(EmptyPlanKeyError);
  });

  it("sorts by feature, so two calls produce identical rows", () => {
    const declared = { grants_zeta: 1, grants_alpha: 2, grants_mu: 3 };
    expect(grantsForPlan(PRO, declared).map((g) => g.feature)).toEqual(["alpha", "mu", "zeta"]);
  });

  it("is a no-op to apply twice", () => {
    // The property the unique index enforces in the database, held here too:
    // the same plan produces byte-identical rows, so the upsert has nothing new
    // to write and used_value is untouched.
    const once = grantsForPlan(PRO, { grants_seats: 5 });
    const twice = grantsForPlan(PRO, { grants_seats: 5 });
    expect(twice).toEqual(once);
    expect(planGrantDiff(once, twice)).toEqual({ add: [], remove: [], change: [] });
  });

  it("rejects a limit that is not a whole count", () => {
    // A fraction reaches an integer column and is truncated by the driver, so
    // 2.5 seats becomes 2 and nobody is told. A negative grant is a plan that
    // takes capacity away, which is an override written deliberately by an
    // admin, not something a purchase should do behind one.
    expect(() => grantsForPlan(PRO, { grants_seats: 2.5 })).toThrow(InvalidGrantLimitError);
    expect(() => grantsForPlan(PRO, { grants_seats: -1 })).toThrow(InvalidGrantLimitError);
    expect(() => grantsForPlan(PRO, { grants_seats: Number.NaN })).toThrow(InvalidGrantLimitError);
    expect(() => grantsForPlan(PRO, { grants_seats: Number.POSITIVE_INFINITY })).toThrow(
      InvalidGrantLimitError,
    );
  });

  it("names the plan and the feature in the error", () => {
    // The message is read in a deploy log, where the only context is the text.
    expect(() => grantsForPlan(PRO, { grants_seats: -1 })).toThrow(/pro/);
    expect(() => grantsForPlan(PRO, { grants_seats: -1 })).toThrow(/grants_seats/);
  });
});

const grant = (
  feature: string,
  limitValue: number | null,
  sourceRef: string,
): PlanGrant => ({ feature, limitValue, source: "plan", sourceRef });

const sourced = (
  feature: string,
  limitValue: number | null,
  source: EntitlementSource,
  sourceRef: string,
): PlanGrant => ({ feature, limitValue, source, sourceRef });

describe("planGrantDiff — an upgrade must not lose used_value", () => {
  const current = grantsForPlan(STARTER, { grants_seats: 2, grants_projects: 3 });
  const next = grantsForPlan(PRO, { grants_seats: 10, grants_projects: 3 });

  it("reports an upgrade as changes, never as removals plus insertions", () => {
    // THE REGRESSION THIS FUNCTION EXISTS FOR. Matching on (feature, sourceRef)
    // classifies every row as remove+add, the writer deletes and reinserts, and
    // used_value resets — a tenant with 4 seats in use gets 4 free ones back
    // and nothing about the result looks wrong.
    const diff = planGrantDiff(current, next);
    expect(diff.add).toEqual([]);
    expect(diff.remove).toEqual([]);
    expect(diff.change.map((c) => c.feature).sort()).toEqual(["projects", "seats"]);
  });

  it("carries the row to UPDATE and the values to write", () => {
    const diff = planGrantDiff(current, next);
    const seats = diff.change.find((c) => c.feature === "seats");
    expect(seats?.previous).toEqual(grant("seats", 2, "starter"));
    expect(seats?.next).toEqual(grant("seats", 10, "pro"));
  });

  it("reports a feature whose limit did not move, because its source ref did", () => {
    // projects is 3 on both plans. The row still has to be rewritten to point
    // at "pro", or the next diff believes the tenant is on starter and removes
    // the row as orphaned.
    const projects = planGrantDiff(current, next).change.find((c) => c.feature === "projects");
    expect(projects?.previous.sourceRef).toBe("starter");
    expect(projects?.next.sourceRef).toBe("pro");
  });

  it("adds what the new plan introduces and removes what it drops", () => {
    const diff = planGrantDiff(
      grantsForPlan(STARTER, { grants_seats: 2, grants_sso: 0 }),
      grantsForPlan(PRO, { grants_seats: 2, grants_exports: null }),
    );
    expect(diff.add).toEqual([grant("exports", null, "pro")]);
    expect(diff.remove).toEqual([grant("sso", 0, "starter")]);
    expect(diff.change.map((c) => c.feature)).toEqual(["seats"]);
  });

  it("never puts the same feature in both add and remove", () => {
    const diff = planGrantDiff(current, next);
    const added = new Set(diff.add.map((g) => g.feature));
    for (const removed of diff.remove) expect(added.has(removed.feature)).toBe(false);
  });

  it("diffs from nothing as pure additions", () => {
    const diff = planGrantDiff([], next);
    expect(diff.add).toEqual(next);
    expect(diff.remove).toEqual([]);
    expect(diff.change).toEqual([]);
  });

  it("diffs to nothing as pure removals — a cancellation, not a rewrite", () => {
    const diff = planGrantDiff(current, []);
    expect(diff.remove).toEqual(current);
    expect(diff.add).toEqual([]);
    expect(diff.change).toEqual([]);
  });
});

describe("planGrantDiff — reconciling rows an earlier bug left behind", () => {
  it("keeps the row that already points at the new plan and removes the stray", () => {
    // Two plan-sourced rows for one feature is the scar of an upgrade that
    // inserted where it should have updated. Left alone they SUM, so the tenant
    // quietly holds double the limit, and every later diff preserves both.
    const duplicated = [grant("seats", 2, "starter"), grant("seats", 10, "pro")];
    const diff = planGrantDiff(duplicated, grantsForPlan(PRO, { grants_seats: 10 }));

    expect(diff.change).toEqual([]);
    expect(diff.remove).toEqual([grant("seats", 2, "starter")]);
    expect(diff.add).toEqual([]);
  });

  it("falls back to the first row when none of them matches the new plan", () => {
    const duplicated = [grant("seats", 2, "starter"), grant("seats", 4, "legacy")];
    const diff = planGrantDiff(duplicated, grantsForPlan(PRO, { grants_seats: 10 }));

    expect(diff.change).toEqual([
      { feature: "seats", previous: grant("seats", 2, "starter"), next: grant("seats", 10, "pro") },
    ]);
    expect(diff.remove).toEqual([grant("seats", 4, "legacy")]);
  });

  it("removes every duplicate when the feature is dropped altogether", () => {
    const duplicated = [grant("seats", 2, "starter"), grant("seats", 4, "legacy")];
    expect(planGrantDiff(duplicated, []).remove).toEqual(duplicated);
  });
});

describe("planGrantDiff — a plan change must not touch another source's rows", () => {
  // The unique index is on (tenant, feature, source, ref), so a plan row and an
  // add-on row for the SAME feature are two legitimate rows that sum. Matched
  // on feature alone, the add-on looked like a stale plan row.
  const addon = sourced("seats", 3, "addon", "seat-pack-3");
  const support = sourced("seats", 2, "grant", "ZD-4471");
  const override = sourced("seats", -1, "override", "");

  it("leaves an add-on row alone while the plan row moves plans", () => {
    // Removing it revokes seats the customer bought separately, in the middle
    // of an upgrade, and the resulting diff looks entirely reasonable.
    const diff = planGrantDiff(
      [grant("seats", 2, "starter"), addon],
      grantsForPlan(PRO, { grants_seats: 10 }),
    );

    expect(diff.remove).toEqual([]);
    expect(diff.add).toEqual([]);
    expect(diff.change).toEqual([
      { feature: "seats", previous: grant("seats", 2, "starter"), next: grant("seats", 10, "pro") },
    ]);
  });

  it("still UPDATEs the plan row in place, which is what keeps used_value", () => {
    // The add-on sharing the feature must not push the plan row onto the
    // remove+add path: that row carries the tenant's seats in use, and
    // recreating it hands back every seat already occupied. `previous` is the
    // row object the caller passed in, so the writer UPDATEs that row rather
    // than matching one back up by hand.
    const planRow = grant("seats", 2, "starter");
    const diff = planGrantDiff([planRow, addon], grantsForPlan(PRO, { grants_seats: 10 }));

    expect(diff.change[0]?.previous).toBe(planRow);
    expect(diff.remove).not.toContain(planRow);
    expect(diff.add.map((g) => g.feature)).not.toContain("seats");
  });

  it("leaves a support grant and a manual override alone too", () => {
    // Same bug, the sources a human writes by hand — the ones with nobody
    // holding a receipt for them.
    const diff = planGrantDiff(
      [grant("seats", 2, "starter"), support, override],
      grantsForPlan(PRO, { grants_seats: 10 }),
    );

    expect(diff.remove).toEqual([]);
    expect(diff.change.map((c) => c.previous.source)).toEqual(["plan"]);
  });

  it("does not revoke an add-on when the new plan drops the feature", () => {
    const diff = planGrantDiff(
      [grant("seats", 2, "starter"), addon],
      grantsForPlan(PRO, { grants_projects: 3 }),
    );

    expect(diff.remove).toEqual([grant("seats", 2, "starter")]);
    expect(diff.add).toEqual([grant("projects", 3, "pro")]);
  });

  it("does not revoke an add-on when the plan is cancelled outright", () => {
    // next is empty, which is a cancellation of the PLAN. The seat pack the
    // customer bought separately is still paid for.
    const diff = planGrantDiff([grant("seats", 2, "starter"), addon], []);

    expect(diff.remove).toEqual([grant("seats", 2, "starter")]);
    expect(diff.change).toEqual([]);
    expect(diff.add).toEqual([]);
  });

  it("reconciles duplicates only within one source", () => {
    // Two plan rows for seats is a scar to clean up. A plan row plus an add-on
    // row for seats is the design working.
    const diff = planGrantDiff(
      [grant("seats", 2, "starter"), grant("seats", 4, "legacy"), addon],
      grantsForPlan(PRO, { grants_seats: 10 }),
    );

    expect(diff.remove).toEqual([grant("seats", 4, "legacy")]);
    expect(diff.change.map((c) => c.previous)).toEqual([grant("seats", 2, "starter")]);
  });

  it("adds a plan row for a feature only another source holds", () => {
    // The tenant holds seats via an add-on and the new plan grants seats too.
    // Those are separate rows on separate index keys, so this is an INSERT —
    // upserting onto the add-on's row would fold the two into one and lose the
    // add-on the moment the plan changes again.
    const diff = planGrantDiff([addon], grantsForPlan(PRO, { grants_seats: 10 }));

    expect(diff.add).toEqual([grant("seats", 10, "pro")]);
    expect(diff.remove).toEqual([]);
    expect(diff.change).toEqual([]);
  });
});

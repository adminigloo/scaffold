/**
 * Where an entitlement row came from.
 *
 * PROVENANCE, NOT PRECEDENCE. Every live row for a feature sums, whatever its
 * source; `override` records how the row got there (an admin set it by hand),
 * not that it beats the plan. Making one source win reads well and behaves
 * badly: an override of 0 would silently swallow a paid add-on, and there would
 * be no row left to point at when the customer asks where their seats went. An
 * override that must REDUCE a limit is written as a negative row, which sums
 * like any other.
 */
export type EntitlementSource = "plan" | "addon" | "grant" | "override";

/** One `entitlements` row, reduced to the fields the resolver reads. */
export interface EntitlementRow {
  readonly feature: string;
  /** NULL means unlimited. Not unknown, and not zero. */
  readonly limitValue: number | null;
  readonly usedValue: number;
  readonly source: EntitlementSource;
  /** NULL means it never expires. */
  readonly expiresAt: Date | null;
}

export interface ResolvedEntitlement {
  /** Summed across live rows. NULL when any one of them is unlimited. */
  readonly limit: number | null;
  /** Summed across live rows, and NOT clamped — see resolveEntitlements. */
  readonly used: number;
  /** NULL when unlimited. Never negative. */
  readonly remaining: number | null;
  readonly unlimited: boolean;
}

/**
 * Collapse a tenant's entitlement rows into one answer per feature.
 *
 * Takes rows and returns a Map: computed once per request, from one query, the
 * same shape `resolvePermissionSet` uses. A per-feature query is how a page
 * that renders twelve gated components issues twelve round trips.
 *
 * `now` is a parameter so the expiry boundary is testable without faking a
 * clock, and so every feature on a page is resolved against ONE instant —
 * `new Date()` per row can expire a grant halfway down a render.
 */
export function resolveEntitlements(
  rows: readonly EntitlementRow[],
  now: Date = new Date(),
): ReadonlyMap<string, ResolvedEntitlement> {
  const nowMs = now.getTime();
  const totals = new Map<string, { limit: number; used: number; unlimited: boolean }>();

  for (const row of rows) {
    /**
     * Expired rows are dropped whole — limit AND usage.
     *
     * Closed boundary, matching `invitationState` in @adminigloo/tenancy: an
     * entitlement is expired at the instant it expires. The open form leaves a
     * seat spendable for the millisecond it is stamped dead, which never
     * reproduces in production and never stops flaking in tests.
     */
    if (row.expiresAt !== null && row.expiresAt.getTime() <= nowMs) continue;

    const total = totals.get(row.feature) ?? { limit: 0, used: 0, unlimited: false };

    // Usage is counted even on a row whose limit is unlimited. Consumption is a
    // fact about the tenant, not a property of the plan that paid for it; drop
    // it and the number falls off a cliff the day the unlimited add-on expires,
    // handing back seats that are still occupied.
    total.used += row.usedValue;

    // One unlimited row wins the feature. Summing `null` as 0 would let an
    // unlimited add-on be capped by the plan sitting beside it — the exact
    // opposite of what the customer bought.
    if (row.limitValue === null) total.unlimited = true;
    // A negative limit (an override that takes capacity away) sums like any
    // other and can only reduce the total, so bad data fails closed.
    else total.limit += row.limitValue;

    totals.set(row.feature, total);
  }

  const resolved = new Map<string, ResolvedEntitlement>();
  for (const [feature, total] of totals) {
    resolved.set(feature, {
      limit: total.unlimited ? null : total.limit,
      used: total.used,
      /**
       * `remaining` clamps at 0; `limit` and `used` do not.
       *
       * Over-consumption is real — a plan was downgraded, or two invitations
       * raced past the same check — and it has to stay visible: 7 seats against
       * a limit of 5 must render as "7 of 5 used", not as a tidy "0 remaining"
       * with the overage erased and nobody accountable for it. Only the number
       * that gates the next write is clamped, because a negative `remaining` is
       * truthy, so `if (remaining)` waves the write through at exactly the
       * moment it should not.
       */
      remaining: total.unlimited ? null : Math.max(0, total.limit - total.used),
      unlimited: total.unlimited,
    });
  }
  return resolved;
}

export type EntitlementReason = "ok" | "no-entitlement" | "limit-reached";

export interface EntitlementCheck {
  readonly allowed: boolean;
  /** NULL ONLY when the feature is unlimited. A feature nobody holds is 0. */
  readonly remaining: number | null;
  readonly reason: EntitlementReason;
}

export class InvalidEntitlementAmountError extends Error {
  readonly name = "InvalidEntitlementAmountError";
  constructor(amount: number) {
    super(
      `checkEntitlement was asked about ${amount} units, which is not a finite ` +
        `count >= 0. This is almost always Number(userInput) producing NaN, and ` +
        `NaN must not be swallowed here: every comparison against it is false, ` +
        `so a limited feature would deny and an UNLIMITED one would allow — the ` +
        `same bad input silently taking two different paths.`,
    );
  }
}

/**
 * May this tenant consume `amount` of `feature`?
 *
 * Returns a REASON, not a boolean. "You have used all 5 seats — remove someone
 * or upgrade" and "your plan does not include seats at all" are different
 * sentences with different buttons under them, and a boolean forces every
 * caller to re-derive which one to show, from a map it often does not have.
 * Every caller that guesses picks the generic denial, so the upsell never
 * renders and the limit looks like a bug.
 */
export function checkEntitlement(
  resolved: ReadonlyMap<string, ResolvedEntitlement>,
  feature: string,
  amount = 1,
): EntitlementCheck {
  if (!Number.isFinite(amount) || amount < 0) throw new InvalidEntitlementAmountError(amount);

  const entitlement = resolved.get(feature);
  if (!entitlement) {
    // `remaining: 0`, never null. Null means UNLIMITED in this shape, and a UI
    // rendering `remaining ?? "unlimited"` would advertise unlimited access to
    // a feature the tenant has never bought.
    return { allowed: false, remaining: 0, reason: "no-entitlement" };
  }

  if (entitlement.unlimited) return { allowed: true, remaining: null, reason: "ok" };

  // Non-null whenever `unlimited` is false; the fallback is for the type, not
  // for a case that can occur.
  const remaining = entitlement.remaining ?? 0;
  return remaining >= amount
    ? { allowed: true, remaining, reason: "ok" }
    : { allowed: false, remaining, reason: "limit-reached" };
}

import type { EntitlementSource } from "./entitlements.js";
import {
  IDENTITY_SEPARATOR,
  InvalidGrantLimitError,
  InvalidPlanKeyError,
  type PlanTier,
} from "./plans.js";

/**
 * The bridge between the plan record and the entitlements table.
 *
 * `plans.ts` says what a tier includes; this says what rows a tenant on that
 * tier has to hold, and what to write when they move between tiers. Both take
 * the RECORD as their input, which is the whole point: a pricing page and an
 * enforcement check that read two different descriptions of Pro will eventually
 * describe two different Pros, and the one the customer read is the one they
 * will hold you to.
 *
 * The declarations used to arrive as a flat `grants_*` bag — a settings blob, a
 * Stripe product's metadata — which is why a prefix was needed to tell a feature
 * from a `sort_order` sitting beside it. A typed record has no unrelated keys in
 * it, so the prefix, and the whole class of "an unrelated setting silently
 * became a feature", is gone.
 */

/** One entitlement row a purchase creates, before a tenant is attached. */
export interface PlanGrant {
  readonly feature: string;
  /** NULL is unlimited. */
  readonly limitValue: number | null;
  readonly source: EntitlementSource;
  /** `plans.key`. Never empty — see the COALESCE on the unique index. */
  readonly sourceRef: string;
}

/**
 * The entitlement rows a subscription to `tier` creates.
 *
 * No tenant id and no `usedValue`: this describes what the tier grants, and the
 * writer supplies the tenant. Staying tenant-free is what makes it testable with
 * no database, and what lets the result be diffed against the rows a tenant
 * already holds.
 *
 * `source` is always `plan` and `sourceRef` is always the TIER key, which is the
 * pair the unique index keys on — so applying the same tier twice upserts onto
 * the same rows and is a no-op, however many times the webhook is redelivered. A
 * row with no `sourceRef` would be exempt from that (Postgres treats NULLs as
 * distinct), which is why this never emits one.
 *
 * THE TIER KEY, NOT THE `plans.key`. A tier projects one row per (interval,
 * currency) and the customer is subscribed to exactly one of them, but moving
 * from monthly to yearly does not change what they are entitled to. If the ref
 * carried the cadence, that billing change would rewrite every entitlement row
 * the tenant holds, and each rewrite is a chance to lose `used_value`.
 *
 * WHAT EACH KIND BECOMES, and why:
 *
 *   quota   the limit, straight through. `null` stays unlimited.
 *   flag    1 or 0. Zero rather than no row at all, because `entitlements`
 *           treats a limit of 0 as a feature explicitly WITHHELD — the row stays
 *           for the audit trail, and it still sums, so buying an add-on that
 *           grants the same feature turns it on rather than being capped by a
 *           plan that does not include it.
 *   option  NOTHING. Entitlement rows sum, and there is no sum of "every 10
 *           minutes" and "every minute". An option is read off the tier through
 *           `planAllows`; putting one in this table would produce a row whose
 *           limit is a number nobody can interpret.
 *
 * Sorted by feature so two calls produce identical output — the diff of a write
 * plan is otherwise pure noise.
 */
export function grantsForPlan(tier: PlanTier): readonly PlanGrant[] {
  // Re-checked here as well as in `definePlans`, which is not duplication: this
  // is the function that writes the ref, `PlanTier` is a plain interface that a
  // caller can build by hand, and the type cannot say "a non-empty slug".
  if (tier.key.length === 0) {
    throw new InvalidPlanKeyError(tier.key, "it is empty.");
  }

  const grants: PlanGrant[] = [];
  for (const feature of Object.values(tier.features)) {
    if (feature.kind === "option") continue;

    const limitValue =
      feature.kind === "quota" ? feature.limit : feature.included ? 1 : 0;

    if (limitValue !== null && (!Number.isInteger(limitValue) || limitValue < 0)) {
      throw new InvalidGrantLimitError(tier.key, feature.feature, limitValue);
    }

    grants.push({
      feature: feature.feature,
      limitValue,
      source: "plan",
      sourceRef: tier.key,
    });
  }

  return grants.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
}

export interface PlanGrantChange {
  readonly feature: string;
  /** The row as it stands. UPDATE this one. */
  readonly previous: PlanGrant;
  /** What it must become — including the new `sourceRef`. */
  readonly next: PlanGrant;
}

export interface PlanGrantDiff {
  readonly add: readonly PlanGrant[];
  readonly remove: readonly PlanGrant[];
  readonly change: readonly PlanGrantChange[];
}

/**
 * The part of an entitlement's identity that a plan change may NOT rewrite.
 *
 * The unique index keys on (tenant, feature, source, coalesce(source_ref, '')).
 * The tenant is the same on both sides of a diff and the ref is the one field an
 * upgrade moves, so (source, feature) is what two rows must share to be the same
 * row. NUL as the separator because feature names are chosen by whoever writes
 * the plan catalog and can contain any printable character: with "-" as the
 * separator, source `plan` + feature `-seats` and source `plan-` + feature
 * `seats` produce one key, and one row silently reconciles against the other.
 * `definePlans` refuses a feature name containing NUL, which is what closes the
 * same hole from the other end.
 */
function rowIdentity(grant: PlanGrant): string {
  return `${grant.source}${IDENTITY_SEPARATOR}${grant.feature}`;
}

/**
 * What to write when a tenant moves onto `next`, or off a plan entirely.
 *
 * `current` is the rows the tenant ACTUALLY HOLDS, read from the database —
 * every source, not just the plan's. `next` is a tier from the record, or `null`
 * for a cancellation. Taking the tier rather than a second list of grants is
 * what keeps the two halves of a plan change reading the same description: a
 * caller that could hand-assemble `next` is a caller that can hand-assemble a
 * Pro that the pricing page has never heard of.
 *
 * MATCHED BY (source, feature). Sources are additive and coexist by design — a
 * plan grants 5 seats, an add-on grants 3 more, support grants 2 for a month,
 * and the unique index keeps all three as separate rows. Matching on `feature`
 * alone made the add-on row indistinguishable from a stale plan row, so a plan
 * change removed it: capacity a human deliberately bought or granted, revoked by
 * an upgrade, with nothing in the resulting diff that looks wrong.
 *
 * `sourceRef` is the one part of that identity the match ignores, because an
 * upgrade rewrites it — `starter` becomes `pro`. Matching on it would classify
 * every row as a removal plus an insertion, which is exactly the
 * delete-and-recreate this function exists to prevent. `used_value` lives on the
 * row: recreating it resets a tenant's 4 seats in use to 0, and they invite four
 * more people they are not paying for. A customer who has spent 400 of 500
 * exports and moves to a tier with 5000 must still have spent 400, and the only
 * way to keep that number is to UPDATE the row it sits on.
 *
 * `change` therefore also fires when only the ref moved and the limit is
 * identical — the row still has to be UPDATEd to point at the new tier, or the
 * next diff goes on believing the tenant is on the old one and removes the row
 * as orphaned.
 *
 * ONLY `plan` ROWS ARE EVER REMOVED. `grantsForPlan` emits nothing else, so this
 * diff owns nothing else; an add-on the customer bought separately, or seats
 * support granted, survive a downgrade and a cancellation untouched. That used
 * to be inferred from whatever sources happened to appear in `next`, with a
 * special case for the empty list. With a tier as the input there is nothing to
 * infer.
 *
 * Re-applying the same tier yields three empty lists.
 */
export function planGrantDiff(
  current: readonly PlanGrant[],
  next: PlanTier | null,
): PlanGrantDiff {
  const target = next === null ? [] : grantsForPlan(next);
  const nextByIdentity = new Map(target.map((grant) => [rowIdentity(grant), grant]));

  // Non-empty tuples, so the "which row do we keep" branch below does not need
  // an undefined check for a case that cannot happen.
  const currentByIdentity = new Map<string, [PlanGrant, ...PlanGrant[]]>();
  for (const grant of current) {
    const key = rowIdentity(grant);
    const bucket = currentByIdentity.get(key);
    if (bucket) bucket.push(grant);
    else currentByIdentity.set(key, [grant]);
  }

  const add: PlanGrant[] = [];
  const remove: PlanGrant[] = [];
  const change: PlanGrantChange[] = [];

  for (const [key, wanted] of nextByIdentity) {
    const existing = currentByIdentity.get(key);
    if (!existing) {
      add.push(wanted);
      continue;
    }

    // Prefer the row that already points at this tier, so re-applying the same
    // tier is genuinely a no-op instead of rewriting whichever duplicate the
    // database happened to return first.
    const keep = existing.find((grant) => grant.sourceRef === wanted.sourceRef) ?? existing[0];

    if (keep.limitValue !== wanted.limitValue || keep.sourceRef !== wanted.sourceRef) {
      change.push({ feature: wanted.feature, previous: keep, next: wanted });
    }

    // More than one row for one (source, feature) is the scar of an earlier
    // upgrade that inserted where it should have updated. Reconcile down to one:
    // left alone they sum in resolveEntitlements, so the tenant quietly holds
    // double the limit and every later diff preserves the extra row.
    for (const extra of existing) if (extra !== keep) remove.push(extra);
  }

  for (const [key, existing] of currentByIdentity) {
    if (nextByIdentity.has(key)) continue;
    // Plan rows only. An add-on or a support grant that happens to name the same
    // feature as a plan entitlement is not an orphan of the old plan, and
    // removing it revokes capacity nobody asked to have removed.
    for (const grant of existing) if (grant.source === "plan") remove.push(grant);
  }

  return { add, remove, change };
}

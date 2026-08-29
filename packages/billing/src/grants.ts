import type { EntitlementSource } from "./entitlements.js";

/**
 * The prefix that marks a key as a feature limit.
 *
 * Grant declarations arrive as a flat record — plan settings, a Stripe product's
 * metadata, a constant in app code — and those bags always carry other keys.
 * The prefix is what stops `trial_days` or `sort_order` being read as a feature;
 * without it, adding an unrelated setting to a plan silently grants every
 * subscriber a feature named after it, with that setting's value as the limit.
 */
export const GRANT_PREFIX = "grants_";

/**
 * What a plan declares, keyed `grants_<feature>`. `null` is unlimited, matching
 * `entitlements.limit_value`.
 */
export type FeatureGrants = Readonly<Record<string, number | null>>;

/** Only the part of a plan a grant needs. A full row satisfies it. */
export interface PlanRef {
  readonly key: string;
}

/** One entitlement row a purchase creates, before a tenant is attached. */
export interface PlanGrant {
  readonly feature: string;
  /** NULL is unlimited. */
  readonly limitValue: number | null;
  readonly source: EntitlementSource;
  /** `plans.key`. Never empty — see the COALESCE on the unique index. */
  readonly sourceRef: string;
}

export class EmptyPlanKeyError extends Error {
  readonly name = "EmptyPlanKeyError";
  constructor() {
    super(
      `grantsForPlan was given a plan with an empty key. The key becomes ` +
        `entitlements.source_ref, and the unique index indexes ` +
        `coalesce(source_ref, '') — so an empty key collides with every manual ` +
        `grant that has no ref at all, and the two would upsert over each other.`,
    );
  }
}

export class InvalidGrantLimitError extends Error {
  readonly name = "InvalidGrantLimitError";
  constructor(planKey: string, feature: string, limit: number) {
    super(
      `Plan "${planKey}" declares ${GRANT_PREFIX}${feature} = ${limit}. A plan ` +
        `grant must be a whole number >= 0, or null for unlimited. A fraction ` +
        `would be written into an integer column and silently truncated by the ` +
        `driver, and a negative grant is a plan that takes capacity away — which ` +
        `is an override, deliberately written as a negative row by an admin, not ` +
        `something a purchase should do behind one.`,
    );
  }
}

/**
 * The entitlement rows a purchase of `plan` creates.
 *
 * No tenant id and no `usedValue`: this describes what the plan grants, and the
 * writer supplies the tenant. Staying tenant-free is what makes it testable
 * with no database, and what lets the result be diffed against the rows a
 * tenant already holds.
 *
 * `source` is always `plan` and `sourceRef` is always the plan key, which is the
 * pair the unique index keys on — so applying the same plan twice upserts onto
 * the same rows and is a no-op, however many times the webhook is redelivered.
 * A row with no `sourceRef` would be exempt from that (Postgres treats NULLs as
 * distinct), which is why this never emits one.
 *
 * The declarations are passed in rather than read off the plan row on purpose:
 * `plans` has no settings blob, because a limit that can be edited in a table
 * re-entitles every subscriber the moment somebody saves the form, with no
 * deploy and no review.
 *
 * Sorted by feature so two calls produce identical output — the diff of a write
 * plan is otherwise pure noise.
 */
export function grantsForPlan(plan: PlanRef, features: FeatureGrants): readonly PlanGrant[] {
  if (plan.key.length === 0) throw new EmptyPlanKeyError();

  const grants: PlanGrant[] = [];
  for (const [declared, limit] of Object.entries(features)) {
    if (!declared.startsWith(GRANT_PREFIX)) continue;

    const feature = declared.slice(GRANT_PREFIX.length);
    // `grants_` on its own names no feature. Emitting it would create a row
    // keyed on the empty string, which every later lookup misses and no admin
    // screen can display.
    if (feature.length === 0) continue;

    if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
      throw new InvalidGrantLimitError(plan.key, feature, limit);
    }

    grants.push({ feature, limitValue: limit, source: "plan", sourceRef: plan.key });
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
 * The tenant is the same on both sides of a diff and the ref is the one field
 * an upgrade moves, so (source, feature) is what two rows must share to be the
 * same row. NUL as the separator because feature names come from plan settings
 * keys and can contain any printable character a human types: with "-" as the
 * separator, source `plan` + feature `-seats` and source `plan-` + feature
 * `seats` produce one key, and one row silently reconciles against the other.
 */
function rowIdentity(grant: PlanGrant): string {
  return `${grant.source}\u0000${grant.feature}`;
}

/**
 * What to write when a tenant moves from one plan's grants to another's.
 *
 * MATCHED BY (source, feature). Sources are additive and coexist by design — a
 * plan grants 5 seats, an add-on grants 3 more, support grants 2 for a month,
 * and the unique index keeps all three as separate rows. Matching on `feature`
 * alone made the add-on row indistinguishable from a stale plan row, so a plan
 * change removed it: capacity a human deliberately bought or granted, revoked
 * by an upgrade, with nothing in the resulting diff that looks wrong.
 *
 * `sourceRef` is the one part of that identity the match ignores, because an
 * upgrade rewrites it — `starter` becomes `pro`. Matching on it would classify
 * every row as a removal plus an insertion, which is exactly the
 * delete-and-recreate this function exists to prevent. `used_value` lives on
 * the row: recreating it resets a tenant's 4 seats in use to 0, and they invite
 * four more people they are not paying for. Nothing about the result looks
 * wrong afterwards.
 *
 * `change` therefore also fires when only the ref moved and the limit is
 * identical — the row still has to be UPDATEd to point at the new plan, or the
 * next diff goes on believing the tenant is on the old one and removes the row
 * as orphaned.
 *
 * Re-applying the same plan yields three empty lists.
 */
export function planGrantDiff(
  current: readonly PlanGrant[],
  next: readonly PlanGrant[],
): PlanGrantDiff {
  const nextByIdentity = new Map(next.map((grant) => [rowIdentity(grant), grant]));

  // Non-empty tuples, so the "which row do we keep" branch below does not need
  // an undefined check for a case that cannot happen.
  const currentByIdentity = new Map<string, [PlanGrant, ...PlanGrant[]]>();
  for (const grant of current) {
    const key = rowIdentity(grant);
    const bucket = currentByIdentity.get(key);
    if (bucket) bucket.push(grant);
    else currentByIdentity.set(key, [grant]);
  }

  /**
   * Which sources this diff may DELETE from. `next` names them: it is one
   * origin's grants, and `grantsForPlan` only ever emits `plan`. An empty
   * `next` is a cancellation, which is still about the plan.
   *
   * Everything else in `current` is another origin's row and survives
   * untouched. A cancelled plan must not take the add-on the customer bought
   * separately, or the seats support granted, with it.
   */
  const owned: ReadonlySet<EntitlementSource> =
    next.length > 0
      ? new Set(next.map((grant) => grant.source))
      : new Set<EntitlementSource>(["plan"]);

  const add: PlanGrant[] = [];
  const remove: PlanGrant[] = [];
  const change: PlanGrantChange[] = [];

  for (const [key, target] of nextByIdentity) {
    const existing = currentByIdentity.get(key);
    if (!existing) {
      add.push(target);
      continue;
    }

    // Prefer the row that already points at this plan, so re-applying the same
    // plan is genuinely a no-op instead of rewriting whichever duplicate the
    // database happened to return first.
    const keep = existing.find((grant) => grant.sourceRef === target.sourceRef) ?? existing[0];

    if (keep.limitValue !== target.limitValue || keep.sourceRef !== target.sourceRef) {
      change.push({ feature: target.feature, previous: keep, next: target });
    }

    // More than one row for one (source, feature) is the scar of an earlier
    // upgrade that inserted where it should have updated. Reconcile down to
    // one: left alone they sum in resolveEntitlements, so the tenant quietly
    // holds double the limit and every later diff preserves the extra row.
    for (const extra of existing) if (extra !== keep) remove.push(extra);
  }

  for (const [key, existing] of currentByIdentity) {
    if (nextByIdentity.has(key)) continue;
    // Only rows this diff owns. An add-on or a support grant that happens to
    // name the same feature as a plan entitlement is not an orphan of the old
    // plan, and removing it revokes capacity nobody asked to have removed.
    for (const grant of existing) if (owned.has(grant.source)) remove.push(grant);
  }

  return { add, remove, change };
}

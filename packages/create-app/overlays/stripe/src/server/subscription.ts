import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  decideSubscriptionWrite,
  isLiveStatus,
  LIVE_SUBSCRIPTION_STATUSES,
  mapStripeSubscriptionStatus,
  planGrantDiff,
  planLineRefs,
  planRowKey,
  subscriptionEntitlementWindow,
  type EntitlementWindow,
  type PlanGrant,
  type PlanTier,
  type SubscriptionStatus,
} from "__SCOPE__/billing";
import { entitlements, plans as planTable, subscriptions } from "__SCOPE__/billing/schema";
import { lineOfStoredRow } from "__SCOPE__/billing/server";
import type { StripeSubscriptionItemSnapshot, StripeSubscriptionSnapshot } from "__SCOPE__/stripe";
import { auditEntry, defineAuditedActions } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db, type Db } from "@/db";
import { plans } from "@/plans";

/**
 * THE ONE PLACE A SUBSCRIPTION BECOMES A ROW AND A SET OF ENTITLEMENTS.
 *
 * `customer.subscription.created`, `.updated` and `.deleted` call it. The two
 * invoice events call it. Cancel and resume call it. The staff resync calls it.
 * The "Simulate a subscription" button calls it. Nothing else may write
 * `subscriptions`, and that single shared call site is the same design
 * `fulfilPurchase` is built on and for the same reason: a deployment with no
 * Stripe keys exercises the real mirroring path every day, so the first real
 * webhook runs code that has already worked a hundred times.
 *
 * The alternative — a simulated path that writes its own row — drifts in the
 * one direction nobody tests. The simulated one is exercised during
 * development; the real one is exercised for the first time by a paying
 * customer whose entitlements do not appear.
 *
 * *** WHY THIS MATTERS MORE HERE THAN FOR AN ORDER. *** The firm owns
 * `subscriptions`, so the table is not a cache of Stripe that a later read
 * repairs — it is the authority the product answers from. A missed or
 * misapplied event leaves it AUTHORITATIVE AND WRONG: the customer is charged
 * and holds nothing, or has cancelled and is still served, and neither shows up
 * anywhere until somebody complains. Every guard below exists because of that
 * asymmetry.
 *
 * WHAT NEVER COMES FROM A CALLER: what a tier includes. That is read from the
 * plan record in `src/plans.ts` through `grantsForPlan`, so the entitlements a
 * subscriber holds and the bullet list the pricing page renders are the same
 * object. The caller supplies an identity — which tenant, which tier, which
 * Stripe subscription, in what state, observed when — and nothing that decides
 * what anybody is entitled to.
 *
 * THIS MODULE NEVER IMPORTS STRIPE. Not the client, not the SDK types. It is
 * called from a Stripe webhook, but nothing about recording a subscription
 * depends on Stripe existing — which is exactly what lets the simulated path
 * run the same code rather than a copy of it. `subscriptionSnapshot` in
 * @__SCOPE_NAME__/stripe is the adapter, and it lives on the other side of the
 * line.
 */

// ---------------------------------------------------------------------------
// Identity of a subscription
// ---------------------------------------------------------------------------

/**
 * Which path produced this subscription.
 *
 * Not cosmetic, and the same argument `FulfilmentSource` makes: "was this real
 * money?" is the first question anyone asks about a suspicious grant, and it
 * has to be answerable from stored rows six months later by somebody who has
 * never read this file. Here it is answerable from the audit action alone.
 */
export type SubscriptionSource = "stripe" | "simulated";

/** A reference for a subscription Stripe is billing. */
const STRIPE_SUBSCRIPTION_PATTERN = /^sub_[A-Za-z0-9_]+$/;

/**
 * A reference for a subscription nobody is paying for.
 *
 * `simsub_` rather than a bare UUID so the distinction survives into the audit
 * metadata, where a support engineer meets it without needing this file. It is
 * deliberately NOT written into `subscriptions.stripe_subscription_id`: that
 * column names an object in Stripe, every dashboard and refund tool reading it
 * believes so, and `bookOrder` makes exactly this call about
 * `orders.stripe_payment_intent_id`. A simulated subscription leaves it NULL,
 * which is the value the schema already documents for "a comped subscription an
 * admin granted has no Stripe object".
 */
const SIMULATED_SUBSCRIPTION_PATTERN = /^simsub_[0-9a-f-]{36}$/;

export function simulatedSubscriptionRef(): string {
  return `simsub_${randomUUID()}`;
}

/** Reads back which path produced a subscription, from its reference alone. */
export function sourceOfSubscriptionRef(reference: string): SubscriptionSource | null {
  if (STRIPE_SUBSCRIPTION_PATTERN.test(reference)) return "stripe";
  if (SIMULATED_SUBSCRIPTION_PATTERN.test(reference)) return "simulated";
  return null;
}

export class InvalidSubscriptionReferenceError extends Error {
  readonly name = "InvalidSubscriptionReferenceError";
  constructor(reference: string, source: SubscriptionSource) {
    super(
      `"${reference}" is not a valid ${source} subscription reference. A Stripe ` +
        `mirror must be keyed on the Subscription id (sub_…) and a simulated ` +
        `one on simulatedSubscriptionRef() (simsub_…). The reference is what ` +
        `finds the row again, so a malformed one either mirrors every ` +
        `subscription onto a single row or creates a second one on every event.`,
    );
  }
}

export class PlanNotResolvedError extends Error {
  readonly name = "PlanNotResolvedError";
  constructor(readonly detail: string) {
    super(
      `${detail} A subscription cannot be recorded without a plan: ` +
        `subscriptions.plan_id is NOT NULL, and a row that named no plan would ` +
        `read as a tenant paying for nothing — status "active", entitlements ` +
        `empty, a paying customer on the free tier. Failing here answers the ` +
        `webhook 500 so Stripe redelivers and the event stays visible in the ` +
        `dashboard until somebody looks.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * One key per thing that can happen to a subscription, not one key with the
 * verb in metadata.
 *
 * `action` is an indexed column and `metadata` is jsonb nobody indexes. "Show
 * me every subscription that was granted without a payment" and "show me
 * everything staff re-pulled from Stripe on the day the numbers went wrong" are
 * the two questions this log gets asked during an incident, and both have to be
 * cheap. Same argument `fulfilmentAuditedActions` makes for splitting a
 * simulated order from a real one.
 */
export const subscriptionAuditedActions = {
  "billing.subscription.mirrored": {
    label: "Recorded a subscription's state from Stripe and applied its plan's grants",
  },
  "billing.subscription.simulated": {
    label:
      "Recorded a SIMULATED subscription — no money moved. Only reachable " +
      "while Stripe is unconfigured on this deployment",
    /**
     * Sensitive, so it lands in the compliance slice rather than the firehose.
     * A subscription with no payment behind it grants everything a paid one
     * does, and that is precisely what a "who was given what" review is for.
     */
    sensitive: true,
  },
  "billing.subscription.cancelled": {
    label: "Scheduled a subscription to end when the paid period does",
  },
  "billing.subscription.resumed": {
    label: "Cancelled a scheduled cancellation, so the subscription renews again",
  },
  "billing.subscription.comped": {
    label: "Gave a company free months of a plan — no money moved",
    /** Sensitive: a plan with no payment behind it, given by a person. */
    sensitive: true,
  },
  "billing.subscription.resynced": {
    label: "Re-pulled subscription state from Stripe into the firm's own tables",
    /**
     * Sensitive. This is the one action that overwrites the authoritative
     * billing tables from outside the event stream, so "who changed what this
     * organisation is entitled to, and when" has to start from it.
     */
    sensitive: true,
  },
} as const satisfies Record<string, { label: string; sensitive?: boolean }>;

export const subscriptionAuditRegistry = defineAuditedActions(subscriptionAuditedActions);

export type SubscriptionAuditAction = keyof typeof subscriptionAuditedActions;

/**
 * Which action a write is recorded under.
 *
 * A parameter rather than derived from `source`, because cancel, resume and
 * resync are all `stripe`-sourced writes that a person deliberately performed
 * and an incident review has to tell apart. `source` still decides the default,
 * so a caller that says nothing cannot accidentally record a simulated
 * subscription as a real one.
 */
const DEFAULT_ACTION_FOR: Record<SubscriptionSource, SubscriptionAuditAction> = {
  stripe: "billing.subscription.mirrored",
  simulated: "billing.subscription.simulated",
};

// ---------------------------------------------------------------------------
// applySubscription
// ---------------------------------------------------------------------------

/** A Drizzle transaction handle, derived from the app's own db handle. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ApplySubscriptionInput {
  readonly tenantId: string;
  /** A tier key from the plan record — `pro`, not `pro:month:usd`. */
  readonly tierKey: string;
  /** `plans.key` — `<tier>:<interval>:<currency>`. The row that is being billed. */
  readonly planKey: string;
  /** `sub_…`, or NULL for a subscription with no Stripe object behind it. */
  readonly stripeSubscriptionId: string | null;
  /**
   * The Stripe ITEM that bills this line (`si_…`, billing 0.5). Omitted: the
   * row keeps the item it already names (cancel and resume don't move it).
   */
  readonly stripeItemId?: string | null;
  readonly stripeCustomerId: string | null;
  /** Already mapped through `mapStripeSubscriptionStatus`. Never a raw Stripe string. */
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly trialEndsAt: Date | null;
  /**
   * When this state was observed at Stripe — `event.created` for a webhook, the
   * instant of the fetch for a resync, now for a simulated write. THE
   * WATERMARK: see `decideSubscriptionWrite`.
   */
  readonly observedAt: Date;
  /** The delivery that carried it, so the row can be traced to `stripe_events`. */
  readonly observedBy?: string | null;
  readonly source: SubscriptionSource;
  /** Overrides the audit action. Cancel, resume and resync each name their own. */
  readonly action?: SubscriptionAuditAction;
  /** Who acted, when a person did. NULL for a webhook, which is not a person. */
  readonly actorUserId?: string | null;
}

export interface EntitlementOutcome {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  /** What every plan-sourced row's `expires_at` now holds. NULL is never. */
  readonly expiresAt: Date | null;
  /** Is the tenant served right now? */
  readonly serving: boolean;
  readonly why: string;
}

export interface ApplySubscriptionResult {
  /** Our `subscriptions.id`. NULL only when a stale event wrote nothing. */
  readonly subscriptionId: string | null;
  /**
   * FALSE means the observation was older than the one already applied and
   * nothing was written. Not an error — it is the normal answer to an
   * out-of-order delivery, and a caller must treat it as success or Stripe will
   * redeliver an event that is correctly being ignored.
   */
  readonly applied: boolean;
  readonly created: boolean;
  readonly status: SubscriptionStatus;
  readonly why: string;
  readonly entitlements: EntitlementOutcome | null;
  /**
   * TRUE when the subscription belongs to a company that has been deleted
   * (create-app 0.37): nothing was written, on purpose. Like a stale event it
   * is a success to acknowledge, or Stripe redelivers it for three days.
   */
  readonly tenantGone?: true;
}

/**
 * Record what a subscription is, and make the tenant's entitlements agree.
 *
 * ONE TRANSACTION. The subscription row, every entitlement change and the audit
 * line commit together or not at all. Without that, a grant that throws leaves
 * a committed subscription behind, the webhook answers 500, Stripe redelivers,
 * the watermark now says the state is already applied, and the entitlements are
 * skipped for ever — a customer charged for a plan they never receive, with a
 * row saying they have it.
 *
 * THE ORDER OF THE FOUR STEPS IS THE LOGIC:
 *
 *  1. RESOLVE THE PLAN. Before anything is written, because a subscription with
 *     no plan cannot be recorded at all and finding that out after the row is
 *     in would mean a rollback either way.
 *  2. DECIDE WHETHER THIS IS NEWS. `decideSubscriptionWrite` against the
 *     watermark on the row. A stale delivery returns here and writes nothing —
 *     no row, no entitlements, no audit line, because none of them happened.
 *  3. WRITE THE ROW, having first made room for it: the database permits at
 *     most one live subscription per tenant, so a live incoming state
 *     supersedes any other live row rather than colliding with the partial
 *     unique index and wedging the endpoint.
 *  4. RECONCILE THE ENTITLEMENTS through `planGrantDiff`, so an upgrade UPDATEs
 *     the rows it already holds and `used_value` survives — somebody who has
 *     spent 400 of 500 exports has still spent 400 on the tier above.
 */
export async function applySubscription(
  input: ApplySubscriptionInput,
): Promise<ApplySubscriptionResult> {
  if (input.stripeSubscriptionId !== null) {
    if (!STRIPE_SUBSCRIPTION_PATTERN.test(input.stripeSubscriptionId)) {
      throw new InvalidSubscriptionReferenceError(input.stripeSubscriptionId, "stripe");
    }
  } else if (input.source === "stripe") {
    throw new InvalidSubscriptionReferenceError("", "stripe");
  }

  return db.transaction((tx) => writeSubscription(tx, input));
}

async function writeSubscription(
  tx: Tx,
  input: ApplySubscriptionInput,
): Promise<ApplySubscriptionResult> {
  // ---- 0. a company that's gone -------------------------------------------
  //
  // Deleting a company forgets its subscription and entitlement rows, and a
  // forced delete leaves the subscription live at Stripe. Its next event (the
  // cancel staff make afterwards, next month's invoice.paid) must not write
  // them back: a row for a company that no longer exists, re-granting a plan
  // to nobody. Read under a share lock on the company's row, so a delete committing
  // alongside is seen before this writes (and waits for it if it starts after).
  const [company] = await tx
    .select({ deletedAt: tenants.deletedAt })
    .from(tenants)
    .where(eq(tenants.id, input.tenantId))
    .limit(1)
    .for("share");
  if (company?.deletedAt) {
    return {
      subscriptionId: null,
      applied: false,
      created: false,
      status: input.status,
      why: `The ${input.tenantId} company was deleted on ${company.deletedAt.toISOString()}: nothing written. If Stripe is still charging it, cancel the subscription there.`,
      entitlements: null,
      tenantGone: true,
    };
  }

  // ---- 1. the plan --------------------------------------------------------
  //
  // The TIER comes from the record and the ROW comes from the table, and both
  // are required: the tier says what the subscriber is entitled to and the row
  // is what `subscriptions.plan_id` points at. They are checked separately
  // because the two failures have two different fixes — a tier missing from the
  // record is a deploy, a row missing from the table is `pnpm db:seed:plans`.
  const tier = plans.tier(input.tierKey);
  if (tier === undefined) {
    throw new PlanNotResolvedError(
      `No tier in src/plans.ts is keyed "${input.tierKey}".`,
    );
  }
  // THE LINE COMES FROM THE TIER (billing 0.5), never from a caller: the row,
  // the one-live-per-line slot it takes and the entitlement rows it may touch
  // are all that line's. A one-line catalog has one line, so every row is on it.
  const line = tier.line;

  const [planRow] = await tx
    .select({ id: planTable.id, isActive: planTable.isActive })
    .from(planTable)
    .where(eq(planTable.key, input.planKey))
    .limit(1);

  if (!planRow) {
    throw new PlanNotResolvedError(
      `The plans table holds no row keyed "${input.planKey}", which is what ` +
        `src/plans.ts projects for that tier. Run \`pnpm db:seed:plans\`.`,
    );
  }

  // ---- 2. is this news? ---------------------------------------------------
  const existing = await findSubscriptionRow(tx, input, line);

  const decision = decideSubscriptionWrite({
    observedAt: input.observedAt,
    observedTerminal: input.status === "canceled",
    storedAt: existing?.lastEventAt ?? null,
    storedTerminal: existing?.status === "canceled",
  });

  if (decision.action === "skip") {
    return {
      subscriptionId: existing?.id ?? null,
      applied: false,
      created: false,
      // The status we still hold, not the one we refused — a caller logging
      // this must not report a state that was never applied.
      status: existing?.status ?? input.status,
      why: decision.why,
      entitlements: null,
    };
  }

  // ---- 3. the row ---------------------------------------------------------
  const window = subscriptionEntitlementWindow({
    status: input.status,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    currentPeriodEnd: input.currentPeriodEnd,
    at: input.observedAt,
  });

  const values = {
    tenantId: input.tenantId,
    planId: planRow.id,
    line,
    stripeSubscriptionId: input.stripeSubscriptionId,
    ...(input.stripeItemId !== undefined ? { stripeItemId: input.stripeItemId } : {}),
    stripeCustomerId: input.stripeCustomerId,
    status: input.status,
    currentPeriodStart: input.currentPeriodStart,
    currentPeriodEnd: input.currentPeriodEnd,
    cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    canceledAt: input.canceledAt,
    trialEndsAt: input.trialEndsAt,
    lastEventAt: input.observedAt,
    lastEventId: input.observedBy ?? null,
    updatedAt: new Date(),
  };

  // AT MOST ONE LIVE SUBSCRIPTION PER TENANT is enforced by a partial unique
  // index, so this has to be true before the write rather than discovered by
  // it. A tenant genuinely holding two live subscriptions at Stripe is a
  // mistake somewhere, but the mistake must not become a 23505 that the webhook
  // retries for three days and then loses the endpoint over. The newer
  // observation wins and the displaced row is closed, which is also the only
  // outcome that leaves the two tables agreeing.
  const superseded = isLiveStatus(input.status)
    ? await supersedeOtherLiveRows(tx, input.tenantId, line, existing?.id ?? null, input.observedAt)
    : [];

  let subscriptionId: string;
  let created: boolean;

  if (existing) {
    await tx.update(subscriptions).set(values).where(eq(subscriptions.id, existing.id));
    subscriptionId = existing.id;
    created = false;
  } else if (input.stripeSubscriptionId !== null) {
    // `onConflictDoUpdate` rather than a bare insert: two events for one
    // subscription can be processed by two instances at the same instant, and
    // the read above would then miss the row the other one is inserting. The
    // conflict target is the unique index on the Stripe id, which is the only
    // key a Stripe-sourced row is identified by.
    const [row] = await tx
      .insert(subscriptions)
      .values(values)
      .onConflictDoUpdate({ target: [subscriptions.stripeSubscriptionId, subscriptions.line], set: values })
      .returning({ id: subscriptions.id });
    if (!row) {
      throw new Error(
        "applySubscription: the subscription upsert returned no row. Refusing " +
          "to report a mirror that may not have happened.",
      );
    }
    subscriptionId = row.id;
    created = true;
  } else {
    const [row] = await tx
      .insert(subscriptions)
      .values(values)
      .returning({ id: subscriptions.id });
    if (!row) {
      throw new Error("applySubscription: the subscription insert returned no row.");
    }
    subscriptionId = row.id;
    created = true;
  }

  // ---- 4. the entitlements ------------------------------------------------
  const outcome = await reconcileEntitlements(tx, {
    tenantId: input.tenantId,
    tier,
    window,
    // This line's rows only: Weather's change never touches what Sports granted.
    refs: planLineRefs(plans, line),
  });

  await tx.insert(auditLog).values(
    auditEntry(subscriptionAuditRegistry, {
      action: input.action ?? DEFAULT_ACTION_FOR[input.source],
      // NULL for a webhook, which is not a person. `actorUserId` is supplied by
      // the surfaces a person presses — cancel, resume, resync, simulate — so
      // "what did this user do" still answers for those.
      actor: input.actorUserId ? { userId: input.actorUserId } : null,
      scope: "tenant",
      tenantId: input.tenantId,
      resourceType: "subscription",
      resourceId: subscriptionId,
      metadata: {
        source: input.source,
        stripeSubscriptionId: input.stripeSubscriptionId,
        eventId: input.observedBy ?? null,
        observedAt: input.observedAt.toISOString(),
        tierKey: input.tierKey,
        planKey: input.planKey,
        line,
        stripeItemId: input.stripeItemId ?? null,
        status: input.status,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        entitlements: outcome,
        // Empty on every ordinary write. Non-empty means a tenant held two live
        // subscriptions and one was closed, which is the single most useful
        // thing this row can say to whoever is reading it afterwards.
        superseded,
      },
    }),
  );

  return {
    subscriptionId,
    applied: true,
    created,
    status: input.status,
    why: window.why,
    entitlements: outcome,
  };
}

/**
 * The row this observation is about, if we already hold one.
 *
 * TWO KEYS, BECAUSE THERE ARE TWO KINDS OF SUBSCRIPTION AND THE SCHEMA SAYS SO.
 * A Stripe subscription is identified by its Stripe id, which is globally
 * unique and indexed as such. A subscription with no Stripe object — a
 * simulated one, or a comped one an admin granted — has no such id, and the
 * schema documents the NULL rather than inventing a fake id to fill it. Its key
 * is the tenant, which is sound because the database permits the tenant at most
 * one live subscription at a time.
 *
 * NOT a branch on `source`: it is a branch on whether there is an id to look
 * up, which is a fact about the data rather than about who is calling. The
 * simulated and the real path go through everything after this identically.
 *
 * Most recent first rather than live-only, so that a simulated subscription
 * which has been cancelled and is then restarted reuses its row instead of
 * leaving a trail of dead ones.
 */
async function findSubscriptionRow(
  tx: Tx,
  input: ApplySubscriptionInput,
  line: string,
): Promise<
  | {
      readonly id: string;
      readonly status: SubscriptionStatus;
      readonly lastEventAt: Date | null;
    }
  | undefined
> {
  const columns = {
    id: subscriptions.id,
    status: subscriptions.status,
    lastEventAt: subscriptions.lastEventAt,
    line: subscriptions.line,
    stripeItemId: subscriptions.stripeItemId,
    planKey: planTable.key,
  };

  if (input.stripeSubscriptionId !== null) {
    // One row per (Stripe subscription, LINE): Weather and Sports on one
    // subscription are two rows. A row mirrored before lines existed says
    // the implicit line and names no item; read by its tier, it is this
    // line's row, and this write re-labels it rather than adding a second.
    const rows = await tx
      .select(columns)
      .from(subscriptions)
      .innerJoin(planTable, eq(planTable.id, subscriptions.planId))
      .where(eq(subscriptions.stripeSubscriptionId, input.stripeSubscriptionId))
      .limit(50);
    return (
      rows.find((row) => row.line === line) ??
      rows.find(
        (row) =>
          lineOfStoredRow(plans, row.planKey, row.line) === line &&
          (row.stripeItemId === null || input.stripeItemId === undefined || row.stripeItemId === input.stripeItemId),
      )
    );
  }

  // No Stripe object (simulated, or free months): the tenant's newest such row
  // ON THIS LINE — the one-live-per-line index is what makes that one row.
  const rows = await tx
    .select(columns)
    .from(subscriptions)
    .innerJoin(planTable, eq(planTable.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.tenantId, input.tenantId),
        isNull(subscriptions.stripeSubscriptionId),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(50);
  return rows.find((row) => lineOfStoredRow(plans, row.planKey, row.line) === line);
}

/**
 * Close any other live subscription this tenant holds, and say which.
 *
 * `LIVE_SUBSCRIPTION_STATUSES` rather than a list written here: the partial
 * unique index protects exactly that set, and a local copy would let this
 * function clear rows the index was not protecting while leaving one it was —
 * which is the collision it exists to prevent, arriving anyway.
 */
async function supersedeOtherLiveRows(
  tx: Tx,
  tenantId: string,
  line: string,
  keepId: string | null,
  at: Date,
): Promise<readonly string[]> {
  const live = await tx
    .select({ id: subscriptions.id, stripeId: subscriptions.stripeSubscriptionId, line: subscriptions.line, planKey: planTable.key })
    .from(subscriptions)
    .innerJoin(planTable, eq(planTable.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.tenantId, tenantId),
        // Spread from the tuple itself and NOT through a `readonly string[]`
        // binding. Widening it loses the literal union the column is typed
        // with, and Drizzle then has no overload for the call — which is the
        // type system noticing, correctly, that a plain string is not a status
        // this column accepts.
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        ...(keepId === null ? [] : [ne(subscriptions.id, keepId)]),
      ),
    );
  // THIS LINE'S live rows only (billing 0.5): a live Weather row never
  // displaces Sports. The partial unique index is per (tenant, line), and a
  // row written before lines (the implicit line) is read by its tier.
  const others = live.filter((row) => row.line === line || lineOfStoredRow(plans, row.planKey, row.line) === line);

  if (others.length === 0) return [];

  await tx
    .update(subscriptions)
    .set({ status: "canceled", canceledAt: at, updatedAt: at })
    .where(
      inArray(
        subscriptions.id,
        others.map((row) => row.id),
      ),
    );

  return others.map((row) => row.stripeId ?? row.id);
}

/**
 * Make the tenant's entitlement rows say what the plan says.
 *
 * THROUGH `planGrantDiff`, WHICH IS THE WHOLE POINT. It matches rows on
 * (source, feature) and ignores the ref, so an upgrade from Starter to Pro is
 * an UPDATE of the row the tenant already holds rather than a delete and an
 * insert — and `used_value` lives on that row. Recreating it resets four seats
 * in use to zero and the tenant invites four more people they are not paying
 * for. It also removes only `plan`-sourced rows, so a seat pack bought as a
 * PRODUCT and an allowance support granted by hand both survive a downgrade and
 * a cancellation untouched.
 *
 * THE EXPIRY SWEEP IS SEPARATE AND DELIBERATE. `planGrantDiff` answers "which
 * rows should exist"; `expires_at` answers "are they live right now", and the
 * two are different questions with different consequences. Suspending a
 * past-due tenant by deleting their rows would throw away the usage counters
 * the moment their card is retried; suspending them with a deadline keeps the
 * numbers and stops the service, which is what `subscriptionEntitlementWindow`
 * decided and this only carries out.
 *
 * The sweep runs over every `plan` row for the tenant rather than over the rows
 * the diff just touched, because a row that needed no change still needs the
 * new deadline — that is exactly the case of a renewal that only moved the
 * period, and the case of a cancellation scheduled on an unchanged plan.
 */
async function reconcileEntitlements(
  tx: Tx,
  input: {
    readonly tenantId: string;
    readonly tier: PlanTier;
    readonly window: EntitlementWindow;
    /** The line's own `source_ref`s (`planLineRefs`); undefined in a one-line catalog, where every plan row is the line's. */
    readonly refs: ReadonlySet<string> | undefined;
  },
): Promise<EntitlementOutcome> {
  const held = await tx
    .select({
      feature: entitlements.feature,
      limitValue: entitlements.limitValue,
      source: entitlements.source,
      sourceRef: entitlements.sourceRef,
    })
    .from(entitlements)
    .where(eq(entitlements.tenantId, input.tenantId));

  // `sourceRef` is nullable in the column and non-nullable in `PlanGrant`,
  // because `grantsForPlan` never emits an empty one and the unique index
  // coalesces NULL to the empty string. Normalising here rather than widening
  // the package's type keeps that invariant where it is enforced.
  const current: PlanGrant[] = held.map((row) => ({
    feature: row.feature,
    limitValue: row.limitValue,
    source: row.source,
    sourceRef: row.sourceRef ?? "",
  }));

  const diff = planGrantDiff(current, input.window.holds ? input.tier : null, { refs: input.refs });

  for (const grant of diff.add) {
    await tx
      .insert(entitlements)
      .values({
        tenantId: input.tenantId,
        feature: grant.feature,
        limitValue: grant.limitValue,
        source: grant.source,
        sourceRef: grant.sourceRef,
        expiresAt: input.window.expiresAt,
      })
      // Targetless, for the reason `applyGrant` gives: `entitlements` carries
      // one unique index and it is over a `coalesce(source_ref, '')`
      // EXPRESSION, which Drizzle's `target` array cannot spell. "If the row is
      // already there, leave it alone" is the whole requirement — and it must
      // not DO UPDATE, because `used_value` on an existing row is consumption
      // already recorded.
      .onConflictDoNothing();
  }

  for (const change of diff.change) {
    await tx
      .update(entitlements)
      .set({
        limitValue: change.next.limitValue,
        sourceRef: change.next.sourceRef,
        updatedAt: new Date(),
      })
      .where(identityOf(input.tenantId, change.previous));
  }

  for (const grant of diff.remove) {
    await tx.delete(entitlements).where(identityOf(input.tenantId, grant));
  }

  // The sweep. Every plan-sourced row of THIS LINE now carries the same
  // deadline, whether the diff touched it or not — and no other line's: a
  // cancelled Sports ends on its own date while Weather renews.
  await tx
    .update(entitlements)
    .set({ expiresAt: input.window.expiresAt, updatedAt: new Date() })
    .where(
      and(
        eq(entitlements.tenantId, input.tenantId),
        eq(entitlements.source, "plan"),
        ...(input.refs === undefined ? [] : [inArray(entitlements.sourceRef, [...input.refs])]),
      ),
    );

  return {
    added: diff.add.length,
    changed: diff.change.length,
    removed: diff.remove.length,
    expiresAt: input.window.expiresAt,
    serving: input.window.serving,
    why: input.window.why,
  };
}

/**
 * The predicate that names exactly one entitlement row.
 *
 * The four columns of the unique index, with the same COALESCE the index
 * applies — matching on the bare `source_ref` would miss a row whose ref is
 * NULL, and SQL equality against NULL is never true, so the update would
 * silently affect nothing and the diff would propose the same change for ever.
 */
function identityOf(tenantId: string, grant: PlanGrant) {
  return and(
    eq(entitlements.tenantId, tenantId),
    eq(entitlements.feature, grant.feature),
    eq(entitlements.source, grant.source),
    sql`coalesce(${entitlements.sourceRef}, '') = ${grant.sourceRef}`,
  );
}

// ---------------------------------------------------------------------------
// Which plan is this subscription on?
// ---------------------------------------------------------------------------

/** The metadata key `subscribeToPlan` stamps the tier onto a Stripe subscription with. */
export const PLAN_METADATA_KEY = "planKey";

export type PlanResolution =
  | { readonly kind: "plan"; readonly tierKey: string; readonly planKey: string }
  /** Ours, but not a plan: a recurring PRODUCT from the shop. */
  | { readonly kind: "product"; readonly why: string }
  /** Nothing here can say what this subscription is for. */
  | { readonly kind: "unknown"; readonly why: string };

export interface ResolvePlanInput {
  /** `metadata.planKey` on the Stripe subscription, if it carries one. */
  readonly planMetadata: string | null | undefined;
  /** `metadata.variantId` — present on a subscription the STOREFRONT created. */
  readonly variantMetadata: string | null | undefined;
  readonly priceId: string | null;
  /**
   * The PRICE's own metadata: `ensurePlanPrice` has stamped `{ planKey,
   * tierKey }` on every Price it ever made, so a Price from before a
   * repricing still says which plan it bills.
   */
  readonly priceMetadata?: Readonly<Record<string, string>> | null;
  readonly interval: "month" | "year" | null;
  readonly currency: string | null;
}

/**
 * Work out which plan a Stripe subscription is for — or say, out loud, that it
 * is not one.
 *
 * TWO ROUTES IN, AND THE ORDER IS THE POINT (billing 0.3 put the price first).
 *
 *  2. THE METADATA. `subscribeToPlan` stamps the tier key onto the Subscription
 *     at creation, and Stripe hands it back on every event. It is the cheapest
 *     answer and the only one that still works on a deployment whose `plans`
 *     rows have never been synced to Stripe.
 *  1. THE CACHED PRICE ID. `plans.stripe_price_id` is the id `ensurePlanPrice`
 *     wrote. This is what catches a subscription somebody created in the Stripe
 *     dashboard against a price we published, which carries no metadata of ours
 *     at all — and that subscription is real money, so it has to be mirrored.
 *     Then THE PRICE'S OWN STAMP: the cache holds only the CURRENT price, and
 *     a repriced tier gets a new Price while the people already on it keep the
 *     old one (by design) — whose metadata, stamped by `ensurePlanPrice`, still
 *     names its plan. Without it, that item resolved to nothing once a second
 *     line was added, and the line it pays for was ended (review).
 *
 * WHAT "NOT A PLAN" MEANS, AND WHY IT IS NOT AN ERROR. A recurring PRODUCT in
 * the shop — @__SCOPE_NAME__/catalog's `product_variants` with an interval — is
 * also a Stripe subscription, and it is deliberately not mirrored here:
 * `subscriptions.plan_id` names a row in the plan catalogue and a product
 * variant is not one. Its purchase books an order and applies the product's own
 * grants through `fulfilPurchase`, which is a different mechanism with a
 * different receipt. Throwing on one would answer 500 to a perfectly ordinary
 * event, Stripe would retry for three days and then disable the endpoint, and
 * every plan subscription would stop mirroring with it. So it is reported and
 * skipped, and the caller logs it.
 *
 * `unknown` is the third answer and it is deliberately distinct from the
 * second: a subscription that names neither a tier nor a variant nor a price we
 * published is one nobody here can attribute, and that is worth a warning even
 * though it is still not worth wedging the endpoint over.
 */
export async function resolvePlanForSubscription(
  input: ResolvePlanInput,
  handle: Db | Tx = db,
): Promise<PlanResolution> {
  // THE PRICE FIRST (billing 0.3): after a plan change, the price on the
  // subscription is what the company is actually paying for. Its metadata is
  // only updated once the change has gone through, so reading the metadata
  // first could name the old plan for one event, or a plan never paid for.
  if (input.priceId !== null) {
    const [row] = await handle
      .select({ key: planTable.key })
      .from(planTable)
      .where(eq(planTable.stripePriceId, input.priceId))
      .limit(1);

    if (row) {
      const tier = plans.tierForRow(row.key);
      if (tier !== undefined) {
        return { kind: "plan", tierKey: tier.key, planKey: row.key };
      }
      return {
        kind: "unknown",
        why:
          `plans row "${row.key}" caches Stripe price ${input.priceId}, and no ` +
          `tier in src/plans.ts projects that row. It is an orphan — see ` +
          `reconcilePlans, which reports exactly this.`,
      };
    }
  }

  // The Price's own stamp: a Price we published before a repricing.
  const stamped = planFromPriceMetadata(input);
  if (stamped !== null) return stamped;

  const declared = input.planMetadata?.trim();
  if (declared !== undefined && declared.length > 0) {
    const tier = plans.tier(declared);
    if (tier === undefined) {
      // A tier key that the record has never heard of. This one IS loud, via
      // the caller: it means a subscription was sold against a tier that has
      // since been deleted from `src/plans.ts` — which is what `isActive:
      // false` exists to prevent — and the subscriber's entitlements cannot be
      // computed from anything.
      return {
        kind: "unknown",
        why:
          `The subscription names tier "${declared}", which src/plans.ts no ` +
          `longer declares. Retire a tier with isActive: false rather than ` +
          `deleting it; subscribers reference it.`,
      };
    }
    if (input.interval === null || input.currency === null) {
      return {
        kind: "unknown",
        why:
          `The subscription names tier "${declared}" but bills on a cadence or ` +
          `currency this catalogue does not sell, so no plans row projects it.`,
      };
    }
    return {
      kind: "plan",
      tierKey: tier.key,
      planKey: planRowKey(tier.key, input.interval, input.currency.toLowerCase()),
    };
  }

  const variant = input.variantMetadata?.trim();
  if (variant !== undefined && variant.length > 0) {
    return {
      kind: "product",
      why:
        `This subscription was created from product variant "${variant}", not ` +
        `from the plan catalogue. Recurring products book orders through ` +
        `fulfilPurchase and apply their own grants; the subscriptions table is ` +
        `the plan catalogue's.`,
    };
  }

  return {
    kind: "unknown",
    why:
      `Nothing identifies this subscription: it carries no ${PLAN_METADATA_KEY} ` +
      `metadata, no variantId, and its price ${input.priceId ?? "(none)"} is not ` +
      `cached on any plans row. It was probably created in the Stripe dashboard ` +
      `against a price this application has never published.`,
  };
}

/**
 * The plan a Price we published names in its own metadata (`ensurePlanPrice`
 * stamps `{ planKey, tierKey }`), or null when it names none this catalog
 * still sells on that cadence.
 */
function planFromPriceMetadata(input: ResolvePlanInput): PlanResolution | null {
  const metadata = input.priceMetadata ?? {};
  const rowKey = metadata[PLAN_METADATA_KEY]?.trim();
  if (rowKey) {
    const tier = plans.tierForRow(rowKey);
    if (tier !== undefined && plans.rows.some((row) => row.key === rowKey)) {
      return { kind: "plan", tierKey: tier.key, planKey: rowKey };
    }
  }
  const tierKey = metadata["tierKey"]?.trim();
  if (tierKey && input.interval !== null && input.currency !== null) {
    const tier = plans.tier(tierKey);
    const key = tier === undefined ? null : planRowKey(tier.key, input.interval, input.currency.toLowerCase());
    if (tier !== undefined && key !== null && plans.rows.some((row) => row.key === key)) {
      return { kind: "plan", tierKey: tier.key, planKey: key };
    }
  }
  return null;
}

/**
 * Which plan ONE item of a Stripe subscription bills — the mirror's own rule,
 * shared with adding a line (so "is this line already on the subscription?"
 * gets the same answer the mirror would give).
 *
 *   1. the item's price: the cached one, then the Price's own stamp;
 *   2. the item's own `planKey` metadata (the subscription's, with one item);
 *   3. a recurring product from the shop (`variantId` on the subscription);
 *   4. OUR OWN ROW that already names this item (review): an item we have
 *      mirrored before is still the line it was — a price we can no longer
 *      read (one made by hand in the dashboard) never ends a line Stripe is
 *      still billing.
 */
export async function resolveSubscriptionItem(
  snapshot: StripeSubscriptionSnapshot,
  item: Pick<StripeSubscriptionItemSnapshot, "priceId" | "interval" | "currency" | "metadata"> & {
    readonly itemId: string | null;
    readonly priceMetadata?: Readonly<Record<string, string>>;
  },
  handle: Db | Tx = db,
): Promise<PlanResolution> {
  const single = snapshot.items.length <= 1;
  const resolution = await resolvePlanForSubscription(
    {
      planMetadata: item.metadata[PLAN_METADATA_KEY] ?? (single ? snapshot.metadata[PLAN_METADATA_KEY] : undefined),
      variantMetadata: snapshot.metadata["variantId"],
      priceId: item.priceId,
      priceMetadata: item.priceMetadata ?? {},
      interval: item.interval,
      currency: item.currency,
    },
    handle,
  );
  if (resolution.kind !== "unknown" || item.itemId === null) return resolution;

  const [stored] = await handle
    .select({ planKey: planTable.key })
    .from(subscriptions)
    .innerJoin(planTable, eq(planTable.id, subscriptions.planId))
    .where(
      and(
        eq(subscriptions.stripeSubscriptionId, snapshot.subscriptionId),
        eq(subscriptions.stripeItemId, item.itemId),
      ),
    )
    .orderBy(desc(subscriptions.updatedAt))
    .limit(1);
  const tier = stored ? plans.tierForRow(stored.planKey) : undefined;
  if (stored && tier !== undefined) return { kind: "plan", tierKey: tier.key, planKey: stored.planKey };
  return resolution;
}

// ---------------------------------------------------------------------------
// A whole Stripe subscription, one line per item (billing 0.5)
// ---------------------------------------------------------------------------

export interface MirrorContext {
  /** When this state was observed: `event.created` for a webhook, now for a live read. */
  readonly observedAt: Date;
  readonly observedBy: string;
  readonly action?: SubscriptionAuditAction;
  readonly actorUserId?: string | null;
}

export interface MirroredLine {
  readonly line: string;
  readonly tierKey: string;
  readonly result: ApplySubscriptionResult;
}

export type MirrorOutcome =
  /** Ours, but not a plan: a recurring PRODUCT from the shop (its own grants are windowed by the caller). */
  | { readonly kind: "product"; readonly why: string }
  /** Nothing here can say what this subscription is for. */
  | { readonly kind: "unknown"; readonly why: string }
  /** A plan subscription that names no tenant: there is nobody to record it against. */
  | { readonly kind: "no_tenant"; readonly planKey: string }
  | {
      readonly kind: "mirrored";
      /** One per product line the subscription bills. */
      readonly lines: readonly MirroredLine[];
      /** Lines whose item is no longer on the subscription, now ended (their rows removed). */
      readonly closed: readonly MirroredLine[];
      /** Items billing a line another item already bills — money for a line held twice. A person must look. */
      readonly duplicates: readonly string[];
      /** Items that aren't plans at all, mirrored by nothing here. */
      readonly skipped: readonly { readonly itemId: string; readonly why: string }[];
    };

/**
 * Mirror a Stripe subscription — ALL of its items — through the one writer.
 *
 * PRODUCT LINES (billing 0.5). A tenant on Weather Pro and Sports holds ONE
 * Stripe subscription with TWO items, and this writes one row per line: each
 * item resolves to its plan (`resolveSubscriptionItem`: by its PRICE first —
 * the cached one, then the Price's own stamp — then its own `planKey`
 * metadata; the subscription's `planKey` only when there is a single item,
 * because with several it can only ever describe one of them; then our own
 * row naming that item), and each line goes through `applySubscription` with
 * its own watermark, item and period.
 *
 * A LINE WHOSE ITEM IS GONE has been dropped (`removeLine`, or by hand in the
 * dashboard): its live row is ended through the same writer, so its rows go
 * and the other lines' stay. Only when Stripe sent the whole item list — a
 * truncated list (`has_more`) closes nothing, since an absent item there
 * proves nothing — and NEVER a row whose own item is still on the
 * subscription: Stripe is billing it, so it is not gone, whatever its price
 * resolves to (review: a repriced tier).
 *
 * Called by the webhook, the staff resync, cancel and resume, and adding or
 * changing a line: every Stripe-sourced write of a subscription.
 */
export async function mirrorStripeSubscription(
  snapshot: StripeSubscriptionSnapshot,
  context: MirrorContext,
): Promise<MirrorOutcome> {
  const items =
    snapshot.items.length > 0
      ? snapshot.items
      : [
          {
            itemId: null as string | null,
            priceId: snapshot.priceId,
            interval: snapshot.interval,
            currency: snapshot.currency,
            quantity: snapshot.quantity,
            currentPeriodStart: snapshot.currentPeriodStart,
            currentPeriodEnd: snapshot.currentPeriodEnd,
            metadata: {} as Readonly<Record<string, string>>,
            priceMetadata: {} as Readonly<Record<string, string>>,
          },
        ];

  const resolved: { readonly itemId: string | null; readonly item: (typeof items)[number]; readonly tierKey: string; readonly planKey: string }[] = [];
  const skipped: { itemId: string; why: string }[] = [];
  let first: PlanResolution | null = null;
  for (const item of items) {
    const resolution = await resolveSubscriptionItem(snapshot, item);
    first ??= resolution;
    if (resolution.kind === "plan") resolved.push({ itemId: item.itemId, item, tierKey: resolution.tierKey, planKey: resolution.planKey });
    else skipped.push({ itemId: item.itemId ?? "", why: resolution.why });
  }

  if (resolved.length === 0) {
    const nothing = first ?? { kind: "unknown" as const, why: "The subscription has no items." };
    return nothing.kind === "product" ? { kind: "product", why: nothing.why } : { kind: "unknown", why: nothing.kind === "unknown" ? nothing.why : "" };
  }

  const tenantId = snapshot.metadata["tenantId"];
  if (!tenantId) return { kind: "no_tenant", planKey: resolved[0]!.planKey };

  const status = mapStripeSubscriptionStatus(snapshot.status);
  const lines: MirroredLine[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const each of resolved) {
    const line = plans.tier(each.tierKey)?.line;
    if (line === undefined) continue;
    if (seen.has(line)) {
      duplicates.push(each.itemId ?? each.planKey);
      continue;
    }
    seen.add(line);
    const result = await applySubscription({
      tenantId,
      tierKey: each.tierKey,
      planKey: each.planKey,
      stripeSubscriptionId: snapshot.subscriptionId,
      ...(each.itemId !== null ? { stripeItemId: each.itemId } : {}),
      stripeCustomerId: snapshot.customerId,
      status,
      currentPeriodStart: each.item.currentPeriodStart ?? snapshot.currentPeriodStart,
      currentPeriodEnd: each.item.currentPeriodEnd ?? snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      canceledAt: snapshot.canceledAt,
      trialEndsAt: snapshot.trialEndsAt,
      observedAt: context.observedAt,
      observedBy: context.observedBy,
      source: "stripe",
      ...(context.action ? { action: context.action } : {}),
      ...(context.actorUserId !== undefined ? { actorUserId: context.actorUserId } : {}),
    });
    lines.push({ line, tierKey: each.tierKey, result });
  }

  // The lines this subscription billed before and doesn't now.
  const closed: MirroredLine[] = [];
  if (snapshot.itemsComplete && !lines.some((line) => line.result.tenantGone)) {
    // Every item Stripe is billing right now: a row naming one of them is
    // being paid for, so it is never ended here — even if its price could not
    // be read (review: a repriced tier ended a paid line, and "Add" then
    // billed it twice).
    const billedNow = new Set(items.map((item) => item.itemId).filter((id): id is string => id !== null));
    const held = await db
      .select({
        line: subscriptions.line,
        stripeItemId: subscriptions.stripeItemId,
        status: subscriptions.status,
        planKey: planTable.key,
        currentPeriodStart: subscriptions.currentPeriodStart,
        currentPeriodEnd: subscriptions.currentPeriodEnd,
        trialEndsAt: subscriptions.trialEndsAt,
      })
      .from(subscriptions)
      .innerJoin(planTable, eq(planTable.id, subscriptions.planId))
      .where(
        and(
          eq(subscriptions.stripeSubscriptionId, snapshot.subscriptionId),
          inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
        ),
      );
    for (const row of held) {
      const tier = plans.tierForRow(row.planKey);
      if (tier === undefined) continue;
      const line = lineOfStoredRow(plans, row.planKey, row.line);
      if (seen.has(line)) continue;
      if (row.stripeItemId !== null && billedNow.has(row.stripeItemId)) continue;
      const result = await applySubscription({
        tenantId,
        tierKey: tier.key,
        planKey: row.planKey,
        stripeSubscriptionId: snapshot.subscriptionId,
        stripeCustomerId: snapshot.customerId,
        status: "canceled",
        currentPeriodStart: row.currentPeriodStart,
        // ENDED NOW: an item taken off a subscription stops now (its unused
        // time is credited to the next bill), so the line is not "ending" until
        // a period end it no longer has.
        currentPeriodEnd: context.observedAt,
        cancelAtPeriodEnd: false,
        canceledAt: context.observedAt,
        trialEndsAt: row.trialEndsAt,
        observedAt: context.observedAt,
        observedBy: context.observedBy,
        source: "stripe",
        ...(context.action ? { action: context.action } : {}),
        ...(context.actorUserId !== undefined ? { actorUserId: context.actorUserId } : {}),
      });
      closed.push({ line, tierKey: tier.key, result });
    }
  }

  return { kind: "mirrored", lines, closed, duplicates, skipped };
}

// ---------------------------------------------------------------------------
// Reading a subscription back
// ---------------------------------------------------------------------------

/**
 * Every entitlement row a tenant holds because of its plan, for a screen that
 * wants to show what the subscription actually bought.
 *
 * `source = 'plan'` and nothing else. The account area's other reader reaches
 * grants THROUGH the order that paid for them, because a storefront grant
 * belongs to the buyer; a plan grant belongs to the organisation, which is the
 * tenant on the row, so here the tenant IS the authorisation.
 */
export async function readPlanEntitlements(
  tenantId: string,
  /** One product line's rows only (billing 0.5): `planLineRefs(plans, line)`. Omitted: every plan row. */
  refs?: ReadonlySet<string>,
): Promise<
  readonly {
    readonly feature: string;
    readonly limitValue: number | null;
    readonly usedValue: number;
    readonly sourceRef: string | null;
    readonly expiresAt: Date | null;
  }[]
> {
  const rows = await db
    .select({
      feature: entitlements.feature,
      limitValue: entitlements.limitValue,
      usedValue: entitlements.usedValue,
      sourceRef: entitlements.sourceRef,
      expiresAt: entitlements.expiresAt,
    })
    .from(entitlements)
    .where(and(eq(entitlements.tenantId, tenantId), eq(entitlements.source, "plan")));
  return refs === undefined ? rows : rows.filter((row) => refs.has(row.sourceRef ?? ""));
}

/** Every subscription row the firm holds, newest first. The resync's before-picture. */
export async function listMirroredSubscriptions(limit = 50): Promise<
  readonly {
    readonly id: string;
    readonly tenantId: string;
    readonly line: string;
    readonly stripeSubscriptionId: string | null;
    readonly status: SubscriptionStatus;
    readonly planKey: string;
    readonly currentPeriodEnd: Date | null;
    readonly cancelAtPeriodEnd: boolean;
    readonly lastEventAt: Date | null;
  }[]
> {
  return db
    .select({
      id: subscriptions.id,
      tenantId: subscriptions.tenantId,
      line: subscriptions.line,
      stripeSubscriptionId: subscriptions.stripeSubscriptionId,
      status: subscriptions.status,
      planKey: planTable.key,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
      lastEventAt: subscriptions.lastEventAt,
    })
    .from(subscriptions)
    .innerJoin(planTable, eq(planTable.id, subscriptions.planId))
    .orderBy(desc(subscriptions.updatedAt))
    .limit(limit);
}

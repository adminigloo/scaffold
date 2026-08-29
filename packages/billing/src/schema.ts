import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { amountMinor, createdAt, idColumn, updatedAt } from "@adminigloo/db";
import { FIRM_WIDE } from "@adminigloo/permissions";
import type { EntitlementSource } from "./entitlements.js";
import type { SubscriptionStatus } from "./status.js";

/**
 * The unions above are imported as TYPES, and the dependency runs one way:
 * schema -> pure modules, never the reverse. A value import in the other
 * direction would put drizzle-orm/pg-core on the root entry's import graph,
 * which is the thing index.ts exists to prevent.
 *
 * `text` with `$type<...>()` rather than `pgEnum`, matching @adminigloo/tenancy:
 * a value added to a Postgres enum can never be removed, so a name chosen badly
 * today is permanent, and the union gives the compile-time check without the
 * one-way door.
 */

/** `once` is a lifetime purchase: it never renews, so it never prorates. */
export type PlanInterval = "month" | "year" | "once";

/**
 * The plan catalog. THIS is what a plan means.
 *
 * Stripe is the payment engine, not the product database. Reading names and
 * prices back out of Stripe at render time makes the pricing page a network
 * call that can fail, ties the copy on it to whatever someone last typed into a
 * dashboard, and leaves test mode and live mode describing different products
 * with no diff between them. Here the row is authoritative and
 * `stripe_product_id` / `stripe_price_id` are a CACHE, written when an admin
 * saves the plan. When the cache is wrong, checkout fails loudly at session
 * creation instead of the catalog quietly rendering someone else's prices.
 */
export const plans = pgTable(
  "plans",
  {
    id: idColumn(),
    /**
     * Which tenant may see this plan. `FIRM_WIDE` (`'*'`) means catalog-wide.
     *
     * ONE SPELLING, NOT TWO. This column used to be nullable with the sentinel
     * accepted alongside NULL, and two spellings for one idea is a trap: a
     * query filtering `tenant_id is null` alone hides every legacy-imported
     * catalog-wide plan, and the missing plans look like a pricing decision
     * rather than a bug. NOT NULL DEFAULT '*' leaves nothing to get wrong —
     * the pricing page is `tenant_id in ($tenant, FIRM_WIDE)`, always.
     *
     * The constant is imported from @adminigloo/permissions, which already
     * made this call for `role_template`. A second constant spelling the same
     * `'*'` is a second thing to change when the sentinel ever moves, and the
     * two halves of the schema would then disagree about what firm-wide means.
     */
    tenantId: text("tenant_id").notNull().default(FIRM_WIDE),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    interval: text("interval").$type<PlanInterval>().notNull(),
    /**
     * Whole-period price in minor units. A free plan is 0, never NULL — NULL
     * would propagate through every price computation and render a free plan as
     * "no price" instead of "Free".
     */
    priceMinor: amountMinor("price_minor"),
    /**
     * Per plan, not per tenant. A price without its currency is meaningless,
     * and a tenant-level currency silently misbills by the exchange rate the
     * first time a USD plan and a EUR plan sit in the same catalog.
     */
    currency: text("currency").notNull().default("usd"),
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    /** Plans are retired, never deleted — subscriptions reference them. */
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * The key is the join between this catalog and everything outside the
     * database: Stripe metadata, `entitlements.source_ref`, feature checks in
     * app code. It has to resolve to exactly one row.
     *
     * Deliberately NOT scoped to the tenant. A tenant-specific plan must still
     * pick a globally unique key, because a webhook carrying `plan=pro` arrives
     * with no tenant to disambiguate it — and picking the wrong `pro` grants
     * one customer's entitlements to another.
     *
     * Indexing the key alone is also what makes two catalog-wide plans named
     * `pro` impossible: a `(tenant_id, key)` index over a NULLABLE tenant_id
     * would accept both, because Postgres treats NULLs as distinct.
     */
    uniqueIndex("plans_key_idx").on(t.key),
    /** The pricing page: this tenant's plans plus the catalog-wide ones. */
    index("plans_tenant_sort_idx").on(t.tenantId, t.sortOrder),
  ],
);

/**
 * What a tenant is currently paying for.
 *
 * At most one LIVE row per tenant, enforced by the partial unique index below
 * rather than by a check in the code that creates them — the check that matters
 * runs during a double-clicked checkout, from two instances, in the same
 * millisecond.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    /**
     * `restrict`, not `cascade`: deleting a plan somebody is subscribed to
     * would take the subscription row with it and leave the tenant still paying
     * Stripe for a subscription this database has no record of. Retire plans
     * with `is_active = false` instead.
     *
     * notNull, because a subscription whose plan is NULL claims the tenant pays
     * for nothing: `status` still reads `active`, entitlements resolve empty,
     * and a paying customer gets the free tier. The webhook must resolve the
     * Stripe price to a local plan before writing the row, or fail loudly.
     */
    planId: text("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeCustomerId: text("stripe_customer_id"),
    /**
     * Written only by `mapStripeSubscriptionStatus`, never copied out of a
     * webhook payload — see status.ts for what an unmapped status does to the
     * live-set predicate below.
     */
    status: text("status").$type<SubscriptionStatus>().notNull(),
    /**
     * Nullable: a `once` purchase has no period at all, and Stripe omits both
     * on a subscription that has not completed its first payment. Proration
     * treats a missing period as "nothing to prorate" rather than guessing.
     */
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    /**
     * Distinct from `canceled_at` on purpose. "Will cancel when the period ends"
     * and "is cancelled" are different states, and collapsing them into one
     * status is how a customer who scheduled a cancellation gets locked out
     * immediately, mid-period, having already paid for the rest of it.
     */
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * One row per Stripe subscription. Nullable because a comped subscription
     * an admin granted has no Stripe object, and Postgres treats NULLs as
     * distinct in a unique index — so those rows do not collide with each
     * other, which is exactly the behaviour wanted.
     */
    uniqueIndex("subscriptions_stripe_subscription_id_idx").on(t.stripeSubscriptionId),
    /**
     * AT MOST ONE LIVE SUBSCRIPTION PER TENANT.
     *
     * Raw SQL because Drizzle has no builder for a partial index over an IN
     * list, and both alternatives are worse: `status <> 'canceled'` would
     * silently enrol any status added to the union later, and four OR'd
     * equality tests are the same list with more places to mistype it.
     *
     * The list is everything except `canceled`, INCLUDING `incomplete`. A
     * checkout that has not collected its first payment still has to block a
     * second one, or a double-clicked upgrade creates two Stripe subscriptions
     * for one tenant, bills the customer twice, and leaves two webhook streams
     * racing to set the status. `canceled` is excluded so a tenant can
     * resubscribe, and so the history survives.
     *
     * Keep in step with `LIVE_SUBSCRIPTION_STATUSES` in status.ts: the query
     * that loads "the current subscription" must select the same set the
     * database protects, or the invariant is enforced on one list and read
     * through another.
     */
    uniqueIndex("subscriptions_tenant_live_idx")
      .on(t.tenantId)
      .where(sql`${t.status} in ('trialing', 'active', 'past_due', 'unpaid', 'incomplete')`),
    /**
     * Billing history reads every row for a tenant, cancelled ones included,
     * which the partial index above cannot serve.
     */
    index("subscriptions_tenant_idx").on(t.tenantId, t.createdAt),
  ],
);

/**
 * What a tenant is allowed to do, one row per source of the allowance.
 *
 * Rows rather than one computed number per feature, because the sources are
 * additive and outlive each other: a plan grants 5 seats, an add-on grants 3
 * more, support grants 2 for a month. Collapsed into a single integer, "why do
 * I have 10 seats" is unanswerable and removing the add-on becomes a
 * subtraction that has to guess which part it owned.
 *
 * `used_value` lives on the row beside its limit, which is what makes an
 * upgrade an UPDATE rather than a delete-and-insert — see `planGrantDiff`.
 */
export const entitlements = pgTable(
  "entitlements",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    feature: text("feature").notNull(),
    /**
     * NULL is unlimited — not unknown, and not zero. A limit of 0 is a real
     * thing (a feature explicitly withheld while the row stays for the audit
     * trail), so the two cannot share a spelling.
     */
    limitValue: integer("limit_value"),
    usedValue: integer("used_value").notNull().default(0),
    source: text("source").$type<EntitlementSource>().notNull(),
    /** Which plan, add-on or grant produced the row. `plans.key` for a plan. */
    sourceRef: text("source_ref"),
    /** NULL never expires. A time-boxed support grant sets it. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * One row per (tenant, feature, source, ref). This is what makes applying a
     * plan's grants idempotent: the writer upserts on this index, so a webhook
     * redelivered three times leaves one row with its `used_value` intact.
     *
     * `source_ref` is wrapped in COALESCE because it is nullable and Postgres
     * treats NULLs as DISTINCT in a unique index. Indexing the bare column
     * would exempt exactly the rows that have no ref — a hand-made admin grant,
     * typically — so re-running the same admin action inserts a second row and
     * doubles the limit, silently, because both rows sum. The empty string is
     * safe as the sentinel: a real ref is a plan key or a Stripe id and is
     * never empty, which `grantsForPlan` enforces on the way in. (Drizzle's
     * `nullsNotDistinct()` would say this more directly, but it exists on
     * `unique()` table constraints, not on `uniqueIndex()`.)
     */
    uniqueIndex("entitlements_tenant_feature_source_ref_idx").on(
      t.tenantId,
      t.feature,
      t.source,
      sql`coalesce(${t.sourceRef}, '')`,
    ),
    /**
     * The read path. `resolveEntitlements` takes every row for a tenant in one
     * query and resolves all features at once, precisely so a page with twelve
     * gated components does not issue twelve round trips.
     */
    index("entitlements_tenant_idx").on(t.tenantId),
  ],
);

export const billingSchema = { plans, subscriptions, entitlements };

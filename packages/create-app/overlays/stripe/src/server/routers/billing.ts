import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  mapStripeSubscriptionStatus,
  planRowKey,
  priceFor,
  type PlanInterval,
} from "__SCOPE__/billing";
import { plans as planTable } from "__SCOPE__/billing/schema";
import { companyStripeCustomer, liveStripeSubscription } from "__SCOPE__/billing/server";
import { formatMinor } from "__SCOPE__/catalog";
import { createLogger } from "__SCOPE__/observability";
import {
  changePlan as changeStripePlan,
  checkoutReturnUrls,
  createCheckoutSession,
  ensurePlanPrice,
  PlanChangeError,
  prepareCompanyCheckout,
  previewPlanChange as previewStripePlanChange,
  subscriptionSnapshot,
} from "__SCOPE__/stripe";
import { db } from "@/db";
import { env } from "@/env";
import { plans } from "@/plans";
import { checkoutMode } from "@/server/checkout-mode";
import { planStandingOf } from "@/server/plan-gate";
import { stripe } from "@/server/stripe";
import { tenancy } from "@/server/tenancy";
import {
  applySubscription,
  listMirroredSubscriptions,
  resolvePlanForSubscription,
  simulatedSubscriptionRef,
  PLAN_METADATA_KEY,
} from "@/server/subscription";
import { requestContext } from "../request-context";
import { createTRPCRouter, requireStaff, requireTenant } from "../trpc";

/**
 * Starting, simulating and repairing a subscription.
 *
 * SEPARATE FROM `checkout.ts` BECAUSE THE TWO SELL DIFFERENT THINGS. That
 * router sells PRODUCTS — rows in @__SCOPE_NAME__/catalog with variants, stock
 * and grants — and it is public, because a shop nobody can browse without an
 * account is a shop nobody browses. This one sells the PLAN CATALOGUE, which is
 * a record in `src/plans.ts` rather than a table, is bought by an organisation
 * rather than by a person, and commits that organisation to a recurring charge.
 * Different subject, different tenancy, different rung.
 *
 * WHAT IS NOT HERE. Cancel and resume live on the account router beside the
 * billing portal, because they are things a customer does to their own
 * subscription on their own screen. This router is the two ends nobody else
 * owns: getting a subscription started, and putting the firm's tables back in
 * step with Stripe when a webhook was missed.
 */

const logger = createLogger({ level: env.LOG_LEVEL });

/**
 * THE STAFF KEY, and why one key covers both staff procedures.
 *
 * `resync` re-pulls Stripe's state into the firm's own tables and `syncPlans`
 * pushes the plan record's prices out to Stripe. They are the two halves of one
 * capability — reconciling this application's billing tables with Stripe — and
 * whoever may do one may do the other: both write the objects the other reads,
 * so splitting the key would produce a role that can publish a price nothing
 * can then be reconciled against.
 *
 * STAFF AND NOT TENANT, unlike everything in `billingPermissions`. Those keys
 * are the customer's own — `subscriptions.view` and `subscriptions.manage` are
 * what an owner holds over their organisation's plan. This is the FIRM
 * repairing its own records across every customer at once, which is the staff
 * ladder's whole subject, and a tenant key would have nowhere to reach from.
 */
const RESYNC_PERMISSION = "staff.billing.resync";

/** Intervals a subscription can be sold on. `once` is a plan nobody subscribes to. */
const subscribableInterval = z.enum(["month", "year"]);

export const billingRouter = createTRPCRouter({
  /**
   * The plan catalogue as a page renders it, with no database in the way.
   *
   * READ STRAIGHT OFF THE RECORD. `src/plans.ts` is the source of truth for
   * what a tier includes and costs, so a pricing page that read the `plans`
   * TABLE would render nothing at all on a fresh clone — the same failure the
   * table's own comment condemns about reading prices back out of Stripe. The
   * table exists so `subscriptions.plan_id` has something to point at and so
   * the two Stripe ids have somewhere to be cached, not so the catalogue can be
   * read from it.
   *
   * `publicProcedure` is not needed and not used: this is a `requireTenant`
   * router, and the pricing page imports the record directly rather than going
   * through tRPC for a value that is already in its own bundle. The procedure
   * exists for the ADMIN screen, which needs the record and the table side by
   * side to say which rows are missing.
   */
  catalogue: requireStaff(RESYNC_PERMISSION)
    .meta({ scope: "staff" })
    .query(async () => {
      const rows = await db
        .select({
          key: planTable.key,
          isActive: planTable.isActive,
          stripePriceId: planTable.stripePriceId,
          stripeProductId: planTable.stripeProductId,
        })
        .from(planTable);

      const stored = new Map(rows.map((row) => [row.key, row]));

      return {
        rows: plans.rows.map((row) => {
          const found = stored.get(row.key);
          return {
            key: row.key,
            tierKey: row.tierKey,
            name: row.name,
            interval: row.interval,
            currency: row.currency,
            priceMinor: row.priceMinor,
            isActive: row.isActive,
            /** FALSE means `pnpm db:seed:plans` has not been run here. */
            seeded: found !== undefined,
            /** FALSE means Stripe has never been told this plan exists. */
            published: (found?.stripePriceId ?? null) !== null,
          };
        }),
        // Rows the table holds and the record does not project. Reported rather
        // than deleted: `subscriptions.plan_id` is `on delete restrict`.
        orphaned: rows
          .filter((row) => plans.tierForRow(row.key) === undefined)
          .map((row) => ({ key: row.key, isActive: row.isActive })),
      };
    }),

  /**
   * Take an organisation to Stripe's hosted checkout for a plan.
   *
   * A HOSTED SESSION RATHER THAN A PAYMENT ELEMENT, which is the opposite of
   * what `checkout.createIntent` does for a product, and deliberately so. A
   * product sale is one amount and one card; a subscription needs tax, VAT
   * numbers, currency selection, coupons, trials and a payment method saved for
   * future invoices — every one of which Stripe's hosted page does correctly
   * and every one of which is a form this firm would otherwise restyle per
   * client. It also means there is no plan checkout PAGE to maintain: a link, a
   * redirect, and the customer comes back to `/account/billing`.
   *
   * `withTenantMetadata` — inside `createCheckoutSession` — is what makes the
   * whole mirror work. A Session's metadata does NOT propagate to the
   * Subscription it creates, so without it every `customer.subscription.*`
   * event would arrive carrying no tenant and the mirror would have nobody to
   * record it against. The tier key is stamped alongside, through
   * `subscription_data`, for the same reason.
   *
   * `subscriptions.manage` and not `plans.view`: this commits the organisation
   * to a recurring charge, which is the same capability as cancelling one.
   */
  subscribeToPlan: requireTenant("subscriptions.manage")
    .meta({ scope: "tenant" })
    .input(
      z.object({
        tierKey: z.string().min(1),
        interval: subscribableInterval,
        currency: z.string().trim().toLowerCase().min(3).max(3),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ readonly url: string }> => {
      if (!stripe) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Payments are not configured on this deployment: STRIPE_SECRET_KEY " +
            "is not set, so there is no checkout to open. See /setup — and " +
            "note that a local deployment can exercise the whole subscription " +
            "path without keys through the simulated one.",
        });
      }
      const client = stripe;

      // NEVER A SECOND SUBSCRIPTION (billing 0.3). A __TENANT_LABEL_LOWER__ that already pays
      // changes its plan in place (`previewPlanChange` / `changePlan`);
      // a new checkout here would make a second subscription and charge for both.
      const live = await liveStripeSubscription(db, ctx.tenantId);
      if (live) throw alreadyPaysRefusal(live.status);
      // ...and ask STRIPE too (review H2): your copy of a new subscription
      // arrives by webhook seconds later, and in that gap (a second tab, or
      // paying and coming straight back) a check of the tables alone says "no
      // plan". This also finds or makes the __TENANT_LABEL_LOWER__'s ONE Stripe customer (a
      // returning one keeps its saved card and invoices) and closes its other
      // open checkouts, so two tabs can never both be paid.
      const prepared = await prepareCompanyCheckout(client, {
        tenantId: ctx.tenantId,
        knownCustomerId: await companyStripeCustomer(db, ctx.tenantId),
        email: ctx.principal.email,
      });
      if (prepared.existingSubscription) throw alreadyPaysRefusal(prepared.existingSubscription.status);

      const { tier, row, priceMinor } = planRowOrThrow(input);

      // The cached Stripe ids, read from the TABLE. The record projects the
      // row's name, amount and interval; only the two ids live in the database,
      // and only because Stripe minted them. A missing row means the seed has
      // never run here, and refusing is better than publishing Stripe objects
      // with nowhere to remember them: the next checkout would make a second
      // pair, and the first pair would keep billing whoever is on it.
      const [cached] = await db
        .select({
          stripeProductId: planTable.stripeProductId,
          stripePriceId: planTable.stripePriceId,
        })
        .from(planTable)
        .where(eq(planTable.key, row.key))
        .limit(1);

      if (!cached) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            `The plans table holds no row keyed "${row.key}". src/plans.ts ` +
            `projects it; \`pnpm db:seed:plans\` is what writes it. Nothing can ` +
            `be subscribed to a plan that has no row for subscriptions.plan_id ` +
            `to point at.`,
        });
      }

      // Published to Stripe on demand rather than by a separate step somebody
      // has to remember. `ensurePlanPrice` is idempotent three ways over and
      // verifies the cached id against the record before trusting it, so a
      // repricing produces a new Price here rather than charging yesterday's
      // amount.
      const published = await ensurePlanPrice(client, {
        planKey: row.key,
        tierKey: tier.key,
        name: row.name,
        description: row.description,
        interval: row.interval,
        unitAmountMinor: priceMinor,
        currency: row.currency,
        cachedProductId: cached.stripeProductId,
        cachedPriceId: cached.stripePriceId,
      });

      await cachePlanIds(row.key, published);

      const returnUrls = checkoutReturnUrls(client.appUrl, {
        // Both back to the billing page. It is where the subscription appears,
        // where the banner explains what state it is in, and where somebody who
        // abandoned the checkout can try again — a cancel that lands on the site
        // root reads as "something went wrong".
        successPath: "/account/billing",
        cancelPath: "/account/billing",
      });

      const session = await createCheckoutSession(client, {
        tenantId: ctx.tenantId,
        params: {
          mode: "subscription",
          line_items: [{ price: published.priceId, quantity: 1 }],
          success_url: returnUrls.success_url,
          cancel_url: returnUrls.cancel_url,
          customer: prepared.customerId,
          // A free tier is a real tier and a real subscription. Without this
          // Stripe demands a card for a £0 subscription and the checkout dead-ends.
          payment_method_collection: "if_required",
          subscription_data: {
            metadata: {
              // THE TIER KEY, read back by `resolvePlanForSubscription` on every
              // event this subscription will ever emit.
              [PLAN_METADATA_KEY]: tier.key,
              planRowKey: row.key,
              userId: ctx.principal.userId,
            },
          },
        },
        // Derived from what is being bought rather than from a random value, so
        // a double-clicked button produces one Session instead of two.
        idempotencyKey: `plan_checkout:${ctx.tenantId}:${row.key}`,
      });

      if (session.url === null) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe returned a checkout session with no URL.",
        });
      }

      return { url: session.url };
    }),

  /**
   * Subscribe to a plan with no Stripe account, on the SAME code path a real
   * subscription takes.
   *
   * WHY THIS EXISTS, and it is the same argument `checkout.simulate` makes one
   * router over. Until the Stripe keys arrive, everything after "subscribe" is
   * theory: no `subscriptions` row, no entitlements, no banner, no cancel
   * button, no renewal — so the whole second half of a subscription product is
   * written blind and integrated on the day money starts moving. This closes
   * the loop early by calling `applySubscription`, which is the exact function
   * `customer.subscription.created` calls. The day the keys land, the only
   * thing that changes is who calls it, what reference it carries, and which
   * audit action it writes.
   *
   * THE FOUR PROPERTIES THAT MAKE IT SAFE are `checkout.simulate`'s, unchanged:
   *
   *  1. ONE PREDICATE. `checkoutMode()`, called first, before any database
   *     read. Not "is Stripe missing" and not "is this not production" — those
   *     are negative gates, and the storefront's own history is the standing
   *     proof of what a negative gate costs. There is no second opinion here.
   *  2. IT NEVER TOUCHES STRIPE. No customer, no subscription, no price.
   *     `applySubscription` does not import Stripe at all.
   *  3. IT GOES THROUGH THE SAME WRITER, so a simulated subscription cannot
   *     hold an entitlement a real one would not — the grants come from
   *     `grantsForPlan` either way, and the expiry window from
   *     `subscriptionEntitlementWindow`.
   *  4. IT IS LOUD. `billing.subscription.simulated` is flagged sensitive, so
   *     it lands in the compliance slice rather than the firehose, and a
   *     `logger.warn` names who was granted what and which environment allowed
   *     it.
   *
   * UNLIKE `checkout.simulate` IT IS NOT PUBLIC, and the difference is real
   * rather than an inconsistency. An order can belong to a guest —
   * `orders.user_id` is nullable by design — but `subscriptions.tenant_id` is
   * NOT NULL, because a subscription is what an ORGANISATION pays. There is no
   * such thing as a subscription with nobody on the other end of it, so the
   * tenant rung is not a restriction added here; it is the table's own shape.
   */
  simulateSubscription: requireTenant("subscriptions.manage")
    .meta({ scope: "tenant" })
    .input(
      z.object({
        tierKey: z.string().min(1),
        interval: subscribableInterval,
        currency: z.string().trim().toLowerCase().min(3).max(3),
        /**
         * Which state to put it in, so the five banners and the two actions on
         * `/account/billing` can each be seen without waiting a month or
         * cancelling a card. `active` is the default and the useful one.
         */
        status: z
          .enum(["active", "trialing", "past_due", "unpaid", "incomplete", "canceled"])
          .default("active"),
        cancelAtPeriodEnd: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Property 1, and it is the FIRST statement. Before the plan lookup,
      // because a deployment with no database would otherwise answer "cannot
      // connect" here — which reads as an outage and sends somebody looking for
      // the wrong fault entirely.
      const mode = checkoutMode();
      if (mode.kind !== "simulated") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Simulated subscriptions are not available here. ${mode.reason}`,
        });
      }

      const { tier, row } = planRowOrThrow(input);

      const now = new Date();
      const period = input.interval === "year" ? 365 : 30;
      const reference = simulatedSubscriptionRef();

      logger.warn(
        {
          reference,
          tenantId: ctx.tenantId,
          userId: ctx.principal.userId,
          tierKey: tier.key,
          planKey: row.key,
          status: input.status,
          reason: mode.reason,
        },
        "SIMULATED SUBSCRIPTION — no money collected, no Stripe call made",
      );

      const result = await applySubscription({
        tenantId: ctx.tenantId,
        tierKey: tier.key,
        planKey: row.key,
        // NULL, never the simulated reference. That column names an object in
        // Stripe and every tool reading it believes so — the same call
        // `bookOrder` makes about `orders.stripe_payment_intent_id`. The
        // reference lives in the audit metadata instead.
        stripeSubscriptionId: null,
        stripeCustomerId: null,
        status: input.status,
        // `incomplete` has no period at Stripe either: a subscription whose
        // first payment never completed has not started one.
        currentPeriodStart: input.status === "incomplete" ? null : now,
        currentPeriodEnd:
          input.status === "incomplete"
            ? null
            : new Date(now.getTime() + period * 24 * 60 * 60 * 1000),
        cancelAtPeriodEnd: input.cancelAtPeriodEnd,
        canceledAt: input.status === "canceled" ? now : null,
        trialEndsAt:
          input.status === "trialing"
            ? new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
            : null,
        observedAt: now,
        observedBy: reference,
        source: "simulated",
        actorUserId: ctx.principal.userId,
      });

      logger.warn(
        {
          reference,
          subscriptionId: result.subscriptionId,
          status: result.status,
          entitlements: result.entitlements,
        },
        "SIMULATED SUBSCRIPTION — recorded and the plan's grants applied",
      );

      return result;
    }),

  /**
   * What changing plan costs, BEFORE anything changes (billing 0.3).
   *
   * THE DOUBLE-CHARGE FIX. "Change plan" used to open a fresh checkout, which
   * made a second Stripe customer and a second subscription: the business paid
   * for both plans and could cancel only one. A __TENANT_LABEL_LOWER__ that already pays now
   * changes the plan ON its one subscription. This asks Stripe what the switch
   * costs today (prorated) so the owner sees "You'll pay $12.50 today, then
   * $99.00 a month" and confirms; `changePlan` then makes exactly that change,
   * with the same proration date, so the charge is the one that was shown.
   *
   * A mutation rather than a query: it may publish the new plan's price to
   * Stripe first, as `subscribeToPlan` does.
   */
  previewPlanChange: requireTenant("subscriptions.manage")
    .meta({ scope: "tenant" })
    .input(
      z.object({
        tierKey: z.string().min(1),
        interval: subscribableInterval,
        currency: z.string().trim().toLowerCase().min(3).max(3),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = stripeOrThrow();
      const live = await liveStripeSubscription(db, ctx.tenantId);
      if (!live) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This __TENANT_LABEL_LOWER__ has no paid plan to change yet. Choose a plan to subscribe.",
        });
      }
      const { tier, row, priceMinor } = planRowOrThrow(input);
      const published = await publishedPlanPrice(client, tier, row, priceMinor);
      try {
        const preview = await previewStripePlanChange(client, {
          subscriptionId: live.stripeSubscriptionId,
          newPriceId: published.priceId,
        });
        return {
          planName: tier.name,
          samePrice: preview.samePrice,
          prorationDate: preview.prorationDate,
          /** "charge": pay `dueNow` today. "credit": `dueNow` comes off the next bills. "none": nothing today. */
          today: preview.dueNowMinor > 0 ? ("charge" as const) : preview.dueNowMinor < 0 ? ("credit" as const) : ("none" as const),
          dueNow: formatMinor(BigInt(Math.abs(preview.dueNowMinor)), preview.currency),
          then: formatMinor(priceMinor, row.currency),
          interval: input.interval,
        };
      } catch (error) {
        throw planChangeRefusal(error);
      }
    }),

  /**
   * Change the plan on the __TENANT_LABEL_LOWER__'s existing subscription — never a second one.
   *
   * `prorationDate` is the preview's, so Stripe charges what the owner agreed
   * to. If that charge fails, Stripe keeps the old plan (`applied: false`) and
   * the screen says so; nothing names the new plan until it's paid for. The
   * subscription's next webhook moves the entitlements, exactly as for any
   * other change, so the plan's limits follow within seconds.
   */
  changePlan: requireTenant("subscriptions.manage")
    .meta({ scope: "tenant" })
    .input(
      z.object({
        tierKey: z.string().min(1),
        interval: subscribableInterval,
        currency: z.string().trim().toLowerCase().min(3).max(3),
        prorationDate: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ readonly applied: boolean }> => {
      const client = stripeOrThrow();
      const live = await liveStripeSubscription(db, ctx.tenantId);
      if (!live) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This __TENANT_LABEL_LOWER__ has no paid plan to change yet. Choose a plan to subscribe.",
        });
      }
      const { tier, row, priceMinor } = planRowOrThrow(input);
      const published = await publishedPlanPrice(client, tier, row, priceMinor);
      try {
        const result = await changeStripePlan(client, {
          subscriptionId: live.stripeSubscriptionId,
          newPriceId: published.priceId,
          prorationDate: input.prorationDate,
          metadata: { [PLAN_METADATA_KEY]: tier.key, planRowKey: row.key, userId: ctx.principal.userId },
          // One change per plan per preview: a double click changes the plan once.
          idempotencyKey: `plan_change:${ctx.tenantId}:${row.key}:${input.prorationDate}`,
        });
        logger.info(
          { tenantId: ctx.tenantId, userId: ctx.principal.userId, planKey: row.key, applied: result.applied },
          result.applied ? "plan changed on the existing subscription" : "plan change held: the prorated charge didn't go through",
        );
        return { applied: result.applied };
      } catch (error) {
        throw planChangeRefusal(error);
      }
    }),

  /**
   * Every __TENANT_LABEL_LOWER__ and where it stands with its plan — for the operator console
   * (billing 0.3). In a project that doesn't sell plans, `plan` is null.
   */
  companies: requireStaff("staff.tenants.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        q: z.string().trim().max(100).optional(),
        page: z.number().int().min(1).max(1000).default(1),
      }),
    )
    .query(async ({ ctx, input }) => {
      const list = await tenancy.listCompanies({
        actorUserId: ctx.principal.userId,
        ...(input.q ? { q: input.q } : {}),
        kind: "org",
        page: input.page,
        pageSize: 25,
      });
      const rows = await Promise.all(
        list.companies.map(async (company) => {
          const plan = await planStandingOf(company.id);
          return {
            id: company.id,
            name: company.name,
            status: company.status,
            members: company.members,
            plan: plan === null
              ? null
              : { state: plan.state, open: plan.open, tierKey: plan.tierKey, until: plan.until?.toISOString() ?? null },
          };
        }),
      );
      return { companies: rows, total: list.total, page: list.page, pageSize: list.pageSize };
    }),

  /**
   * Give a __TENANT_LABEL_LOWER__ free months of a plan — a friend, a first client, a
   * make-good (billing 0.3). Recorded like any subscription, with no Stripe
   * object and no card, ending by itself after `months`; the audit log names
   * who gave it. Refused for a __TENANT_LABEL_LOWER__ that already pays through Stripe (change
   * or cancel that first), and for a plan with no monthly price row to record
   * it against (Enterprise, as shipped).
   */
  compPlan: requireStaff(RESYNC_PERMISSION)
    .meta({ scope: "staff" })
    .input(
      z.object({
        tenantId: z.string().min(1),
        tierKey: z.string().min(1),
        months: z.number().int().min(1).max(36),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (await liveStripeSubscription(db, input.tenantId)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This __TENANT_LABEL_LOWER__ already pays through Stripe. Change or cancel that plan first.",
        });
      }
      const tier = plans.tier(input.tierKey);
      if (tier === undefined) {
        throw new TRPCError({ code: "NOT_FOUND", message: `There is no plan called "${input.tierKey}".` });
      }
      const row =
        plans.rows.find((candidate) => candidate.tierKey === tier.key && candidate.interval === "month") ??
        plans.rows.find((candidate) => candidate.tierKey === tier.key);
      if (row === undefined) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `${tier.name} has no price to record free months against. Give a plan that has one.`,
        });
      }
      const now = new Date();
      const endsAt = new Date(now.getTime() + input.months * 30 * 24 * 60 * 60 * 1000);
      const result = await applySubscription({
        tenantId: input.tenantId,
        tierKey: tier.key,
        planKey: row.key,
        stripeSubscriptionId: null,
        stripeCustomerId: null,
        status: "active",
        currentPeriodStart: now,
        currentPeriodEnd: endsAt,
        // Ends by itself: the plan's rows expire at `endsAt`, no event needed.
        cancelAtPeriodEnd: true,
        canceledAt: null,
        trialEndsAt: null,
        observedAt: now,
        observedBy: `comp:${ctx.principal.userId}`,
        source: "simulated",
        action: "billing.subscription.comped",
        actorUserId: ctx.principal.userId,
      });
      logger.warn(
        { tenantId: input.tenantId, by: ctx.principal.userId, tierKey: tier.key, months: input.months },
        "FREE MONTHS GIVEN — no money collected",
      );
      return { status: result.status, endsAt: endsAt.toISOString() };
    }),

  /**
   * Publish the plan record's prices to Stripe.
   *
   * The push half of the reconciliation. `plans.stripe_product_id` and
   * `stripe_price_id` are a CACHE of objects that have to exist before Stripe
   * will bill anything, and nothing in this scaffold created them — which is
   * why a subscription checkout had a complete catalogue and nothing to charge
   * against.
   *
   * A STRIPE PRICE IS IMMUTABLE, so this never edits one. A repriced tier
   * produces a NEW Price and moves the lookup key onto it; the old Price keeps
   * billing the subscribers already on it, which is the only behaviour that
   * does not silently restate what somebody agreed to pay.
   */
  syncPlans: requireStaff(RESYNC_PERMISSION)
    .meta({ scope: "staff" })
    .mutation(async () => {
      if (!stripe) {
        return {
          status: "not_configured" as const,
          published: 0,
          created: 0,
          rows: [] as readonly { readonly key: string; readonly outcome: string }[],
        };
      }
      const client = stripe;

      const stored = await db
        .select({
          key: planTable.key,
          stripeProductId: planTable.stripeProductId,
          stripePriceId: planTable.stripePriceId,
        })
        .from(planTable);
      const cache = new Map(stored.map((row) => [row.key, row]));

      const outcomes: { key: string; outcome: string }[] = [];
      let created = 0;

      for (const row of plans.rows) {
        // Only rows the seed has written. A row the record projects and the
        // table does not hold has nowhere to cache the ids, so publishing it
        // would create Stripe objects nothing could ever find again.
        const cached = cache.get(row.key);
        if (!cached) {
          outcomes.push({
            key: row.key,
            outcome: "not seeded — run `pnpm db:seed:plans` first",
          });
          continue;
        }

        // A retired tier is not published. It is still readable by everything
        // that has to reason about the people on it, and creating a Price for
        // something nobody may buy would put it back on sale in the dashboard.
        if (!row.isActive) {
          outcomes.push({ key: row.key, outcome: "retired — left alone" });
          continue;
        }

        const published = await ensurePlanPrice(client, {
          planKey: row.key,
          tierKey: row.tierKey,
          name: row.name,
          description: row.description,
          interval: row.interval,
          unitAmountMinor: row.priceMinor,
          currency: row.currency,
          cachedProductId: cached.stripeProductId,
          cachedPriceId: cached.stripePriceId,
        });

        await cachePlanIds(row.key, published);
        if (published.created) created += 1;
        outcomes.push({
          key: row.key,
          outcome: published.unchanged
            ? "already published"
            : published.created
              ? `new price ${published.priceId}`
              : `re-attached to ${published.priceId}`,
        });
      }

      return {
        status: "ok" as const,
        published: outcomes.length,
        created,
        rows: outcomes as readonly { readonly key: string; readonly outcome: string }[],
      };
    }),

  /**
   * Re-pull every subscription Stripe holds into the firm's own tables.
   *
   * *** THIS MATTERS MORE HERE THAN IT WOULD ANYWHERE ELSE. *** A kit that
   * treats Stripe as the record of what a customer pays can repair a missed
   * webhook by reading Stripe on the next page load. This firm owns
   * `subscriptions` and `entitlements`, so a missed event leaves those tables
   * AUTHORITATIVE AND WRONG, with nothing downstream to reconcile against: the
   * customer is charged and holds nothing, or has cancelled and is still
   * served, and neither is visible from inside the application. The webhook is
   * the mechanism; this is the repair, and a firm-owned billing table is not
   * safe to ship without one.
   *
   * IT WINS EVERY ORDERING CONTEST, ON PURPOSE. Each snapshot is stamped with
   * the instant it was FETCHED rather than with an event time, so it is by
   * definition newer than anything the event stream has delivered — which is
   * the correct semantics for a live read and the reason it can repair a row
   * that a stale event would be refused for. The one thing it cannot repair is
   * a subscription Stripe has forgotten, and Stripe does not forget.
   *
   * `status: "all"` and not just the live ones: a cancellation that never
   * arrived is exactly the case where the local table is wrong and still
   * serving, and asking only for live subscriptions would never see it.
   */
  resync: requireStaff(RESYNC_PERMISSION)
    .meta({ scope: "staff" })
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .mutation(async ({ ctx, input }) => {
      if (!stripe) {
        return {
          status: "not_configured" as const,
          examined: 0,
          mirrored: 0,
          skipped: [] as readonly { readonly id: string; readonly why: string }[],
        };
      }
      const client = stripe;
      const context = await requestContext();

      const listed = await client.stripe.subscriptions.list({
        status: "all",
        limit: input.limit,
      });

      const skipped: { id: string; why: string }[] = [];
      let mirrored = 0;

      for (const subscription of listed.data) {
        const snapshot = subscriptionSnapshot(subscription);
        const resolution = await resolvePlanForSubscription({
          planMetadata: snapshot.metadata[PLAN_METADATA_KEY],
          variantMetadata: snapshot.metadata["variantId"],
          priceId: snapshot.priceId,
          interval: snapshot.interval,
          currency: snapshot.currency,
        });

        if (resolution.kind !== "plan") {
          skipped.push({ id: snapshot.subscriptionId, why: resolution.why });
          continue;
        }

        const tenantId = snapshot.metadata["tenantId"];
        if (!tenantId) {
          // Reported rather than thrown, and this is the one place the two
          // differ. In the webhook an unattributable subscription must stay in
          // Stripe's failed queue until a human fixes it; here a human IS
          // looking, and one bad subscription must not abort the repair of the
          // forty-nine beside it.
          skipped.push({
            id: snapshot.subscriptionId,
            why: "carries no tenantId, so there is nobody to record it against",
          });
          continue;
        }

        const result = await applySubscription({
          tenantId,
          tierKey: resolution.tierKey,
          planKey: resolution.planKey,
          stripeSubscriptionId: snapshot.subscriptionId,
          stripeCustomerId: snapshot.customerId,
          status: mapStripeSubscriptionStatus(snapshot.status),
          currentPeriodStart: snapshot.currentPeriodStart,
          currentPeriodEnd: snapshot.currentPeriodEnd,
          cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
          canceledAt: snapshot.canceledAt,
          trialEndsAt: snapshot.trialEndsAt,
          // NOW, not an event time. A live read is newer than every delivery.
          observedAt: new Date(),
          observedBy: `resync:${ctx.principal.userId}`,
          source: "stripe",
          action: "billing.subscription.resynced",
          actorUserId: ctx.principal.userId,
        });

        if (result.applied) mirrored += 1;
        else skipped.push({ id: snapshot.subscriptionId, why: result.why });
      }

      logger.info(
        {
          actorUserId: ctx.principal.userId,
          ipAddress: context.ipAddress,
          examined: listed.data.length,
          mirrored,
          skipped: skipped.length,
        },
        "Staff re-pulled subscription state from Stripe",
      );

      return {
        status: "ok" as const,
        examined: listed.data.length,
        mirrored,
        skipped: skipped as readonly { readonly id: string; readonly why: string }[],
      };
    }),

  /** What the firm's own tables currently say. The resync's before-picture. */
  mirrored: requireStaff(RESYNC_PERMISSION)
    .meta({ scope: "staff" })
    .query(async () => listMirroredSubscriptions()),
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The tier, the projected row and the amount, or a refusal saying which of the
 * three was missing.
 *
 * ONE FUNCTION FOR BOTH PURCHASE PATHS, exactly as `purchasableOrThrow` is one
 * function for `createIntent` and `checkout.simulate`. The requirement is not
 * "simulate checks the same things today"; it is that a simulated subscription
 * can never be granted for a tier a real one would refuse, including after
 * somebody adds a fourth rule and remembers only one call site.
 */
function planRowOrThrow(input: {
  readonly tierKey: string;
  readonly interval: "month" | "year";
  readonly currency: string;
}): {
  readonly tier: NonNullable<ReturnType<typeof plans.tier>>;
  readonly row: (typeof plans.rows)[number];
  readonly priceMinor: bigint;
} {
  const tier = plans.tier(input.tierKey);
  if (tier === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `There is no plan called "${input.tierKey}".`,
    });
  }

  if (!tier.isActive) {
    // Same message a missing tier gets. A retired tier is closed to new
    // subscriptions and the difference between "retired" and "never existed" is
    // information about the firm's pricing history.
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `There is no plan called "${input.tierKey}".`,
    });
  }

  const interval: PlanInterval = input.interval;
  const priceMinor = priceFor(tier, interval, input.currency);
  if (priceMinor === undefined) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message:
        `${tier.name} is not sold ${input.interval}ly in ` +
        `${input.currency.toUpperCase()}. A tier with no price on an interval is ` +
        `a real decision — "talk to us" is a plan — so this is a refusal rather ` +
        `than a zero.`,
    });
  }

  const key = planRowKey(tier.key, interval, input.currency);
  const row = plans.rows.find((candidate) => candidate.key === key);
  if (row === undefined) {
    // Unreachable while `priceFor` and the projection agree, which is what
    // `definePlans` enforces at construction. Loud rather than absent, because
    // the alternative is a checkout that charges an amount no row describes.
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        `${tier.name} has a price for ${key} and the record projects no row for ` +
        `it. definePlans should have refused that catalogue.`,
    });
  }

  return { tier, row, priceMinor };
}

/**
 * Remember what Stripe was told, on the row the record projected.
 *
 * A cache write, never a catalogue write: the amount, the name and the interval
 * are the record's and are not touched here. Only the two ids move, and they
 * move in one direction — Stripe told us what it created, and the next checkout
 * must find the same objects rather than making a second set.
 */
async function cachePlanIds(
  planKey: string,
  published: { readonly productId: string; readonly priceId: string },
): Promise<void> {
  await db
    .update(planTable)
    .set({
      stripeProductId: published.productId,
      stripePriceId: published.priceId,
      updatedAt: new Date(),
    })
    .where(eq(planTable.key, planKey));
}

/** The Stripe client, or the plain refusal a deployment without keys gives. */
function stripeOrThrow(): NonNullable<typeof stripe> {
  if (!stripe) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      // The owner's words; the operator's (STRIPE_SECRET_KEY, /setup) are on /setup.
      message: "Paying for a plan isn't switched on for this site yet. Please try again later.",
    });
  }
  return stripe;
}

/**
 * The plan's price, published to Stripe if it isn't yet — the same steps
 * `subscribeToPlan` takes, shared so a plan change can never charge a price
 * a new subscription wouldn't.
 */
async function publishedPlanPrice(
  client: NonNullable<typeof stripe>,
  tier: NonNullable<ReturnType<typeof plans.tier>>,
  row: (typeof plans.rows)[number],
  priceMinor: bigint,
): Promise<{ readonly productId: string; readonly priceId: string }> {
  const [cached] = await db
    .select({ stripeProductId: planTable.stripeProductId, stripePriceId: planTable.stripePriceId })
    .from(planTable)
    .where(eq(planTable.key, row.key))
    .limit(1);
  if (!cached) {
    logger.error({ planKey: row.key }, "plans table has no row for this plan: run pnpm db:seed:plans");
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      // The owner's words; the fix (pnpm db:seed:plans) is in the log line above.
      message: "This plan isn't ready to buy yet. Please try again later.",
    });
  }
  const published = await ensurePlanPrice(client, {
    planKey: row.key,
    tierKey: tier.key,
    name: row.name,
    description: row.description,
    interval: row.interval,
    unitAmountMinor: priceMinor,
    currency: row.currency,
    cachedProductId: cached.stripeProductId,
    cachedPriceId: cached.stripePriceId,
  });
  await cachePlanIds(row.key, published);
  return published;
}

/** A plan change Stripe can't make, in words: a cancelled subscription, or one edited by hand in Stripe. */
function planChangeRefusal(error: unknown): unknown {
  if (error instanceof PlanChangeError) {
    return new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        error.code === "not_changeable"
          ? "This plan can't be changed right now because the subscription isn't active. Choose a plan to start a new one."
          : error.code === "stale_preview"
            ? error.message
            : "This plan can't be switched here. Contact support and we'll change it for you.",
      cause: error,
    });
  }
  return error;
}

/**
 * "You already have a plan", in words that say what to do (review M7): a
 * plan whose payment failed is fixed by updating the card, not by a second
 * checkout or a plan change.
 */
function alreadyPaysRefusal(status: string): TRPCError {
  if (status === "past_due" || status === "unpaid") {
    return new TRPCError({
      code: "CONFLICT",
      message: "The last payment for this plan didn't go through. Update the card under Payment methods to keep it running.",
    });
  }
  if (status === "incomplete") {
    return new TRPCError({
      code: "CONFLICT",
      message: "A checkout for this plan was started but not finished. Finish it, or wait a few minutes and try again.",
    });
  }
  return new TRPCError({
    code: "CONFLICT",
    message: "This __TENANT_LABEL_LOWER__ already pays for a plan. Use Change plan, so it's never charged twice.",
  });
}

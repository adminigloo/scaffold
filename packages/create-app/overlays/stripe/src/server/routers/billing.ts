import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, exists, ilike, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  formatMinor,
  mapStripeSubscriptionStatus,
  notOnSaleReason,
  planOnSale,
  planRowKey,
  priceFor,
  type PlanInterval,
} from "__SCOPE__/billing";
import { plans as planTable, subscriptions } from "__SCOPE__/billing/schema";
import { users } from "__SCOPE__/auth/schema";
import {
  companyStripeCustomer,
  lineOfStoredRow,
  liveStripeLines,
  liveStripeSubscription,
  loadCompanyPlan,
  type LiveStripeLine,
} from "__SCOPE__/billing/server";
import { createLogger } from "__SCOPE__/observability";
import {
  addLine as addStripeLine,
  addLineIdempotencyKey,
  changePlan as changeStripePlan,
  checkoutReturnUrls,
  createCheckoutSession,
  ensurePlanPrice,
  PlanChangeError,
  prepareCompanyCheckout,
  previewAddLine as previewStripeAddLine,
  previewPlanChange as previewStripePlanChange,
  subscriptionSnapshot,
} from "__SCOPE__/stripe";
import { tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import { env } from "@/env";
import { plans } from "@/plans";
import { checkoutMode } from "@/server/checkout-mode";
import { followShopSubscription } from "@/server/shop-hooks";
import { CHECKOUT_TRIAL_DAYS, planStandingOf } from "@/server/plan-gate";
import { stripe } from "@/server/stripe";
import { tenancy } from "@/server/tenancy";
import {
  applySubscription,
  listMirroredSubscriptions,
  mirrorStripeSubscription,
  resolveSubscriptionItem,
  simulatedSubscriptionRef,
  PLAN_METADATA_KEY,
} from "@/server/subscription";
import { isOwnPersonalWorkspace } from "@/server/stripe-customers";
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
      // PRODUCT LINES (billing 0.5): a second line is an ITEM added to the
      // subscription this __TENANT_LABEL_LOWER__ already pays (`addLine`), never a second
      // subscription — so "already pays" is refused here whichever line it is.
      const multiLine = plans.lines.length > 1;
      const live = await liveStripeSubscription(db, ctx.tenantId);
      if (live) throw alreadyPaysRefusal(live.status, multiLine);
      // ...and ask STRIPE too (review H2): your copy of a new subscription
      // arrives by webhook seconds later, and in that gap (a second tab, or
      // paying and coming straight back) a check of the tables alone says "no
      // plan". This also finds or makes the __TENANT_LABEL_LOWER__'s ONE Stripe customer (a
      // returning one keeps its saved card and invoices; one the shop made for
      // this person is reused, review B5) and closes its other open checkouts,
      // so two tabs can never both be paid. A person's own customer from the
      // shop is adopted only for their OWN workspace — never a company's
      // (review: the company's invoices would go to that member's email).
      const ownWorkspace = await isOwnPersonalWorkspace(ctx.tenantId, ctx.principal.userId);
      const prepared = await prepareCompanyCheckout(client, {
        tenantId: ctx.tenantId,
        ...(ownWorkspace ? { userId: ctx.principal.userId } : {}),
        knownCustomerId: await companyStripeCustomer(db, ctx.tenantId),
        email: ctx.principal.email,
      });
      if (prepared.existingSubscription) throw alreadyPaysRefusal(prepared.existingSubscription.status, multiLine);

      const { tier, row, priceMinor } = planRowOrThrow(input);

      // A FREE TRIAL AT STRIPE (billing 0.5, a personal-plans project with
      // BILLING_TRIAL_DAYS set): only for someone who has never had a
      // subscription — not here, and not on this Stripe customer — so ending
      // one and starting again is not a second free trial. The card is taken
      // up front, so the first charge on the trial's last day just happens.
      const [anyBefore] = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, ctx.tenantId))
        .limit(1);
      const trialDays = CHECKOUT_TRIAL_DAYS > 0 && !prepared.hadSubscription && anyBefore === undefined && priceMinor > 0n ? CHECKOUT_TRIAL_DAYS : 0;

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
        // root reads as "something went wrong". A success passes through
        // /account/billing/return first (create-app 0.39), which marks a FIRST
        // payment for the site's numbers and 307s on to the billing page.
        successPath: "/account/billing/return",
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
          // A trial takes the card now, so it can be charged when the trial ends.
          payment_method_collection: trialDays > 0 ? "always" : "if_required",
          subscription_data: {
            ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
            metadata: {
              // THE TIER KEY, read back by `resolvePlanForSubscription` on every
              // event this subscription will ever emit.
              [PLAN_METADATA_KEY]: tier.key,
              planRowKey: row.key,
              planLine: tier.line,
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
      const { tier, row, priceMinor } = planRowOrThrow(input);
      // The LINE's own item (billing 0.5): a change to Weather never touches Sports.
      const live = lineToChange(await liveStripeLines(db, ctx.tenantId), tier, input);
      const published = await publishedPlanPrice(client, tier, row, priceMinor);
      try {
        const preview = await previewStripePlanChange(client, {
          subscriptionId: live.stripeSubscriptionId,
          ...(live.stripeItemId !== null ? { itemId: live.stripeItemId } : {}),
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
      const { tier, row, priceMinor } = planRowOrThrow(input);
      const live = lineToChange(await liveStripeLines(db, ctx.tenantId), tier, input);
      const published = await publishedPlanPrice(client, tier, row, priceMinor);
      try {
        const result = await changeStripePlan(client, {
          subscriptionId: live.stripeSubscriptionId,
          ...(live.stripeItemId !== null ? { itemId: live.stripeItemId } : {}),
          newPriceId: published.priceId,
          prorationDate: input.prorationDate,
          metadata: { [PLAN_METADATA_KEY]: tier.key, planRowKey: row.key, planLine: tier.line, userId: ctx.principal.userId },
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
   * What ADDING a product line costs today (billing 0.5), before anything
   * changes: "Sports: you'll pay $2.40 today, then $5.00 a month".
   *
   * A second line is an ITEM on the subscription this __TENANT_LABEL_LOWER__ already pays —
   * one customer, one invoice, one billing date — prorated to the rest of the
   * period and charged now. Never a second checkout or a second subscription.
   * Every line on one subscription is billed on the same cadence and in the
   * same currency (Stripe's rule), so the line is added on the plan's own.
   */
  previewAddLine: requireTenant("subscriptions.manage")
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
      const { tier, row, priceMinor } = planRowOrThrow(input);
      const paying = lineToAddTo(await liveStripeLines(db, ctx.tenantId), tier, input);
      // Stripe's own items too, read the way the mirror reads them: a line
      // whose item is still billed is on the plan, whatever our rows say.
      await assertLineNotAtStripe(client, paying.stripeSubscriptionId, tier);
      const published = await publishedPlanPrice(client, tier, row, priceMinor);
      try {
        const preview = await previewStripeAddLine(client, {
          subscriptionId: paying.stripeSubscriptionId,
          newPriceId: published.priceId,
        });
        return {
          planName: tier.name,
          lineName: lineName(tier.line),
          samePrice: preview.samePrice,
          prorationDate: preview.prorationDate,
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
   * Add a product line to the plan this __TENANT_LABEL_LOWER__ already pays (billing 0.5).
   *
   * MONEY RULES, the same ones a plan change keeps: the price is the record's
   * (published through `ensurePlanPrice`, never the browser's); the proration
   * date is the preview's and no older than half an hour; and the charge is
   * `pending_if_incomplete`, so a declined card adds nothing. Stripe is read
   * first, so a line added a second ago in another tab (whose webhook hasn't
   * arrived) is refused rather than added twice — and two tabs adding from
   * the same state share one idempotency key, so Stripe adds ONE item.
   *
   * THE KEY NEVER COMES ROUND AGAIN (review). It names the subscription's
   * latest invoice and the items this line held before, so adding a line
   * back after dropping it is a new request — never a replay of the first
   * add's stored answer, which added and charged nothing. And what is
   * mirrored is a FRESH READ of the subscription after the add (the package's
   * `addLine` reads it again), never the update's own answer: the line is
   * granted only if Stripe holds its new item.
   */
  addLine: requireTenant("subscriptions.manage")
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
      const { tier, row, priceMinor } = planRowOrThrow(input);
      const paying = lineToAddTo(await liveStripeLines(db, ctx.tenantId), tier, input);
      // The items this line held on this subscription before (one row per
      // subscription and line, which keeps the last item's id): every add
      // makes a new item, so a re-add after a drop gets a key of its own.
      // READ BEFORE STRIPE IS, on purpose: a second tab whose read of Stripe
      // predates the first tab's add must also predate that add's mirror, so
      // both derive ONE key and Stripe refuses the second (a different tier of
      // the same line collides instead of billing the line twice); a tab that
      // reads Stripe after the add is refused by the item it finds there.
      const before = await db
        .select({ itemId: subscriptions.stripeItemId })
        .from(subscriptions)
        .where(and(eq(subscriptions.stripeSubscriptionId, paying.stripeSubscriptionId), eq(subscriptions.line, tier.line)));
      const published = await publishedPlanPrice(client, tier, row, priceMinor);
      const current = await assertLineNotAtStripe(client, paying.stripeSubscriptionId, tier);
      try {
        const result = await addStripeLine(client, {
          subscriptionId: current.id,
          newPriceId: published.priceId,
          prorationDate: input.prorationDate,
          itemMetadata: { [PLAN_METADATA_KEY]: tier.key, planRowKey: row.key, planLine: tier.line, userId: ctx.principal.userId },
          idempotencyKey: addLineIdempotencyKey(current, tier.line, { previousItemIds: before.map((each) => each.itemId) }),
        });
        if (result.applied && result.itemId !== null) {
          // Mirrored at once from the FRESH read `addLine` made after the
          // update (never the update's own answer, which a replay can make
          // stale), so the billing page shows the new line on the reload
          // rather than after the webhook. A failure here changes nothing at
          // Stripe: logged, and the webhook mirrors it a moment later.
          try {
            await mirrorStripeSubscription(subscriptionSnapshot(result.subscription), {
              observedAt: new Date(),
              observedBy: `line-add:${ctx.principal.userId}`,
              actorUserId: ctx.principal.userId,
            });
          } catch (error) {
            logger.error({ err: error, tenantId: ctx.tenantId, planKey: row.key }, "a line was added at Stripe and couldn't be mirrored yet; the webhook will");
          }
        }
        logger.info(
          { tenantId: ctx.tenantId, userId: ctx.principal.userId, planKey: row.key, line: tier.line, applied: result.applied },
          result.applied ? "product line added to the existing subscription" : "product line held: the prorated charge didn't go through",
        );
        return { applied: result.applied };
      } catch (error) {
        if (isIdempotencyConflict(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "Your plan was just changed from another window. Reload the page to see what it is now.",
            cause: error,
          });
        }
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
      const tier = plans.tier(input.tierKey);
      if (tier === undefined) {
        throw new TRPCError({ code: "NOT_FOUND", message: `There is no plan called "${input.tierKey}".` });
      }
      // Refused where it would sit beside a paid line: on the SAME product
      // line (billing 0.5). Free months of Sports for someone paying for
      // Weather are fine; free months of Weather for someone paying for it
      // would be a second Weather.
      const paidLines = await liveStripeLines(db, input.tenantId);
      if (paidLines.some((paid) => lineOfStoredRow(plans, paid.planKey, paid.line) === tier.line)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: plans.lines.length > 1
            ? `This __TENANT_LABEL_LOWER__ already pays for ${lineName(tier.line)} through Stripe. Change or cancel that first.`
            : "This __TENANT_LABEL_LOWER__ already pays through Stripe. Change or cancel that plan first.",
        });
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
   * WHO PAYS, AND FOR WHAT (billing 0.5): the people who signed up, each with
   * where they stand on every product line — for the Subscribers page of a
   * project whose customers are people (`--audience consumers`), and its Give
   * free months. With no search, only people who have (or had) a plan; a
   * search finds anyone by name or email, so free months can go to someone
   * who never paid.
   */
  subscribers: requireStaff("staff.tenants.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        q: z.string().trim().max(100).optional(),
        page: z.number().int().min(1).max(1000).default(1),
      }),
    )
    .query(async ({ input }) => {
      const pageSize = 25;
      const pattern = input.q && input.q.length > 0 ? `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const where = and(
        eq(tenants.kind, "personal"),
        isNull(tenants.deletedAt),
        pattern !== null
          ? or(ilike(users.email, pattern), ilike(users.displayName, pattern), ilike(tenants.name, pattern))
          : exists(db.select({ one: sql`1` }).from(subscriptions).where(eq(subscriptions.tenantId, tenants.id))),
      );
      const [total] = await db
        .select({ n: count() })
        .from(tenants)
        .leftJoin(users, eq(users.id, tenants.ownerUserId))
        .where(where);
      const rows = await db
        .select({ id: tenants.id, name: tenants.name, createdAt: tenants.createdAt, email: users.email, displayName: users.displayName })
        .from(tenants)
        .leftJoin(users, eq(users.id, tenants.ownerUserId))
        .where(where)
        .orderBy(desc(tenants.createdAt))
        .limit(pageSize)
        .offset((input.page - 1) * pageSize);
      const people = await Promise.all(
        rows.map(async (row) => {
          const plan = await loadCompanyPlan(db, { tenantId: row.id, trialStartedAt: null, trialDays: 0, plans });
          return {
            tenantId: row.id,
            name: row.displayName ?? row.name,
            email: row.email,
            joinedAt: row.createdAt.toISOString(),
            lines: [...plan.lines.values()].map((line) => ({
              line: line.line,
              lineName: plans.line(line.line)?.name ?? line.line,
              state: line.standing.state,
              open: line.standing.open,
              tierKey: line.standing.tierKey,
              tierName: line.standing.tierKey ? (plans.tier(line.standing.tierKey)?.name ?? line.standing.tierKey) : null,
              until: line.standing.until?.toISOString() ?? null,
              paidByCard: (line.subscription?.stripeSubscriptionId ?? null) !== null,
            })),
          };
        }),
      );
      return { people, total: Number(total?.n ?? 0), page: input.page, pageSize };
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
        // Nor is a tier that isn't on sale (billing 0.6, review): "coming"
        // (shown with its price, never sold) or sold by hand only. The same
        // rule as checkout's, `planOnSale`, for the same reason as above.
        const tierOnSale = plans.tier(row.tierKey);
        if (tierOnSale === undefined || !planOnSale(tierOnSale)) {
          outcomes.push({ key: row.key, outcome: tierOnSale?.onSale === "coming" ? "coming soon — not published until it's on sale" : "not on sale — left alone" });
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
        // Every item, one product line each (billing 0.5), through the one
        // writer — and a line whose item is gone is ended, as the webhook does.
        const outcome = await mirrorStripeSubscription(snapshot, {
          // NOW, not an event time. A live read is newer than every delivery.
          observedAt: new Date(),
          observedBy: `resync:${ctx.principal.userId}`,
          action: "billing.subscription.resynced",
          actorUserId: ctx.principal.userId,
        });

        if (outcome.kind === "product") {
          // A recurring product's grants follow its subscription (review B4);
          // nothing to follow in a project with no shop (src/server/shop-hooks.ts).
          await followShopSubscription({
            subscriptionId: snapshot.subscriptionId,
            status: mapStripeSubscriptionStatus(snapshot.status),
            cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
            currentPeriodEnd: snapshot.currentPeriodEnd,
            at: new Date(),
          });
          skipped.push({ id: snapshot.subscriptionId, why: outcome.why });
          continue;
        }
        if (outcome.kind === "unknown") {
          skipped.push({ id: snapshot.subscriptionId, why: outcome.why });
          continue;
        }
        if (outcome.kind === "no_tenant") {
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

        if ([...outcome.lines, ...outcome.closed].some((line) => line.result.applied)) mirrored += 1;
        else skipped.push({ id: snapshot.subscriptionId, why: outcome.lines[0]?.result.why ?? "nothing to write" });
        if (outcome.duplicates.length > 0) {
          skipped.push({
            id: snapshot.subscriptionId,
            why: `bills one product line twice (${outcome.duplicates.join(", ")}): remove the extra item in Stripe`,
          });
        }
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

  // ON SALE (billing 0.6): a plan marked "coming" is shown with its price and
  // never sold; one marked onSale: false is put on by hand only (free months,
  // from the Subscribers page). Every way in — a new checkout, a simulated
  // one, a change of plan, an added line — comes through here.
  const notSold = notOnSaleReason(tier);
  if (notSold !== null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: notSold });
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
            : error.code === "no_such_item"
              ? "Your plan was just changed somewhere else. Reload the page and try again."
              : error.code === "already_on_price"
                ? "That's already on your plan."
                : error.code === "not_added"
                  ? "Nothing was added or charged. Reload the page and try again."
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
function alreadyPaysRefusal(status: string, multiLine = false): TRPCError {
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
  if (multiLine) {
    // PRODUCT LINES (billing 0.5): another line is added to the plan already
    // paid for — one subscription, one bill — never a second checkout.
    return new TRPCError({
      code: "CONFLICT",
      message: "This __TENANT_LABEL_LOWER__ already pays for a plan here. Add this one to it (or use Change plan on the same line), so it's one bill and never charged twice.",
    });
  }
  return new TRPCError({
    code: "CONFLICT",
    message: "This __TENANT_LABEL_LOWER__ already pays for a plan. Use Change plan, so it's never charged twice.",
  });
}

// ---------------------------------------------------------------------------
// Product lines (billing 0.5)
// ---------------------------------------------------------------------------

/** A product line's name ("Weather"); "this plan" for the one line of a catalog without lines. */
function lineName(key: string): string {
  const line = plans.line(key);
  return line !== undefined && !line.implicit ? line.name : "this plan";
}

/** The cadence and currency a live line is billed on, read off its `plans.key`. */
function cadenceOf(planKey: string | null): { readonly interval: string; readonly currency: string } | null {
  const row = planKey === null ? undefined : plans.rows.find((candidate) => candidate.key === planKey);
  return row ? { interval: row.interval, currency: row.currency } : null;
}

/**
 * Everything on one Stripe subscription is billed together: one cadence, one
 * currency (Stripe refuses a monthly and a yearly item side by side). So with
 * other lines on the plan, a line is added or changed on the plan's own.
 */
function assertSameCadence(lines: readonly LiveStripeLine[], input: { readonly interval: string; readonly currency: string }): void {
  const cadence = cadenceOf(lines[0]?.planKey ?? null);
  if (cadence === null) return;
  if (cadence.interval !== input.interval || cadence.currency !== input.currency.toLowerCase()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        `Your plan is billed ${cadence.interval === "year" ? "yearly" : "monthly"} in ${cadence.currency.toUpperCase()}, ` +
        `and everything on it is billed together. Choose the ${cadence.interval === "year" ? "yearly" : "monthly"} ${cadence.currency.toUpperCase()} price.`,
    });
  }
}

/**
 * The live line a change of tier swaps: the one ON THE TIER'S OWN LINE. A
 * __TENANT_LABEL_LOWER__ paying for another line only is told to add this one instead.
 */
function lineToChange(
  lines: readonly LiveStripeLine[],
  tier: NonNullable<ReturnType<typeof plans.tier>>,
  input: { readonly interval: string; readonly currency: string },
): LiveStripeLine {
  const mine = lines.find((paid) => lineOfStoredRow(plans, paid.planKey, paid.line) === tier.line);
  if (mine === undefined) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        lines.length > 0
          ? `${tier.name} isn't on your plan yet. Add it, so it's on the same bill.`
          : "This __TENANT_LABEL_LOWER__ has no paid plan to change yet. Choose a plan to subscribe.",
    });
  }
  const others = lines.filter((paid) => paid !== mine);
  if (others.length > 0) assertSameCadence(others, input);
  return mine;
}

/** The paid subscription a new line is added to, refused in words when it can't be. */
function lineToAddTo(
  lines: readonly LiveStripeLine[],
  tier: NonNullable<ReturnType<typeof plans.tier>>,
  input: { readonly interval: string; readonly currency: string },
): LiveStripeLine {
  const first = lines[0];
  if (first === undefined) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "There's no paid plan to add this to yet. Choose a plan to subscribe.",
    });
  }
  if (lines.some((paid) => lineOfStoredRow(plans, paid.planKey, paid.line) === tier.line)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `${lineName(tier.line)} is already on your plan. Use Change plan to move to ${tier.name}.`,
    });
  }
  if (first.status === "past_due" || first.status === "unpaid") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "The last payment for your plan didn't go through. Update the card under Payment methods first, then add this.",
    });
  }
  assertSameCadence(lines, input);
  return first;
}

/**
 * Refuse to add `tier`'s line when Stripe already bills it on this
 * subscription — read item by item the way the MIRROR reads them
 * (`resolveSubscriptionItem`: the cached price, the Price's own stamp, the
 * item's metadata, our own row for the item). Not the cached price alone
 * (review): an item still on a Price from before a repricing isn't the cached
 * one, and reading it as "not a plan" let the same line be added — and billed
 * — twice. Answers the subscription it read.
 */
async function assertLineNotAtStripe(
  client: NonNullable<typeof stripe>,
  subscriptionId: string,
  tier: NonNullable<ReturnType<typeof plans.tier>>,
) {
  const current = await client.stripe.subscriptions.retrieve(subscriptionId);
  const snapshot = subscriptionSnapshot(current);
  for (const item of snapshot.items) {
    const resolution = await resolveSubscriptionItem(snapshot, item);
    if (resolution.kind === "plan" && plans.tier(resolution.tierKey)?.line === tier.line) {
      throw new TRPCError({
        code: "CONFLICT",
        message: `${lineName(tier.line)} is already on your plan. Use Change plan to move to ${tier.name}.`,
      });
    }
  }
  return current;
}

/** Stripe's answer to one idempotency key reused with different parameters — another tab got there first. */
function isIdempotencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { type?: unknown }).type === "idempotency_error";
}


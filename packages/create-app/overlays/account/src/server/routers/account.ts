import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { isLiveStatus, mapStripeSubscriptionStatus } from "__SCOPE__/billing";
import { auditEntry, defineAuditedActions } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { createBillingPortalSession, subscriptionSnapshot } from "__SCOPE__/stripe";
import { db } from "@/db";
import { plans } from "@/plans";
import { readSubscriptionForTenant, type AccountSubscription } from "@/server/account";
import { stripe } from "@/server/stripe";
import { applySubscription } from "@/server/subscription";
import { requestContext } from "../request-context";
import { findStripeCustomerId } from "./checkout";
import { createTRPCRouter, requireTenant } from "../trpc";

/**
 * The one mutation the customer account area has.
 *
 * EVERYTHING ELSE IN THIS OVERLAY IS A SERVER-COMPONENT READ, deliberately, and
 * matching `app/(site)/members/page.tsx`: pages read the database directly,
 * mutations go through a router, because a mutation written into a page is a
 * mutation the scope audit cannot see. There is exactly one thing a customer
 * can DO here that is not navigation, and it is this.
 *
 * IT REPLACES A WHOLE CATEGORY OF SCREENS. Payment methods, billing addresses,
 * VAT ids, dunning, invoice PDFs and cancellation are all Stripe's hosted
 * portal, and every one of them is a form this firm would otherwise restyle for
 * each client. One server call and a redirect is the entire feature.
 */

/**
 * TENANT-SCOPED, NOT STAFF, and the scope is the whole decision in this file.
 *
 * `billing.portal.open` is declared by @__SCOPE_NAME__/stripe and spread into
 * the TENANT catalog by `src/permissions/catalog.ts`. Nothing new is declared
 * here, and the key is checked with `requireTenant`, which is the rung that
 * reads that catalog. A key declared in one catalog and checked against the
 * other matches nothing, is invisible to everybody including the owner, and
 * raises no error anywhere — this scaffold has shipped that bug three times.
 *
 * It is genuinely the customer's own key rather than the firm's: the portal
 * shows one organisation its own cards and its own invoices, and the firm's
 * staff ladder has no `owner` to give it to. `defaultFor: ["owner"]` on the
 * package's declaration names a template that exists only in
 * `TENANT_ROLE_TEMPLATES`, which is the tie-breaker the fragment table uses.
 *
 * NOTE WHAT IS NOT GATED THIS WAY. `/account` and `/account/orders` check no
 * permission key at all, and that is not an oversight — see the header of
 * `src/server/account.ts`. A storefront order is booked under the FIRM's tenant
 * with the buyer's `user_id`, so the buyer is not a member of the tenant their
 * own order lives in, and a `requireTenant("orders.view")` there would deny
 * every customer their own receipt. Ownership of the row is the authorisation
 * on those pages. A subscription is different: it belongs to a real customer
 * organisation, several people can be in it, and only some of them should be
 * able to cancel it. That is what a permission is for, and it is why only this
 * surface has one.
 */
const PORTAL_PERMISSION = "billing.portal.open";

/**
 * Opening the portal is recorded; reading your own orders is not.
 *
 * The line is drawn at what somebody else can be affected by. A customer
 * looking at their own receipts affects nobody, and auditing it would bury the
 * rows that matter under a stream of page views. A portal session hands the
 * holder the ability to cancel the ORGANISATION's subscription and download its
 * invoices, and the act itself then happens at Stripe where this application
 * sees nothing — so without this row, "who cancelled our subscription" has no
 * answer on our side at all.
 *
 * ITS OWN REGISTRY, and the fragment is exported for `src/server/audit.ts` to
 * compose. `defineAuditedActions` here, used here, imported nowhere from here:
 * the generated audit module reads this fragment, so if this module read the
 * generated registry back the two would form an import cycle and one of them
 * would be half-initialised at first use. `routers/catalog.ts` is arranged the
 * same way for the same reason.
 */
export const accountAuditedActions = {
  "billing.portal.opened": {
    label: "Opened the Stripe billing portal for this __TENANT_LABEL_LOWER__",
    /**
     * Sensitive, so it lands in the partial index the compliance slice reads
     * rather than in the general firehose. The session grants a view of every
     * invoice and payment method the __TENANT_LABEL_LOWER__ has, which is the
     * disclosure a "who could have seen this" review starts from — and it is
     * the same reasoning that marks `invitation.accepted` sensitive and leaves
     * `invitation.sent` alone.
     */
    sensitive: true,
  },
} as const satisfies Record<string, { label: string; sensitive?: boolean }>;

export const accountAuditRegistry = defineAuditedActions(accountAuditedActions);

/**
 * What `billingPortal` can answer. THREE OUTCOMES, NO THROW ON TWO OF THEM.
 *
 * A missing credential is not an error, it is a state — that rule is what the
 * whole scaffold is organised around, and it applies with particular force to
 * the button a customer presses when they want to stop paying. Throwing
 * `StripeNotConfiguredError` at somebody trying to cancel a subscription would
 * be the single worst place in the product to surface a deployment problem.
 *
 * A DISCRIMINATED UNION rather than a nullable url, so the component cannot
 * render a link to `undefined` and cannot show one apology for two different
 * situations: "this deployment cannot reach Stripe" and "you have never paid us
 * anything" need different sentences, and only one of them is worth telling an
 * operator about.
 */
export type BillingPortalResult =
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "not_configured" }
  | { readonly status: "no_customer" };

export const accountRouter = createTRPCRouter({
  /**
   * A one-time link into Stripe's hosted billing portal.
   *
   * A MUTATION EVEN THOUGH IT READS. It creates a short-lived, single-use
   * session object at Stripe and writes an audit row, so it must not be a
   * query: a query is retried by the client on focus and prefetched by the
   * router, and either would mint sessions and audit rows nobody asked for.
   */
  billingPortal: requireTenant(PORTAL_PERMISSION)
    .meta({ scope: "tenant" })
    .mutation(async ({ ctx }): Promise<BillingPortalResult> => {
      // The same honest condition `SimulatePurchase` keys off, enforced on the
      // server as well as decided in the page. The page hides the button when
      // Stripe is absent; this is what makes that a guarantee rather than a
      // rendering choice, because the procedure is reachable directly.
      if (!stripe) return { status: "not_configured" };
      const client = stripe;

      /**
       * THE LOCAL ROW FIRST, STRIPE SECOND.
       *
       * `subscriptions.stripe_customer_id` is the canonical local record of who
       * this __TENANT_LABEL_LOWER__ is at Stripe, and reading it costs nothing.
       * It is empty today on a fresh deployment, because nothing in this
       * scaffold yet mirrors `customer.subscription.*` back into that table —
       * so falling through to Stripe's own index is what makes the button work
       * for a customer who has bought a subscription through this checkout. The
       * fallback goes away by itself the day the mirror lands.
       *
       * `findStripeCustomerId` and never `ensureCustomer`: creating a Customer
       * to open a portal against produces a session with no invoices, no cards
       * and no subscription, which reads as lost billing history rather than as
       * an account that has never been charged.
       */
      const subscription = await readSubscriptionForTenant(ctx.tenantId);
      const customerId =
        subscription?.stripeCustomerId ??
        (await findStripeCustomerId(client, ctx.principal.userId));

      if (customerId === null) return { status: "no_customer" };

      const session = await createBillingPortalSession(client, {
        customerId,
        // Back to the page they left, not to the site root. A portal is a place
        // people leave and come back from repeatedly — update a card, check it
        // took — and landing on the home page each time makes a two-minute
        // task feel like it failed.
        returnPath: "/account/billing",
      });

      await db.insert(auditLog).values(
        auditEntry(accountAuditRegistry, {
          action: "billing.portal.opened",
          actor: ctx.principal,
          scope: "tenant",
          tenantId: ctx.tenantId,
          resourceType: "subscription",
          // The subscription when there is one, the Stripe customer when there
          // is not. Never null: a sensitive row that names no object is a row
          // an incident review cannot follow anywhere.
          resourceId: subscription?.id ?? customerId,
          request: await requestContext(),
          // The Stripe customer id, never the session url. The url IS the
          // credential — anyone holding it opens the portal without signing in
          // — and `metadata` is jsonb in the one table deliberately kept longer
          // than everything else, so a secret written here outlives the
          // incident it would be used in.
          metadata: { stripeCustomerId: customerId },
        }),
      );

      return { status: "ready", url: session.url };
    }),

  /**
   * Schedule this __TENANT_LABEL_LOWER__'s subscription to end when the period
   * it has already paid for does.
   *
   * *** NOT AN IMMEDIATE CANCELLATION, AND THAT IS THE WHOLE DECISION. ***
   * Ending it now would take away time the customer has already been charged
   * for, and every one of them writes in to say so. `cancel_at_period_end` is
   * the state `subscriptions` carries a separate column for, that
   * `describeSubscription` renders a different sentence for, and that
   * `subscriptionEntitlementWindow` turns into an `expires_at` on the
   * entitlement rows — so access ends on the right day BY ITSELF, without
   * depending on a `customer.subscription.deleted` event that may never arrive.
   *
   * THROUGH THE SAME WRITER AS THE WEBHOOK. Stripe is told first and its answer
   * is what gets mirrored, so the row records what Stripe actually did rather
   * than what this procedure asked for. With no Stripe object — a simulated or
   * comped subscription — the same call is made from the row's own fields, and
   * everything downstream is identical.
   */
  cancelSubscription: requireTenant("subscriptions.manage")
    .meta({ scope: "tenant" })
    .mutation(async ({ ctx }) => scheduleCancellation(ctx, true)),

  /**
   * Undo a scheduled cancellation.
   *
   * Nothing is charged today: the billing period is untouched, which is why
   * `describeSubscription` promises exactly that and why this is the one
   * consequential action a customer can take without a confirmation being
   * frightening. It is the same mutation as cancelling with the flag inverted,
   * deliberately — two procedures that differ by a boolean cannot drift the way
   * two hand-written cancel and resume paths would.
   */
  resumeSubscription: requireTenant("subscriptions.manage")
    .meta({ scope: "tenant" })
    .mutation(async ({ ctx }) => scheduleCancellation(ctx, false)),

  /**
   * Past invoices, FROM STRIPE'S API AND NEVER FROM A LOCAL TABLE.
   *
   * A mirrored invoice table is a second set of financial records that has to
   * be right, and it is wrong the first time a webhook is missed — at which
   * point the customer is looking at a receipt list that disagrees with their
   * bank statement. Stripe already stores every invoice, renders a hosted page
   * and a PDF for each, and is the document the customer's accountant will ask
   * for. Reading them live costs one API call on a page nobody loads often.
   *
   * IT ANSWERS WITH AN EMPTY LIST RATHER THAN AN ERROR, on every path where
   * there is nothing to show: no Stripe key, no customer, or Stripe not
   * answering. A billing page that throws an error boundary because an optional
   * credential is missing is the scaffold's no-credentials rule broken on the
   * one screen where a customer is already anxious. The `status` says which of
   * the three it was, so the copy can differ while the shape does not.
   */
  invoices: requireTenant("billing.invoices.view")
    .meta({ scope: "tenant" })
    .input(z.object({ limit: z.number().int().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }): Promise<InvoiceList> => {
      if (!stripe) return { status: "not_configured", invoices: [] };
      const client = stripe;

      const subscription = await readSubscriptionForTenant(ctx.tenantId);
      const customerId =
        subscription?.stripeCustomerId ??
        (await findStripeCustomerId(client, ctx.principal.userId));
      if (customerId === null) return { status: "no_customer", invoices: [] };

      try {
        const listed = await client.stripe.invoices.list({
          customer: customerId,
          limit: input.limit,
        });
        return {
          status: "ok",
          invoices: listed.data.map((invoice) => ({
            id: invoice.id ?? "",
            // Stripe leaves `number` null on a draft. The id is not a
            // substitute — it is not what appears on the customer's statement —
            // so the UI is told there is no number rather than shown a fake one.
            number: invoice.number,
            status: invoice.status,
            // Minor units, as `formatMinor` wants them and as every other
            // amount in this project is carried. `amount_paid` rather than
            // `total`: what was actually taken is what a receipt list is for.
            amountPaidMinor: BigInt(invoice.amount_paid),
            currency: invoice.currency,
            createdAt: new Date(invoice.created * 1000),
            hostedUrl: invoice.hosted_invoice_url ?? null,
            pdfUrl: invoice.invoice_pdf ?? null,
          })),
        };
      } catch {
        // Deliberately swallowed. Stripe being slow or down must not take the
        // billing page with it — the subscription state above comes from our
        // own tables and is still correct, and the portal button is still the
        // way to reach every invoice there has ever been.
        return { status: "unavailable", invoices: [] };
      }
    }),
});

/**
 * What `invoices` answers. FOUR STATES, ONE SHAPE.
 *
 * `invoices` is always an array so the component renders one list and not four,
 * and `status` is always present so the empty case can say which empty it is.
 * "This deployment has no Stripe key", "you have never been charged" and
 * "Stripe did not answer just now" need three different sentences and only one
 * of them is worth telling an operator about.
 */
export interface AccountInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly status: string | null;
  readonly amountPaidMinor: bigint;
  readonly currency: string;
  readonly createdAt: Date;
  readonly hostedUrl: string | null;
  readonly pdfUrl: string | null;
}

export interface InvoiceList {
  readonly status: "ok" | "not_configured" | "no_customer" | "unavailable";
  readonly invoices: readonly AccountInvoice[];
}

/**
 * Cancel and resume, as one function, because they are one operation.
 *
 * THE ORDER IS STRIPE FIRST, MIRROR SECOND. Asking Stripe and mirroring its
 * answer means the row records what actually happened rather than what was
 * requested — if Stripe refuses, nothing local changed and the customer sees an
 * error instead of a subscription that says "ends on the 3rd" and keeps
 * renewing. Writing locally first and telling Stripe afterwards would leave
 * exactly that lie behind on any failure.
 *
 * THE SIMULATED PATH IS THE SAME CALL WITH THE STRIPE STEP MISSING, not a
 * separate write. Everything after the snapshot — the staleness check, the
 * entitlement window, `planGrantDiff`, the audit row — is `applySubscription`,
 * which is also what the webhook runs. That is the property that makes a
 * simulated cancellation worth anything as a rehearsal.
 */
async function scheduleCancellation(
  ctx: {
    readonly tenantId: string;
    readonly principal: { readonly userId: string };
  },
  cancelAtPeriodEnd: boolean,
): Promise<{ readonly changed: boolean; readonly cancelAtPeriodEnd: boolean }> {
  const subscription = await readSubscriptionForTenant(ctx.tenantId);
  if (subscription === null) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "There is no subscription on this __TENANT_LABEL_LOWER__ to change.",
    });
  }

  if (!isLiveStatus(subscription.status)) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "This subscription has already ended, so there is nothing to cancel or " +
        "resume. Choosing a plan starts a new one.",
    });
  }

  if (subscription.cancelAtPeriodEnd === cancelAtPeriodEnd) {
    // Not an error and not a write. Two clicks on one button, or two people on
    // two screens, must not produce a second audit row claiming a change that
    // did not happen.
    return { changed: false, cancelAtPeriodEnd };
  }

  const tier = plans.tier(tierKeyOf(subscription));
  if (tier === undefined) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        `This subscription is on plan row "${subscription.planKey}", which no ` +
        `tier in src/plans.ts projects. Retire a tier with isActive: false ` +
        `rather than deleting it — subscribers reference it.`,
    });
  }

  const now = new Date();

  if (stripe !== null && subscription.stripeSubscriptionId !== null) {
    const updated = await stripe.stripe.subscriptions.update(
      subscription.stripeSubscriptionId,
      { cancel_at_period_end: cancelAtPeriodEnd },
    );
    const snapshot = subscriptionSnapshot(updated);

    await applySubscription({
      tenantId: ctx.tenantId,
      tierKey: tier.key,
      planKey: subscription.planKey,
      stripeSubscriptionId: snapshot.subscriptionId,
      stripeCustomerId: snapshot.customerId,
      status: mapStripeSubscriptionStatus(snapshot.status),
      currentPeriodStart: snapshot.currentPeriodStart,
      currentPeriodEnd: snapshot.currentPeriodEnd,
      cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd,
      canceledAt: snapshot.canceledAt,
      trialEndsAt: snapshot.trialEndsAt,
      // NOW rather than an event time. This is a live read of what Stripe just
      // did, so it is newer than anything the event stream can deliver — and it
      // has to win, or the webhook for this very change would arrive a second
      // later and be refused as stale.
      observedAt: now,
      observedBy: `portal:${ctx.principal.userId}`,
      source: "stripe",
      action: cancelAtPeriodEnd
        ? "billing.subscription.cancelled"
        : "billing.subscription.resumed",
      actorUserId: ctx.principal.userId,
    });

    return { changed: true, cancelAtPeriodEnd: snapshot.cancelAtPeriodEnd };
  }

  await applySubscription({
    tenantId: ctx.tenantId,
    tierKey: tier.key,
    planKey: subscription.planKey,
    stripeSubscriptionId: null,
    stripeCustomerId: subscription.stripeCustomerId,
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd,
    // Stripe stamps `canceled_at` with the time of the REQUEST for a scheduled
    // cancellation, not the end of the period. Mirroring that here is what
    // keeps a simulated subscription indistinguishable from a real one on the
    // screen that renders both.
    canceledAt: cancelAtPeriodEnd ? now : null,
    trialEndsAt: subscription.trialEndsAt,
    observedAt: now,
    observedBy: `local:${ctx.principal.userId}`,
    source: "simulated",
    action: cancelAtPeriodEnd
      ? "billing.subscription.cancelled"
      : "billing.subscription.resumed",
    actorUserId: ctx.principal.userId,
  });

  return { changed: true, cancelAtPeriodEnd };
}

/**
 * The tier a subscription row is on.
 *
 * `plans.tierForRow` and never `planKey.split(":")[0]`. The projection's key
 * shape is `planRowKey`'s to decide, and a second implementation of it here is
 * a second thing to change the day a currency-less plan key appears — one that
 * would keep compiling and start resolving the wrong tier.
 */
function tierKeyOf(subscription: AccountSubscription): string {
  return plans.tierForRow(subscription.planKey)?.key ?? subscription.planKey;
}

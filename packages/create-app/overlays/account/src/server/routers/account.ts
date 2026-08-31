import { auditEntry, defineAuditedActions } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { createBillingPortalSession } from "__SCOPE__/stripe";
import { db } from "@/db";
import { readSubscriptionForTenant } from "@/server/account";
import { stripe } from "@/server/stripe";
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
});

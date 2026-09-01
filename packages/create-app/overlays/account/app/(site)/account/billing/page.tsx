import Link from "next/link";
import type { ReactNode } from "react";
import { formatMinor } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
import { priceFor, type PlanTier } from "__SCOPE__/billing";
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  buttonClass,
} from "@/components/ui";
import { BillingPortalButton } from "@/components/account/BillingPortalButton";
import { PlanChooser, type ChoosableTier } from "@/components/account/PlanChooser";
import { SubscriptionActions } from "@/components/account/SubscriptionActions";
import { db } from "@/db";
import { plans } from "@/plans";
import { currentPrincipal } from "@/server/auth";
import {
  describeSubscription,
  formatDay,
  metersFor,
  primaryActionFor,
  type GrantedEntitlement,
} from "@/account";
import {
  readSubscriptionForTenant,
  type AccountSubscription,
} from "@/server/account";
// The invoice shape is declared beside the procedure that builds it, because
// the four states it can be in are that procedure's decision — "no key", "no
// customer", "Stripe did not answer" and "here they are" need four sentences
// and one shape.
import type { InvoiceList } from "@/server/routers/account";
import { checkoutMode } from "@/server/checkout-mode";
import { loadTenantPermissions } from "@/server/permissions";
import { readPlanEntitlements } from "@/server/subscription";
import { stripe } from "@/server/stripe";
import { currentTenantFor } from "@/server/tenant";
import { api } from "@/trpc/server";

/**
 * What is being charged, what it grants, and the ONE thing to do about it.
 *
 * THE ONLY TENANT-SCOPED SURFACE IN THIS OVERLAY, and the split is deliberate.
 * `/account` and `/account/orders` show one person their own purchases, and
 * ownership of the row is the authorisation — a storefront order is booked
 * under the FIRM's tenant, so the buyer is not a member of the tenant their own
 * order lives in and a permission check there would deny everybody. A
 * subscription is the opposite: `subscriptions.tenant_id` is a real customer
 * organisation, more than one person can be in it, and the renewal amount is
 * the same disclosure as an invoice. That is what a permission is for.
 *
 * THREE KEYS, AND EACH GATES A DIFFERENT THING. `subscriptions.view` gates the
 * state, `subscriptions.manage` gates cancelling, resuming and starting one,
 * and `billing.portal.open` gates the door out to Stripe. The package gives
 * view to owner and admin and the other two to the owner alone, which is the
 * right shape: seeing what the organisation pays is routine, and holding the
 * ability to stop it is not.
 *
 * *** ONE BANNER AND ONE PRIMARY ACTION, BOTH CHOSEN BY STATE. *** The five
 * columns that describe a subscription — status, the two period ends,
 * `cancel_at_period_end` and `trial_ends_at` — all modify the same sentence and
 * all bear on the same decision, and a page that renders one control per column
 * asks the reader to combine them. They combine them wrongly, because the
 * interesting combinations are the rare ones: a trialling subscription already
 * scheduled to cancel, a past-due one still inside its paid period.
 * `describeSubscription` collapses them into the sentence and
 * `primaryActionFor` into the button, both pure, both tested, both server-side
 * so no component can form a second opinion.
 *
 * DEGRADES WITH NO STRIPE KEY BY CONSTRUCTION, and now does more than degrade:
 * `checkoutMode()` is handed to the plan chooser, so a deployment with no keys
 * can start a subscription, watch the entitlements land, cancel it and resume
 * it — through the same `applySubscription` a real webhook calls. The button
 * disappears by itself the moment the keys are pasted in.
 */
export const dynamic = "force-dynamic";

export default async function AccountBillingPage() {
  const principal = await currentPrincipal();
  if (!principal) {
    return (
      <Notice tone="info" title="Sign in to see billing">
        What is being charged depends on which __TENANT_LABEL_LOWER__ you are
        in, and that depends on who you are.{" "}
        <Link href="/sign-in" className="text-accent underline underline-offset-2">
          Sign in
        </Link>
        .
      </Notice>
    );
  }

  if (!isDbConfigured(db)) {
    return (
      <Notice tone="warn" title="DATABASE_URL is not set">
        Subscriptions live in Postgres and this deployment has no connection to
        one, so there is nothing to read back. Nothing is being charged.
      </Notice>
    );
  }

  const tenant = await currentTenantFor(principal.userId);
  if (!tenant) {
    return (
      <Notice tone="warn" title="You are not a member of anything">
        Billing belongs to a __TENANT_LABEL_LOWER__ and this account is in none.
        Every account gets a personal workspace on first sign-in, so this is
        usually a suspended membership rather than a missing one.
      </Notice>
    );
  }

  const permissions = await loadTenantPermissions({ principal, tenantId: tenant.id });
  const canView = permissions?.can("subscriptions.view") ?? false;
  const canManage = permissions?.can("subscriptions.manage") ?? false;
  const canOpenPortal = permissions?.can("billing.portal.open") ?? false;
  const canSeeInvoices = permissions?.can("billing.invoices.view") ?? false;

  if (!canView) {
    return (
      <Notice tone="info" title="Billing is not visible to your role">
        <p>
          What <strong className="font-medium text-ink">{tenant.name}</strong>{" "}
          pays, and when it renews, is shown to whoever holds{" "}
          <code className="font-mono">subscriptions.view</code> in this
          __TENANT_LABEL_LOWER__ — normally its owner and administrators. This is
          the whole of what you are missing; nothing else on this page is hidden
          from you.
        </p>
        <p className="mt-2">
          Anything you personally bought is on{" "}
          <Link href="/account" className="text-accent underline underline-offset-2">
            your overview
          </Link>{" "}
          regardless of this, because a purchase belongs to the person who made
          it rather than to the __TENANT_LABEL_LOWER__.
        </p>
      </Notice>
    );
  }

  const subscription = await readSubscriptionForTenant(tenant.id);
  const currentTier =
    subscription === null ? null : (plans.tierForRow(subscription.planKey) ?? null);

  // The rows the plan actually wrote. Rendered because "you are on Pro" and
  // "Pro's grants reached your account" are different claims, and only the
  // second one is what the product enforces — this is the screen where a
  // mirror that half-worked becomes visible instead of staying a support call.
  const granted = await readPlanEntitlements(tenant.id);
  const meters = metersFor(
    granted.map(
      (row): GrantedEntitlement => ({
        feature: row.feature,
        limitValue: row.limitValue,
        usedValue: row.usedValue,
        source: "plan",
        expiresAt: row.expiresAt,
        // `source_ref` on a plan row is the TIER key rather than a fulfilment
        // reference. Carried through so the shape matches; nothing on this
        // screen reads it, because the tier is already known from the row.
        reference: row.sourceRef ?? "",
      }),
    ),
  );

  // Through `api()` rather than a direct Stripe call, so the read runs the same
  // middleware chain a browser request would — the same rung, the same
  // permission, the same rate limit. Only asked for when the viewer holds the
  // key, because the procedure would otherwise throw and take the page with it.
  const invoices: InvoiceList = canSeeInvoices
    ? await (await api()).account.invoices({ tenantId: tenant.id, limit: 6 })
    : { status: "no_customer", invoices: [] };

  const mode = checkoutMode();

  return (
    <div className="flex flex-col gap-6">
      {subscription === null ? (
        <NoSubscription tenantName={tenant.name} />
      ) : (
        <SubscriptionCard
          subscription={subscription}
          tenantId={tenant.id}
          tenantName={tenant.name}
          canManage={canManage}
        />
      )}

      {meters.length > 0 && (
        <Card>
          <CardHeader
            title="What the plan grants"
            hint="Read from the entitlements the subscription actually wrote, not from the plan's description of itself."
          />
          <CardBody className="flex flex-col gap-1">
            {meters.map((meter) => (
              <Detail key={meter.feature} label={meter.feature}>
                {meter.resolved.unlimited
                  ? "Unlimited"
                  : `${meter.resolved.used} of ${meter.resolved.limit} used`}
              </Detail>
            ))}
          </CardBody>
        </Card>
      )}

      {/* The chooser is rendered whenever there is no live subscription — which
          covers "never subscribed", "cancelled" and "lapsed" — and beside an
          existing one so a change of plan is a click rather than a support
          request. The mutation refuses the tier they are already on. */}
      <Card>
        <CardHeader
          title={subscription?.live === true ? "Change plan" : "Choose a plan"}
          hint="Every tier and what it includes, from src/plans.ts — the same record the enforcement reads."
        />
        <CardBody>
          <PlanChooser
            tenantId={tenant.id}
            tiers={choosableTiers()}
            intervals={subscribableIntervals()}
            currencies={plans.currencies}
            mode={mode}
            canManage={canManage}
            currentTierKey={currentTier?.key ?? null}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Payment methods, invoices and cancellation"
          hint="All of it is on Stripe, which is where the card details actually live."
        />
        <CardBody className="flex flex-col gap-3">
          <p className="max-w-[62ch] text-sm text-ink-muted">
            Updating a card, downloading a past invoice, changing the billing
            address or a VAT number — every one of those is in Stripe&rsquo;s own
            portal. This application never sees a card number, which is the point.
          </p>

          {/* Three states, and each says something different. No Stripe key is
              an operator problem; no permission is a role problem; a button is
              the ordinary case. Collapsing any two of them into one message
              would send somebody to fix the wrong thing. */}
          {!stripe ? (
            <Notice tone="warn" title="Payments are not configured here">
              <code>STRIPE_SECRET_KEY</code> is not set on this deployment, so
              there is no billing account to open and nothing has ever been
              charged.{" "}
              <Link href="/setup" className="text-accent underline underline-offset-2">
                /setup
              </Link>{" "}
              lists what is outstanding.
            </Notice>
          ) : canOpenPortal ? (
            <BillingPortalButton tenantId={tenant.id} />
          ) : (
            <div className="flex flex-col gap-2">
              {/* Rendered and disabled rather than absent. Somebody who cannot
                  cancel should be able to see that cancelling is possible and
                  who to ask, instead of concluding the product has no way out. */}
              <button
                type="button"
                disabled
                className={buttonClass("primary", "self-start")}
              >
                Manage billing
              </button>
              <p className="max-w-[62ch] text-sm text-ink-muted">
                Opening the billing portal needs{" "}
                <code className="font-mono">billing.portal.open</code>, which
                normally only the owner of {tenant.name} holds — it is the same
                permission as cancelling. Ask them, or have them grant it to you.
              </p>
            </div>
          )}
        </CardBody>
      </Card>

      <Invoices list={invoices} canSee={canSeeInvoices} />
    </div>
  );
}

function SubscriptionCard({
  subscription,
  tenantId,
  tenantName,
  canManage,
}: {
  readonly subscription: AccountSubscription;
  /**
   * Threaded down rather than read off the subscription row, because the
   * mutation behind the button NAMES its tenant in the input and that is what
   * the permission ladder resolves against. Passing the id the page already
   * proved membership of keeps the check and the render about the same tenant.
   */
  readonly tenantId: string;
  readonly tenantName: string;
  readonly canManage: boolean;
}) {
  const banner = describeSubscription(subscription);
  const action = primaryActionFor(subscription);

  return (
    <div className="flex flex-col gap-3">
      {/* ONE banner, chosen by state. `describeSubscription` picks it from the
          five columns that all modify the same sentence, in an order where
          "ends on the 3rd" always beats "renews on the 3rd". */}
      <Notice tone={banner.tone} title={banner.title}>
        {banner.body}
      </Notice>

      <Card>
        <CardHeader
          title={subscription.planName}
          hint={`${tenantName} · billed every ${subscription.interval}`}
          actions={
            <Badge tone={subscription.live ? "accent" : "neutral"}>
              {subscription.status}
            </Badge>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Detail label="Amount">
              {formatMinor(subscription.planPriceMinor, subscription.planCurrency)} per{" "}
              {subscription.interval}
            </Detail>
            {subscription.currentPeriodStart !== null &&
              subscription.currentPeriodEnd !== null && (
                <Detail label="Current period">
                  {formatDay(subscription.currentPeriodStart)} to{" "}
                  {formatDay(subscription.currentPeriodEnd)}
                </Detail>
              )}
            {subscription.trialEndsAt !== null && (
              <Detail label="Trial ends">{formatDay(subscription.trialEndsAt)}</Detail>
            )}
            {subscription.canceledAt !== null && (
              <Detail label="Cancelled">{formatDay(subscription.canceledAt)}</Detail>
            )}
            {subscription.stripeSubscriptionId === null && (
              <Detail label="Stripe">
                {/* Honest rather than hidden. A subscription with no Stripe
                    object is either simulated or comped, and a screen that did
                    not say so would let a demo be mistaken for a paying
                    customer. */}
                Not billed by Stripe — recorded locally
              </Detail>
            )}
          </div>

          {/* ONE primary action, chosen by the same state the banner was. */}
          <SubscriptionActions
            tenantId={tenantId}
            action={action}
            canManage={canManage}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <span className="text-sm text-ink-muted">{label}</span>
      <span className="text-sm tabular-nums">{children}</span>
    </div>
  );
}

/**
 * Past invoices, or the honest reason there are none.
 *
 * FROM STRIPE, NEVER FROM A LOCAL TABLE. A mirrored invoice table is a second
 * set of financial records that has to be right and is wrong the first time a
 * webhook is missed — at which point the customer is reading a receipt list
 * that disagrees with their bank statement.
 */
function Invoices({
  list,
  canSee,
}: {
  readonly list: InvoiceList;
  readonly canSee: boolean;
}) {
  if (!canSee) return null;

  return (
    <Card>
      <CardHeader
        title="Invoices"
        hint="Read live from Stripe. The PDF is the document your accountant wants."
      />
      <CardBody className="flex flex-col gap-2">
        {list.invoices.length === 0 ? (
          <p className="max-w-[62ch] text-sm text-ink-muted">
            {list.status === "not_configured"
              ? "This deployment has no Stripe key, so no invoice has ever been raised."
              : list.status === "unavailable"
                ? "Stripe did not answer just now. Nothing is wrong with the subscription above — it is read from this application's own records — and the billing portal has every invoice there has ever been."
                : "Nothing has been invoiced to this __TENANT_LABEL_LOWER__ yet."}
          </p>
        ) : (
          list.invoices.map((invoice) => (
            <div
              key={invoice.id}
              className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-2 last:border-0"
            >
              <span className="text-sm text-ink">
                {formatDay(invoice.createdAt)}
                {invoice.number !== null && (
                  <span className="text-ink-muted"> · {invoice.number}</span>
                )}
              </span>
              <span className="flex items-baseline gap-3 text-sm tabular-nums">
                {formatMinor(invoice.amountPaidMinor, invoice.currency)}
                {invoice.pdfUrl !== null && (
                  <a
                    href={invoice.pdfUrl}
                    className="text-accent underline underline-offset-2"
                  >
                    PDF
                  </a>
                )}
              </span>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

/**
 * No row in `subscriptions` for this __TENANT_LABEL_LOWER__.
 *
 * Which is the honest state for a customer who has never subscribed — and, now
 * that `customer.subscription.*` is mirrored, no longer the state a developer
 * lands in after buying one. The plan chooser below is the action.
 */
function NoSubscription({ tenantName }: { readonly tenantName: string }) {
  return (
    <EmptyState title="No subscription on this __TENANT_LABEL_LOWER__">
      Nothing recurring is being charged to {tenantName}. Choosing a plan below
      starts one — and applies everything that plan grants, immediately.
    </EmptyState>
  );
}

// ---------------------------------------------------------------------------
// The plan record, rendered
// ---------------------------------------------------------------------------

/**
 * Which intervals the chooser offers.
 *
 * `catalog.intervals` reports what is actually offered, and `once` is not a
 * subscription cadence — a plan priced `once` belongs to no toggle. Filtering
 * here rather than in the component keeps the record's own answer authoritative
 * and stops the browser from being handed an option the mutation would refuse.
 */
function subscribableIntervals(): readonly ("month" | "year")[] {
  return plans.intervals.filter(
    (interval): interval is "month" | "year" =>
      interval === "month" || interval === "year",
  );
}

/**
 * Every active tier, with its prices already formatted.
 *
 * FORMATTED ON THE SERVER, always. Amounts are `bigint` minor units and
 * `formatMinor` is what renders them — JPY has no minor unit, so dividing by a
 * hundred in the browser prints ¥1,000 as ¥10. It also keeps `bigint` off the
 * server/client boundary entirely.
 *
 * RETIRED TIERS ARE ABSENT rather than disabled: `isActive: false` means closed
 * to new subscriptions, and a greyed-out card advertising a price nobody may
 * pay is worse than no card at all. The people already on one still see their
 * plan name, because that comes from the `plans` row their subscription points
 * at rather than from this list.
 */
function choosableTiers(): readonly ChoosableTier[] {
  return plans.tiers
    .filter((tier) => tier.isActive)
    .map((tier) => ({
      key: tier.key,
      name: tier.name,
      description: tier.description,
      highlight: tier.highlight,
      prices: pricesFor(tier),
      features: featureLines(tier),
    }));
}

function pricesFor(tier: PlanTier): Readonly<Record<string, string>> {
  const prices: Record<string, string> = {};
  for (const interval of subscribableIntervals()) {
    for (const currency of plans.currencies) {
      const amount = priceFor(tier, interval, currency);
      // `undefined` is a real answer — a tier priced monthly and not yearly is
      // an ordinary thing to sell — so the key is left out rather than filled
      // with a zero, which reads as free.
      if (amount === undefined) continue;
      prices[`${interval}:${currency}`] = formatMinor(amount, currency);
    }
  }
  return prices;
}

/**
 * One line per declared feature, in the record's own order.
 *
 * The three kinds read differently and that is the point of having three: a
 * quota is a number in front of its label, a flag is present or absent, and an
 * option names the best value the tier allows. `allowed[0]` needs no `??`
 * because the tuple is non-empty by construction — which is exactly why
 * `definePlans` types it that way.
 */
function featureLines(tier: PlanTier): readonly string[] {
  const lines: string[] = [];
  for (const heading of plans.features) {
    const feature = tier.features[heading.feature];
    if (feature === undefined) continue;
    if (feature.kind === "quota") {
      lines.push(`${feature.limit === null ? "Unlimited" : feature.limit} ${feature.label}`);
    } else if (feature.kind === "flag") {
      lines.push(feature.included ? feature.label : `No ${feature.label.toLowerCase()}`);
    } else {
      lines.push(`${feature.label}: ${feature.allowed[0]}`);
    }
  }
  return lines;
}

import Link from "next/link";
import type { ReactNode } from "react";
import { formatMinor } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
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
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { describeSubscription, formatDay } from "@/account";
import {
  readSubscriptionForTenant,
  type AccountSubscription,
} from "@/server/account";
import { loadTenantPermissions } from "@/server/permissions";
import { stripe } from "@/server/stripe";
import { currentTenantFor } from "@/server/tenant";

/**
 * What is being charged, and the one door out to Stripe.
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
 * TWO KEYS, NOT ONE. `subscriptions.view` gates the state, and
 * `billing.portal.open` gates the door — both TENANT keys, from
 * @__SCOPE_NAME__/billing and @__SCOPE_NAME__/stripe respectively, spread into
 * the tenant catalog and checked with the tenant loader. The package gives view
 * to owner and admin and the portal to owner alone, which is the right shape:
 * seeing what the organisation pays is routine, and holding the ability to
 * cancel it is not.
 *
 * DISABLED WITH THE REASON, NOT HIDDEN, when a key is missing. A permission
 * model the client cannot see is a permission model they will not maintain, and
 * a control that silently vanishes produces the support question "why can't I
 * find the cancel button" instead of the answer. That trade goes the other way
 * for a pure disclosure — see `/account`, where the banner is hidden rather
 * than replaced by an apology, because there is nothing there to act on.
 *
 * DEGRADES WITH NO STRIPE KEY BY CONSTRUCTION. The portal button renders only
 * when `stripe` is non-null, which is the same honest condition
 * `SimulatePurchase` keys off and the one that flips by itself the moment the
 * keys are pasted in. The mutation behind it enforces the same condition
 * server-side and answers with a state rather than a throw, so there is no
 * arrangement in which pressing it produces an error boundary.
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
  const canOpenPortal = permissions?.can("billing.portal.open") ?? false;

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

  return (
    <div className="flex flex-col gap-6">
      {subscription === null ? (
        <NoSubscription tenantName={tenant.name} />
      ) : (
        <SubscriptionCard subscription={subscription} tenantName={tenant.name} />
      )}

      <Card>
        <CardHeader
          title="Payment methods, invoices and cancellation"
          hint="All of it is on Stripe, which is where the card details actually live."
        />
        <CardBody className="flex flex-col gap-3">
          <p className="max-w-[62ch] text-sm text-ink-muted">
            Updating a card, downloading a past invoice, changing the billing
            address or a VAT number, and cancelling — every one of those is in
            Stripe&rsquo;s own portal. This application never sees a card number,
            which is the point.
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
    </div>
  );
}

function SubscriptionCard({
  subscription,
  tenantName,
}: {
  readonly subscription: AccountSubscription;
  readonly tenantName: string;
}) {
  const banner = describeSubscription(subscription);

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
        <CardBody className="flex flex-col gap-1">
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
 * No row in `subscriptions` for this __TENANT_LABEL_LOWER__.
 *
 * Which is the honest and, today, the usual state: `checkout.createIntent`
 * creates the subscription AT STRIPE and nothing in this scaffold yet mirrors
 * `customer.subscription.*` back into the local table. So this empty state has
 * to be true for a customer who has genuinely never subscribed AND readable to
 * a developer wondering why a subscription they just bought is not here — the
 * sentence about the portal does both, because the portal reads Stripe directly
 * and will show the subscription regardless of what this table holds.
 */
function NoSubscription({ tenantName }: { readonly tenantName: string }) {
  return (
    <EmptyState
      title="No subscription on this __TENANT_LABEL_LOWER__"
      action={
        <Link href="/products" className={buttonClass("primary")}>
          See what is available
        </Link>
      }
    >
      Nothing recurring is being charged to {tenantName}. A subscription bought
      from the shop appears here with its renewal date, and anything already at
      Stripe is visible in the billing portal below whether or not it is recorded
      here yet.
    </EmptyState>
  );
}

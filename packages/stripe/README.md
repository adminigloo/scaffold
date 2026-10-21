# @adminigloo/stripe

Taking money with Stripe without the mistakes that cost real money: every
checkout is stamped with the company it's for, every Stripe event is handled
exactly once (a ledger with two-phase idempotency, so a retry never applies a
payment twice), signatures and test/live mode are checked before anything
runs, and **a company that already pays changes its plan on its one
subscription** — with a price preview — instead of being sent through a
second checkout and charged for two plans.

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/stripe` | `createStripeClient`, `createCheckoutSession` (tenant-stamped), `createBillingPortalSession`, `verifyStripeSignature`, `assertEventLivemode`, the event ledger (`decideClaim`, `claimStatements`) and registry, `subscriptionSnapshot`, `ensurePlanPrice` (publishes a plan's price once, and a new one when you reprice), `previewPlanChange` / `changePlan`, `stripePermissions`, and the `stripe_events` table (`./schema`) | Stripe keys, the webhook route, and what each event does |
| + `@adminigloo/billing` | The plan record and each company's subscription and limits | The tables |
| + `@adminigloo/create-app` (`--model subscription`, `one-time` or `both`) | All of it wired: checkout, the webhook, the billing page with "change plan", a returning company's own Stripe customer reused, the re-sync screen, and a simulated mode that runs the whole flow before you have keys | Your Stripe keys and the webhook endpoint in the Stripe dashboard |

What is **not** included is listed at the end.

## Install

```sh
pnpm add @adminigloo/stripe stripe drizzle-orm zod
```

## Changing a plan (never a second subscription)

```ts
import { changePlan, previewPlanChange } from "@adminigloo/stripe";

// 1. What it costs today, before anything changes.
const preview = await previewPlanChange(client, { subscriptionId, newPriceId });
// preview.dueNowMinor > 0: charged today; < 0: credited toward the next bills.

// 2. The owner confirms; change it with the SAME proration date.
const { applied } = await changePlan(client, {
  subscriptionId,
  newPriceId,
  prorationDate: preview.prorationDate,
  metadata: { planKey: "pro" },
  idempotencyKey: `plan_change:${tenantId}:pro:${preview.prorationDate}`,
});
// applied === false: the charge didn't go through, and Stripe kept the old plan.
```

The price is swapped with `payment_behavior: "pending_if_incomplete"`, so a
failed charge leaves the company on the plan it was paying for. Only once the
change has gone through is the plan's name written on the subscription. When
you mirror a subscription back from its webhook, read the plan from its
**price** first: after a change, the price is what the company actually pays
for.

Before starting a checkout for a plan, check the company doesn't already have
a live subscription (`liveStripeSubscription` in `@adminigloo/billing/server`)
and reuse its Stripe customer (`companyStripeCustomer`) if it paid before.

## Companies taking card payments (Connect, 0.4)

Each company connects ITS OWN Stripe account (Standard-style through the
Accounts API controller settings: full Stripe dashboard, its own Stripe fees,
Stripe carries losses). `startConnectOnboarding` makes or reuses its one
account and returns an onboarding link; `stripe_connected_accounts` keeps the
account and Stripe's charges/payouts flags per company (`applyAccountUpdate`
from `account.updated`). `createDirectCheckoutSession` charges on the
company's account with this site's optional cut as `application_fee_amount`
(`platformFeeMinor`: PLATFORM_FEE_BPS, rounded DOWN to the cent; 0 = none).

The Connect webhook (its own secret, STRIPE_CONNECT_WEBHOOK_SECRET) resolves
the company only from `event.account` (`companyForConnectEvent`: an unknown
account is ignored) and runs `runLedgeredEvent` keyed by account + event
(`connectLedgerKey`). `createConnectAdminHandlers` with
`STRIPE_CONNECT_ADMIN_ROUTES` serves the company's payments screen (status,
connect, disconnect) on `payments.view` / `payments.manage`. Run
`sql/upgrade-0.3-to-0.4.sql` before deploying.

**When Stripe says no (0.5).** `describeStripeFailure(error)` reads a failed
call: the site's own setup (not signed up for Connect — Stripe's 400 "You can
only create new accounts if you've signed up for Connect…" — or its platform
profile unfinished, a wrong or restricted key, or no key: `stripeNotSetUp`),
Stripe not answering (5xx, or the SDK's own dropped connection), its rate
limit, or any other refusal. Anything the Stripe SDK didn't raise — a database
that is down ("fetch failed", ECONNREFUSED) included — is "something went
wrong on our side", never Stripe's outage. It gives the owner one plain sentence ("Card payments aren't switched
on for this site yet. We've told whoever runs it."), Stripe's own words and the
fix link for the site's staff, and the type, code, status and request id for
the log. `createConnectAdminHandlers` answers with it, reports every failure
through `onError` (`context.stripe`), and adds Stripe's sentence and the link
(`error.staff`) only for callers its `staffDetail(req)` says are staff.

## Not included

- **Payouts to anyone but the company.** A company's card payments pay out to
  its own bank from its own Stripe account; this site only takes its fee.
- **Selling products per company** (a company's own shop): getting paid, part 2.
- **SMS** payment links or receipts.
- **Tax and coupons screens.** Turn on Stripe Tax and promotion codes in
  Stripe's hosted checkout.
- **Changing a subscription with more than one priced item.** Plan
  subscriptions have one; anything else is changed in the Stripe dashboard.

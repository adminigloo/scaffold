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

## Not included

- **Businesses taking payments from their own customers** (Stripe Connect):
  every payment here is to you, the app's owner.
- **Tax and coupons screens.** Turn on Stripe Tax and promotion codes in
  Stripe's hosted checkout.
- **Changing a subscription with more than one priced item.** Plan
  subscriptions have one; anything else is changed in the Stripe dashboard.

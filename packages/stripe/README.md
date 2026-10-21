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
| `@adminigloo/stripe` | `createStripeClient`, `createCheckoutSession` (tenant-stamped), `createBillingPortalSession`, `verifyStripeSignature`, `assertEventLivemode`, the event ledger (`decideClaim`, `claimStatements`) and registry, `subscriptionSnapshot`, `ensurePlanPrice` (publishes a plan's price once, and a new one when you reprice), `previewPlanChange` / `changePlan`, `previewAddLine` / `addLine` / `removeLine` (product lines as items of one subscription), `resolveStripeCustomer` (a tenant's one customer), `stripePermissions`, and the `stripe_events` table (`./schema`) | Stripe keys, the webhook route, and what each event does |
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

## Product lines on one subscription (0.6)

A tenant on Weather Pro and Sports holds ONE subscription with two items. A
change of tier names the line's item; a second line is added to the same
subscription; dropping one line removes its item:

```ts
import { addLine, addLineIdempotencyKey, changePlan, previewAddLine, removeLine } from "@adminigloo/stripe";

await changePlan(client, { subscriptionId, itemId: weatherItemId, newPriceId, prorationDate, metadata, idempotencyKey });

const preview = await previewAddLine(client, { subscriptionId, newPriceId: sportsPrice });
const current = await client.stripe.subscriptions.retrieve(subscriptionId);
const { applied, itemId } = await addLine(client, {
  subscriptionId,
  newPriceId: sportsPrice,
  prorationDate: preview.prorationDate,
  itemMetadata: { planKey: "sports" },
  // Two tabs from the same state add ONE item; a re-add after a drop is always a new request.
  idempotencyKey: addLineIdempotencyKey(current, "sports", { previousItemIds: itemsThisLineHeldBefore }),
});
// `addLine` reads the subscription again after the update and answers THAT read
// (a replayed answer can name an item that's gone): mirror `result.subscription`.

await removeLine(client, { subscriptionId, itemId: sportsItemId, idempotencyKey: `plan_line_remove:${sportsItemId}` });
// Invoices the unused time at once as a credit on the customer's balance (it comes off the
// next bill, and isn't lost if the last line is cancelled later). The LAST item is refused:
// cancel at the period's end instead.
```

Adding is prorated and charged now with `pending_if_incomplete` (a failed
charge adds nothing), with the same proration-date bound as a change. Every
item on one subscription bills on one cadence and in one currency (Stripe's
rule), so add a line on the plan's own.

`resolveStripeCustomer(client, { tenantId, userId, knownCustomerId, email })`
is the tenant's ONE customer: its own, or the one with `metadata.tenantId`.
Pass `userId` ONLY when the tenant is that person's own personal workspace:
then a customer the shop made for them that belongs to no tenant yet is
adopted, and their shop purchases and plans share it. Never for a company — a
member's own card, invoices and subscriptions must not become the company's.
`create: false` never writes — for a portal or an invoice list.

`prepareCompanyCheckout` counts only PLAN subscriptions on that customer
(`isPlanSubscriptionFor`: not the shop's, which carry `variantId`, and not
another tenant's), both for "already pays" and for the one free trial.

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
- **Changing several items at once, or quantities.** Each call changes one
  line's item, at quantity 1; anything else is changed in the Stripe dashboard.

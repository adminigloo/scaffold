# @adminigloo/billing

Plans a business pays you for each month, and what each plan allows. One
record (`definePlans`) says what every plan includes and costs; your database
keeps each company's subscription and what it's entitled to; and **one check**
answers, for any company, at any moment: may it work right now, and how much
of each thing does it have left?

That one check is what lets a plan apply to every feature at once. Every
company request already passes a checkpoint (your sign-in-and-company check,
your public pages, your permission loaders); ask the plan check there and
every package behind it — estimates, the schedule, invoices, messages, files,
anything — follows the company's plan without knowing billing exists.

What a company sees as its plan changes:

| Where it stands | What it means | What it can do |
| --- | --- | --- |
| Free trial | No plan yet; inside the trial (you choose how long) | Everything, with the trial's limits |
| Paying | A paid plan that renews | Everything its plan allows |
| Ending | Cancelled; paid up until a date | Everything, until that date |
| Payment failed | The card failed; Stripe is retrying (14 days' grace) | Everything, until the grace ends |
| Ended / trial over | Nothing paid for now | See everything, open billing, manage its team and settings — no new work. Nothing is deleted. |

## What each install gets you

| You install | You get | You wire yourself |
| --- | --- | --- |
| `@adminigloo/billing` | `definePlans` (the plan record: quotas, on/off features, options, prices per interval and currency, a free tier, and what's on sale), `planColumns` (how a plan is shown, 0.6), `formatMinor` / `formatPrice`, `grantsForPlan` / `planGrantDiff` (what a plan entitles, and moving between plans without losing what's been used), `resolveEntitlements` / `checkEntitlement`, `planStanding`, `createPlanGate`, `gatePermissionLoaders`, `billingPermissions`, and the `plans`, `subscriptions` and `entitlements` tables (`./schema`) | Your plan record, the tables, and where your checkpoints ask the gate |
| + `./server` | `loadCompanyPlan` (a company's standing and every limit, from its rows — per product line too), `loadPlanStanding`, `liveStripeSubscription`, `liveStripeLines`, `lineOfStoredRow`, `companyStripeCustomer` | A database handle (drizzle, Postgres) |
| + `@adminigloo/stripe` | Checkout, the Stripe event ledger, and changing a plan on the company's existing subscription | Stripe keys and the webhook route |
| + `@adminigloo/create-app` (`--model subscription`, with companies) | All of it wired: the plan check at every checkpoint, a free trial for every new company, plan limits for team members, storage and online estimates, Billing with "change plan" (a price preview, never a second subscription), a banner saying where the company stands, and the operator's Company plans page with Give free months | Your prices in `src/plans.ts`, and `BILLING_TRIAL_DAYS` if 14 days isn't right |
| + `@adminigloo/create-app` (`--tenant-noun none --audience consumers --model subscription`) | Personal plans: each person who signs up pays for their own, per product line, on one bill; `requireEntitlement(feature)` for pages, route handlers and tRPC; a banner about the person's own plans; one person per account (no team, no invitations); the founder's Subscribers page with Give free months; an optional free trial at checkout | Your lines, tiers and features in `src/plans.ts`, and where each feature asks `requireEntitlement` |

What is **not** included is listed at the end.

## Install

```sh
pnpm add @adminigloo/billing drizzle-orm
```

## The plan record

```ts
import { definePlans } from "@adminigloo/billing";

export const plans = definePlans({
  features: {
    seats: { kind: "quota", label: "team members", labelOne: "team member" },
    storage_gb: { kind: "quota", label: "GB of photos and files", labelOne: "GB of photos and files" },
  },
  tiers: [
    { key: "starter", name: "Starter", description: "Getting going.", prices: { month: { usd: 4900n } }, features: { seats: 3, storage_gb: 5 } },
    { key: "pro", name: "Pro", description: "A growing team.", highlight: true, prices: { month: { usd: 9900n } }, features: { seats: 10, storage_gb: 25 } },
  ],
});
```

Prices are whole minor units (cents) as `bigint`. A limit of `null` is
unlimited. Only sell what something checks: a feature on the pricing page
that nothing enforces is selling something that doesn't exist.

## Product lines (0.5): several things that stack on one bill

```ts
export const plans = definePlans({
  lines: {
    weather: {
      name: "Weather",
      features: { weather_live: { kind: "flag", label: "Live prices" }, alert_rules: { kind: "quota", label: "alert rules" } },
      tiers: [
        { key: "weather-basic", name: "Weather Basic", prices: { month: { usd: 500n } }, features: { weather_live: true, alert_rules: 0 } },
        { key: "weather-pro", name: "Weather Pro", highlight: true, prices: { month: { usd: 2000n } }, features: { weather_live: true, alert_rules: 25 } },
      ],
    },
    sports: {
      name: "Sports",
      features: { sports_live: { kind: "flag", label: "Live scores" } },
      tiers: [{ key: "sports", name: "Sports", prices: { month: { usd: 500n } }, features: { sports_live: true } }],
    },
  },
});
```

Tiers inside a line replace each other (Basic to Pro); lines stack (Weather
and Sports at once). A tenant holds at most one live tier per line — the
database refuses a second (`subscriptions_tenant_line_live_idx`) — and with
`@adminigloo/stripe` they are items of ONE Stripe subscription: one card, one
invoice, one billing date. Each line has its own vocabulary, checked per tier
at compile time; tier keys are unique across the whole catalog.

A catalog written without `lines` is one implicit line (`DEFAULT_PLAN_LINE`,
`"main"`), and every existing subscription row is already on it.

Changing or cancelling one line must not touch another's rows, so scope the
diff: `planGrantDiff(current, nextTier, { refs: planLineRefs(plans, line) })`
(`undefined` for a one-line catalog: every plan row is the line's). And read
standing per line: `loadCompanyPlan(db, { tenantId, trialStartedAt, trialDays,
plans })` returns `lines` (each line's standing and newest subscription) and
`standing`, the best of them.

## A free tier, and plans not on sale yet (0.6)

```ts
export const plans = definePlans({
  features: {
    weather_live: { kind: "flag", label: "Live prices for every city" },
    cities: { kind: "quota", label: "watchlist cities", labelOne: "watchlist city" },
  },
  // What a signed-in account with no plan holds. Not a plan: no $0
  // subscription, no `plans` row, nothing at Stripe.
  free: { description: "Follow three cities.", features: { weather_live: false, cities: 3 } },
  tiers: [
    { key: "basic", name: "Basic", prices: { month: { usd: 1000n }, year: { usd: 10000n } }, features: { weather_live: true, cities: 24 } },
    // Shown with its price and "Coming soon"; checkout refuses it.
    { key: "pro", name: "Pro", onSale: "coming", prices: { month: { usd: 2000n } }, features: { weather_live: true, cities: 24 } },
  ],
});
```

`free` (top level, or on a product line) is checked like a tier — every
feature of the line given a value — and `loadCompanyPlan(db, { …, plans })`
grants it, in memory, to any line whose standing isn't open: it sums with
add-ons and grants, and the moment a paid tier of the line is live its own
rows replace it. So the plan check, the pricing page's Free column and the
plan chooser all read the same record. Usage on a free quota isn't stored:
ask with the amount the account would hold after the change.

`onSale` is `true` (the default), `"coming"` (shown, never sold — for a plan
whose features aren't built yet) or `false` (sold by hand only: free months, a
founding member). A retired tier (`isActive: false`) is never on sale. Every
checkout asks `planOnSale(tier)`, and refuses with `notOnSaleReason(tier)`.

## Showing a plan (0.6)

```ts
import { planColumns, defaultPlanInterval } from "@adminigloo/billing";

const columns = planColumns(plans, { interval: defaultPlanInterval(plans), currency: "usd" });
// [{ key: "free", name: "Free", price: { kind: "free", label: "Free" }, includes: [{ text: "3 watchlist cities" }] },
//  { key: "basic", price: { kind: "amount", label: "$100", per: "/yr", note: "2 months free" },
//    buildsOn: "Free", includes: [{ text: "Live prices for every city" }, { text: "24 watchlist cities" }] },
//  { key: "pro", onSale: "coming", buildsOn: "Basic", … }]
```

One answer for every plans page: the free tier first, then every tier on sale
or coming. A column lists what it includes — never "No …" — and the next tier
up says what it adds over the one before ("Everything in Free, plus:"); a
tier with less of something than the one before lists everything instead.
Prices are whole units when exact (`formatPrice`: "$10", "$12.50"), yearly
first (`planIntervals`), and "Most popular" only where the record set
`highlight`.

## The plan check at your checkpoints

```ts
import { createPlanGate, gatePermissionLoaders } from "@adminigloo/billing";
import { loadCompanyPlan } from "@adminigloo/billing/server";

export const planGate = createPlanGate({
  standing: async (tenantId) =>
    (await loadCompanyPlan(db, { tenantId, trialStartedAt: await companyCreatedAt(tenantId), trialDays: 14 })).standing,
  noun: "company",
  cacheMs: 15_000, // a page that asks ten times reads once
});

// Your permission loaders: a closed company keeps reading, billing, its team and settings.
export const loaders = gatePermissionLoaders(myLoaders, planGate);

// Your feature routes and public pages (with @adminigloo/tenancy):
createCompanyRouteSeams({ tenancy, principal, plan: planGate });
createPublicCompanySeams({ tenancy, plan: planGate });
```

`planGate.allows(tenantId, permission)` answers for one permission;
`planGate.isOpen(tenantId)` for a whole company (its public pages); and
`planGate.closedMessage(tenantId)` gives the sentence to show: "This
company's plan has ended. An owner can choose a plan in Billing to keep using
this." What stays usable while a plan is closed is `openWhilePlanClosed`
(reading — `*.view` — plus `subscriptions.*`, `plans.*`, `billing.*`,
`members.*` and `tenant.*`); pass your own to change it.

On a project that ran before plans were enforced, start every existing
company's trial from the day you deploy (create-app's `PLANS_ENFORCED_FROM`
does this), or they're closed the moment you turn the check on.

## Not included

- **Several Stripe subscriptions for one tenant.** Product lines are items of
  one subscription; a line on a separate subscription (made by hand in the
  dashboard) is mirrored, but never created by this package's flows.

- **Your customers paying you through Stripe.** That's `@adminigloo/stripe`;
  this package keeps the records and answers the questions.
- **Businesses taking payments from their own customers** (Stripe Connect).
- **Taxes and coupon screens.** Stripe's hosted checkout handles tax and
  promotion codes if you turn them on there.
- **A different limit for one company.** Every company on a plan gets that
  plan's limits; give a company more by moving it to a bigger plan or giving
  it free months of one.
- **Usage-based pricing** (charging per estimate or per GB). Limits here stop
  at the plan's number; they don't bill for going over.

/**
 * THIS SITE'S OWN SHOP, AND A PROJECT THAT HAS NONE (create-app 0.39).
 *
 * `--model one-time` and `--model both` sell PRODUCTS: the storefront
 * (/products), the checkout (/checkout), orders and licence keys under
 * /account/orders, the product builder at /admin/products, `pnpm
 * db:seed:shop`, and the catalog and commerce packages with their tables.
 * `--model subscription` sells PLANS and nothing else, so it ships none of
 * that: the stripe overlay is the plans' half (the webhook, the Stripe client,
 * the subscription mirror, the billing router) and the shop's half is the
 * `shop`, `account-shop` and `shop-admin` overlays, selected only here.
 *
 * Three files differ between the two and are written here, so nothing static
 * carries an `if` about which it is:
 *
 *   src/server/shop-hooks.ts            what the Stripe webhook and the staff
 *                                       resync hand the shop (a product's
 *                                       payment, a recurring product's
 *                                       subscription) — or, with no shop,
 *                                       nothing to book
 *   src/components/account/AccountTabs  Overview, Orders, Billing — or
 *                                       Overview, Billing
 *   app/(site)/account/page.tsx         (no shop) what the person is on and
 *                                       what it includes; the shop's own
 *                                       overview (orders, licence keys,
 *                                       deliveries) is the account-shop overlay's
 */
import type { Answers } from "./answers.js";

/** Does this project sell its own PRODUCTS (a storefront and orders)? Plans alone are not a shop. */
export function sellsShop(answers: Pick<Answers, "businessModel">): boolean {
  return answers.businessModel === "one-time" || answers.businessModel === "both";
}

// ---------------------------------------------------------------------------
// src/server/shop-hooks.ts
// ---------------------------------------------------------------------------

export function renderShopHooks(answers: Answers): string {
  const scope = answers.scope;
  if (!sellsShop(answers)) {
    return `import type Stripe from "stripe";
import type { SubscriptionStatus } from "${scope}/billing";
import { createLogger } from "${scope}/observability";
import { env } from "@/env";

/**
 * WHAT THE STRIPE WEBHOOK HANDS THE SHOP — and this project has none: it was
 * generated with --model subscription, so it sells plans and nothing else
 * (no /products, no orders, no catalog or commerce tables). GENERATED in two
 * variants; a project with a shop (--model one-time or both) books the
 * product's order here and lets its grants follow a recurring product's
 * subscription.
 */
const logger = createLogger({ level: env.LOG_LEVEL });

/** What the webhook reads off a subscription made from a product: the shop's shape, for a project that has one. */
export interface ShopSubscriptionState {
  readonly subscriptionId: string;
  readonly status: SubscriptionStatus;
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: Date | null;
  readonly at: Date;
}

/**
 * A payment carrying our metadata for a PRODUCT, in a project that sells none.
 * Nothing here created it, so it is recorded and skipped — never thrown,
 * which would have Stripe retry it for three days and then switch the
 * endpoint off, taking every plan event with it.
 */
export async function bookShopPayment(intent: Stripe.PaymentIntent): Promise<void> {
  logger.warn(
    { paymentIntentId: intent.id },
    "payment_intent.succeeded names a product, and this project sells plans only (no shop). Nothing was booked; look it up in Stripe.",
  );
}

/** A subscription made from a product: nothing to follow without a shop. */
export async function followShopSubscription(_state: ShopSubscriptionState): Promise<number> {
  return 0;
}

/**
 * A refund, or a dispute, on a charge (create-app 0.44). With no shop there is
 * no order to record it on: a refund on a plan's invoice is Stripe's and the
 * subscription mirror's business, so these are no-ops, never throws.
 */
export async function refundShopPayment(_charge: Stripe.Charge): Promise<void> {}
export async function disputeShopPayment(_dispute: Stripe.Dispute): Promise<void> {}
`;
  }
  return `import type Stripe from "stripe";
import { createLogger } from "${scope}/observability";
import { env } from "@/env";
import {
  disputePurchase,
  fulfilPurchase,
  refundPurchase,
  windowProductGrants,
  type ProductSubscriptionState,
} from "@/server/fulfilment";

/**
 * WHAT THE STRIPE WEBHOOK HANDS THE SHOP: a product's payment (book the
 * order) and a recurring product's subscription (its grants follow it).
 * GENERATED in two variants; a project with no shop (--model subscription)
 * books nothing here.
 */

export type ShopSubscriptionState = ProductSubscriptionState;

/**
 * The money for a product arrived. Book the order.
 *
 * THIS OWNS NO LOGIC. Every decision — the price, the order number, the
 * grants, the audit row, the idempotency — lives in \`fulfilPurchase\`, and the
 * "Simulate purchase" button on the checkout page calls the identical
 * function with \`source: "simulated"\`. The webhook has already skipped the
 * payments that aren't the shop's (an invoice, a store order, a renewal with
 * none of our metadata).
 *
 * WHY THE THROWS BELOW ARE CORRECT. An intent carrying SOME of the metadata
 * and not the rest is one this application created and mis-stamped: money
 * moved and nothing can say what for. Throwing answers 500, so Stripe
 * redelivers and the event sits in the dashboard's failed queue until a human
 * looks. Swallowing it would let a customer be charged for an order that was
 * never recorded.
 */
export async function bookShopPayment(intent: Stripe.PaymentIntent): Promise<void> {
  const metadata = intent.metadata;
  const tenantId = metadata["tenantId"];
  const variantId = metadata["variantId"];
  const rawQuantity = metadata["quantity"];

  if (!tenantId || !variantId || !rawQuantity) {
    throw new Error(
      \`payment_intent.succeeded \${intent.id} is missing the metadata needed to \` +
        \`book an order (tenantId, variantId, quantity). It was not created by \` +
        \`checkout.createIntent — reconcile it by hand before refunding.\`,
    );
  }

  // Stripe stringifies every metadata value. Base 10 explicitly: a quantity
  // that somehow arrived as "0x10" must not silently become sixteen.
  const quantity = Number.parseInt(rawQuantity, 10);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error(
      \`payment_intent.succeeded \${intent.id} carries quantity "\${rawQuantity}", \` +
        \`which is not a positive integer.\`,
    );
  }

  await fulfilPurchase({
    variantId,
    quantity,
    // NULL is supported (guest checkout); an empty string is normalised to it.
    userId: metadata["userId"] || null,
    tenantId,
    // THE PAYMENT INTENT ID IS THE REFERENCE: the one identifier stable across
    // every redelivery, which is what the unique (tenant_id, idempotency_key)
    // index needs. An event id would book one sale twice.
    reference: intent.id,
    source: "stripe",
    // A recurring product's first payment names its subscription, so the
    // subscription's later events can end what this order granted (review B4).
    subscriptionId: metadata["subscriptionId"] || null,
  });
}

/** A recurring product's grants follow its subscription (review B4). Returns how many rows moved. */
export function followShopSubscription(state: ShopSubscriptionState): Promise<number> {
  return windowProductGrants(state);
}

const logger = createLogger({ level: env.LOG_LEVEL });

/** A charge names its PaymentIntent by id, or expanded. */
function paymentIntentOf(value: string | { readonly id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * A refund made in Stripe (create-app 0.44): the order records it and takes back
 * the refunded share of what it granted. THIS OWNS NO LOGIC, like
 * \`bookShopPayment\`: \`refundPurchase\` decides everything, idempotently, and a
 * charge that isn't one of this shop's orders (a plan's invoice) is ignored.
 */
export async function refundShopPayment(charge: Stripe.Charge): Promise<void> {
  const paymentIntentId = paymentIntentOf(charge.payment_intent);
  if (!paymentIntentId) return;
  const result = await refundPurchase({
    paymentIntentId,
    refundedMinor: charge.amount_refunded,
    currency: charge.currency,
  });
  logger.info({ chargeId: charge.id, paymentIntentId, ...result }, "charge.refunded handled for the shop");
}

/**
 * A dispute at the customer's bank: treated as a full refund of what the order
 * granted (see \`disputePurchase\` for why, and for what happens if it's won).
 */
export async function disputeShopPayment(dispute: Stripe.Dispute): Promise<void> {
  const paymentIntentId = paymentIntentOf(dispute.payment_intent);
  if (!paymentIntentId) return;
  const result = await disputePurchase({
    paymentIntentId,
    disputeId: dispute.id,
    currency: dispute.currency,
  });
  logger.warn({ disputeId: dispute.id, paymentIntentId, ...result }, "charge.dispute.created handled for the shop");
}
`;
}

// ---------------------------------------------------------------------------
// DEPLOYMENT.md — the Stripe webhook's events (create-app 0.44)
// ---------------------------------------------------------------------------

/** Where DEPLOYMENT.md's Stripe webhook section goes. */
export const STRIPE_WEBHOOK_MARKER = "<!-- adminigloo:stripe-webhook -->";

/**
 * The events /api/webhooks/stripe acts on in this project, in DEPLOYMENT.md's
 * order. The last five are @adminigloo/stripe's SUBSCRIPTION_EVENT_TYPES (the
 * route refuses to load without a handler for each); a shop adds its payment,
 * its refunds and its disputes. Empty when the project takes no money.
 */
export function stripeWebhookEvents(answers: Pick<Answers, "businessModel">): readonly string[] {
  if (answers.businessModel === "none") return [];
  return [
    ...(sellsShop(answers) ? ["payment_intent.succeeded", "charge.refunded", "charge.dispute.created"] : []),
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
  ];
}

/**
 * DEPLOYMENT.md's "Stripe's webhook" section: the two endpoints (test and live)
 * and every event to enable on both. Before 0.44 the file named no events at
 * all, and an event that isn't enabled is never sent: a refund nobody enabled
 * is a refund nobody records. Empty when the project takes no money.
 */
export function renderDeploymentStripeWebhook(answers: Pick<Answers, "businessModel">): string {
  if (stripeWebhookEvents(answers).length === 0) return "";
  const shop = sellsShop(answers);
  const renews =
    answers.businessModel === "one-time" ? "a product that renews" : shop ? "a plan, or a product that renews" : "a plan";
  const lines = [
    "",
    "### Stripe's webhook (one per mode)",
    "",
    "Stripe sends only the events an endpoint has enabled, and nothing in this app",
    "can notice one missing. Make one endpoint in each mode, both at",
    "`/api/webhooks/stripe`, and enable the same events on each:",
    "",
    "| Mode | Endpoint URL | Secret goes in |",
    "| --- | --- | --- |",
    "| Test | `https://<STAGING_DOMAIN>/api/webhooks/stripe` | Vercel **Preview** → `STRIPE_WEBHOOK_SECRET` |",
    "| Live | `https://<your domain>/api/webhooks/stripe` | Vercel **Production** → `STRIPE_WEBHOOK_SECRET` |",
    "",
    "The events, on both endpoints:",
    "",
    ...(shop
      ? [
          "- `payment_intent.succeeded`: a purchase from the shop was paid. The order is booked and what it grants is given.",
          "- `charge.refunded`: a refund made in Stripe (refunds are made there, never in this app). The order records it, " +
            "and the refunded share of what it granted comes back: credits from the buyer's balance, never below zero, " +
            "and once the whole order is refunded, its entitlements and licence keys too.",
          "- `charge.dispute.created`: a dispute, treated as a full refund of what the order granted, and the order is " +
            "flagged. Winning it later restores nothing by itself; staff adjust by hand.",
        ]
      : []),
    `- \`customer.subscription.created\`, \`customer.subscription.updated\`, \`customer.subscription.deleted\`: the state of a subscription to ${renews}.`,
    "- `invoice.paid`, `invoice.payment_failed`: a renewal, and a failed payment.",
    "",
    "The test endpoint reaches staging past Vercel's login the way Clerk's does",
    "(the exception above). Locally no endpoint is needed: `pnpm dev` runs",
    "`stripe listen`, which forwards every event.",
  ];
  return `${lines.join("\n")}\n`;
}

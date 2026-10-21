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
`;
  }
  return `import type Stripe from "stripe";
import { fulfilPurchase, windowProductGrants, type ProductSubscriptionState } from "@/server/fulfilment";

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
`;
}

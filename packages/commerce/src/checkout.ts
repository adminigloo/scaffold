import type Stripe from "stripe";
import { withTenantMetadata } from "@adminigloo/stripe";
import type { CheckoutReturnUrls } from "@adminigloo/stripe";
import type { CartLine } from "./cart.js";

export class StripeAmountRangeError extends Error {
  readonly name = "StripeAmountRangeError";
  constructor(minor: bigint, context: string) {
    super(
      `Amount ${minor} for "${context}" cannot be sent to Stripe. unit_amount is ` +
        `a JSON number, so a bigint outside 0..${Number.MAX_SAFE_INTEGER} either ` +
        `loses precision on the way out or is rejected. A price this size is a ` +
        `unit-conversion bug upstream, not a real price.`,
    );
  }
}

/**
 * Cart lines as Stripe `price_data` line items.
 *
 * `price_data` rather than pre-created `price` ids because this package prices
 * one-time purchases whose amounts are decided by the app's own catalogue;
 * mirroring every product into Stripe just to reference an id doubles the
 * places a price can be wrong.
 *
 * NO CONVERSION HAPPENS TO THE AMOUNT. `unitPriceMinor` is minor units and
 * Stripe's `unit_amount` is minor units, so the value passes through unchanged.
 * That is also why zero-decimal currencies work: for JPY the minor unit IS the
 * yen, and the moment someone adds a "× 100 to get cents" step here, every
 * Japanese order is charged a hundred times over.
 */
export function buildStripeLineItems(
  lines: readonly CartLine[],
  currency: string,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  const normalisedCurrency = currency.trim().toLowerCase();

  return lines.map((line) => {
    const images = absoluteImageUrls(line.imageUrl);

    return {
      quantity: line.quantity,
      price_data: {
        currency: normalisedCurrency,
        unit_amount: toStripeAmount(line.unitPriceMinor, line.name),
        product_data: {
          name: line.name,
          ...(images.length > 0 ? { images } : {}),
          ...(line.metadata ? { metadata: { ...line.metadata } } : {}),
        },
      },
    };
  });
}

export type CheckoutDiscountRef =
  | { readonly coupon: string }
  | { readonly promotionCode: string };

/**
 * A discount as a Stripe coupon or promotion code. NEVER as a negative line
 * item.
 *
 * trailcards fakes a discount by writing down the `unit_amount` of the products
 * themselves, because Stripe rejects a negative `unit_amount` outright and that
 * is the only way left to make the numbers add up in line items. Four things
 * break at once:
 *
 *   - The receipt and the dashboard show the written-down figure AS the
 *     product's price. Nothing anywhere records that a discount was applied, so
 *     "what did the SPRING promo cost us" is unanswerable after the fact.
 *   - Stripe Tax computes tax on the written-down price with no discount to
 *     attribute it to. A real coupon reports both the gross and the discount,
 *     which is what a tax filing needs.
 *   - A partial refund refunds a percentage of a price that never existed, and
 *     reconciling it against the order row takes a human.
 *   - The rounding `applyDiscount` did once, on the subtotal, has to be
 *     redistributed across N line items by hand. That redistribution is where
 *     the order total and the Stripe charge end up a cent apart, permanently,
 *     with neither side obviously wrong.
 *
 * Stripe also refuses `discounts` together with `allow_promotion_codes`, and
 * refuses more than one entry, so this returns at most one.
 *
 * A code that is not already a Stripe coupon has to become one first — a
 * `coupons.create` with `percent_off` or `amount_off`, which is a network call
 * and therefore not this function's job. Create it against the discount row's
 * id as the coupon id so it is created once and reused, rather than minting a
 * fresh coupon per checkout and filling the account with them.
 */
export function buildCheckoutDiscounts(
  discount: CheckoutDiscountRef | undefined,
): Stripe.Checkout.SessionCreateParams.Discount[] | undefined {
  if (!discount) return undefined;
  return "coupon" in discount
    ? [{ coupon: discount.coupon }]
    : [{ promotion_code: discount.promotionCode }];
}

export interface OrderCheckoutInput {
  /** Stamped onto the Session AND the PaymentIntent. Never read from `metadata`. */
  readonly tenantId: string;
  readonly lines: readonly CartLine[];
  readonly currency: string;
  /** Build with `checkoutReturnUrls` from @adminigloo/stripe. */
  readonly returnUrls: CheckoutReturnUrls;
  readonly customerEmail?: string;
  readonly discount?: CheckoutDiscountRef;
  /**
   * Stripe shipping rate ids, not an extra line item. Stripe Tax taxes shipping
   * at the jurisdiction's shipping rate, which in several US states is not the
   * product rate; a "Shipping" product line gets taxed as a product and the
   * difference is the merchant's to make up.
   */
  readonly shippingRateIds?: readonly string[];
  /** Merged under the tenant stamp. A caller-supplied `tenantId` cannot win. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * Session parameters for a one-time purchase.
 *
 * The tenant stamp is delegated to `withTenantMetadata` from
 * @adminigloo/stripe rather than reimplemented, because the rule it encodes is
 * subtle and easy to half-implement: a Session's metadata does NOT propagate to
 * the PaymentIntent it creates, so the tenant has to be written into
 * `payment_intent_data.metadata` as well. `payment_intent.succeeded` carries
 * only the PaymentIntent's metadata, and the ledger's `tenantIdFromEvent` reads
 * it from there — miss it and the event lands in the ledger with a NULL tenant
 * and no support engineer can find the order it paid for.
 *
 * `mode` is set explicitly even though "payment" is Stripe's default, because
 * `withTenantMetadata` branches on it: an omitted mode falls through to the
 * payment branch today, and a later edit that makes the mode dynamic would move
 * the metadata somewhere `payment_intent.succeeded` cannot see it, silently.
 */
export function buildOrderCheckoutParams(
  input: OrderCheckoutInput,
): Stripe.Checkout.SessionCreateParams {
  const discounts = buildCheckoutDiscounts(input.discount);

  return withTenantMetadata(input.tenantId, {
    mode: "payment",
    line_items: buildStripeLineItems(input.lines, input.currency),
    success_url: input.returnUrls.success_url,
    cancel_url: input.returnUrls.cancel_url,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    ...(discounts ? { discounts } : {}),
    ...(input.shippingRateIds && input.shippingRateIds.length > 0
      ? {
          shipping_options: input.shippingRateIds.map((rate) => ({
            shipping_rate: rate,
          })),
        }
      : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  });
}

/**
 * Stripe's `unit_amount` is a JSON number. A bigint above 2^53 converts to a
 * rounded double, and the charge then differs from the order row by an amount
 * nobody can explain — so this throws instead of narrowing silently. Negative
 * is rejected here too: Stripe returns a generic parameter error that does not
 * name the line item, and in a thirty-line cart that is a long afternoon.
 *
 * The per-currency ceiling Stripe enforces (99999999 for USD, lower elsewhere)
 * is deliberately not duplicated here. It varies by currency and changes, and
 * Stripe's own error for it is specific and readable — unlike the two above.
 */
function toStripeAmount(minor: bigint, context: string): number {
  if (minor < 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StripeAmountRangeError(minor, context);
  }
  return Number(minor);
}

/**
 * Absolute http(s) image URLs only; everything else is dropped.
 *
 * Stripe rejects relative paths and `data:` URIs with "Not a valid URL" and
 * does NOT say which line item or which field, so one product whose image is
 * stored as "/img/card.png" fails the entire checkout with no pointer at all.
 * Dropping the image is strictly better than failing the sale: the customer
 * sees a Stripe page without a thumbnail and still pays.
 *
 * `new URL(relative)` throws with no base, which is the filter for relative
 * paths. `data:` and `blob:` URLs parse fine, so the protocol check is what
 * catches those — the case a truthiness test misses.
 */
function absoluteImageUrls(imageUrl: string | undefined): string[] {
  if (!imageUrl) return [];

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return [];
  }

  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? [parsed.toString()]
    : [];
}

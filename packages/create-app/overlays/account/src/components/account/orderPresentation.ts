import type { BadgeTone } from "@/components/ui";

/**
 * How an order's status reads on a customer's own screen.
 *
 * A PURE FUNCTION IN ITS OWN MODULE so both the list and the detail page get
 * the same answer, and so the answer can be tested without a database or a
 * renderer. Two screens deciding independently what `cancelled` looks like is
 * how one of them ends up saying "Cancelled" in grey while the other says
 * "Refunded" in red about the same row.
 *
 * `orders.status` is a five-value union in @__SCOPE_NAME__/commerce — pending,
 * paid, fulfilled, cancelled, refunded — and until this overlay existed NOTHING
 * ANYWHERE RENDERED IT. Two of the five, `cancelled` and `refunded`, are states
 * a customer specifically goes looking for confirmation of, and they were
 * modelled in the type system and shown to nobody.
 *
 * The parameter is `string`, not the union, on purpose and for the same reason
 * `mapStripeSubscriptionStatus` takes one: the value arrives out of a text
 * column that a migration, a support script or a future status can widen, and a
 * page that crashed on an unrecognised status would take a customer's whole
 * order history down over one row. The fallback states plainly that we do not
 * know, which is honest and legible, rather than guessing at "Paid".
 */
export interface OrderStatusView {
  readonly label: string;
  readonly tone: BadgeTone;
  /**
   * Strike the total through.
   *
   * ONLY for money that came back. A refunded order still has a total — it is
   * what was charged — and printing it plainly beside four other orders reads
   * as an amount the customer is still out of pocket for. Striking it says the
   * figure is historical without deleting it, which matters because the number
   * is what they will quote to their bank.
   *
   * NOT set for `cancelled`. A cancelled order was never paid, so there is no
   * charge to walk back and the strike would imply a refund that never happened.
   */
  readonly struckThrough: boolean;
}

export function orderStatusView(status: string): OrderStatusView {
  switch (status) {
    case "pending":
      return { label: "Awaiting payment", tone: "warn", struckThrough: false };
    case "paid":
      return { label: "Paid", tone: "accent", struckThrough: false };
    case "fulfilled":
      return { label: "Complete", tone: "accent", struckThrough: false };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", struckThrough: false };
    case "refunded":
      return { label: "Refunded", tone: "danger", struckThrough: true };
    default:
      return { label: status, tone: "neutral", struckThrough: false };
  }
}

/**
 * How a limit reads when NULL means unlimited.
 *
 * `entitlements.limit_value` is nullable and the null is load-bearing:
 * `resolveEntitlements` treats one unlimited row as winning the whole feature.
 * Rendering that null as "0" — which is what a bare `?? 0` does, and what a
 * template literal does with `undefined` — tells a customer who paid for
 * unlimited access that they have none.
 */
export function limitLabel(limit: number | null): string {
  return limit === null ? "unlimited" : String(limit);
}

/**
 * A feature key as a heading.
 *
 * `entitlements.feature` is a machine key chosen by whoever configured the
 * grant — `api_calls`, `seats`, `extra-storage` — and it is what the server
 * checks, so it cannot be renamed for display. Splitting on the separators and
 * capitalising the first word is the smallest thing that makes it readable
 * while leaving the key itself visible enough that a support conversation can
 * still be had about it.
 */
export function featureLabel(feature: string): string {
  const words = feature.replace(/[_-]+/g, " ").trim();
  if (words.length === 0) return feature;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

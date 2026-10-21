/**
 * WHAT AN ORDER MEANS, with no database in the room — the shop's half of the
 * account area (a project that sells products: --model one-time or both).
 * Plans and their allowances are src/account.ts, in every project that sells.
 */

// ---------------------------------------------------------------------------
// Where one order lives
// ---------------------------------------------------------------------------

/**
 * One order's URL, built from the number on its receipt.
 *
 * A FUNCTION FOR THE DYNAMIC ROUTE AND NOTHING FOR THE STATIC ONES. `/account`,
 * `/account/orders` and `/account/billing` are written out literally wherever
 * they are linked, because a constant would hide them from the two guards that
 * keep this project's links honest: both walk the emitted source for a literal
 * `href`, and a route reachable only through an imported identifier is
 * invisible to them. The scaffold has already shipped a live storefront that
 * nothing linked to, and a sidebar with two dead links in it.
 *
 * `encodeURIComponent` rather than raw interpolation. `formatOrderNumber`
 * produces `ORD-20260831-000001-42`, which needs no encoding today — and that
 * is exactly the reason to encode it: `ORDER_NUMBER_PREFIX` is a constant a
 * project is invited to change, and the first prefix carrying a slash or a
 * space would split the value across path segments and 404 the receipt it
 * named. That failure reads as a lost order rather than as a mislinked one.
 */
export function accountOrderHref(orderNumber: string): string {
  return `/account/orders/${encodeURIComponent(orderNumber)}`;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export type DeliveryStage = "preparing" | "despatched" | "delivered";

export interface Delivery {
  readonly stage: DeliveryStage;
  readonly carrier: string | null;
  readonly trackingNumber: string | null;
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
}

/**
 * What an `order_shipments` row means, as three states rather than four nulls.
 *
 * The row is inserted by the `ship` grant with carrier, tracking and
 * `shipped_at` all NULL, and @__SCOPE_NAME__/commerce is explicit about why:
 * the row exists so a warehouse queue has something to pick up, not to claim
 * anything moved. Rendering those NULLs directly would tell a customer their
 * carrier is "—", which reads as missing information about a parcel in transit
 * rather than as a parcel that has not been packed. Naming the state is the
 * whole job.
 *
 * `delivered_at` outranks `shipped_at` rather than requiring both. They are
 * written by two different processes, a delivery confirmation can land without
 * a despatch one, and "being prepared" for a parcel already in somebody's hands
 * is the worse of the two errors.
 */
export function deliveryStageOf(row: {
  readonly shippedAt: Date | null;
  readonly deliveredAt: Date | null;
}): DeliveryStage {
  if (row.deliveredAt !== null) return "delivered";
  if (row.shippedAt !== null) return "despatched";
  return "preparing";
}

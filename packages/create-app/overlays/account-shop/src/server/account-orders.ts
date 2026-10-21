import { and, eq, inArray, sql } from "drizzle-orm";
import { entitlements } from "__SCOPE__/billing/schema";
import { orderShipments } from "__SCOPE__/commerce/schema";
import type { GrantedEntitlement } from "@/account";
import { deliveryStageOf, type Delivery } from "@/account-orders";
import { db } from "@/db";

/**
 * The account area's reads of what a person BOUGHT from the shop: what each
 * order granted, and where its parcels are. The plan reads are
 * src/server/account.ts, in every project that sells.
 */

/**
 * WHOSE THINGS THE ACCOUNT AREA SHOWS, AND WHY THAT IS TWO DIFFERENT ANSWERS.
 *
 * This is the decision the rest of the overlay is built on, so it is settled
 * here rather than page by page. Getting it wrong has exactly two shapes, and
 * both were reachable from the data as `fulfilPurchase` writes it: a customer
 * who cannot see their own purchase, or a customer who can see somebody else's.
 *
 * ORDERS ARE PER PERSON. `fulfilPurchase` writes `orders.user_id` — the buyer —
 * and `orders.tenant_id` — whose catalog was sold from. A storefront purchase
 * runs under `STOREFRONT_TENANT_ID`, which is `FIRM_WIDE`, so every customer of
 * the shop shares one tenant id. Filtering an order list by tenant would
 * therefore show each buyer the whole shop's history. Filtering by the buyer's
 * own organisation would show them nothing, because their order was never
 * booked there. `listOrdersForUser` filters on `user_id` for that reason, with
 * the tenant as a narrowing second predicate.
 *
 * ENTITLEMENTS ARE PER TENANT, AND THAT TENANT IS THE FIRM. `applyGrant` writes
 * `entitlements.tenant_id = input.tenantId`, which on the storefront path is
 * `FIRM_WIDE` again — so the entitlements table is NOT a per-customer bucket
 * and must never be read as one. `select * from entitlements where tenant_id =
 * FIRM_WIDE` is every grant the shop has ever issued to anybody.
 *
 * SO THE ACCOUNT AREA NEVER QUERIES ENTITLEMENTS BY TENANT ALONE. It reaches a
 * grant only THROUGH the order that paid for it. `applyGrant` writes
 * `source_ref` as `<reference>:<grantId>`, and `orders.idempotency_key` is
 * `fulfilment:<reference>` — so an order the user demonstrably owns names
 * exactly the entitlement rows it produced and no others. The provenance column
 * that already exists is the authorisation, which is what makes this a read of
 * the customer's own data rather than a filter over the firm's.
 *
 * THE ALTERNATIVE, AND WHY IT IS NOT TAKEN HERE. A B2B seat purchase genuinely
 * wants the opposite: one person buys, their whole organisation is entitled.
 * That shape needs `applyGrant` to be handed the BUYER's tenant rather than the
 * storefront's, which is a change to `checkout.createIntent` and to the webhook
 * — a decision about what the product is, not about how a screen reads. It
 * belongs in the generator's answers. Until it is asked, a storefront grant
 * belongs to the person who bought it, and this module says so in the only way
 * that cannot leak: by never widening past an order it has already proved.
 *
 * SUBSCRIPTIONS ARE PER TENANT AND THAT IS CORRECT. `subscriptions.tenant_id`
 * is a real customer organisation — the row is what an organisation pays — so
 * `/account/billing` resolves the viewer's own tenant with `currentTenantFor`
 * and checks the tenant permission ladder against it. That is the one surface
 * here where a permission key is the right instrument, and it is why the money
 * blocks and the grant blocks are separated: a colleague can hold the
 * subscription while you hold the thing it granted.
 */

// ---------------------------------------------------------------------------
// Grants, reached through the orders that produced them
// ---------------------------------------------------------------------------

/**
 * The reference half of `entitlements.source_ref`, as SQL.
 *
 * `split_part(source_ref, ':', 1)` rather than `like reference || ':%'`, and
 * the difference is not stylistic. A Stripe reference is `pi_3ABC…` and `_` is
 * a single-character wildcard in LIKE, so the pattern form silently matches
 * references that merely resemble the one asked for — and every such match
 * would be another customer's grant rendered on this customer's page. Neither
 * a reference nor a grant id contains a colon, so the split is exact.
 */
const REFERENCE_OF_SOURCE_REF = sql`split_part(${entitlements.sourceRef}, ':', 1)`;

/**
 * Every entitlement these orders granted, keyed by fulfilment reference.
 *
 * ONE QUERY FOR THE WHOLE PAGE, matching how `resolvePermissionSet` and
 * `resolveEntitlements` are both built: a page rendering six orders must not
 * issue six statements, and the `Map` is what lets each order pick out its own
 * rows without a second round trip.
 *
 * The tenant predicate is kept even though the reference set already narrows to
 * this person's purchases. Belt and braces on a cross-customer read is cheap,
 * and it keeps the query on `entitlements_tenant_idx` rather than scanning for
 * a `split_part` match across every tenant.
 */
export async function readGrantsForReferences(input: {
  readonly tenantId: string;
  readonly references: readonly string[];
}): Promise<ReadonlyMap<string, GrantedEntitlement[]>> {
  const byReference = new Map<string, GrantedEntitlement[]>();
  // An empty `inArray` is a syntax error in some drivers and an always-false
  // predicate in others, and "this person has bought nothing" is the single
  // most common state of this page.
  if (input.references.length === 0) return byReference;

  const rows = await db
    .select({
      feature: entitlements.feature,
      limitValue: entitlements.limitValue,
      usedValue: entitlements.usedValue,
      source: entitlements.source,
      expiresAt: entitlements.expiresAt,
      reference: REFERENCE_OF_SOURCE_REF,
    })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.tenantId, input.tenantId),
        inArray(REFERENCE_OF_SOURCE_REF, [...input.references]),
      ),
    );

  for (const row of rows) {
    // The query builder types a bare `sql` fragment as unknown, so the value is
    // narrowed rather than asserted. A row whose `source_ref` is NULL splits to
    // an empty string and belongs to no order, which is exactly where a
    // plan-sourced entitlement should fall out.
    const reference = typeof row.reference === "string" ? row.reference : "";
    if (reference.length === 0) continue;
    const list = byReference.get(reference) ?? [];
    list.push({
      feature: row.feature,
      limitValue: row.limitValue,
      usedValue: row.usedValue,
      source: row.source,
      expiresAt: row.expiresAt,
      reference,
    });
    byReference.set(reference, list);
  }
  return byReference;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Every shipment on these orders, keyed by order id. */
export async function readDeliveriesForOrders(
  orderIds: readonly string[],
): Promise<ReadonlyMap<string, Delivery[]>> {
  const byOrder = new Map<string, Delivery[]>();
  if (orderIds.length === 0) return byOrder;

  const rows = await db
    .select({
      orderId: orderShipments.orderId,
      carrier: orderShipments.carrier,
      trackingNumber: orderShipments.trackingNumber,
      shippedAt: orderShipments.shippedAt,
      deliveredAt: orderShipments.deliveredAt,
    })
    .from(orderShipments)
    .where(inArray(orderShipments.orderId, [...orderIds]));

  for (const row of rows) {
    const list = byOrder.get(row.orderId) ?? [];
    list.push({
      // The three-state reading of four nullable columns lives in `@/account`,
      // so the page and this reader cannot come to different conclusions about
      // what a row with no `shipped_at` means.
      stage: deliveryStageOf(row),
      carrier: row.carrier,
      trackingNumber: row.trackingNumber,
      shippedAt: row.shippedAt,
      deliveredAt: row.deliveredAt,
    });
    byOrder.set(row.orderId, list);
  }
  return byOrder;
}

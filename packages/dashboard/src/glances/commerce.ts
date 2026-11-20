import { and, asc, count, desc, eq, gte, inArray, isNull, like, not, sum } from "drizzle-orm";
import { formatMinor } from "@adminigloo/catalog";
import { products } from "@adminigloo/catalog/schema";
import { orders, orderShipments } from "@adminigloo/commerce/schema";
import { ago, plural, type Glance } from "../glance.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/commerce and @adminigloo/catalog: one store.
 *
 * `tenantId` is the STORE's own id, not an operator's "every company" filter
 * — a business's shop sells its own products to its own customers, the same
 * scope the generated admin dashboard used (`FIRM_WIDE`, "*", for the site's
 * own store). A project with per-company shops would call this once per
 * company with that company's id.
 */
export interface ShopGlanceInput {
  readonly db: DashboardDb;
  readonly now: Date;
  /** This store's own tenant id. The site passes its own ("*"). */
  readonly tenantId: string;
  /**
   * The idempotency-key namespace fulfilment writes a booked order under
   * ("fulfilment:" on the reference site's src/server/fulfilment.ts).
   * @adminigloo/commerce does not export this — it is the calling app's own
   * constant, not the package's — so it is taken here with that same
   * default, used only to spot the "sim" reference the no-Stripe-keys
   * "Simulate purchase" button writes.
   */
  readonly fulfilmentKeyPrefix?: string;
  /** The full page. */
  readonly href?: string;
  /**
   * The orders page, where the tiles and rows about orders link. Null for an
   * app with no orders page: they then link nowhere rather than to a 404.
   * Default /admin/orders.
   */
  readonly ordersHref?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const DEFAULT_FULFILMENT_KEY_PREFIX = "fulfilment:";

/** A store: orders, despatch, the catalogue, and what came in. */
export async function shopGlance(input: ShopGlanceInput): Promise<Glance> {
  const { db, now, tenantId } = input;
  const href = input.href ?? "/admin/products";
  const ordersHref = input.ordersHref === undefined ? "/admin/orders" : input.ordersHref;
  const fulfilmentKeyPrefix = input.fulfilmentKeyPrefix ?? DEFAULT_FULFILMENT_KEY_PREFIX;
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);

  // A simulated reference always begins "sim" right after the namespace — see
  // src/server/fulfilment.ts on the reference site for why this reads off
  // `idempotency_key` rather than a NULL `stripe_payment_intent_id` (which is
  // also NULL for a real order whose webhook hasn't attached it yet).
  const simulated = like(orders.idempotencyKey, `${fulfilmentKeyPrefix}sim%`);
  const paidInWindow = and(
    eq(orders.tenantId, tenantId),
    inArray(orders.status, ["paid", "fulfilled"]),
    gte(orders.placedAt, since),
    not(simulated),
  );

  const [paidRows, despatchRows, productRows, simulatedRows, takings, latest] = await Promise.all([
    db.select({ n: count() }).from(orders).where(paidInWindow),
    db
      .select({ n: count() })
      .from(orderShipments)
      .innerJoin(orders, eq(orders.id, orderShipments.orderId))
      .where(and(isNull(orderShipments.shippedAt), eq(orders.tenantId, tenantId))),
    db
      .select({ n: count() })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.status, "active"), isNull(products.deletedAt))),
    // All time, not the window: this should read zero the day payments go
    // live, and only an all-time count can still say so a month later.
    db.select({ n: count() }).from(orders).where(and(eq(orders.tenantId, tenantId), simulated)),
    // One row per currency. NEVER summed: 1000 JPY plus 1000 GBP is 2000 of
    // nothing, and it would still look like a plausible figure.
    db
      .select({ currency: orders.currency, totalMinor: sum(orders.totalMinor) })
      .from(orders)
      .where(paidInWindow)
      .groupBy(orders.currency)
      .orderBy(asc(orders.currency)),
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        totalMinor: orders.totalMinor,
        currency: orders.currency,
        createdAt: orders.createdAt,
        idempotencyKey: orders.idempotencyKey,
      })
      .from(orders)
      .where(eq(orders.tenantId, tenantId))
      .orderBy(desc(orders.createdAt))
      .limit(6),
  ]);

  const paidOrders = paidRows[0]?.n ?? 0;
  const despatch = despatchRows[0]?.n ?? 0;
  const activeProducts = productRows[0]?.n ?? 0;
  const simulatedCount = simulatedRows[0]?.n ?? 0;
  const takingsValue =
    takings.length === 0
      ? formatMinor(0n, "usd")
      : takings.map((row) => formatMinor(BigInt(row.totalMinor ?? "0"), row.currency)).join(" · ");

  return {
    status:
      simulatedCount > 0
        ? {
            text: `${plural(simulatedCount, "order")} ${simulatedCount === 1 ? "was" : "were"} recorded with no payment behind ${
              simulatedCount === 1 ? "it" : "them"
            }.`,
            tone: "warn",
          }
        : { text: `${plural(paidOrders, "order")} in the last ${WINDOW_DAYS} days.`, tone: "neutral" },
    attention: despatch,
    tiles: [
      {
        label: `Orders, ${WINDOW_DAYS} days`,
        value: paidOrders,
        href: ordersHref ? `${ordersHref}?filter=paid` : undefined,
        hint: "Paid. Simulated orders are not counted.",
      },
      {
        label: "Awaiting despatch",
        value: despatch,
        href: ordersHref ?? undefined,
        tone: despatch > 0 ? "warn" : undefined,
        hint: "Booked, not yet handed to a carrier.",
      },
      {
        label: "Products for sale",
        value: activeProducts,
        href,
        hint: "Active and not deleted.",
      },
      {
        label: `Taken, ${WINDOW_DAYS} days`,
        value: takingsValue,
        href: ordersHref ? `${ordersHref}?filter=paid` : undefined,
        hint: "One figure per currency. Never added together.",
      },
    ],
    list: {
      title: "Latest orders",
      empty: "No orders yet.",
      rows: latest.map((row) => {
        const isSimulated = row.idempotencyKey.startsWith(`${fulfilmentKeyPrefix}sim`);
        return {
          title: row.orderNumber,
          meta: `${formatMinor(row.totalMinor, row.currency)} · ${ago(row.createdAt, now)}`,
          badge: isSimulated ? "Simulated" : statusLabel(row.status),
          tone: isSimulated ? "warn" : row.status === "paid" || row.status === "fulfilled" ? "good" : "neutral",
          href: ordersHref ? `${ordersHref}/${row.id}` : undefined,
        };
      }),
    },
    link: { href, label: "Open products" },
  };
}

/** "fulfilled" -> "Fulfilled". Order statuses are already plain English. */
function statusLabel(status: string): string {
  return status.length === 0 ? status : status.charAt(0).toUpperCase() + status.slice(1);
}

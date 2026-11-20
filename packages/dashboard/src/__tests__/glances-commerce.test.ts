import { afterEach, describe, expect, it } from "vitest";
import { formatMinor } from "@adminigloo/catalog";
import * as catalog from "@adminigloo/catalog/schema";
import * as commerce from "@adminigloo/commerce/schema";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { shopGlance } from "../glances/commerce.js";

const NOW = new Date("2026-11-19T18:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const t = await createPgliteDb({ schema: { ...commerce, ...catalog }, logQueries: false });
  close = () => t.close();
  return t.db;
}

/** Every money column on `orders` is NOT NULL with no default. */
function money(totalMinor: bigint) {
  return { subtotalMinor: totalMinor, shippingMinor: 0n, taxMinor: 0n, discountMinor: 0n, totalMinor };
}

describe("shopGlance", () => {
  it("is empty when the store has nothing yet", async () => {
    const db = await setup();
    const glance = await shopGlance({ db, now: NOW, tenantId: "*" });
    const [paid, despatch, productsTile, takings] = glance.tiles ?? [];
    expect(paid?.value).toBe(0);
    expect(despatch?.value).toBe(0);
    expect(productsTile?.value).toBe(0);
    expect(takings?.value).toBe(formatMinor(0n, "usd"));
    expect(glance.list?.rows).toEqual([]);
    expect(glance.status).toEqual({ text: "0 orders in the last 30 days.", tone: "neutral" });
  });

  it("counts paid orders, despatch and products for this store only, excludes simulated takings, and lists every order newest first", async () => {
    const db = await setup();
    await db.insert(catalog.products).values([
      { id: "p-active", tenantId: "*", slug: "mug", name: "Mug", kind: "one_time", status: "active" },
      { id: "p-draft", tenantId: "*", slug: "draft-mug", name: "Draft mug", kind: "one_time", status: "draft" },
      { id: "p-deleted", tenantId: "*", slug: "old-mug", name: "Old mug", kind: "one_time", status: "active", deletedAt: daysAgo(1) },
      { id: "p-other", tenantId: "other", slug: "mug", name: "Other store's mug", kind: "one_time", status: "active" },
    ]);
    await db.insert(commerce.orders).values([
      {
        id: "o-paid-usd",
        tenantId: "*",
        idempotencyKey: "fulfilment:real1",
        orderNumber: "ORD-1",
        email: "a@example.com",
        status: "paid",
        currency: "usd",
        placedAt: daysAgo(5),
        createdAt: daysAgo(5),
        ...money(1000n),
      },
      {
        id: "o-simulated",
        tenantId: "*",
        idempotencyKey: "fulfilment:sim_abc",
        orderNumber: "ORD-2",
        email: "a@example.com",
        status: "paid",
        currency: "usd",
        placedAt: daysAgo(4),
        createdAt: daysAgo(4),
        ...money(500n),
      },
      {
        id: "o-too-old",
        tenantId: "*",
        idempotencyKey: "fulfilment:real3",
        orderNumber: "ORD-3",
        email: "a@example.com",
        status: "paid",
        currency: "usd",
        placedAt: daysAgo(40),
        createdAt: daysAgo(40),
        ...money(2000n),
      },
      {
        id: "o-paid-eur",
        tenantId: "*",
        idempotencyKey: "fulfilment:real4",
        orderNumber: "ORD-4",
        email: "a@example.com",
        status: "paid",
        currency: "eur",
        placedAt: daysAgo(3),
        createdAt: daysAgo(3),
        ...money(300n),
      },
      {
        id: "o-other-tenant",
        tenantId: "other",
        idempotencyKey: "fulfilment:real5",
        orderNumber: "ORD-5",
        email: "a@example.com",
        status: "paid",
        currency: "usd",
        placedAt: daysAgo(2),
        createdAt: daysAgo(2),
        ...money(9999n),
      },
      {
        id: "o-pending",
        tenantId: "*",
        idempotencyKey: "fulfilment:real6",
        orderNumber: "ORD-6",
        email: "a@example.com",
        status: "pending",
        currency: "usd",
        createdAt: daysAgo(1),
        ...money(50n),
      },
    ]);
    await db.insert(commerce.orderShipments).values([
      { orderId: "o-paid-usd", shippedAt: null },
      { orderId: "o-paid-eur", shippedAt: daysAgo(1) },
      { orderId: "o-other-tenant", shippedAt: null },
    ]);

    const glance = await shopGlance({ db, now: NOW, tenantId: "*" });
    const [paid, despatch, productsTile, takings] = glance.tiles ?? [];

    // Paid, in the 30-day window, this store only: ORD-1 and ORD-4. ORD-2 is
    // simulated, ORD-3 is 40 days old, ORD-5 belongs to another tenant, ORD-6
    // was never paid.
    expect(paid).toMatchObject({ value: 2, href: "/admin/orders?filter=paid" });
    // Only ORD-1's shipment is unshipped and this store's; ORD-4's shipped,
    // and ORD-5's shipment belongs to another tenant.
    expect(despatch).toMatchObject({ value: 1, tone: "warn" });
    expect(productsTile?.value).toBe(1);
    // Two currencies, never summed, alphabetical.
    expect(takings?.value).toBe(`${formatMinor(300n, "eur")} · ${formatMinor(1000n, "usd")}`);
    expect(glance.status?.tone).toBe("warn");
    expect(glance.status?.text).toContain("1 order was recorded with no payment behind it");
    expect(glance.attention).toBe(1);

    expect(glance.list?.rows.map((r) => r.title)).toEqual(["ORD-6", "ORD-4", "ORD-2", "ORD-1", "ORD-3"]);
    expect(glance.list?.rows[0]).toMatchObject({ badge: "Pending", href: "/admin/orders/o-pending" });
    expect(glance.list?.rows[2]).toMatchObject({ badge: "Simulated", tone: "warn" });
    expect(glance.list?.rows[3]).toMatchObject({ badge: "Paid", tone: "good" });

    // An app with no orders page: the order tiles and rows link nowhere, never to a 404.
    const bare = await shopGlance({ db, now: NOW, tenantId: "*", ordersHref: null });
    expect(bare.tiles?.[0]?.href).toBeUndefined();
    expect(bare.list?.rows[0]?.href).toBeUndefined();
  });
});

import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { resolveEntitlements } from "__SCOPE__/billing";
import { users } from "__SCOPE__/auth/schema";
import { productGrants, products, productVariants } from "__SCOPE__/catalog/schema";
import { entitlements } from "__SCOPE__/billing/schema";
import { db } from "@/db";
import { fulfilPurchase, windowProductGrants } from "@/server/fulfilment";

/**
 * A RECURRING PRODUCT'S GRANT FOLLOWS ITS SUBSCRIPTION (review B4), on an
 * in-process Postgres. Before, a monthly product granted its entitlement once
 * with no end, and cancelling never took it away: the webhook skipped every
 * product subscription. Now the order line remembers its subscription, and
 * each of that subscription's events moves what the order granted:
 *
 *   renewing                no end
 *   scheduled to cancel     the end of the paid period
 *   cancelled               ends now (the row stays, with what was used)
 *
 * — and nothing of a one-time sale, or of another subscription's order.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

const TENANT_ID = `test-product-grants-${randomUUID()}`;
const fx = {} as { userId: string; monthlyVariantId: string; onceVariantId: string };

async function variant(productId: string, name: string, interval: "month" | null): Promise<string> {
  const [row] = await db
    .insert(productVariants)
    .values({ productId, name, priceMinor: 900n, currency: "usd", interval })
    .returning({ id: productVariants.id });
  if (!row) throw new Error("variant insert returned no rows");
  await db.insert(productGrants).values({ variantId: row.id, kind: "entitlement", config: { feature: "reports", limit: 10 } });
  return row.id;
}

async function grantsFor(reference: string) {
  const rows = await db.select().from(entitlements).where(eq(entitlements.tenantId, TENANT_ID));
  return rows.filter((row) => (row.sourceRef ?? "").startsWith(`${reference}:`));
}

const pi = () => `pi_${randomUUID().replace(/-/g, "")}`;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ identityProvider: "test", externalId: `ext_${randomUUID()}`, email: "buyer@example.test" })
    .returning({ id: users.id });
  const [monthly] = await db
    .insert(products)
    .values({ tenantId: TENANT_ID, slug: `grants-${randomUUID()}`, name: "Reports", kind: "subscription", status: "active" })
    .returning({ id: products.id });
  const [once] = await db
    .insert(products)
    .values({ tenantId: TENANT_ID, slug: `grants-once-${randomUUID()}`, name: "Report pack", kind: "one_time", status: "active" })
    .returning({ id: products.id });
  fx.userId = user!.id;
  fx.monthlyVariantId = await variant(monthly!.id, "Monthly", "month");
  fx.onceVariantId = await variant(once!.id, "Once", null);
});

describe("a recurring product's grant follows its subscription (review B4)", () => {
  it("renewing: no end; scheduled to cancel: the period's end; cancelled: now — and only this subscription's order", async () => {
    const reference = pi();
    await fulfilPurchase({ variantId: fx.monthlyVariantId, quantity: 1, userId: fx.userId, tenantId: TENANT_ID, reference, source: "stripe", subscriptionId: "sub_reports" });
    // Two orders that must never move: a one-time sale, and another subscription's.
    const once = pi();
    await fulfilPurchase({ variantId: fx.onceVariantId, quantity: 1, userId: fx.userId, tenantId: TENANT_ID, reference: once, source: "stripe" });
    const other = pi();
    await fulfilPurchase({ variantId: fx.monthlyVariantId, quantity: 1, userId: fx.userId, tenantId: TENANT_ID, reference: other, source: "stripe", subscriptionId: "sub_other" });

    const now = new Date();
    const periodEnd = new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000);

    expect(await windowProductGrants({ subscriptionId: "sub_reports", status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd, at: now })).toBe(1);
    expect((await grantsFor(reference))[0]?.expiresAt).toBeNull();

    await windowProductGrants({ subscriptionId: "sub_reports", status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd, at: now });
    expect((await grantsFor(reference))[0]?.expiresAt?.getTime()).toBe(periodEnd.getTime());

    await windowProductGrants({ subscriptionId: "sub_reports", status: "canceled", cancelAtPeriodEnd: false, currentPeriodEnd: periodEnd, at: now });
    const [ended] = await grantsFor(reference);
    // Kept (with its use, for the receipt), and no longer counted.
    expect(ended?.expiresAt?.getTime()).toBe(now.getTime());
    const held = resolveEntitlements(
      [ended!].map((row) => ({ feature: row.feature, limitValue: row.limitValue, usedValue: row.usedValue, source: row.source, expiresAt: row.expiresAt })),
      new Date(now.getTime() + 1),
    );
    expect(held.get("reports")).toBeUndefined();

    // NEGATIVE CONTROLS: the one-time sale and the other subscription's order never moved.
    expect((await grantsFor(once))[0]?.expiresAt).toBeNull();
    expect((await grantsFor(other))[0]?.expiresAt).toBeNull();
  });

  it("a subscription no order names moves nothing", async () => {
    expect(await windowProductGrants({ subscriptionId: "sub_nobody", status: "canceled", cancelAtPeriodEnd: false, currentPeriodEnd: null, at: new Date() })).toBe(0);
  });
});

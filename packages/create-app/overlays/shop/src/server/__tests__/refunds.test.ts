import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Principal } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import { entitlements } from "__SCOPE__/billing/schema";
import { productGrants, products, productVariants } from "__SCOPE__/catalog/schema";
import { orderItems, orders } from "__SCOPE__/commerce/schema";
import { auditLog } from "__SCOPE__/observability/schema";
import { assignRoleTemplate } from "__SCOPE__/permissions/server";
import { createScaffoldContext } from "__SCOPE__/trpc";
import { walletLedger } from "__SCOPE__/wallet/schema";
import { spendWallet, walletBalance } from "__SCOPE__/wallet/server";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";
import {
  disputePurchase,
  fulfilPurchase,
  refundedShare,
  refundPurchase,
  simulatedReference,
} from "@/server/fulfilment";
import { appRouter } from "@/server/routers/_app";
import { createCallerFactory } from "@/server/trpc";

/**
 * REFUNDS AND DISPUTES COME BACK FROM STRIPE (create-app 0.44), on an
 * in-process Postgres, through the real booking path:
 *
 *   a part refund       the refunded share of the credits, rounded down; the
 *                       order stays paid with the amount shown
 *   the rest of it      the rest of the credits; the order is refunded, its
 *                       entitlements end and its licence keys are revoked
 *   any redelivery      nothing, and an older running total arriving late is
 *                       nothing too
 *   spent credits       stay spent: never below zero
 *   a dispute           everything a refund hadn't taken, at once; the order
 *                       is flagged and its money left alone
 *   staff               see it all at /admin/orders (the orders router), and
 *                       nobody else does
 *
 * Every rule is shown with its negative control beside it.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

const TENANT_ID = `test-refunds-${randomUUID()}`;
const UNIT = "test-crowns";
const fx = {} as { productId: string; credits: string; entitlement: string; licence: string };

const pi = () => `pi_${randomUUID().replace(/-/g, "")}`;

async function person(): Promise<{ id: string; email: string }> {
  const email = `buyer-${randomUUID()}@example.test`;
  const [row] = await db
    .insert(users)
    .values({ identityProvider: "test", externalId: `ext_${randomUUID()}`, email })
    .returning({ id: users.id });
  if (!row) throw new Error("user insert returned no rows");
  return { id: row.id, email };
}

async function variant(name: string, kind: "credits" | "entitlement" | "license_key", config: Record<string, unknown>) {
  const [row] = await db
    .insert(productVariants)
    .values({ productId: fx.productId, name, priceMinor: 2500n, currency: "usd", interval: null })
    .returning({ id: productVariants.id });
  if (!row) throw new Error("variant insert returned no rows");
  await db.insert(productGrants).values({ variantId: row.id, kind, config });
  return row.id;
}

/** Bought and paid through Stripe: the same call `payment_intent.succeeded` makes. */
async function buy(variantId: string, userId: string, quantity = 1) {
  const reference = pi();
  const booked = await fulfilPurchase({ variantId, quantity, userId, tenantId: TENANT_ID, reference, source: "stripe" });
  return { reference, orderId: booked.orderId, orderNumber: booked.orderNumber };
}

/** What `charge.refunded` reports: Stripe's RUNNING refunded total for the charge. */
const refund = (paymentIntentId: string, refundedMinor: number, currency = "usd") =>
  refundPurchase({ paymentIntentId, refundedMinor, currency });

async function order(orderId: string) {
  const [row] = await db
    .select({ status: orders.status, refundedMinor: orders.refundedMinor, flag: orders.flag })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row;
}

async function refundRows(holderId: string) {
  return db
    .select({ delta: walletLedger.delta, ref: walletLedger.ref })
    .from(walletLedger)
    .where(and(eq(walletLedger.holderId, holderId), eq(walletLedger.reason, "refund")));
}

beforeAll(async () => {
  const [product] = await db
    .insert(products)
    .values({ tenantId: TENANT_ID, slug: `refunds-${randomUUID()}`, name: "Refund fixture", kind: "one_time", status: "active" })
    .returning({ id: products.id });
  fx.productId = product!.id;
  // 25 crowns a pack, $25.00 a pack: two packs are $50.00 and 50 crowns.
  fx.credits = await variant("Pouch", "credits", { unit: UNIT, amount: 25 });
  fx.entitlement = await variant("Reports", "entitlement", { feature: "reports", limit: 10 });
  fx.licence = await variant("Licence", "license_key", { seats: 1 });
});

describe("refundedShare", () => {
  it("is the refunded share of what was granted, rounded down", () => {
    expect(refundedShare(50, 5000n, 2500n)).toBe(25);
    // Half of 25 is 12: the customer keeps the odd one rather than losing one they paid for.
    expect(refundedShare(25, 2500n, 1250n)).toBe(12);
    expect(refundedShare(25, 2500n, 2500n)).toBe(25);
    expect(refundedShare(50, 5000n, 1n)).toBe(0);
  });

  it("never more than was granted, and nothing from nothing", () => {
    expect(refundedShare(50, 5000n, 9000n)).toBe(50);
    expect(refundedShare(0, 5000n, 5000n)).toBe(0);
    expect(refundedShare(50, 0n, 100n)).toBe(0);
    expect(refundedShare(50, 5000n, 0n)).toBe(0);
  });

  it("stays whole on a large pack at the largest amount Stripe takes", () => {
    expect(refundedShare(2_000_000_000, 99_999_999n, 33_333_333n)).toBe(666_666_666);
  });
});

describe("refundPurchase (charge.refunded)", () => {
  it("a part refund takes back its share and leaves the order paid; the rest refunds it", async () => {
    const buyer = await person();
    const { reference, orderId } = await buy(fx.credits, buyer.id, 2);
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(50);

    const half = await refund(reference, 2500);
    expect(half).toMatchObject({ outcome: "refunded", orderId, whole: false, creditsTaken: [{ unit: UNIT, taken: 25 }] });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(25);
    // A part refund is not a refunded order: commerce's own reading of both columns.
    expect(await order(orderId)).toMatchObject({ status: "paid", refundedMinor: 2500n });

    const rest = await refund(reference, 5000);
    expect(rest).toMatchObject({ outcome: "refunded", whole: true, creditsTaken: [{ unit: UNIT, taken: 25 }] });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(0);
    expect(await order(orderId)).toMatchObject({ status: "refunded", refundedMinor: 5000n });

    // One wallet row per step of the running total, each named for it.
    const rows = await refundRows(buyer.id);
    expect(rows.map((row) => row.delta).sort()).toEqual([-25, -25]);
    expect(rows.map((row) => row.ref.split(":").slice(-2).join(":")).sort()).toEqual(["refund:2500", "refund:5000"]);

    // And one sensitive audit row per refund, about the order.
    const trail = await db
      .select({ action: auditLog.action, isSensitive: auditLog.isSensitive })
      .from(auditLog)
      .where(and(eq(auditLog.resourceType, "order"), eq(auditLog.resourceId, orderId)));
    expect(trail.filter((row) => row.action === "commerce.order.refunded")).toEqual([
      { action: "commerce.order.refunded", isSensitive: true },
      { action: "commerce.order.refunded", isSensitive: true },
    ]);
  });

  it("is idempotent on Stripe's running total: a redelivery, or an older total arriving late, moves nothing", async () => {
    const buyer = await person();
    const { reference, orderId } = await buy(fx.credits, buyer.id, 2);

    // Stripe delivers out of order: the 5000 total lands before the 2500 one.
    expect(await refund(reference, 5000)).toMatchObject({ outcome: "refunded", whole: true, creditsTaken: [{ taken: 50 }] });
    expect(await refund(reference, 5000)).toEqual({ outcome: "duplicate", orderId });
    expect(await refund(reference, 2500)).toEqual({ outcome: "duplicate", orderId });

    expect(await walletBalance(db, buyer.id, UNIT)).toBe(0);
    expect(await refundRows(buyer.id)).toHaveLength(1);
    expect(await order(orderId)).toMatchObject({ status: "refunded", refundedMinor: 5000n });
  });

  it("rounds each step down and still takes back exactly what was granted in the end", async () => {
    const buyer = await person();
    const { reference } = await buy(fx.credits, buyer.id, 1);

    expect(await refund(reference, 1250)).toMatchObject({ creditsTaken: [{ taken: 12 }] });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(13);
    expect(await refund(reference, 2500)).toMatchObject({ creditsTaken: [{ taken: 13 }] });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(0);
  });

  it("never takes the balance below zero: credits already spent stay spent", async () => {
    const buyer = await person();
    const { reference } = await buy(fx.credits, buyer.id, 2);
    await spendWallet(db, { holderId: buyer.id, unit: UNIT, amount: 40, ref: `spent-${randomUUID()}` });

    expect(await refund(reference, 5000)).toMatchObject({ whole: true, creditsTaken: [{ unit: UNIT, taken: 10 }] });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(0);
  });

  it("a whole refund ends the order's entitlements and revokes its licence keys; a part refund leaves both", async () => {
    const buyer = await person();
    const access = await buy(fx.entitlement, buyer.id);
    const key = await buy(fx.licence, buyer.id);

    const heldBy = async (reference: string) =>
      (await db.select().from(entitlements).where(eq(entitlements.tenantId, TENANT_ID))).filter((row) =>
        (row.sourceRef ?? "").startsWith(`${reference}:`),
      );
    const lineOf = async (orderId: string) =>
      (await db.select({ metadata: orderItems.metadata }).from(orderItems).where(eq(orderItems.orderId, orderId)))[0]?.metadata ?? {};

    // NEGATIVE CONTROL: a part refund is usually goodwill on a purchase that stands.
    expect(await refund(access.reference, 1000)).toMatchObject({ entitlementsEnded: 0, licencesRevoked: 0 });
    expect(await refund(key.reference, 1000)).toMatchObject({ entitlementsEnded: 0, licencesRevoked: 0 });
    expect((await heldBy(access.reference))[0]?.expiresAt).toBeNull();
    expect((await lineOf(key.orderId))["licenseRevokedAt"]).toBeUndefined();

    const before = Date.now();
    expect(await refund(access.reference, 2500)).toMatchObject({ whole: true, entitlementsEnded: 1 });
    expect(await refund(key.reference, 2500)).toMatchObject({ whole: true, licencesRevoked: 1 });

    // Ended, not deleted: the row is the record of what was held.
    const [ended] = await heldBy(access.reference);
    expect(ended?.expiresAt?.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(ended?.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now());
    // The key stays on the line (the buyer has it); the line says it's revoked.
    const line = await lineOf(key.orderId);
    expect(line["licenseKey"]).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(line["licenseRevokedAt"]).toEqual(expect.any(String));
  });

  it("ignores a payment the shop didn't book, and a refund in another currency", async () => {
    expect(await refund(pi(), 100)).toMatchObject({ outcome: "ignored" });

    const buyer = await person();
    const { reference, orderId } = await buy(fx.credits, buyer.id);
    expect(await refund(reference, 2500, "eur")).toMatchObject({ outcome: "ignored" });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(25);
    expect(await order(orderId)).toMatchObject({ status: "paid", refundedMinor: 0n });
  });
});

describe("disputePurchase (charge.dispute.created)", () => {
  it("takes back everything a refund hadn't, at once; flags the order and leaves its money alone", async () => {
    const buyer = await person();
    const { reference, orderId } = await buy(fx.credits, buyer.id, 2);
    await refund(reference, 2500); // 25 of the 50 already back

    const disputed = await disputePurchase({ paymentIntentId: reference, disputeId: "dp_test_1", currency: "usd" });
    expect(disputed).toMatchObject({ outcome: "disputed", whole: true, creditsTaken: [{ unit: UNIT, taken: 25 }] });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(0);
    // Nobody refunded anything: refunded_minor is still Stripe's refund total.
    expect(await order(orderId)).toMatchObject({ status: "paid", refundedMinor: 2500n, flag: "disputed" });

    expect(await disputePurchase({ paymentIntentId: reference, disputeId: "dp_test_1", currency: "usd" })).toEqual({
      outcome: "duplicate",
      orderId,
    });

    // A refund after the dispute records the money and takes nothing: the
    // dispute took it all, and these 25 are a new pack's.
    await buy(fx.credits, buyer.id);
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(25);
    expect(await refund(reference, 5000)).toMatchObject({ outcome: "refunded", whole: true, creditsTaken: [] });
    expect(await walletBalance(db, buyer.id, UNIT)).toBe(25);
    expect(await order(orderId)).toMatchObject({ status: "refunded", refundedMinor: 5000n, flag: "disputed" });
  });

  it("ends entitlements and revokes licence keys like a whole refund", async () => {
    const buyer = await person();
    const access = await buy(fx.entitlement, buyer.id);
    const key = await buy(fx.licence, buyer.id);
    expect(await disputePurchase({ paymentIntentId: access.reference, disputeId: "dp_test_2", currency: "usd" })).toMatchObject({
      entitlementsEnded: 1,
    });
    expect(await disputePurchase({ paymentIntentId: key.reference, disputeId: "dp_test_3", currency: "usd" })).toMatchObject({
      licencesRevoked: 1,
    });
  });

  it("ignores a payment the shop didn't book", async () => {
    expect(await disputePurchase({ paymentIntentId: pi(), disputeId: "dp_test_4", currency: "usd" })).toMatchObject({
      outcome: "ignored",
    });
  });
});

describe("the staff orders list (/admin/orders)", () => {
  const callerFor = (who: { id: string; email: string }) => {
    const principal: Principal = { userId: who.id, externalId: `ext_${who.id}`, email: who.email };
    return createCallerFactory(appRouter)(createScaffoldContext({ principal }));
  };

  it("lists the shop's orders by filter and search, shows one in full, and refuses anyone without the key", async () => {
    await seedPermissions(db, { log: () => {} });
    const agent = await person();
    await assignRoleTemplate(db, { scope: "staff", principalId: agent.id, templateKey: "cs_agent", actor: { system: "test" } });
    const outsider = await person();

    // One buyer, four orders: kept, part refunded, disputed and simulated.
    const buyer = await person();
    const kept = await buy(fx.credits, buyer.id);
    const refunded = await buy(fx.credits, buyer.id, 2);
    await refund(refunded.reference, 2500);
    const disputed = await buy(fx.credits, buyer.id);
    await disputePurchase({ paymentIntentId: disputed.reference, disputeId: "dp_test_5", currency: "usd" });
    const simulated = await fulfilPurchase({
      variantId: fx.credits,
      quantity: 1,
      userId: buyer.id,
      tenantId: TENANT_ID,
      reference: simulatedReference(),
      source: "simulated",
    });

    const staff = callerFor(agent);
    const ids = async (filter: "all" | "paid" | "refunded" | "disputed" | "simulated") =>
      (await staff.orders.list({ filter, search: buyer.email })).rows.map((row) => row.id).sort();

    expect(await ids("all")).toEqual([kept.orderId, refunded.orderId, disputed.orderId, simulated.orderId].sort());
    expect(await ids("paid")).toEqual([kept.orderId]);
    expect(await ids("refunded")).toEqual([refunded.orderId]);
    expect(await ids("disputed")).toEqual([disputed.orderId]);
    expect(await ids("simulated")).toEqual([simulated.orderId]);
    expect((await staff.orders.list({ search: refunded.orderNumber })).rows.map((row) => row.id)).toEqual([refunded.orderId]);

    const detail = await staff.orders.detail({ id: refunded.orderId });
    expect(detail.order).toMatchObject({ reference: refunded.reference, source: "stripe", refundedMinor: 2500n });
    expect(detail.order.stripeUrl).toContain(`/payments/${refunded.reference}`);
    expect(detail.lines).toEqual([expect.objectContaining({ quantity: 2, credits: [{ unit: UNIT, amount: 50 }] })]);
    expect(detail.credits.map((entry) => [entry.reason, entry.delta])).toEqual([
      ["grant", 50],
      ["refund", -25],
    ]);
    expect(detail.trail.map((row) => row.action)).toEqual(["commerce.order.fulfilled", "commerce.order.refunded"]);

    await expect(staff.orders.detail({ id: `missing-${randomUUID()}` })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // NEGATIVE CONTROL: signed in, no staff role, so no `shop.orders.view`.
    await expect(callerFor(outsider).orders.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

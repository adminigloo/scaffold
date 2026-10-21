import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { users } from "__SCOPE__/auth/schema";
import { productGrants, products, productVariants } from "__SCOPE__/catalog/schema";
import { entitlements } from "__SCOPE__/billing/schema";
import { orderItems, orderShipments, orders } from "__SCOPE__/commerce/schema";
import { auditLog } from "__SCOPE__/observability/schema";
import { fulfilPurchase, readOrderByReference } from "@/server/fulfilment";
import { db, describeIntegration } from "@/test/db";

/**
 * Fulfilment against a real Postgres.
 *
 * NOT `withRollback`. `fulfilPurchase` opens its own transaction — that
 * atomicity is the property under test — and a transaction opened inside the
 * rollback sandbox takes a different connection from the pool, so it would not
 * see the seed rows and the suite would fail for a reason that has nothing to
 * do with the code. So this seeds committed rows under a tenant id nothing else
 * uses and deletes them again in `afterAll`.
 *
 * EVERY WRITE IS SCOPED TO `TENANT_ID`. The cleanup deletes by that key and by
 * the ids it created, never by a bare table truncate — a suite that TRUNCATEs
 * `orders` is a suite that will eventually be pointed at something real.
 */

/** Unique per run, so two suites (or a re-run after a crash) cannot collide. */
const TENANT_ID = `test-fulfilment-${randomUUID()}`;

interface Seeded {
  readonly userId: string;
  readonly productId: string;
  /** Grants an entitlement worth 10 units per unit bought. */
  readonly entitlementVariantId: string;
  readonly licenseVariantId: string;
  readonly shipVariantId: string;
  readonly noneVariantId: string;
}

describeIntegration("fulfilPurchase", () => {
  /**
   * INSIDE the describe, not at file scope. `describeIntegration` is
   * `describe.skip` without a DATABASE_URL, and a top-level `beforeAll` runs
   * regardless of that skip — so seeding from file scope would fail the whole
   * file on a laptop with no database, which is the exact outcome the skip
   * exists to prevent.
   */
  let seeded: Seeded;

  async function seedVariant(
    productId: string,
    name: string,
    grant: { kind: "entitlement" | "license_key" | "ship" | "none"; config: Record<string, unknown> },
  ): Promise<string> {
    const [variant] = await db
      .insert(productVariants)
      .values({
        productId,
        name,
        priceMinor: 2500n,
        currency: "usd",
        interval: null,
      })
      .returning({ id: productVariants.id });
    if (!variant) throw new Error("variant insert returned no rows");

    await db.insert(productGrants).values({
      variantId: variant.id,
      kind: grant.kind,
      config: grant.config,
    });

    return variant.id;
  }

  beforeAll(async () => {
    const [user] = await db
      .insert(users)
      .values({
        identityProvider: "test",
        externalId: `ext_${randomUUID()}`,
        email: "buyer@example.test",
      })
      .returning({ id: users.id });
    if (!user) throw new Error("user insert returned no rows");

    const [product] = await db
      .insert(products)
      .values({
        tenantId: TENANT_ID,
        slug: `fulfilment-fixture-${randomUUID()}`,
        name: "Fulfilment Fixture",
        kind: "one_time",
        status: "active",
      })
      .returning({ id: products.id });
    if (!product) throw new Error("product insert returned no rows");

    seeded = {
      userId: user.id,
      productId: product.id,
      entitlementVariantId: await seedVariant(product.id, "Entitlement", {
        kind: "entitlement",
        config: { feature: "seats", limit: 10 },
      }),
      licenseVariantId: await seedVariant(product.id, "Licence", {
        kind: "license_key",
        config: { seats: 1 },
      }),
      shipVariantId: await seedVariant(product.id, "Boxed", {
        kind: "ship",
        config: { weightGrams: 300 },
      }),
      noneVariantId: await seedVariant(product.id, "Donation", {
        kind: "none",
        config: {},
      }),
    };
  });

  afterAll(async () => {
    // Order matters only where there is no cascade: order_items, order_shipments
    // and product_grants all cascade from their parents.
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.tenantId, TENANT_ID));
    if (rows.length > 0) {
      await db.delete(orders).where(
        inArray(
          orders.id,
          rows.map((row) => row.id),
        ),
      );
    }
    await db.delete(entitlements).where(eq(entitlements.tenantId, TENANT_ID));
    await db.delete(auditLog).where(eq(auditLog.tenantId, TENANT_ID));
    await db.delete(products).where(eq(products.tenantId, TENANT_ID));
    if (seeded) await db.delete(users).where(eq(users.id, seeded.userId));
  });

  it("is idempotent on reference — twice is one order and one set of grants", async () => {
    const reference = `pi_${randomUUID().replace(/-/g, "")}`;

    const first = await fulfilPurchase({
      variantId: seeded.entitlementVariantId,
      quantity: 2,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference,
      source: "stripe",
    });

    const second = await fulfilPurchase({
      variantId: seeded.entitlementVariantId,
      quantity: 2,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference,
      source: "stripe",
    });

    expect(first.created).toBe(true);
    // Not an error. A redelivered `payment_intent.succeeded` is the normal case,
    // Stripe retries for three days, and the second call has to be a no-op that
    // reports success — a throw here would wedge the event and disable the
    // endpoint.
    expect(second.created).toBe(false);
    expect(second.orderId).toBe(first.orderId);
    expect(second.orderNumber).toBe(first.orderNumber);

    const orderRows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.stripePaymentIntentId, reference));
    expect(orderRows).toHaveLength(1);

    const itemRows = await db
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.orderId, first.orderId));
    expect(itemRows).toHaveLength(1);

    // THE ONE THAT ACTUALLY COSTS MONEY IF IT IS WRONG. A second grant row for
    // the same purchase doubles what the customer is entitled to, silently,
    // because `resolveEntitlements` sums them.
    const grantRows = await db
      .select({ limitValue: entitlements.limitValue })
      .from(entitlements)
      .where(eq(entitlements.tenantId, TENANT_ID));
    expect(grantRows).toHaveLength(1);
    // 10 per unit × quantity 2. A finite limit scales with what was bought.
    expect(grantRows[0]?.limitValue).toBe(20);
  });

  it("writes a license key onto the order line", async () => {
    const result = await fulfilPurchase({
      variantId: seeded.licenseVariantId,
      quantity: 1,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference: `sim_${randomUUID()}`,
      source: "simulated",
    });

    expect(result.grants).toEqual([
      { kind: "license_key", licenseKey: expect.stringMatching(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/) },
    ]);

    const [line] = await db
      .select({ metadata: orderItems.metadata })
      .from(orderItems)
      .where(eq(orderItems.orderId, result.orderId));
    expect(line?.metadata?.["licenseKey"]).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
  });

  it("creates a shipment placeholder that is not yet shipped", async () => {
    const result = await fulfilPurchase({
      variantId: seeded.shipVariantId,
      quantity: 1,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference: `sim_${randomUUID()}`,
      source: "simulated",
    });

    const shipments = await db
      .select({
        carrier: orderShipments.carrier,
        trackingNumber: orderShipments.trackingNumber,
        shippedAt: orderShipments.shippedAt,
      })
      .from(orderShipments)
      .where(eq(orderShipments.orderId, result.orderId));

    expect(shipments).toHaveLength(1);
    // NULL `shipped_at` is the whole content of a placeholder: a label bought is
    // not a parcel gone, and a row that claimed otherwise would tell a customer
    // their order is on its way before anyone has picked it.
    expect(shipments[0]).toEqual({
      carrier: null,
      trackingNumber: null,
      shippedAt: null,
    });
  });

  it("grants nothing for a `none` product, and still records the order", async () => {
    const result = await fulfilPurchase({
      variantId: seeded.noneVariantId,
      quantity: 1,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference: `sim_${randomUUID()}`,
      source: "simulated",
    });

    expect(result.grants).toEqual([{ kind: "none" }]);

    const [order] = await db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, result.orderId));
    // `none` is a real answer, not a misconfiguration. The order is still paid.
    expect(order?.status).toBe("paid");
  });

  it("produces structurally identical orders from the Stripe and simulated paths", async () => {
    // THE ASSERTION THIS WHOLE DESIGN EXISTS FOR. If these two ever diverge, the
    // simulated checkout has stopped testing the real one and every screen built
    // against it is built against a fiction. Same variant, same quantity, same
    // buyer — the ONLY permitted differences are the source and the reference.
    const stripeReference = `pi_${randomUUID().replace(/-/g, "")}`;
    const simulatedReferenceValue = `sim_${randomUUID()}`;

    const paid = await fulfilPurchase({
      variantId: seeded.noneVariantId,
      quantity: 3,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference: stripeReference,
      source: "stripe",
    });
    const simulated = await fulfilPurchase({
      variantId: seeded.noneVariantId,
      quantity: 3,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference: simulatedReferenceValue,
      source: "simulated",
    });

    /** Every column that must NOT depend on which path wrote the row. */
    async function shapeOf(orderId: string) {
      const [order] = await db
        .select({
          tenantId: orders.tenantId,
          userId: orders.userId,
          email: orders.email,
          status: orders.status,
          subtotalMinor: orders.subtotalMinor,
          shippingMinor: orders.shippingMinor,
          taxMinor: orders.taxMinor,
          discountMinor: orders.discountMinor,
          totalMinor: orders.totalMinor,
          currency: orders.currency,
          placedAtIsSet: orders.placedAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId));

      const lines = await db
        .select({
          productRef: orderItems.productRef,
          variantRef: orderItems.variantRef,
          name: orderItems.name,
          quantity: orderItems.quantity,
          unitPriceMinor: orderItems.unitPriceMinor,
          totalMinor: orderItems.totalMinor,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      return {
        ...order,
        // The timestamp differs by milliseconds between the two calls; that it
        // is STAMPED AT ALL is the property. A path that left it null would put
        // the order in the chase-this-customer queue forever.
        placedAtIsSet: order?.placedAtIsSet !== null,
        lines,
      };
    }

    expect(await shapeOf(simulated.orderId)).toEqual(await shapeOf(paid.orderId));

    // And the permitted differences are exactly the two named ones.
    const [paidRow] = await db
      .select({
        pi: orders.stripePaymentIntentId,
        key: orders.idempotencyKey,
      })
      .from(orders)
      .where(eq(orders.id, paid.orderId));
    const [simRow] = await db
      .select({
        pi: orders.stripePaymentIntentId,
        key: orders.idempotencyKey,
      })
      .from(orders)
      .where(eq(orders.id, simulated.orderId));

    expect(paidRow?.pi).toBe(stripeReference);
    // NULL, never `sim_…`. Writing a synthetic id into a column named for a
    // Stripe object makes every refund tool and dashboard that reads it wrong.
    expect(simRow?.pi).toBeNull();
    expect(paidRow?.key).toBe(`fulfilment:${stripeReference}`);
    expect(simRow?.key).toBe(`fulfilment:${simulatedReferenceValue}`);

    // The audit trail is where "was this real money" is answered, and it answers
    // from an INDEXED action column rather than from a jsonb field.
    const audits = await db
      .select({
        action: auditLog.action,
        isSensitive: auditLog.isSensitive,
        resourceId: auditLog.resourceId,
      })
      .from(auditLog)
      .where(eq(auditLog.tenantId, TENANT_ID));

    const paidAudit = audits.find((row) => row.resourceId === paid.orderId);
    const simAudit = audits.find((row) => row.resourceId === simulated.orderId);
    expect(paidAudit?.action).toBe("commerce.order.fulfilled");
    expect(paidAudit?.isSensitive).toBe(false);
    expect(simAudit?.action).toBe("commerce.order.simulated");
    expect(simAudit?.isSensitive).toBe(true);
  });

  it("reads both orders back through the same reader", async () => {
    // The success page's convergence proof, as a test: one function, two
    // references, two orders, no branch.
    const stripeReference = `pi_${randomUUID().replace(/-/g, "")}`;
    const simReference = `sim_${randomUUID()}`;

    await fulfilPurchase({
      variantId: seeded.licenseVariantId,
      quantity: 1,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference: stripeReference,
      source: "stripe",
    });
    await fulfilPurchase({
      variantId: seeded.licenseVariantId,
      quantity: 1,
      userId: seeded.userId,
      tenantId: TENANT_ID,
      reference: simReference,
      source: "simulated",
    });

    const fromStripe = await readOrderByReference({
      tenantId: TENANT_ID,
      reference: stripeReference,
    });
    const fromSimulated = await readOrderByReference({
      tenantId: TENANT_ID,
      reference: simReference,
    });

    expect(fromStripe?.source).toBe("stripe");
    expect(fromSimulated?.source).toBe("simulated");
    expect(fromStripe?.lines).toHaveLength(1);
    expect(fromSimulated?.lines).toHaveLength(1);
    expect(fromStripe?.lines[0]?.name).toBe(fromSimulated?.lines[0]?.name);
    expect(fromStripe?.totalMinor).toBe(fromSimulated?.totalMinor);
    // Both got a key; they are different keys, which is the only thing about
    // them that should differ.
    expect(fromStripe?.lines[0]?.licenseKey).toBeTruthy();
    expect(fromSimulated?.lines[0]?.licenseKey).toBeTruthy();
    expect(fromStripe?.lines[0]?.licenseKey).not.toBe(
      fromSimulated?.lines[0]?.licenseKey,
    );
  });

  it("refuses to book a payment against a variant that no longer exists", async () => {
    // Money moved and this application cannot say what for. Throwing releases
    // the webhook claim and answers 500, so Stripe redelivers and the event sits
    // visibly in the failed queue until a human looks — which is strictly better
    // than a 200 for an order that was never recorded.
    await expect(
      fulfilPurchase({
        variantId: randomUUID(),
        quantity: 1,
        userId: seeded.userId,
        tenantId: TENANT_ID,
        reference: `pi_${randomUUID().replace(/-/g, "")}`,
        source: "stripe",
      }),
    ).rejects.toMatchObject({ name: "VariantNotFoundError" });
  });
});

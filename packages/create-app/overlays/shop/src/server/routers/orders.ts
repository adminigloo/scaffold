import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { entitlements } from "__SCOPE__/billing/schema";
import { orderItems, orders } from "__SCOPE__/commerce/schema";
import { resolveAppEnv } from "__SCOPE__/env";
import { auditLog } from "__SCOPE__/observability/schema";
import { walletLedger } from "__SCOPE__/wallet/schema";
import { db } from "@/db";
import { FULFILMENT_KEY_PREFIX, referenceOfKey, sourceOfReference } from "@/server/fulfilment";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * THE STAFF SIDE OF THE SHOP'S ORDERS (create-app 0.44).
 *
 * Every order this site's own shop booked: `fulfilPurchase` writes them under
 * the `fulfilment:` idempotency key, from a real payment or the simulate
 * button, and this lists exactly those, so a company's store orders or a
 * hand-recorded sale written by another path never leak in here. Read only:
 * a refund is made in Stripe and comes back by the webhook (`refundPurchase`),
 * and that is the only thing that changes an order after it is booked.
 *
 * Gated by `shop.orders.view` from __SCOPE__/commerce's staff fragment (the
 * shop's orders on the staff ladder). Its tenant keys, `orders.*`, are a
 * company's own store's, and nobody on the staff ladder could hold them.
 */

/** What the list can be narrowed to. */
export const ORDER_FILTERS = ["all", "paid", "refunded", "disputed", "simulated"] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

const SHOP_ORDER = like(orders.idempotencyKey, `${FULFILMENT_KEY_PREFIX}%`);
/** A simulated purchase's reference is `sim_<uuid>`; `_` is a LIKE wildcard, so escaped. */
const SIMULATED = like(orders.idempotencyKey, `${FULFILMENT_KEY_PREFIX}sim\\_%`);

function filterFor(filter: OrderFilter): SQL | undefined {
  switch (filter) {
    case "all":
      return undefined;
    // Real money, nothing refunded and nothing disputed: what the shop kept.
    case "paid":
      return and(
        inArray(orders.status, ["paid", "fulfilled"]),
        eq(orders.refundedMinor, 0n),
        isNull(orders.flag),
        sql`not (${orders.idempotencyKey} like ${`${FULFILMENT_KEY_PREFIX}sim\\_%`})`,
      );
    // A part refund leaves an order "paid" with refunded_minor above 0, so the
    // amount is the test, not the status.
    case "refunded":
      return gt(orders.refundedMinor, 0n);
    case "disputed":
      return isNotNull(orders.flag);
    case "simulated":
      return SIMULATED;
  }
}

/** Stripe's dashboard page for a payment, in the mode this deployment takes money in. */
export function stripePaymentUrl(paymentIntentId: string): string {
  const mode = resolveAppEnv() === "production" ? "" : "test/";
  return `https://dashboard.stripe.com/${mode}payments/${encodeURIComponent(paymentIntentId)}`;
}

function likePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, "\\$&")}:%`;
}

export const ordersRouter = createTRPCRouter({
  /** The shop's orders, newest first, narrowed by a filter and a search on email or order number. */
  list: requireStaff("shop.orders.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        filter: z.enum(ORDER_FILTERS).default("all"),
        search: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    )
    .query(async ({ input }) => {
      const search = input.search ? `%${input.search}%` : null;
      const rows = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          email: orders.email,
          userId: orders.userId,
          status: orders.status,
          flag: orders.flag,
          totalMinor: orders.totalMinor,
          refundedMinor: orders.refundedMinor,
          currency: orders.currency,
          placedAt: orders.placedAt,
          createdAt: orders.createdAt,
          idempotencyKey: orders.idempotencyKey,
          lines: sql<number>`(select count(*)::int from ${orderItems} where ${orderItems.orderId} = ${orders.id})`,
        })
        .from(orders)
        .where(
          and(
            SHOP_ORDER,
            filterFor(input.filter),
            search ? or(ilike(orders.email, search), ilike(orders.orderNumber, search)) : undefined,
          ),
        )
        .orderBy(desc(orders.createdAt), desc(orders.id))
        .limit(input.limit);
      return {
        rows: rows.map(({ idempotencyKey, ...row }) => {
          const reference = referenceOfKey(idempotencyKey);
          return { ...row, reference, source: reference === null ? null : sourceOfReference(reference) };
        }),
      };
    }),

  /**
   * One order in full: its lines, what it granted (credits moved for it,
   * entitlements it holds, licence keys), its refunds and dispute, its audit
   * trail, and the payment in Stripe.
   */
  detail: requireStaff("shop.orders.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1).max(200) }))
    .query(async ({ input }) => {
      const [order] = await db
        .select({
          id: orders.id,
          tenantId: orders.tenantId,
          orderNumber: orders.orderNumber,
          email: orders.email,
          userId: orders.userId,
          status: orders.status,
          flag: orders.flag,
          flaggedAt: orders.flaggedAt,
          subtotalMinor: orders.subtotalMinor,
          discountMinor: orders.discountMinor,
          taxMinor: orders.taxMinor,
          shippingMinor: orders.shippingMinor,
          totalMinor: orders.totalMinor,
          refundedMinor: orders.refundedMinor,
          currency: orders.currency,
          placedAt: orders.placedAt,
          createdAt: orders.createdAt,
          idempotencyKey: orders.idempotencyKey,
          stripePaymentIntentId: orders.stripePaymentIntentId,
        })
        .from(orders)
        .where(and(eq(orders.id, input.id), SHOP_ORDER))
        .limit(1);
      if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "No such order in the shop." });

      const reference = referenceOfKey(order.idempotencyKey);
      const [lines, credits, granted, trail] = await Promise.all([
        db
          .select({
            id: orderItems.id,
            name: orderItems.name,
            quantity: orderItems.quantity,
            unitPriceMinor: orderItems.unitPriceMinor,
            totalMinor: orderItems.totalMinor,
            metadata: orderItems.metadata,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, order.id)),
        // Every credit movement this order caused: its grant (`<reference>:<grantId>`)
        // and anything a refund or dispute took back (`<reference>:<grantId>:…`).
        reference && order.userId
          ? db
              .select({
                id: walletLedger.id,
                unit: walletLedger.unit,
                delta: walletLedger.delta,
                reason: walletLedger.reason,
                ref: walletLedger.ref,
                note: walletLedger.note,
                createdAt: walletLedger.createdAt,
              })
              .from(walletLedger)
              .where(and(eq(walletLedger.holderId, order.userId), like(walletLedger.ref, likePrefix(reference))))
              .orderBy(asc(walletLedger.id))
          : Promise.resolve([]),
        reference
          ? db
              .select({
                id: entitlements.id,
                feature: entitlements.feature,
                limitValue: entitlements.limitValue,
                usedValue: entitlements.usedValue,
                expiresAt: entitlements.expiresAt,
              })
              .from(entitlements)
              .where(
                and(
                  eq(entitlements.tenantId, order.tenantId),
                  eq(entitlements.source, "grant"),
                  sql`split_part(${entitlements.sourceRef}, ':', 1) = ${reference}`,
                ),
              )
          : Promise.resolve([]),
        db
          .select({
            id: auditLog.id,
            action: auditLog.action,
            createdAt: auditLog.createdAt,
            isSensitive: auditLog.isSensitive,
            metadata: auditLog.metadata,
          })
          .from(auditLog)
          .where(and(eq(auditLog.resourceType, "order"), eq(auditLog.resourceId, order.id)))
          .orderBy(asc(auditLog.createdAt), asc(auditLog.id)),
      ]);

      const { idempotencyKey: _key, ...rest } = order;
      return {
        order: {
          ...rest,
          reference,
          source: reference === null ? null : sourceOfReference(reference),
          stripeUrl: order.stripePaymentIntentId ? stripePaymentUrl(order.stripePaymentIntentId) : null,
        },
        lines: lines.map((line) => ({
          id: line.id,
          name: line.name,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          totalMinor: line.totalMinor,
          licenseKey: line.metadata?.["licenseKey"] ?? null,
          licenseRevokedAt: line.metadata?.["licenseRevokedAt"] ?? null,
          credits: Object.entries(line.metadata ?? {})
            .filter(([key]) => key.startsWith("credits:"))
            .map(([key, value]) => ({ unit: key.slice("credits:".length), amount: Number(value) })),
        })),
        credits,
        entitlements: granted,
        trail,
      };
    }),
});

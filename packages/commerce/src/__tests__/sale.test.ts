import { productVariants } from "@adminigloo/catalog/schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderItems, orders } from "../schema.js";
import { createStoreAdminHandlers } from "../store-handlers.js";
import { STORE_ADMIN_ROUTES } from "../store-routes.js";
import {
  createStoreProduct,
  listStoreOrders,
  recordStoreSale,
  STORE_SALE_METHODS,
  StoreRefusal,
  type StoreEmailsOwed,
  type StoreOrderPlaced,
} from "../store.js";
import { orderStatusWords, paidInPersonWords } from "../widget/StoreAdmin.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * A SALE RECORDED BY HAND (commerce 0.4): staff record a counter sale from
 * the company's own catalog. Every price is the catalog's unless staff say
 * why; it's paid by cash, check, card terminal or other; the stock comes off
 * exactly once (a double press is one sale); it takes the company's next
 * order number, shows in its orders, and is told to the store's onOrder once
 * (the timeline; a receipt only when asked and there's an email). Another
 * company's product is "not found", and nothing of either company changes.
 */

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

const NOW = new Date("2026-10-20T15:00:00.000Z");

async function shop(stock: number | null = 5) {
  const tenantId = tenant();
  const soap = await createStoreProduct(t.db, tenantId, { name: "Pine soap", priceMinor: 1_250, currency: "usd", stock });
  return { tenantId, soap };
}

async function shelf(productId: string): Promise<{ inventory: number | null; held: number }> {
  const [row] = await t.db.select({ inventory: productVariants.inventory, held: productVariants.held }).from(productVariants).where(eq(productVariants.productId, productId));
  return row!;
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (error) {
    if (error instanceof StoreRefusal) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("recordStoreSale", () => {
  it("records a cash sale at the catalog price, numbered like every order, and takes the stock once", async () => {
    const { tenantId, soap } = await shop(5);
    const told: Array<[StoreOrderPlaced, StoreEmailsOwed]> = [];
    const onOrder = (order: StoreOrderPlaced, owed: StoreEmailsOwed) => void told.push([order, owed]);
    const input = { lines: [{ productId: soap.id, quantity: 2 }], method: "cash" as const, requestKey: "press-0000001", customer: { name: "Pat Lee", email: "Pat@Example.test" } };
    const sale = await recordStoreSale(t.db, tenantId, input, { recordedBy: "u-sam", onOrder, now: NOW });
    expect(sale.duplicate).toBe(false);
    expect(sale.order).toMatchObject({ totalMinor: 2_500, currency: "usd", status: "paid", paidBy: "cash", inPerson: true, email: "pat@example.test" });
    expect(sale.order.orderNumber).toMatch(/^ORD-/);
    expect(sale.order.lines).toEqual([{ name: "Pine soap", quantity: 2, unitPriceMinor: 1_250, totalMinor: 2_500, priceChanged: null }]);
    expect(await shelf(soap.id)).toEqual({ inventory: 3, held: 0 });
    // The store's onOrder once: no receipt asked, no "new order" notice owed (staff made it).
    expect(told.map(([o, owed]) => [o.orderNumber, o.email, owed])).toEqual([[sale.order.orderNumber, "pat@example.test", { receipt: false, notice: false }]]);
    expect(sale.receipt).toBe("not_asked");

    // A double press is ONE sale: no second order, no second lot of stock.
    const again = await recordStoreSale(t.db, tenantId, input, { recordedBy: "u-sam", onOrder, now: NOW });
    expect(again).toMatchObject({ duplicate: true, order: { id: sale.order.id } });
    expect(await shelf(soap.id)).toEqual({ inventory: 3, held: 0 });
    expect(told).toHaveLength(1);
    expect((await listStoreOrders(t.db, tenantId)).map((o) => o.id)).toEqual([sale.order.id]);
    const [row] = await t.db.select().from(orders).where(eq(orders.id, sale.order.id));
    expect(row).toMatchObject({ paymentMethod: "cash", recordedBy: "u-sam", stripePaymentIntentId: null });
  });

  it("a different price needs a reason, kept on the line beside the catalog price", async () => {
    const { tenantId, soap } = await shop(null);
    expect(
      await refusal(recordStoreSale(t.db, tenantId, { lines: [{ productId: soap.id, quantity: 1, priceMinor: 1_000 }], method: "check", requestKey: "press-0000002" }, { recordedBy: "u" })),
    ).toEqual({ code: "invalid", message: "Say why Pine soap is $10.00 instead of $12.50." });
    const sale = await recordStoreSale(
      t.db,
      tenantId,
      { lines: [{ productId: soap.id, quantity: 1, priceMinor: 1_000, priceReason: "Market-day price" }], method: "check", reference: "Check 1042", requestKey: "press-0000003" },
      { recordedBy: "u-sam" },
    );
    expect(sale.order).toMatchObject({ totalMinor: 1_000, paidBy: "check", paymentReference: "Check 1042" });
    expect(sale.order.lines[0]!.priceChanged).toEqual({ listPriceMinor: 1_250, reason: "Market-day price" });
  });

  it("only free stock can be sold; what an online checkout holds stays its own", async () => {
    const { tenantId, soap } = await shop(3);
    await t.db.update(productVariants).set({ held: 2 }).where(eq(productVariants.productId, soap.id));
    expect(
      await refusal(recordStoreSale(t.db, tenantId, { lines: [{ productId: soap.id, quantity: 2 }], method: "cash", requestKey: "press-0000004" }, { recordedBy: "u" })),
    ).toEqual({ code: "sold_out", message: "Only 1 of Pine soap is in stock." });
    expect(await shelf(soap.id)).toEqual({ inventory: 3, held: 2 });
    expect(await listStoreOrders(t.db, tenantId)).toEqual([]);
  });

  it("another company's product is not found, and nothing of either company changes", async () => {
    const a = await shop(5);
    const b = await shop(5);
    expect(
      await refusal(recordStoreSale(t.db, b.tenantId, { lines: [{ productId: a.soap.id, quantity: 1 }], method: "cash", requestKey: "press-0000005" }, { recordedBy: "u" })),
    ).toMatchObject({ code: "not_found" });
    expect(await shelf(a.soap.id)).toEqual({ inventory: 5, held: 0 });
    expect(await listStoreOrders(t.db, a.tenantId)).toEqual([]);
    expect(await listStoreOrders(t.db, b.tenantId)).toEqual([]);
    // The same press key in two companies is two sales (keys are per company).
    await recordStoreSale(t.db, a.tenantId, { lines: [{ productId: a.soap.id, quantity: 1 }], method: "cash", requestKey: "press-shared" }, { recordedBy: "u" });
    const other = await recordStoreSale(t.db, b.tenantId, { lines: [{ productId: b.soap.id, quantity: 1 }], method: "cash", requestKey: "press-shared" }, { recordedBy: "u" });
    expect(other.duplicate).toBe(false);
  });

  it("emails the receipt only when asked and there's an email; a failed receipt never undoes the sale", async () => {
    const { tenantId, soap } = await shop(null);
    const owedSeen: StoreEmailsOwed[] = [];
    const sent = await recordStoreSale(
      t.db,
      tenantId,
      { lines: [{ productId: soap.id, quantity: 1 }], method: "card_terminal", sendReceipt: true, customer: { email: "pat@example.test" }, requestKey: "press-0000006" },
      { recordedBy: "u", onOrder: (_o, owed) => void owedSeen.push(owed) },
    );
    expect(sent.receipt).toBe("sent");
    expect(owedSeen).toEqual([{ receipt: true, notice: false }]);
    const [row] = await t.db.select({ receiptSentAt: orders.receiptSentAt }).from(orders).where(eq(orders.id, sent.order.id));
    expect(row!.receiptSentAt).not.toBeNull();
    const noEmail = await recordStoreSale(t.db, tenantId, { lines: [{ productId: soap.id, quantity: 1 }], method: "other", sendReceipt: true, requestKey: "press-0000007" }, { recordedBy: "u" });
    expect(noEmail.receipt).toBe("no_email");
    const failed = await recordStoreSale(
      t.db,
      tenantId,
      { lines: [{ productId: soap.id, quantity: 1 }], method: "cash", sendReceipt: true, customer: { email: "jo@example.test" }, requestKey: "press-0000008" },
      { recordedBy: "u", onOrder: () => ({ receipt: false }) },
    );
    expect(failed.receipt).toBe("failed");
    expect((await listStoreOrders(t.db, tenantId)).map((o) => o.id)).toContain(failed.order.id);
    const lines = await t.db.select().from(orderItems).where(and(eq(orderItems.orderId, failed.order.id)));
    expect(lines).toHaveLength(1);
  });

  it("refuses an unknown payment method, an empty sale and a bad press key", async () => {
    const { tenantId, soap } = await shop();
    expect(STORE_SALE_METHODS).toEqual(["cash", "check", "card_terminal", "other"]);
    expect((await refusal(recordStoreSale(t.db, tenantId, { lines: [{ productId: soap.id, quantity: 1 }], method: "bitcoin" as never, requestKey: "press-0000009" }, { recordedBy: "u" }))).code).toBe("invalid");
    expect((await refusal(recordStoreSale(t.db, tenantId, { lines: [], method: "cash", requestKey: "press-0000010" }, { recordedBy: "u" }))).code).toBe("invalid");
    expect((await refusal(recordStoreSale(t.db, tenantId, { lines: [{ productId: soap.id, quantity: 1 }], method: "cash", requestKey: "x" }, { recordedBy: "u" }))).code).toBe("invalid");
  });
});

describe("POST v1/admin/sales", () => {
  it("is store.manage; another company's product is 404; the staff member is recorded", async () => {
    expect(STORE_ADMIN_ROUTES.find((r) => r.kind === "sale-record")).toMatchObject({ method: "POST", path: "v1/admin/sales", permission: "store.manage" });
    const a = await shop(5);
    const b = await shop(5);
    const asked: string[] = [];
    const told: StoreOrderPlaced[] = [];
    const handlers = createStoreAdminHandlers({
      db: t.db,
      resolveTenant: (req) => new URL(req.url).pathname.split("/")[3] ?? null,
      authorize: (req, permission) => {
        asked.push(permission);
        return req.headers.get("x-role") === "viewer" && permission === "store.manage" ? false : { userId: "u-sam" };
      },
      onOrder: (order) => void told.push(order),
    });
    const post = (tenantId: string, body: unknown, role = "manager") =>
      handlers.handle(
        new Request(`https://app.test/api/app/${tenantId}/store/v1/admin/sales`, {
          method: "POST",
          headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-role": role },
          body: JSON.stringify(body),
        }),
      );
    const body = { lines: [{ productId: a.soap.id, quantity: 1 }], method: "cash", requestKey: "route-press-01" };
    expect((await post(a.tenantId, body, "viewer")).status).toBe(403);
    expect((await post(b.tenantId, body)).status).toBe(404);
    const ok = await post(a.tenantId, body);
    expect(ok.status).toBe(201);
    const sale = (await ok.json()) as { order: { id: string; paidBy: string } };
    expect(sale.order.paidBy).toBe("cash");
    const [row] = await t.db.select({ recordedBy: orders.recordedBy }).from(orders).where(eq(orders.id, sale.order.id));
    expect(row!.recordedBy).toBe("u-sam");
    expect(told.map((o) => o.orderId)).toEqual([sale.order.id]);
    expect((await post(a.tenantId, body)).status).toBe(200);
    expect(asked.every((p) => p === "store.manage")).toBe(true);
  });
});

describe("a sale by hand reads as paid in person on the orders list (review: it looked like an online order waiting to ship)", () => {
  it("its buyer is a contact, never a place to send it; the list says how it was paid", async () => {
    const { tenantId, soap } = await shop(5);
    const told: StoreOrderPlaced[] = [];
    const sale = await recordStoreSale(
      t.db,
      tenantId,
      { lines: [{ productId: soap.id, quantity: 1 }], method: "check", reference: "Check 1042", requestKey: "press-buyer-01", customer: { name: "Pat Lee", phone: "801-555-0100" } },
      { recordedBy: "u-sam", onOrder: (order) => void told.push(order), now: NOW },
    );
    expect(sale.order).toMatchObject({ inPerson: true, shipTo: null, buyer: { name: "Pat Lee", phone: "801-555-0100" } });
    const [row] = await t.db.select().from(orders).where(eq(orders.id, sale.order.id));
    expect(row!.shippingAddress).toBeNull();
    // The customer list still learns who bought it.
    expect(told.map((o) => [o.buyer, o.shipTo])).toEqual([[{ name: "Pat Lee", phone: "801-555-0100" }, null]]);
    expect(orderStatusWords(sale.order)).toBe("Paid in person");
    expect(paidInPersonWords(sale.order)).toBe("Check #1042");
    expect(paidInPersonWords({ inPerson: true, paidBy: "cash", paymentReference: null })).toBe("Cash");
    expect(paidInPersonWords({ inPerson: true, paidBy: "card_terminal", paymentReference: "slip 88" })).toBe("Card terminal · slip 88");
  });

  it("NEGATIVE CONTROL: an online order is still 'to send', with no in-person words and no buyer", () => {
    const online = {
      id: "o1",
      orderNumber: "ORD-1",
      email: "pat@example.test",
      status: "paid" as const,
      totalMinor: 100,
      refundedMinor: 0,
      currency: "usd",
      placedAt: null,
      flag: null,
      oversold: false,
      shippingMinor: 0,
      shipTo: { name: "Pat Lee", line1: "1 Main St" },
      lines: [],
      stripeUrl: null,
      paidBy: "card" as const,
      paymentReference: null,
      inPerson: false,
      buyer: null,
    };
    expect(orderStatusWords(online)).toBe("Paid — to send");
    expect(paidInPersonWords(online)).toBeNull();
  });
});

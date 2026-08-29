import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  commerceSchema,
  discountCodes,
  orderItems,
  orderShipments,
  orders,
} from "../schema.js";
import * as barrel from "../index.js";

function uniqueIndexNames(table: PgTable) {
  return getTableConfig(table)
    .indexes.filter((i) => i.config.unique)
    .map((i) => i.config.name);
}

function findIndex(table: PgTable, name: string) {
  return getTableConfig(table).indexes.find((i) => i.config.name === name);
}

function indexColumnNames(table: PgTable, name: string) {
  return (findIndex(table, name)?.config.columns ?? []).map((c) =>
    "name" in c ? c.name : null,
  );
}

describe("the barrel never re-exports a table", () => {
  it("exports no runtime value from schema.ts", () => {
    // Tables are reachable ONLY from "@adminigloo/commerce/schema". Re-exported
    // here, the root entry becomes a static import of drizzle-orm/pg-core, so a
    // client component importing `cartTotals` drags the query builder into the
    // browser bundle — and tsup does not code-split CJS, so the same pgTable
    // call is emitted into both dist/index.cjs and dist/schema.cjs and a CJS
    // consumer holds two distinct objects for one physical table. Drizzle
    // relations and getTableConfig compare by reference; both then fail
    // silently.
    for (const name of [
      "orders",
      "orderItems",
      "orderShipments",
      "discountCodes",
      "commerceSchema",
    ]) {
      expect(barrel).not.toHaveProperty(name);
    }
  });

  it("still exports the pure surface", () => {
    // The other half: proving the guard above did not just delete the package.
    for (const name of [
      "cartTotals",
      "applyDiscount",
      "validateCart",
      "discountState",
      "formatOrderNumber",
      "buildStripeLineItems",
      "commercePermissions",
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });
});

describe("orders", () => {
  it("makes order creation idempotent at the DATABASE, not by convention", () => {
    // trailcards creates orders from BOTH checkout.session.completed AND
    // payment_intent.succeeded, each handler first querying whether the other
    // ran. That guard is a read followed by a write with no lock between them,
    // and Stripe delivers those two events milliseconds apart: both read "no
    // order yet" and both insert. Charged once, shipped twice.
    expect(uniqueIndexNames(orders)).toContain(
      "orders_tenant_idempotency_key_idx",
    );
  });

  it("keys idempotency on a NOT NULL column, which is the whole mechanism", () => {
    // The previous target, stripe_payment_intent_id, is NULL for delayed-
    // notification methods, and Postgres treats NULLs as distinct — so
    // ON CONFLICT could not fire in the exact case the mechanism existed for.
    const columns = new Map(
      getTableConfig(orders).columns.map((c) => [c.name, c]),
    );
    expect(columns.get("idempotency_key")?.notNull).toBe(true);
  });

  it("scopes the idempotency key to the tenant, like every other key here", () => {
    // The key is caller-supplied on the admin and back-fill paths. A global
    // unique would make one tenant's "import-batch-1" collide with another's.
    expect(indexColumnNames(orders, "orders_tenant_idempotency_key_idx")).toEqual(
      ["tenant_id", "idempotency_key"],
    );
  });

  it("makes the payment intent index unusable as an ON CONFLICT target", () => {
    // Partial, so a bare ON CONFLICT (stripe_payment_intent_id) cannot infer
    // it: Postgres answers "no unique or exclusion constraint matching the ON
    // CONFLICT specification". A route that reintroduces the old broken
    // statement fails on its first execution instead of silently writing two
    // orders for one delayed-notification payment months later.
    const names = uniqueIndexNames(orders);
    expect(names).toContain("orders_stripe_payment_intent_idx");
    expect(names).toContain("orders_stripe_checkout_session_idx");

    for (const name of [
      "orders_stripe_payment_intent_idx",
      "orders_stripe_checkout_session_idx",
    ]) {
      expect(findIndex(orders, name)?.config.where).toBeDefined();
    }
  });

  it("scopes the order number to the tenant", () => {
    expect(uniqueIndexNames(orders)).toContain("orders_tenant_order_number_idx");
  });

  it("indexes email, the only handle support has on a guest order", () => {
    const names = getTableConfig(orders).indexes.map((i) => i.config.name);
    expect(names).toContain("orders_email_idx");
  });

  it("keeps every money column NOT NULL, so no total is ever unknown", () => {
    // A nullable amount reads as zero in most JavaScript and as NULL in SQL
    // arithmetic, where NULL + 100 is NULL. One nullable column turns a whole
    // revenue report into NULL with no error anywhere.
    const columns = new Map(
      getTableConfig(orders).columns.map((c) => [c.name, c]),
    );
    for (const name of [
      "subtotal_minor",
      "shipping_minor",
      "tax_minor",
      "discount_minor",
      "total_minor",
      "currency",
      "email",
      "tenant_id",
      "order_number",
      "status",
    ]) {
      expect(columns.get(name)?.notNull).toBe(true);
    }
  });

  it("allows a guest order and an unpaid order", () => {
    const columns = new Map(
      getTableConfig(orders).columns.map((c) => [c.name, c]),
    );
    for (const name of [
      "user_id",
      "placed_at",
      "stripe_payment_intent_id",
      "stripe_checkout_session_id",
    ]) {
      expect(columns.get(name)?.notNull).toBe(false);
    }
  });

  it("has no foreign key to users — guests have no user row", () => {
    expect(getTableConfig(orders).foreignKeys).toHaveLength(0);
  });
});

describe("order_items", () => {
  it("refuses a non-positive quantity in the database itself", () => {
    // validateCart only runs on the checkout path. Webhook handlers, admin
    // tools and back-fill scripts all write orders too, and a quantity of 0
    // makes the order's total stop equalling the sum of its lines — surfacing
    // months later as an accounting discrepancy with nothing left to blame.
    expect(getTableConfig(orderItems).checks.map((c) => c.name)).toContain(
      "order_items_quantity_positive",
    );
  });

  it("cascades from the order it belongs to", () => {
    const [fk] = getTableConfig(orderItems).foreignKeys;
    expect(fk?.onDelete).toBe("cascade");
    expect(fk?.reference().foreignTable).toBe(orders);
  });

  it("has no foreign key to a product table this package does not own", () => {
    // A restrict would make a discontinued product undeletable; a cascade would
    // delete the line item and leave the order's totals unexplained.
    expect(getTableConfig(orderItems).foreignKeys).toHaveLength(1);
  });
});

describe("order_shipments", () => {
  it("is a table, so a partially fulfilled order keeps both tracking numbers", () => {
    // Held as orders.tracking_number, the second shipment overwrites the first
    // and the customer chasing the parcel that already arrived is given the
    // tracking for the one that has not shipped.
    const [fk] = getTableConfig(orderShipments).foreignKeys;
    expect(fk?.onDelete).toBe("cascade");
    expect(fk?.reference().foreignTable).toBe(orders);
  });
});

describe("discount_codes", () => {
  it("scopes codes per tenant, never globally", () => {
    // A global unique leaks one client's promo namespace into another's: the
    // second tenant to try "SUMMER20" learns from the constraint error that
    // somebody else already has it, and every failed create is a probe.
    expect(uniqueIndexNames(discountCodes)).toEqual([
      "discount_codes_tenant_code_idx",
    ]);
  });

  it("defaults the minimum rather than leaving it NULL", () => {
    // `subtotal < NULL` is NULL, not false, so a nullable minimum silently
    // drops the row out of the eligibility query it was meant to pass.
    const columns = new Map(
      getTableConfig(discountCodes).columns.map((c) => [c.name, c]),
    );
    expect(columns.get("min_subtotal_minor")?.notNull).toBe(true);
    expect(columns.get("min_subtotal_minor")?.hasDefault).toBe(true);
    expect(columns.get("times_redeemed")?.hasDefault).toBe(true);
    expect(columns.get("is_active")?.hasDefault).toBe(true);
  });

  it("leaves max_redemptions nullable, because NULL means unlimited", () => {
    const columns = new Map(
      getTableConfig(discountCodes).columns.map((c) => [c.name, c]),
    );
    expect(columns.get("max_redemptions")?.notNull).toBe(false);
  });
});

describe("commerceSchema", () => {
  it("holds the same objects the module exports, not copies", () => {
    // Reference equality is what Drizzle relations and getTableConfig compare
    // on. Two objects for one physical table fail silently.
    expect(commerceSchema.orders).toBe(orders);
    expect(commerceSchema.orderItems).toBe(orderItems);
    expect(commerceSchema.orderShipments).toBe(orderShipments);
    expect(commerceSchema.discountCodes).toBe(discountCodes);
  });
});

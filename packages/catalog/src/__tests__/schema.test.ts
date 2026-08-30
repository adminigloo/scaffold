import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  catalogSchema,
  productGrants,
  productVariants,
  products,
} from "../schema.js";
import * as barrel from "../index.js";

function indexNames(table: PgTable): (string | undefined)[] {
  return getTableConfig(table).indexes.map((i) => i.config.name);
}

function uniqueIndexNames(table: PgTable): (string | undefined)[] {
  return getTableConfig(table)
    .indexes.filter((i) => i.config.unique)
    .map((i) => i.config.name);
}

function findIndex(table: PgTable, name: string) {
  return getTableConfig(table).indexes.find((i) => i.config.name === name);
}

function indexColumnNames(
  table: PgTable,
  name: string,
): (string | null | undefined)[] {
  return (findIndex(table, name)?.config.columns ?? []).map((c) =>
    "name" in c ? c.name : null,
  );
}

function checkNames(table: PgTable): string[] {
  return getTableConfig(table).checks.map((c) => c.name);
}

describe("the barrel never re-exports a table", () => {
  it("exports no runtime value from schema.ts", () => {
    // Tables are reachable ONLY from "@adminigloo/catalog/schema". Re-exported
    // here, the root entry becomes a static import of drizzle-orm/pg-core, so a
    // client component importing `formatMinor` to render a price drags the
    // whole query builder into the browser bundle — and tsup does not
    // code-split CJS, so the same pgTable call is emitted into both
    // dist/index.cjs and dist/schema.cjs and a CJS consumer holds two distinct
    // objects for one physical table. Drizzle relations and getTableConfig
    // compare by reference; both then fail silently.
    for (const name of [
      "products",
      "productVariants",
      "productGrants",
      "catalogSchema",
    ]) {
      expect(barrel).not.toHaveProperty(name);
    }
  });

  it("still exports the pure surface", () => {
    // The other half: proving the guard above did not just delete the package.
    for (const name of [
      "formatMinor",
      "defaultVariant",
      "priceRange",
      "validateProduct",
      "canPublish",
      "grantConfigSchemas",
      "planStripeSync",
      "StripeAmountOutOfRangeError",
      "catalogPermissions",
    ]) {
      expect(barrel).toHaveProperty(name);
    }
  });

  it("ships all three tables under the schema entry", () => {
    expect(Object.keys(catalogSchema).sort()).toEqual([
      "productGrants",
      "productVariants",
      "products",
    ]);
  });
});

describe("products", () => {
  it("scopes the slug to the tenant, never globally", () => {
    // A global unique leaks one client's namespace into another's: the second
    // tenant to save "starter-deck" is told somebody else already has it, and
    // every failed create is a probe of a competitor's catalog.
    expect(uniqueIndexNames(products)).toEqual(["products_tenant_slug_idx"]);
    expect(indexColumnNames(products, "products_tenant_slug_idx")).toEqual([
      "tenant_id",
      "slug",
    ]);
  });

  it("does not exempt archived or soft-deleted rows from the slug index", () => {
    // An archived product keeps its slug reserved, because that slug is in the
    // URL on an old receipt. Freeing it lets a NEW product inherit the link.
    expect(findIndex(products, "products_tenant_slug_idx")?.config.where).toBeUndefined();
  });

  it("indexes the storefront listing", () => {
    expect(indexColumnNames(products, "products_tenant_status_sort_idx")).toEqual([
      "tenant_id",
      "status",
      "sort_order",
    ]);
  });

  it("defaults a new product to draft, so nothing publishes itself", () => {
    // The opposite default puts the half-filled product an admin abandoned
    // mid-form on the storefront with no price.
    expect(products.status.default).toBe("draft");
    expect(products.status.notNull).toBe(true);
  });

  it("keeps status and kind as text, not a pgEnum", () => {
    // A value added to a Postgres enum can never be removed, and 'draft' is
    // exactly the kind of value a project renames in its second week.
    expect(products.status.getSQLType()).toBe("text");
    expect(products.kind.getSQLType()).toBe("text");
  });

  it("carries a soft-delete marker without any table cascading into it", () => {
    // ARCHIVED IS NOT DELETED, and an order line must keep rendering. Nothing
    // may hard-delete a product an order references.
    expect(products.deletedAt.notNull).toBe(false);
    expect(getTableConfig(products).foreignKeys).toHaveLength(0);
  });
});

describe("productVariants", () => {
  it("cascades from its product, because a variant is a price and nothing else", () => {
    const [fk] = getTableConfig(productVariants).foreignKeys;
    expect(fk?.onDelete).toBe("cascade");
    expect(getTableConfig(productVariants).foreignKeys).toHaveLength(1);
  });

  it("makes the SKU unique per product, and only where there is one", () => {
    // Without the partial predicate the index sits over every SKU-less variant
    // for no reason; per product rather than per tenant because two products
    // legitimately reuse a supplier's part number.
    expect(uniqueIndexNames(productVariants)).toEqual([
      "product_variants_product_sku_idx",
    ]);
    expect(
      indexColumnNames(productVariants, "product_variants_product_sku_idx"),
    ).toEqual(["product_id", "sku"]);
    expect(
      findIndex(productVariants, "product_variants_product_sku_idx")?.config.where,
    ).toBeDefined();
  });

  it("indexes the Stripe price id, which is the whole webhook read path", () => {
    // A Stripe event carries a price id and nothing else that maps into this
    // database. Without the index it is a sequential scan on the one code path
    // with a three-day retry deadline attached.
    expect(indexNames(productVariants)).toContain(
      "product_variants_stripe_price_idx",
    );
  });

  it("keeps inventory nullable, so untracked and sold-out stay distinct", () => {
    // NULL is untracked, 0 is genuinely out of stock. NOT NULL DEFAULT 0 makes
    // every digital product in the catalog read as sold out.
    expect(productVariants.inventory.notNull).toBe(false);
    expect(productVariants.inventory.hasDefault).toBe(false);
  });

  it("keeps the interval nullable, because a one-time variant has none", () => {
    expect(productVariants.interval.notNull).toBe(false);
  });

  it("stores money as bigint minor units, never numeric or a float", () => {
    expect(productVariants.priceMinor.getSQLType()).toBe("bigint");
    expect(productVariants.priceMinor.notNull).toBe(true);
  });

  it("defaults the currency to Stripe's lowercase spelling", () => {
    // A stored 'USD' beside a Stripe 'usd' turns every currency equality check
    // into a latent bug — and in planStripeSync it re-creates the price on
    // every sync run.
    expect(productVariants.currency.default).toBe("usd");
  });

  it("refuses a negative price at the database, not only in the validator", () => {
    // The validator runs on the admin save path. Imports, seed scripts and
    // whatever a project bolts on later never call it.
    expect(checkNames(productVariants)).toContain(
      "product_variants_price_non_negative",
    );
  });

  it("refuses negative stock at the database too", () => {
    expect(checkNames(productVariants)).toContain(
      "product_variants_inventory_non_negative",
    );
  });

  it("has no CHECK for the interval rule, because that one spans two tables", () => {
    // `kind` lives on `products` and a check constraint may only read columns
    // of its own row. `validateProduct` is where that rule lives.
    expect(checkNames(productVariants)).toHaveLength(2);
  });
});

describe("productGrants", () => {
  it("cascades from its variant", () => {
    const [fk] = getTableConfig(productGrants).foreignKeys;
    expect(fk?.onDelete).toBe("cascade");
  });

  it("indexes the fulfilment read path", () => {
    expect(indexNames(productGrants)).toEqual(["product_grants_variant_idx"]);
  });

  it("keeps the config non-null with a default, so no reader has to branch", () => {
    expect(productGrants.config.notNull).toBe(true);
    expect(productGrants.config.hasDefault).toBe(true);
  });

  it("keeps the kind as text, so a grant kind can be renamed later", () => {
    expect(productGrants.kind.getSQLType()).toBe("text");
  });
});

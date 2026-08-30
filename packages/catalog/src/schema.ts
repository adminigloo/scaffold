import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  amountMinor,
  createdAt,
  deletedAt,
  idColumn,
  updatedAt,
} from "@adminigloo/db";

/**
 * The catalog BOTH sides sell from.
 *
 * commerce turns a variant into an order line; billing turns a recurring
 * variant into a subscription. Neither owns this, which is why it is a package
 * and not a file inside one of them. Before it existed,
 * `order_items.product_ref` was a bare string with no table behind it and
 * `plans` only modelled things that renew — so a project selling a physical
 * deck of cards had nowhere to define the deck.
 *
 * Every union below is `text` with `$type<...>()` rather than `pgEnum`,
 * matching billing, commerce and tenancy. A value added to a Postgres enum can
 * never be removed: `ALTER TYPE ... DROP VALUE` does not exist, and the
 * workaround is rewriting the type and every column that uses it. `'draft'` is
 * exactly the kind of value a project renames in its second week ('unlisted',
 * 'preview', 'internal'), and a rename must not be a migration that rewrites
 * the whole products table.
 */

/**
 * What the thing is, which decides which half of the platform sells it.
 *
 * `one_time` goes to commerce as an order line. `subscription` goes to billing
 * as a subscription. The variant's `interval` has to agree with this — see
 * `validateProduct`, which is the only place that can check it.
 */
export type ProductKind = "one_time" | "subscription";

/**
 * ARCHIVED IS NOT DELETED.
 *
 * An archived product must still render on the order that bought it: a receipt
 * from eighteen months ago names a product, and a chargeback is argued over
 * that receipt. So nothing may hard-delete a product that an order line
 * references, and `deleted_at` below is a soft marker for rows created in
 * error — never a fulfilment path.
 *
 * `draft` is not purchasable, `active` is, `archived` is not purchasable again
 * but stays readable forever.
 */
export type ProductStatus = "draft" | "active" | "archived";

/** How often a recurring variant bills. NULL on the column means one-time. */
export type VariantInterval = "month" | "year";

/**
 * What buying a variant actually gives the buyer.
 *
 * `none` is a real answer, not a placeholder: a pay-what-you-want donation, or
 * a ticket handled entirely outside the platform, grants nothing here — and an
 * absent grant row would be indistinguishable from a misconfigured product.
 */
export type GrantKind = "ship" | "license_key" | "entitlement" | "none";

/**
 * A catalog image. Only `url` is required: `alt` is optional because a project
 * that has not written alt text yet must not be blocked from saving a product,
 * and width/height are optional because they come from the uploader, which not
 * every project has.
 */
export interface ProductImage {
  readonly url: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Free-form product metadata. string -> string, not `unknown`, for the reason
 * commerce gives for `CartLineMetadata`: these values are copied verbatim into
 * Stripe metadata and Stripe stringifies whatever it is handed, so a nested
 * object arrives in the dashboard as `[object Object]`.
 */
export type ProductMetadata = Readonly<Record<string, string>>;

/**
 * A grant's payload, shaped by its `kind`. Deliberately open at the type level
 * and checked at the boundary by `grantConfigSchemas` in ./validation.ts: the
 * shapes differ per kind, jsonb written a year ago has whatever shape it had
 * then, and a narrow type here would invite code to destructure fields a
 * stored row never carried.
 */
export type GrantConfig = Readonly<Record<string, unknown>>;

export const products = pgTable(
  "products",
  {
    id: idColumn(),
    tenantId: text("tenant_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").$type<ProductKind>().notNull(),
    /**
     * Nothing is purchasable until someone publishes it. The default is
     * `'draft'` rather than `'active'` because the opposite default means the
     * half-filled product an admin abandoned mid-form is live on the storefront
     * with no price, and the first anyone hears of it is a customer's
     * screenshot.
     */
    status: text("status").$type<ProductStatus>().notNull().default("draft"),
    images: jsonb("images")
      .$type<readonly ProductImage[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * NOT NULL with a `{}` default, so no reader has to branch. A nullable
     * jsonb makes `metadata->>'x'` return NULL for two different reasons — the
     * key is absent, or the whole column is — and the query filtering on it
     * silently drops every row nobody has edited yet.
     */
    metadata: jsonb("metadata")
      .$type<ProductMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * Soft delete, and ONLY for rows created in error. Archiving is the retire
     * path — see `ProductStatus`. This column exists so a product typed in
     * twice can leave the admin list without breaking a foreign key, not so
     * fulfilment can erase history.
     */
    deletedAt: deletedAt(),
  },
  (t) => [
    /**
     * Slugs are PER TENANT. A global unique on `slug` leaks one client's
     * namespace into another's: the second tenant to save "starter-deck" gets a
     * constraint error telling them somebody else already has it, and every
     * failed create is a probe of a competitor's catalog. It also makes the
     * obvious names first-come-first-served across unrelated businesses on one
     * platform, which is the same mistake `discount_codes_tenant_code_idx`
     * exists to avoid.
     *
     * Deliberately unqualified by `status` and by `deleted_at`. An archived or
     * soft-deleted product keeps its slug reserved, because that slug is in the
     * URL on an old receipt and in whatever a customer bookmarked — freeing it
     * lets a NEW product inherit the URL, so the link that used to show what
     * someone bought now shows something else entirely.
     */
    uniqueIndex("products_tenant_slug_idx").on(t.tenantId, t.slug),
    /**
     * The storefront listing: one tenant's active products in display order.
     * `status` is in the index because the listing always filters on it, and a
     * draft catalog easily outnumbers the published one during a build.
     */
    index("products_tenant_status_sort_idx").on(
      t.tenantId,
      t.status,
      t.sortOrder,
    ),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: idColumn(),
    /**
     * `cascade`, unlike `subscriptions.plan_id`'s `restrict`, because a variant
     * has no independent existence: it is a price on a product and means
     * nothing without it. What must NOT cascade is the order line, and it
     * cannot — commerce stores `product_ref` / `variant_ref` as plain text with
     * no foreign key precisely so a catalog change can never rewrite or delete
     * a completed order.
     */
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /**
     * Nullable: a digital download or a SaaS seat genuinely has no stock
     * keeping unit, and inventing one ("SKU-UNKNOWN") puts a fake value into
     * the warehouse export.
     */
    sku: text("sku"),
    name: text("name").notNull(),
    priceMinor: amountMinor("price_minor"),
    /**
     * Lowercase, matching Stripe's own representation and `orders.currency`, so
     * nothing has to normalise case at the boundary. A stored 'USD' beside a
     * Stripe 'usd' turns every currency equality check into a latent bug — and
     * in `planStripeSync` that particular bug archives and re-creates the
     * Stripe price on every single sync.
     */
    currency: text("currency").notNull().default("usd"),
    /**
     * NULL for a one-time variant, `'month'` or `'year'` for a recurring one.
     *
     * This has to agree with the parent product's `kind`, and that rule CANNOT
     * be a Postgres CHECK: a check constraint may only reference columns of its
     * own row, and `kind` lives on `products`. The alternatives are a trigger
     * (invisible, and it fires during the bulk import nobody is watching) or
     * denormalising `kind` onto every variant (two copies of one fact, which
     * drift). So it is enforced in `validateProduct`, which the builder UI runs
     * on every keystroke and the save path runs again.
     */
    interval: text("interval").$type<VariantInterval | null>(),
    /**
     * A CACHE of what Stripe has, exactly as billing describes for `plans`.
     * This row is authoritative for the price; Stripe is the payment engine.
     * When the cache is wrong, checkout fails loudly at session creation rather
     * than the storefront quietly rendering someone else's amount.
     */
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    isDefault: boolean("is_default").notNull().default(false),
    /**
     * NULL MEANS UNTRACKED. 0 MEANS GENUINELY OUT OF STOCK.
     *
     * Those are different answers to different questions and the UI does
     * different things with them: untracked renders "Add to cart", zero renders
     * "Sold out". A NOT NULL DEFAULT 0 collapses them, and every digital
     * product in the catalog — which has no stock to track — immediately reads
     * as sold out. A nullable integer is how the two stay distinct; the price
     * is that every reader must handle NULL, which is the right amount of
     * friction for a value meaning "the question does not apply".
     */
    inventory: integer("inventory"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * SKUs are unique within a product, and the index is PARTIAL because the
     * column is nullable. Without the `WHERE`, Postgres treats NULLs as
     * distinct, so the index would still accept unlimited SKU-less variants —
     * the behaviour wanted — while sitting uselessly over every one of them.
     * The explicit predicate says the intent out loud instead of relying on the
     * next reader knowing the NULL rule.
     *
     * Per product, not per tenant: two different products legitimately reuse a
     * supplier's part number, and a tenant-wide unique turns that into a save
     * error the admin cannot act on.
     */
    uniqueIndex("product_variants_product_sku_idx")
      .on(t.productId, t.sku)
      .where(sql`${t.sku} is not null`),
    /**
     * The webhook path. A Stripe event carries a price id and nothing else that
     * maps into this database, so every `invoice.paid` and
     * `customer.subscription.updated` starts with this lookup. Without the
     * index it is a sequential scan on the one code path that has a retry
     * schedule attached and a three-day deadline.
     */
    index("product_variants_stripe_price_idx").on(t.stripePriceId),
    /** The variant picker: one product's variants in display order. */
    index("product_variants_product_sort_idx").on(t.productId, t.sortOrder),
    /**
     * The database refuses a negative price, not just `validateProduct`.
     *
     * The validator runs on the admin save path. Variants are also written by
     * imports, seed scripts and whatever a project bolts on later, and none of
     * those remember to call it. A negative `price_minor` is a discount
     * smuggled in as a product — the shape commerce's `buildStripeLineItems`
     * already refuses to send to Stripe — and it makes an order's total stop
     * equalling the sum of its lines. Zero is allowed: a free tier and an
     * included accessory are both real.
     *
     * Contrast the interval rule above, which looks like it belongs here and
     * cannot be: this one reads only its own row.
     */
    check("product_variants_price_non_negative", sql`${t.priceMinor} >= 0`),
    /**
     * Same reasoning, and deliberately `>= 0` rather than `> 0`: zero is the
     * meaningful "sold out" value. NULL passes a CHECK in Postgres, which is
     * exactly right here — untracked inventory is not a violation.
     */
    check("product_variants_inventory_non_negative", sql`${t.inventory} >= 0`),
  ],
);

/**
 * What buying this variant gives the buyer.
 *
 * THIS IS THE SEAM. It is what lets one checkout serve a physical deck of cards
 * and a SaaS seat without either side knowing about the other: commerce reads
 * `ship` and prints a packing slip, billing reads `entitlement` and writes an
 * entitlements row, and the code in between only ever moves a grant from a
 * variant to a fulfilment handler. Without it, "does this need a postal
 * address?" gets answered by a string comparison on the product name, somewhere
 * in a checkout route.
 *
 * A row per grant rather than a column on the variant, because one purchase
 * routinely does two things: a boxed product that also unlocks the companion
 * app is a `ship` AND an `entitlement`, and a single column means the second
 * one is discovered the week after launch.
 */
export const productGrants = pgTable(
  "product_grants",
  {
    id: idColumn(),
    variantId: text("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<GrantKind>().notNull(),
    /**
     * The kind's payload: `{ feature, limit }` for an entitlement,
     * `{ weightGrams }` for a shipment, `{ seats }` for a licence key. Shape
     * checked by `grantConfigSchemas` at the boundary rather than by the
     * column, because a row written under last year's shape must still load.
     */
    config: jsonb("config")
      .$type<GrantConfig>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    /** Fulfilment reads every grant for a variant, always by this key. */
    index("product_grants_variant_idx").on(t.variantId),
  ],
);

export const catalogSchema = { products, productVariants, productGrants };

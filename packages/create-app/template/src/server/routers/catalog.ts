import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import {
  canPublish,
  grantConfigSchemas,
  planStripeSync,
  validateProduct,
  type GrantKind,
  type Problem,
  type ProductStatus,
  type SyncPlan,
  type VariantInterval,
} from "__SCOPE__/catalog";
import {
  productGrants,
  products,
  productVariants,
} from "__SCOPE__/catalog/schema";
import { auditEntry, defineAuditedActions } from "__SCOPE__/observability";
import { auditLog } from "__SCOPE__/observability/schema";
import { FIRM_WIDE } from "__SCOPE__/permissions";
import { db } from "@/db";
import { createTRPCRouter, requireStaff } from "../trpc";

/**
 * The product builder's server half.
 *
 * Every procedure is built from `requireStaff(...)`, never from a permission
 * check written inside a handler — `auditProcedureScopes` reads the rung off
 * the built procedure, and an inline `if (!ctx.can.can(...))` is invisible to
 * it. That is how a codebase ends up half-enforced with nothing to point at.
 *
 * The two catalog rules that matter are BOTH re-run here even though the form
 * runs them too: `validateProduct` before publishing, and the grant config
 * shapes before a grant is written. A validated form is not a constraint. This
 * router is reachable with `curl` by anyone holding the permission, and the
 * failure it prevents — an active product with no price, or an entitlement
 * grant with no feature name — charges a customer and delivers nothing.
 */

/**
 * Which tenant the staff-run catalog belongs to.
 *
 * `products.tenant_id` is per tenant and its slug uniqueness is scoped to it,
 * but this surface is the OPERATOR'S back office: the catalog being built here
 * is the thing the operator sells, not one customer's shop. The firm-wide
 * sentinel is the same value `principal_role` uses for a staff row, so the two
 * agree on what "not a customer's tenant" means.
 *
 * A project that lets each customer run their own storefront should replace
 * this constant with the tenant from the request and swap `requireStaff` for
 * `requireTenant` — the permission keys in `@__SCOPE__/catalog` are already
 * written for the tenant scope. Leaving it as a named constant rather than
 * inlining `FIRM_WIDE` at six call sites is what makes that a one-line change
 * instead of a hunt.
 */
const CATALOG_TENANT_ID = FIRM_WIDE;

/**
 * Actions this router writes to the audit log.
 *
 * A key per effect rather than one `catalog.changed` with the effect in
 * metadata, matching `adminAuditedActions`: "when did this price change" is
 * answered from an indexed `action` column, not by scanning a jsonb field.
 *
 * A price change is here because it is the single thing somebody asks about six
 * months later — a customer says they were charged the wrong amount, and the
 * only defensible answer names who changed it, when, and from what to what.
 *
 * NOTE FOR WHOEVER MERGES THIS WITH `adminAuditedActions`: compose the two with
 * `defineAuditedActions({ ...admin, ...catalog }, { contributedBy: [...] })` so
 * a duplicate key throws. Two separate registries cannot detect a collision
 * between them, and `admin.recentAudit` only knows how to label its own keys —
 * a catalog action currently renders there as its raw key.
 */
export const catalogAuditedActions = {
  "catalog.product.published": {
    label: "Published a product, making it purchasable",
  },
  "catalog.product.archived": {
    label: "Archived a product, retiring it from sale",
  },
  "catalog.price.changed": {
    label: "Changed what a variant costs, in what currency, or how it bills",
  },
  "catalog.variant.removed": {
    label: "Removed a variant, and with it a price",
  },
} as const;

export const catalogAuditRegistry = defineAuditedActions(catalogAuditedActions);

/**
 * Publishing was refused because the product is not valid.
 *
 * A named class carrying the whole problem list, for the same reason
 * `validateProduct` returns a list rather than throwing on the first rule: an
 * admin fixing one problem per round trip abandons the product half
 * configured. `readonly name` as an own property because pnpm can install two
 * physical copies of a package and `instanceof` is false across them, while the
 * name survives.
 */
export class ProductNotPublishableError extends Error {
  readonly name = "ProductNotPublishableError";
  constructor(readonly problems: readonly Problem[]) {
    super(
      `This product cannot be published yet:\n` +
        problems.map((p) => `  • ${p.message}`).join("\n"),
    );
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

const productStatusInput = z.enum(["draft", "active", "archived"]);
const productKindInput = z.enum(["one_time", "subscription"]);
const variantIntervalInput = z.enum(["month", "year"]);
const grantKindInput = z.enum(["ship", "license_key", "entitlement", "none"]);

/**
 * Lowercased and trimmed before it is checked, matching
 * `product_variants.currency` and Stripe's own spelling. A stored 'USD' beside
 * Stripe's 'usd' makes `planStripeSync` see a currency change on every run, and
 * every run then archives the live price and creates a new one.
 */
const currencyInput = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(
    z
      .string()
      .regex(
        /^[a-z]{3}$/,
        'Currency must be a three-letter ISO code, for example "usd".',
      ),
  );

const productImageInput = z.object({
  url: z.string().url(),
  alt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/**
 * `Record<string, string>`, not `unknown`. These values are copied verbatim
 * into Stripe metadata and Stripe stringifies whatever it is handed, so a
 * nested object arrives in the dashboard as `[object Object]`.
 */
const productMetadataInput = z.record(z.string(), z.string());

const productFieldsInput = z.object({
  slug: z.string().trim().min(1).max(96),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).nullable().optional(),
  kind: productKindInput,
  images: z.array(productImageInput).optional(),
  metadata: productMetadataInput.optional(),
  sortOrder: z.number().int().optional(),
});

/**
 * Money crosses this boundary as a bigint in MINOR units and never as a
 * number. superjson carries it intact both ways; a JSON number would silently
 * round a large annual amount, and a "dollars" float would reintroduce the
 * `× 100` that charges every JPY customer a hundredfold.
 */
const variantInput = z.object({
  /** Absent when this is a new row the form has not saved yet. */
  id: z.string().min(1).optional(),
  productId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(120).nullable().optional(),
  priceMinor: z.bigint().nonnegative(),
  currency: currencyInput,
  /** NULL for a one-time variant. Must agree with the product's `kind`. */
  interval: variantIntervalInput.nullable().optional(),
  isDefault: z.boolean().optional(),
  /** NULL means untracked. 0 means genuinely out of stock. Different things. */
  inventory: z.number().int().nonnegative().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Shared loading
// ---------------------------------------------------------------------------

type LoadedProduct = NonNullable<Awaited<ReturnType<typeof loadProduct>>>;

/**
 * One product with its variants and their grants, or null.
 *
 * Every read is filtered on `CATALOG_TENANT_ID` and `deleted_at is null`. The
 * id alone is not an authorization: a staff caller holding
 * `catalog.products.edit` must still not be able to reach into a customer
 * tenant's rows by pasting an id, and the filter is what makes that true for
 * every procedure below rather than for the ones that remembered.
 */
async function loadProduct(id: string) {
  const [product] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, id),
        eq(products.tenantId, CATALOG_TENANT_ID),
        isNull(products.deletedAt),
      ),
    );

  if (!product) return null;

  const variants = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, product.id))
    .orderBy(asc(productVariants.sortOrder), asc(productVariants.id));

  const variantIds = variants.map((variant) => variant.id);
  const grants =
    variantIds.length > 0
      ? await db
          .select()
          .from(productGrants)
          .where(inArray(productGrants.variantId, variantIds))
          .orderBy(asc(productGrants.variantId), asc(productGrants.id))
      : [];

  return { product, variants, grants };
}

async function loadProductOr404(id: string): Promise<LoadedProduct> {
  const loaded = await loadProduct(id);
  if (!loaded) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No product ${id} in this catalog.`,
    });
  }
  return loaded;
}

/**
 * Everything that would block publishing, computed against the status the
 * product is ABOUT to have rather than the one it has.
 *
 * Passing the stored `'draft'` here is the subtle way to disable half these
 * rules: `active-product-needs-variant` only fires for an active product, so a
 * draft with no variants at all would validate clean and then publish into a
 * product nobody can buy.
 */
function publishProblemsFor(loaded: LoadedProduct): readonly Problem[] {
  return validateProduct({
    product: {
      slug: loaded.product.slug,
      kind: loaded.product.kind,
      status: "active",
      name: loaded.product.name,
    },
    variants: loaded.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      name: variant.name,
      priceMinor: variant.priceMinor,
      currency: variant.currency,
      interval: variant.interval,
      isDefault: variant.isDefault,
      inventory: variant.inventory,
    })),
    grants: loaded.grants.map((grant) => ({
      variantId: grant.variantId,
      kind: grant.kind,
      config: grant.config,
    })),
  });
}

/**
 * Whether Stripe should consider the product purchasable.
 *
 * Mirrors `stripeActiveFor` inside @__SCOPE__/catalog, which is not exported.
 * `draft` maps to ACTIVE deliberately — draft is our concept, and what makes a
 * draft unbuyable is that checkout filters on `status` before it ever builds a
 * line item. Keep this in step with the package; if it starts being needed in a
 * third place, export it from there instead of copying it again.
 */
function stripeActiveFor(status: ProductStatus): boolean {
  return status !== "archived";
}

/**
 * Where the request came from, or nulls.
 *
 * `headers()` only answers inside a request scope, and a seed script or a test
 * driving this router through `createCallerFactory` has none. Losing a whole
 * price change over an IP address the row is allowed to leave null would be the
 * wrong trade.
 *
 * Imported lazily so that loading this router does not load Next's server
 * runtime — otherwise a unit test that builds a caller has to boot the
 * framework first. Duplicated from `admin.ts` because that copy is private; if
 * a third router needs it, move it to `src/server/request.ts`.
 */
async function requestContext(): Promise<{
  ipAddress: string | null;
  userAgent: string | null;
}> {
  try {
    const { headers } = await import("next/headers");
    const incoming = await headers();
    // Left-most entry is the original client; the rest are proxies. Spoofable,
    // which is why it is evidence and not identity — the actor id recorded
    // beside it is the part that was authenticated.
    const forwarded = incoming.get("x-forwarded-for")?.split(",")[0]?.trim();
    return {
      ipAddress: forwarded || null,
      userAgent: incoming.get("user-agent"),
    };
  } catch {
    return { ipAddress: null, userAgent: null };
  }
}

/**
 * `jsonb` goes through `JSON.stringify`, and `JSON.stringify(1299n)` THROWS.
 *
 * So every amount recorded in audit metadata is stringified here, at the one
 * place that writes it. Without this the audit insert is what fails, inside the
 * same transaction as the price change — the write is rolled back and the admin
 * is shown a `TypeError: Do not know how to serialize a BigInt` for what was a
 * perfectly valid edit.
 */
function minorForAudit(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const catalogRouter = createTRPCRouter({
  /**
   * The product list, with just enough pricing to render a range.
   *
   * Two queries and an in-memory group rather than an aggregate join: the
   * listing needs the individual prices anyway (`priceRange` in the package is
   * what turns them into "from $12", and it is the only implementation of that
   * rule), and a `min`/`max` in SQL would be a second one that disagrees the
   * first time a currency is mixed in.
   */
  list: requireStaff("catalog.products.view")
    .meta({ scope: "staff" })
    .input(z.object({ status: productStatusInput.optional() }))
    .query(async ({ input }) => {
      const rows = await db
        .select({
          id: products.id,
          slug: products.slug,
          name: products.name,
          kind: products.kind,
          status: products.status,
          sortOrder: products.sortOrder,
          updatedAt: products.updatedAt,
        })
        .from(products)
        .where(
          and(
            eq(products.tenantId, CATALOG_TENANT_ID),
            isNull(products.deletedAt),
            input.status ? eq(products.status, input.status) : undefined,
          ),
        )
        // `products.id` is a UUID v7, so it breaks ties in creation order
        // rather than arbitrarily. Without a tiebreak two products with the
        // same sort order swap places between renders.
        .orderBy(asc(products.sortOrder), desc(products.id));

      const ids = rows.map((row) => row.id);
      const variants =
        ids.length > 0
          ? await db
              .select({
                productId: productVariants.productId,
                priceMinor: productVariants.priceMinor,
                currency: productVariants.currency,
                isDefault: productVariants.isDefault,
              })
              .from(productVariants)
              .where(inArray(productVariants.productId, ids))
              .orderBy(asc(productVariants.sortOrder), asc(productVariants.id))
          : [];

      const byProduct = new Map<string, typeof variants>();
      for (const variant of variants) {
        const bucket = byProduct.get(variant.productId);
        if (bucket) bucket.push(variant);
        else byProduct.set(variant.productId, [variant]);
      }

      return {
        products: rows.map((row) => ({
          ...row,
          variants: byProduct.get(row.id) ?? [],
        })),
      };
    }),

  /** One product, its variants, its grants, and what blocks publishing. */
  get: requireStaff("catalog.products.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const loaded = await loadProductOr404(input.id);
      const problems = publishProblemsFor(loaded);
      return {
        ...loaded,
        // Computed here as well as in the form, from the same package
        // function. The form's copy is live as you type; this one is what the
        // page can show before any JavaScript has run.
        publishProblems: problems,
        canPublish: canPublish(problems),
      };
    }),

  /**
   * Create the product row. Deliberately WITHOUT variants.
   *
   * Adding a price is `catalog.prices.edit` and creating a product is
   * `catalog.products.create`, and the two are separate keys on purpose — the
   * person who writes the copy is usually not the person who signs off on what
   * a customer is charged. Accepting variants here would let the create
   * permission alone set a price, quietly collapsing the two.
   *
   * `status` is not an input. A product always starts as a draft: the opposite
   * default means the half-filled product an admin abandoned mid-form is live
   * on the storefront, and the first anyone hears of it is a customer's
   * screenshot. `publish()` is the only way out of draft, and it validates.
   */
  create: requireStaff("catalog.products.create")
    .meta({ scope: "staff" })
    .input(productFieldsInput)
    .mutation(async ({ input }) => {
      // Reported before the insert so the message names the field. The unique
      // index would otherwise surface as a driver error mentioning
      // `products_tenant_slug_idx`, which means nothing to the person typing.
      const [clash] = await db
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.tenantId, CATALOG_TENANT_ID),
            eq(products.slug, input.slug),
          ),
        );

      if (clash) throw slugTaken(input.slug);

      const [created] = await db
        .insert(products)
        .values({
          tenantId: CATALOG_TENANT_ID,
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          kind: input.kind,
          images: input.images ?? [],
          metadata: input.metadata ?? {},
          sortOrder: input.sortOrder ?? 0,
        })
        .returning({ id: products.id });

      if (!created) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The product row was not written.",
        });
      }

      return { id: created.id };
    }),

  /**
   * Edit the product's own fields.
   *
   * `status` is absent here too. Routing publish and archive through their own
   * permission-gated, audited procedures is the whole point; an `update` that
   * accepted `status: "active"` would be an unaudited publish that skipped
   * `validateProduct`, reachable by anyone holding only `catalog.products.edit`.
   *
   * Changing `kind` is allowed and can invalidate every variant's interval at
   * once — a one-time product whose variants all bill monthly. That is reported
   * by `validateProduct` and refused by `publish`, not blocked here: a product
   * mid-rework is a normal state, and blocking the edit leaves no way to fix it.
   */
  update: requireStaff("catalog.products.edit")
    .meta({ scope: "staff" })
    .input(productFieldsInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const loaded = await loadProductOr404(input.id);

      if (input.slug !== loaded.product.slug) {
        const [clash] = await db
          .select({ id: products.id })
          .from(products)
          .where(
            and(
              eq(products.tenantId, CATALOG_TENANT_ID),
              eq(products.slug, input.slug),
              ne(products.id, input.id),
            ),
          );
        if (clash) throw slugTaken(input.slug);
      }

      await db
        .update(products)
        .set({
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          kind: input.kind,
          ...(input.images ? { images: input.images } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          // `updatedAt()` supplies a default on INSERT only. Without this line
          // an edited product keeps the timestamp of the day it was created and
          // reads as untouched since.
          updatedAt: new Date(),
        })
        .where(eq(products.id, input.id));

      return { id: input.id };
    }),

  /**
   * Create or update one variant, and audit the money if it moved.
   *
   * `catalog.prices.edit`, not `catalog.products.edit`. This is the procedure
   * that reaches Stripe: a changed amount means `planStripeSync` will archive
   * the live price and create a new one, because a Stripe price is immutable.
   *
   * Saving a row whose price, currency and interval are unchanged writes no
   * audit line. The form re-saves every row on every save — that is what makes
   * "save" a single button — and an audit log with a `catalog.price.changed`
   * entry for a typo fix in a variant name is one nobody reads.
   */
  upsertVariant: requireStaff("catalog.prices.edit")
    .meta({ scope: "staff" })
    .input(variantInput)
    .mutation(async ({ ctx, input }) => {
      const loaded = await loadProductOr404(input.productId);
      const request = await requestContext();
      const interval: VariantInterval | null = input.interval ?? null;

      return db.transaction(async (tx) => {
        // Re-read INSIDE the transaction rather than reusing the row from
        // `loadProductOr404`. The `from` half of the audit line comes from this
        // row, and a value read before the transaction opened is the value some
        // other request may already have replaced — an audit trail that
        // confidently records the wrong previous price is worse than none.
        const existing = input.id
          ? (
              await tx
                .select()
                .from(productVariants)
                .where(
                  and(
                    eq(productVariants.id, input.id),
                    eq(productVariants.productId, loaded.product.id),
                  ),
                )
            )[0]
          : undefined;

        // An id that is not one of THIS product's variants. Without the check
        // the update below would silently match zero rows and report success,
        // and the admin would be looking at a price they believe they saved.
        if (input.id && !existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Variant ${input.id} is not part of this product.`,
          });
        }

        const values = {
          productId: loaded.product.id,
          name: input.name,
          sku: input.sku ?? null,
          priceMinor: input.priceMinor,
          currency: input.currency,
          interval,
          isDefault: input.isDefault ?? false,
          inventory: input.inventory ?? null,
          sortOrder: input.sortOrder ?? 0,
        };

        let variantId: string;
        if (existing) {
          await tx
            .update(productVariants)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(productVariants.id, existing.id));
          variantId = existing.id;
        } else {
          const [created] = await tx
            .insert(productVariants)
            .values(values)
            .returning({ id: productVariants.id });
          if (!created) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "The variant row was not written.",
            });
          }
          variantId = created.id;
        }

        // Exactly one default, enforced by clearing the others rather than by
        // trusting the form. Two defaults is `multiple-default-variants`, and
        // its real cost is that which variant the product page preselects then
        // depends on row order — so the price shown changes between page loads.
        if (values.isDefault) {
          await tx
            .update(productVariants)
            .set({ isDefault: false, updatedAt: new Date() })
            .where(
              and(
                eq(productVariants.productId, loaded.product.id),
                ne(productVariants.id, variantId),
                eq(productVariants.isDefault, true),
              ),
            );
        }

        const changed: string[] = [];
        if (!existing) {
          changed.push("created");
        } else {
          if (existing.priceMinor !== values.priceMinor) changed.push("amount");
          if (existing.currency !== values.currency) changed.push("currency");
          if ((existing.interval ?? null) !== interval) changed.push("interval");
        }

        if (changed.length > 0) {
          // In the SAME transaction as the write. A price change that lands
          // without its audit row is precisely the one somebody asks about six
          // months later, and the answer would be that the database says it was
          // always that way.
          await tx.insert(auditLog).values(
            auditEntry(catalogAuditRegistry, {
              action: "catalog.price.changed",
              actor: ctx.principal,
              scope: "staff",
              // Only a real tenant belongs in this column; it indexes the
              // per-organisation activity feed, and the firm-wide sentinel
              // would drop every staff change into whichever feed queries it.
              tenantId: null,
              resourceType: "product_variant",
              resourceId: variantId,
              request,
              metadata: {
                productId: loaded.product.id,
                productSlug: loaded.product.slug,
                variantName: values.name,
                changed,
                fromPriceMinor: minorForAudit(existing?.priceMinor),
                toPriceMinor: minorForAudit(values.priceMinor),
                fromCurrency: existing?.currency ?? null,
                toCurrency: values.currency,
                fromInterval: existing?.interval ?? null,
                toInterval: interval,
                // The Stripe price this row still points at. It is the one that
                // `planStripeSync` will archive, and naming it here is what
                // lets someone reconcile a Stripe dashboard against this log.
                stripePriceId: existing?.stripePriceId ?? null,
              },
            }),
          );
        }

        return { id: variantId, changed };
      });
    }),

  /**
   * Delete a variant outright.
   *
   * A hard delete is safe: @__SCOPE__/commerce stores `product_ref` and
   * `variant_ref` as plain text with NO foreign key, precisely so a catalog
   * change can never rewrite or delete a completed order. The receipt from
   * eighteen months ago keeps rendering.
   *
   * `product_grants.variant_id` cascades, so the grants go with it — which is
   * the reason the last variant of an ACTIVE product is refused: removing it
   * leaves a product the storefront lists and nobody can buy, and the admin
   * would have no error to explain it.
   */
  removeVariant: requireStaff("catalog.prices.edit")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await db
        .select({
          variant: productVariants,
          productId: products.id,
          productSlug: products.slug,
          productStatus: products.status,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          and(
            eq(productVariants.id, input.id),
            eq(products.tenantId, CATALOG_TENANT_ID),
            isNull(products.deletedAt),
          ),
        );

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No variant ${input.id} in this catalog.`,
        });
      }

      const siblings = await db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.productId, row.productId));

      if (row.productStatus === "active" && siblings.length <= 1) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "This is the only variant on an active product, so removing it " +
            "would leave a product the storefront lists and nobody can buy. " +
            "Add a replacement variant first, or archive the product.",
        });
      }

      const request = await requestContext();

      return db.transaction(async (tx) => {
        await tx.delete(productVariants).where(eq(productVariants.id, input.id));

        await tx.insert(auditLog).values(
          auditEntry(catalogAuditRegistry, {
            action: "catalog.variant.removed",
            actor: ctx.principal,
            scope: "staff",
            tenantId: null,
            resourceType: "product_variant",
            resourceId: input.id,
            request,
            metadata: {
              productId: row.productId,
              productSlug: row.productSlug,
              variantName: row.variant.name,
              priceMinor: minorForAudit(row.variant.priceMinor),
              currency: row.variant.currency,
              interval: row.variant.interval,
              // Left live in Stripe on purpose: a payment link somebody pasted
              // into Slack may still reference it, and archiving it from here
              // would be a Stripe write hidden inside a database delete.
              stripePriceId: row.variant.stripePriceId,
            },
          }),
        );

        return { id: input.id };
      });
    }),

  /**
   * Set what buying one variant gives the buyer.
   *
   * The config shape is checked with `grantConfigSchemas` — the package's own
   * map, not a second copy of it here. The one required field in the whole set
   * is `entitlement.feature`, and that is the point: an entitlement grant with
   * no feature name writes an entitlements row keyed on `undefined`, so the
   * customer is charged, the purchase succeeds from every angle except theirs,
   * and they receive nothing.
   *
   * Upserts BY KIND, leaving other kinds alone, because one purchase routinely
   * does two things — a boxed product that also unlocks the companion app is a
   * `ship` AND an `entitlement`. `none` is the exception: it means "grants
   * nothing", so it replaces everything rather than joining it.
   */
  setGrant: requireStaff("catalog.products.edit")
    .meta({ scope: "staff" })
    .input(
      z.object({
        variantId: z.string().min(1),
        kind: grantKindInput,
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const [row] = await db
        .select({ variantId: productVariants.id })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(
          and(
            eq(productVariants.id, input.variantId),
            eq(products.tenantId, CATALOG_TENANT_ID),
            isNull(products.deletedAt),
          ),
        );

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No variant ${input.variantId} in this catalog.`,
        });
      }

      const kind: GrantKind = input.kind;
      const parsed = grantConfigSchemas[kind].safeParse(input.config ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue ? issue.path.map(String).join(".") : "";
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            `The ${kind} grant is misconfigured` +
            (field ? ` (${field}): ` : ": ") +
            (issue?.message ?? "unknown problem") +
            ".",
        });
      }

      return db.transaction(async (tx) => {
        // Replace-in-place rather than insert-and-hope. Without the delete a
        // variant accumulates a grant row per save, and fulfilment reads every
        // one of them — so a customer who bought once is shipped three times.
        const supersedes: GrantKind[] =
          kind === "none" ? ["ship", "license_key", "entitlement", "none"] : [kind, "none"];

        await tx
          .delete(productGrants)
          .where(
            and(
              eq(productGrants.variantId, input.variantId),
              inArray(productGrants.kind, supersedes),
            ),
          );

        const [created] = await tx
          .insert(productGrants)
          .values({
            variantId: input.variantId,
            kind,
            config: parsed.data as Record<string, unknown>,
          })
          .returning({ id: productGrants.id });

        return { id: created?.id ?? null, kind };
      });
    }),

  /**
   * Publish, or refuse with every reason at once.
   *
   * `validateProduct` and `canPublish` run HERE, not only in the form. The form
   * disabling its own button is a courtesy; this procedure is reachable with a
   * hand-written request by anyone holding `catalog.products.publish`, and the
   * thing being prevented is a live product with no price or a subscription
   * variant Stripe cannot create a recurring price for.
   *
   * `catalog.products.publish` is SEALED in the package's permission map — an
   * override cannot hand it to one person for a launch week and then be
   * forgotten. A price with the decimal point in the wrong place is cheaper to
   * prevent than to refund.
   */
  publish: requireStaff("catalog.products.publish")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const loaded = await loadProductOr404(input.id);

      const problems = publishProblemsFor(loaded);
      if (!canPublish(problems)) {
        const error = new ProductNotPublishableError(problems);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: error.message,
          cause: error,
        });
      }

      // Idempotent, and deliberately silent. Publishing an already-active
      // product is a double click, and an audit row for it is noise in the one
      // log that has to stay readable.
      if (loaded.product.status === "active") {
        return { id: loaded.product.id, status: "active" as const, alreadyDone: true };
      }

      const request = await requestContext();

      return db.transaction(async (tx) => {
        await tx
          .update(products)
          .set({ status: "active", updatedAt: new Date() })
          .where(eq(products.id, loaded.product.id));

        await tx.insert(auditLog).values(
          auditEntry(catalogAuditRegistry, {
            action: "catalog.product.published",
            actor: ctx.principal,
            scope: "staff",
            tenantId: null,
            resourceType: "product",
            resourceId: loaded.product.id,
            request,
            metadata: {
              slug: loaded.product.slug,
              name: loaded.product.name,
              kind: loaded.product.kind,
              fromStatus: loaded.product.status,
              variantCount: loaded.variants.length,
              // What each variant costs at the moment it went live. This is the
              // row a chargeback argument is settled from.
              prices: loaded.variants.map((variant) => ({
                variantId: variant.id,
                name: variant.name,
                priceMinor: minorForAudit(variant.priceMinor),
                currency: variant.currency,
                interval: variant.interval,
              })),
            },
          }),
        );

        return { id: loaded.product.id, status: "active" as const, alreadyDone: false };
      });
    }),

  /**
   * Retire a product. NOTHING IS DELETED.
   *
   * An archived product must still render on the order that bought it: a
   * receipt from eighteen months ago names it, and a chargeback is argued over
   * that receipt. So this only moves `status`, and `deleted_at` stays for rows
   * created in error.
   */
  archive: requireStaff("catalog.products.archive")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const loaded = await loadProductOr404(input.id);

      if (loaded.product.status === "archived") {
        return { id: loaded.product.id, status: "archived" as const, alreadyDone: true };
      }

      const request = await requestContext();

      return db.transaction(async (tx) => {
        await tx
          .update(products)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(products.id, loaded.product.id));

        await tx.insert(auditLog).values(
          auditEntry(catalogAuditRegistry, {
            action: "catalog.product.archived",
            actor: ctx.principal,
            scope: "staff",
            tenantId: null,
            resourceType: "product",
            resourceId: loaded.product.id,
            request,
            metadata: {
              slug: loaded.product.slug,
              name: loaded.product.name,
              fromStatus: loaded.product.status,
              variantCount: loaded.variants.length,
            },
          }),
        );

        return { id: loaded.product.id, status: "archived" as const, alreadyDone: false };
      });
    }),

  /**
   * What WOULD happen in Stripe. Makes no Stripe calls of any kind.
   *
   * *** STRIPE PRICES ARE IMMUTABLE, AND THAT SURPRISES PEOPLE. ***
   *
   * You cannot change the amount, currency or interval of an existing Price;
   * `prices.update` accepts the call, ignores those fields and returns 200. So
   * the only correct move is to create a new Price and archive the old one, and
   * an admin who is not told that discovers it at renewal, when half their
   * subscribers turn out to be on an orphaned price.
   *
   * The plan is computed against the STORED row as the cache and the supplied
   * overrides as the target, so the form can ask "what happens if I save this
   * price" BEFORE the price is saved. With no overrides it answers the question
   * the publish button needs: does this create a Stripe product and price, or
   * is there nothing to do.
   *
   * Read-only, so `catalog.products.view` — but note it is a genuine preview of
   * a write, which is why it is a query with no side effects rather than a
   * mutation that "just plans".
   */
  syncPlan: requireStaff("catalog.products.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        id: z.string().min(1),
        /** Unsaved product edits. Omitted fields use the stored values. */
        product: z
          .object({
            name: z.string().trim().min(1).max(200).optional(),
            description: z.string().nullable().optional(),
            status: productStatusInput.optional(),
          })
          .optional(),
        /** Unsaved variant edits, by id. Rows not listed use stored values. */
        variants: z
          .array(
            z.object({
              id: z.string().min(1),
              priceMinor: z.bigint().nonnegative().optional(),
              currency: currencyInput.optional(),
              interval: variantIntervalInput.nullable().optional(),
            }),
          )
          .optional(),
      }),
    )
    .query(async ({ input }) => {
      const loaded = await loadProductOr404(input.id);
      const overrides = new Map(
        (input.variants ?? []).map((variant) => [variant.id, variant]),
      );

      const targetProduct = {
        id: loaded.product.id,
        name: input.product?.name ?? loaded.product.name,
        description:
          input.product?.description === undefined
            ? loaded.product.description
            : input.product.description,
        status: input.product?.status ?? loaded.product.status,
      };

      const variants = loaded.variants.map((variant) => {
        const override = overrides.get(variant.id);
        const target = {
          id: variant.id,
          priceMinor: override?.priceMinor ?? variant.priceMinor,
          currency: override?.currency ?? variant.currency,
          interval:
            override?.interval === undefined
              ? variant.interval
              : override.interval,
        };

        // The cache is what Stripe was last given, which is the STORED row —
        // that is the whole reason the comparison is meaningful. Building it
        // from the target instead would make every plan a noop, and the admin
        // would be told nothing will happen right before a live price is
        // archived.
        const cached =
          variant.stripeProductId === null
            ? { product: null, price: null }
            : {
                product: {
                  id: variant.stripeProductId,
                  name: loaded.product.name,
                  description: loaded.product.description,
                  active: stripeActiveFor(loaded.product.status),
                },
                price:
                  variant.stripePriceId === null
                    ? null
                    : {
                        id: variant.stripePriceId,
                        unitAmountMinor: variant.priceMinor,
                        currency: variant.currency,
                        interval: variant.interval,
                      },
              };

        let plan: SyncPlan | null = null;
        let error: string | null = null;
        try {
          plan = planStripeSync({ product: targetProduct, variant: target, cached });
        } catch (cause) {
          // `StripeAmountOutOfRangeError`, almost always. The money input
          // refuses an amount this size, so a row carrying one arrived from an
          // import or an API client — and the plan is the right place to say so
          // rather than letting the eventual sync throw.
          error = cause instanceof Error ? cause.message : String(cause);
        }

        return {
          variantId: variant.id,
          variantName: variant.name,
          hasStripePrice: variant.stripePriceId !== null,
          plan,
          error,
        };
      });

      return {
        product: {
          id: loaded.product.id,
          name: targetProduct.name,
          status: targetProduct.status,
        },
        variants,
        // No variants means nothing to sync, which is NOT the same as "in
        // sync" — `publish` refuses that product anyway, and the UI says so.
        isNoop:
          variants.length > 0 &&
          variants.every((entry) => entry.error === null && entry.plan?.isNoop === true),
      };
    }),
});

function slugTaken(slug: string): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message:
      `Another product in this catalog already uses the slug "${slug}". ` +
      `Slugs stay reserved after a product is archived, because that slug is ` +
      `in the URL on an old receipt — freeing it would let a new product ` +
      `inherit the link.`,
  });
}

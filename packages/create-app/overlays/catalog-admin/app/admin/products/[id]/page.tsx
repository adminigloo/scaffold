import Link from "next/link";
import { notFound } from "next/navigation";
import { isDbConfigured } from "__SCOPE__/db";
import {
  ProductForm,
  type ProductFormInitial,
  type ProductFormInitialVariant,
} from "@/components/admin/ProductForm";
import { minorToMajorInput } from "@/components/admin/money";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { api } from "@/trpc/server";

/**
 * One product, in the builder.
 *
 * The page's job is to load through the router — so the same `requireStaff`
 * rung applies as to a browser request — and to turn stored rows into the
 * strings the form edits. The one conversion that matters is money:
 * `minorToMajorInput` is the inverse of `parseMoneyInput`, and they live in the
 * same module precisely so there is only ever one implementation of the
 * currency's decimal count. A hand-rolled `Number(minor) / 100` here would
 * render a JPY price as a hundredth of itself, and the admin would helpfully
 * "correct" it back into the database.
 */

interface PageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function ProductPage({ params }: PageProps) {
  const { id } = await params;

  // Before anything queries; see the products list page for why.
  if (!isDbConfigured(db)) return <NotConfigured />;

  let can: Awaited<ReturnType<typeof loadStaffPermissions>> = null;
  try {
    const principal = await currentPrincipal();
    can = principal ? await loadStaffPermissions({ principal }) : null;
  } catch (error) {
    if (!isDatabaseNotConfigured(error)) throw error;
    return <NotConfigured />;
  }

  if (!can?.can("catalog.products.view")) {
    return (
      <>
        <Breadcrumb />
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">Product</h1>
        <p className="mt-4 text-sm text-ink-muted">
          You do not have permission to view the product catalog.
        </p>
      </>
    );
  }

  let loaded: Awaited<ReturnType<typeof loadProduct>>;
  try {
    loaded = await loadProduct(id);
  } catch (error) {
    if (isDatabaseNotConfigured(error)) return <NotConfigured />;
    throw error;
  }

  // `catalog.get` throws NOT_FOUND for an id that is not in this catalog —
  // including one that belongs to another tenant, which is why the router
  // filters on the tenant rather than trusting the id in the URL.
  if (loaded === null) notFound();

  const initial: ProductFormInitial = {
    id: loaded.product.id,
    slug: loaded.product.slug,
    name: loaded.product.name,
    description: loaded.product.description ?? "",
    kind: loaded.product.kind,
    status: loaded.product.status,
    sortOrder: loaded.product.sortOrder,
    variants: loaded.variants.map((variant): ProductFormInitialVariant => {
      const grants = loaded.grants.filter((grant) => grant.variantId === variant.id);
      // The form edits ONE grant per variant, which covers nearly every
      // product. The schema allows more than one — a boxed item that also
      // unlocks the companion app is a `ship` AND an `entitlement` — so the
      // meaningful one is preferred over the `none` placeholder here, and
      // `catalog.setGrant` upserts by kind so saving does not clobber the
      // other. A product genuinely using two kinds should be edited through
      // the API until this form grows a second row.
      const chosen = grants.find((grant) => grant.kind !== "none") ?? grants[0];
      return {
        id: variant.id,
        name: variant.name,
        sku: variant.sku,
        priceInput: minorToMajorInput(variant.priceMinor, variant.currency),
        currency: variant.currency,
        interval: variant.interval,
        isDefault: variant.isDefault,
        inventory: variant.inventory,
        grant: chosen ? { kind: chosen.kind, config: chosen.config } : null,
      };
    }),
  };

  const extraGrants = loaded.grants.length - initial.variants.filter((v) => v.grant).length;

  return (
    <>
      <Breadcrumb />
      <div className="mt-1 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {loaded.product.name}
          </h1>
          <p className="mt-1 max-w-[62ch] text-sm text-ink-muted">
            {loaded.canPublish
              ? "Everything checks out. Publishing makes it purchasable and syncs it to Stripe."
              : `${loaded.publishProblems.length} thing${
                  loaded.publishProblems.length === 1 ? "" : "s"
                } still block publishing — they are listed below the variants.`}
          </p>
        </div>
        <Link
          href={`/admin/products?status=${loaded.product.status}`}
          className="rounded-[--radius-card] border border-line bg-surface px-2.5 py-1 text-xs capitalize text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          {loaded.product.status}
        </Link>
      </div>

      {extraGrants > 0 ? (
        <p className="mt-4 rounded-[--radius-card] border border-warn bg-surface p-3 text-sm text-warn">
          {extraGrants} grant{extraGrants === 1 ? "" : "s"} on this product{" "}
          {extraGrants === 1 ? "is" : "are"} not shown: a variant carries more
          than one kind. Saving here will not remove them —{" "}
          <code>catalog.setGrant</code> replaces a grant by kind — but this form
          cannot edit them.
        </p>
      ) : null}

      <div className="mt-6">
        <ProductForm
          initial={initial}
          canEditPrices={can.can("catalog.prices.edit")}
          canPublishProducts={can.can("catalog.products.publish")}
          canArchiveProducts={can.can("catalog.products.archive")}
        />
      </div>
    </>
  );
}

/** The product, or null when the id is not in this catalog. */
async function loadProduct(id: string) {
  try {
    const caller = await api();
    return await caller.catalog.get({ id });
  } catch (error) {
    // NOT_FOUND is a real answer here, not a failure. Anything else — a
    // FORBIDDEN, a driver error — is left to propagate rather than rendered as
    // a missing product, which would be a lie about what went wrong.
    //
    // Read off the shape rather than with `instanceof TRPCError`: the caller
    // and this page can resolve two physical copies of @trpc/server, and the
    // class identity does not survive that while the fields do.
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "NOT_FOUND"
    ) {
      return null;
    }
    throw error;
  }
}

/** Matched by NAME, never `instanceof` — see the products list page. */
function isDatabaseNotConfigured(error: unknown): boolean {
  return error instanceof Error && error.name === "DatabaseNotConfiguredError";
}

function Breadcrumb() {
  return (
    <p className="text-sm">
      <Link
        href="/admin/products"
        className="text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        ← Products
      </Link>
    </p>
  );
}

function NotConfigured() {
  return (
    <>
      <Breadcrumb />
      <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">Product</h1>
      <p className="mt-4 max-w-[62ch] text-sm text-ink-muted">
        No database yet, so there is no product to load.{" "}
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>{" "}
        lists what is missing; then run{" "}
        <code className="text-ink">pnpm db:migrate</code>.
      </p>
    </>
  );
}

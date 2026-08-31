import Link from "next/link";
import { notFound } from "next/navigation";
import { isDbConfigured } from "__SCOPE__/db";
import {
  ProductForm,
  type ProductFormInitial,
  type ProductFormInitialVariant,
} from "@/components/admin/ProductForm";
import { minorToMajorInput } from "@/components/admin/money";
import {
  storefrontUrlFor,
  type StorefrontLinkable,
} from "@/components/admin/storefrontUrl";
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

  // No try/catch; see the product list for why. The guard above answers "no
  // database configured", and an unreachable one is an incident for the error
  // boundary rather than something to dress up as setup advice.
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

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

  // Read straight through. This catch used to ask whether the thrown error was
  // named `DatabaseNotConfiguredError`, which cannot work: `loadProduct` reads
  // through `api()`, and a tRPC caller wraps whatever a procedure throws, so
  // the name never arrived. It looked like the guard and was dead code behind
  // the real one — the same arrangement that left the storefront with the check
  // and no guard above it, returning a 500 on a project with no credentials.
  const loaded = await loadProduct(id);

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
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Link
            href={`/admin/products?status=${loaded.product.status}`}
            className="rounded-[--radius-card] border border-line bg-surface px-2.5 py-1 text-xs capitalize text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            {loaded.product.status}
          </Link>
          <StorefrontUrl product={loaded.product} />
        </div>
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

/**
 * The public URL, written out rather than hidden behind a word.
 *
 * Somebody who has just published a product wants two things: to look at it,
 * and to send the address to someone else. Printing the URL answers the second
 * without a right-click, and the link answers the first — in a new tab, because
 * this page is a form and losing an unsaved edit to check the shop is a worse
 * trade than an extra tab.
 *
 * A draft says so plainly instead of offering a link that 404s. The storefront
 * only serves `active`, and `storefrontUrlFor` is the same function the product
 * list asks, so the two pages cannot disagree about it.
 */
function StorefrontUrl({ product }: { readonly product: StorefrontLinkable }) {
  const href = storefrontUrlFor(product);

  if (href === null) {
    return (
      <span className="text-xs text-ink-muted">Not on the storefront yet</span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-[--radius-card] font-mono text-xs text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      {href} <span aria-hidden="true">↗</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
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

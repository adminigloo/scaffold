import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { formatMinor, priceRange } from "__SCOPE__/catalog";
import { Badge, Card, CardBody, EmptyState, Notice, PageHeader } from "@/components/ui";
import { db } from "@/db";
import { type StorefrontProduct } from "@/server/routers/checkout";
import { productHref } from "@/storefront";
import { api } from "@/trpc/server";

/**
 * The storefront listing. Public — no account, no tenant, no permission.
 *
 * Rendered per request rather than statically. A storefront cached at build
 * time serves the prices that existed when the deployment was cut, so an
 * admin's price change appears to have silently failed and the first person to
 * notice is a customer who was charged the new amount after seeing the old one.
 */
export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  // ASKED BEFORE ANYTHING QUERIES, exactly as every admin page asks it. This
  // page is linked from the header and the footer of every other page, so on a
  // fresh clone it is the first thing anyone clicks — and it used to 500.
  //
  // The previous guard caught the throw instead of preventing it, and could not
  // work: the read goes through `api()`, and a tRPC caller wraps whatever a
  // procedure throws in a `TRPCError` whose `name` is "TRPCError". Sniffing the
  // error for "DatabaseNotConfiguredError" therefore never matched, the
  // rethrow fired, and the page 500d on a project with no credentials at all.
  // Asking the handle needs no query, cannot be wrapped by anything, and is the
  // one pattern used everywhere else in this project.
  const products: StorefrontProduct[] | null = isDbConfigured(db)
    ? await (await api()).checkout.listProducts()
    : null;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        title="Products"
        description="Everything currently for sale. Prices are shown in the currency each product is sold in."
      />

      {products === null ? (
        <Notice tone="warn" title="The catalog cannot be read yet">
          This page lists rows from Postgres and <code>DATABASE_URL</code> is not
          set, so there is nothing to read. Add it to <code>.env.local</code> and
          restart —{" "}
          <Link href="/setup" className="text-accent underline underline-offset-2">
            /setup
          </Link>{" "}
          lists what else is outstanding.
        </Notice>
      ) : products.length === 0 ? (
        <EmptyState title="Nothing is published yet">
          Published products appear here. Create one in the catalog admin, give
          it at least one variant with a price, then set its status to{" "}
          <strong>Active</strong> — drafts and archived products are deliberately
          never shown to customers.
        </EmptyState>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {products.map((product) => (
            <li key={product.id}>
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function ProductCard({ product }: { readonly product: StorefrontProduct }) {
  return (
    <Card className="h-full">
      <CardBody className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            {/* `productHref`, not a hand-written path. This built the URL
                itself while `src/storefront.ts` documented itself as the single
                place that knows the route — so the storefront index and the
                admin's "view on the site" link were two copies of one rule, and
                an unencoded slug 404s here while resolving in the admin. */}
            <Link
              href={productHref(product.slug)}
              className="text-ink no-underline hover:text-accent"
            >
              {product.name}
            </Link>
          </h2>
          {product.kind === "subscription" && <Badge tone="accent">Subscription</Badge>}
        </div>

        {product.description && (
          <p className="line-clamp-3 text-sm text-ink-muted">{product.description}</p>
        )}

        <p className="mt-auto pt-2 text-sm font-medium tabular-nums">
          <PriceLabel product={product} />
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * "£19" when every variant costs the same, "from £19" when they do not.
 *
 * The single/range decision comes from `priceRange`, not from comparing
 * formatted strings — "£19" and "£19.00" are different strings for one amount,
 * and a card that says "from £19" for a product with one price reads as a
 * missing option the customer then goes looking for.
 */
function PriceLabel({ product }: { readonly product: StorefrontProduct }) {
  const range = priceRange(product.variants);
  const currency = product.variants[0]?.currency;

  // An active product with no variants is already reported by `validateProduct`
  // in the admin. Saying so plainly beats rendering "Free", which is a specific
  // and wrong claim about something that simply has no price yet.
  if (range === null || currency === undefined) {
    return <span className="text-ink-muted">No price set</span>;
  }

  const suffix = product.variants[0]?.interval;
  const per = suffix === null || suffix === undefined ? "" : ` / ${suffix}`;

  return range.single ? (
    <>
      {formatMinor(range.min, currency)}
      {per}
    </>
  ) : (
    <>
      from {formatMinor(range.min, currency)}
      {per}
    </>
  );
}

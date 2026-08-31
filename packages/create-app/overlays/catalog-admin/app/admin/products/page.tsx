import Link from "next/link";
import type { ReactNode } from "react";
import { formatMinor, priceRange, type ProductStatus } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
import {
  storefrontUrlFor,
  type StorefrontLinkable,
} from "@/components/admin/storefrontUrl";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";
import { api } from "@/trpc/server";

/**
 * Everything sellable, in one table.
 *
 * A server component that calls the router through `api()` rather than
 * querying Drizzle directly. The round trip is skipped but the middleware chain
 * is not, so this page is authorized by exactly the same `requireStaff(...)`
 * rung a browser request goes through. A page that queries the database itself
 * is a surface the scope audit cannot see.
 */

interface PageProps {
  readonly searchParams: Promise<{ readonly status?: string }>;
}

const STATUSES: readonly ProductStatus[] = ["draft", "active", "archived"];

const KIND_LABEL: Record<string, string> = {
  one_time: "Bought once",
  subscription: "Subscription",
};

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

export default async function ProductsPage({ searchParams }: PageProps) {
  // FIRST, before anything queries. `currentPrincipal()` reads the users table,
  // so on a fresh clone with no DATABASE_URL this page would otherwise throw
  // DatabaseNotConfiguredError before it could say what is missing. Asking the
  // handle whether it is configured does not trip the throw.
  if (!isDbConfigured(db)) return <NotConfigured />;

  const params = await searchParams;
  const status = STATUSES.find((candidate) => candidate === params.status);

  // No try/catch, matching every other admin page. The guard above has already
  // answered "is there a database configured"; what is left for a catch here is
  // a genuinely unreachable one — a paused Neon branch, a rotated password —
  // which must NOT be dressed up as "not configured yet", because that sends
  // whoever is on call to read /setup instead of the status page. Letting it
  // reach `app/admin/error.tsx` is the correct handling of an incident.
  const principal = await currentPrincipal();
  const can = principal ? await loadStaffPermissions({ principal }) : null;

  // Checked here as well as in the layout and again on every procedure. A page
  // can be rendered by a route that does not sit under the admin layout, and
  // "the parent checked" is not something the type system enforces.
  if (!can?.can("catalog.products.view")) {
    return (
      <>
        <Header />
        <p className="mt-4 text-sm text-ink-muted">
          You do not have permission to view the product catalog.
        </p>
      </>
    );
  }

  const products = await loadProducts(status);
  const canCreate = can.can("catalog.products.create");

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <Header />
        {canCreate ? (
          <Link
            href="/admin/products/new"
            className={`rounded-[--radius-card] bg-accent px-3.5 py-2 text-sm font-medium text-white ${FOCUS}`}
          >
            New product
          </Link>
        ) : null}
      </div>

      <nav className="mt-4 flex flex-wrap gap-1.5" aria-label="Filter by status">
        <FilterLink active={status === undefined} href="/admin/products">
          All
        </FilterLink>
        {STATUSES.map((candidate) => (
          <FilterLink
            key={candidate}
            active={status === candidate}
            href={`/admin/products?status=${candidate}`}
          >
            {candidate}
          </FilterLink>
        ))}
      </nav>

      {products.length === 0 ? (
        <EmptyState canCreate={canCreate} filtered={status !== undefined} />
      ) : (
        <div className="mt-4 overflow-x-auto rounded-[--radius-card] border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-ink-muted">
                <th scope="col" className="px-4 py-2 font-medium">Product</th>
                <th scope="col" className="px-4 py-2 font-medium">Kind</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 font-medium">Price</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Variants</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Storefront</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/admin/products/${product.id}`}
                      className={`rounded-[--radius-card] text-accent underline-offset-2 hover:underline ${FOCUS}`}
                    >
                      {product.name}
                    </Link>
                    <span className="block text-xs text-ink-muted">/{product.slug}</span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted">
                    {KIND_LABEL[product.kind] ?? product.kind}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={product.status} />
                  </td>
                  <td className="px-4 py-2.5 text-ink">
                    <Price variants={product.variants} />
                  </td>
                  <td className="px-4 py-2.5 text-right text-ink-muted tabular-nums">
                    {product.variants.length}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <StorefrontCell product={product} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/**
 * The list.
 *
 * NO "there is no database yet" BRANCH, and it had one. The branch caught this
 * read and asked whether the error was named `DatabaseNotConfiguredError`,
 * which cannot work through `api()`: a tRPC caller wraps whatever a procedure
 * throws in a `TRPCError` and hangs the original off `.cause`, so the name
 * being tested is never the name that arrives. It survived only because the
 * page already returns `<NotConfigured />` before reaching here — dead code
 * that read as the guard, which is how the storefront came to have the same
 * check and no guard above it, and to 500 on a fresh clone.
 */
async function loadProducts(status: ProductStatus | undefined) {
  const caller = await api();
  const { products } = await caller.catalog.list(status ? { status } : {});
  return products;
}

function Header() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-ink">Products</h1>
      <p className="mt-1 max-w-[62ch] text-sm text-ink-muted">
        Everything this business sells — a physical deck of cards, a licence key,
        a subscription seat. Each product carries variants, and each variant
        carries a price and what buying it grants.
      </p>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  readonly href: string;
  readonly active: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-[--radius-card] border px-2.5 py-1 text-xs capitalize ${FOCUS} ${
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-line bg-surface text-ink-muted"
      }`}
    >
      {children}
    </Link>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  const tone =
    status === "active"
      ? "border-accent bg-accent-soft text-accent"
      : status === "archived"
        ? "border-danger bg-surface text-danger"
        : "border-line bg-canvas text-ink-muted";
  return (
    <span
      className={`inline-block rounded-[--radius-card] border px-2 py-0.5 text-xs font-medium capitalize ${tone}`}
    >
      {status}
    </span>
  );
}

/**
 * The live page, or a dash saying there is not one.
 *
 * Only `active` products have a public page — the storefront query filters on
 * the status column, so a link on a draft or an archived row hands somebody a
 * 404 for a product sitting right in front of them. The difference is drawn the
 * same way the status column draws it, as something you read rather than
 * something you discover by clicking: down a list of forty products it is
 * immediately obvious which ones a customer can actually reach.
 *
 * `storefrontUrlFor` decides, not a comparison written out here. The detail
 * page asks the same function, so the two surfaces cannot come to disagree
 * about which products are public.
 */
function StorefrontCell({
  product,
}: {
  readonly product: StorefrontLinkable & { readonly name: string };
}) {
  const href = storefrontUrlFor(product);

  if (href === null) {
    return (
      <span className="text-ink-muted">
        <span aria-hidden="true">—</span>
        <span className="sr-only">Not on the storefront</span>
      </span>
    );
  }

  return (
    // A plain <a> and a new tab, as in the admin sidebar: nothing navigates
    // client-side into a new tab, and an admin checking a page should keep the
    // filtered list they were working through.
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`whitespace-nowrap rounded-[--radius-card] text-accent underline-offset-2 hover:underline ${FOCUS}`}
    >
      View <span aria-hidden="true">↗</span>
      <span className="sr-only">
        {product.name} on the storefront, opens in a new tab
      </span>
    </a>
  );
}

/**
 * One price, or a range.
 *
 * `priceRange` decides `single` rather than this component comparing formatted
 * strings — "$12.00" and "$12" are the same amount and different strings. And
 * every amount goes through `formatMinor`: dividing by 100 by hand renders a
 * JPY price as a hundredth of itself, and it looks entirely plausible.
 */
function Price({
  variants,
}: {
  readonly variants: readonly { readonly priceMinor: bigint; readonly currency: string }[];
}) {
  const range = priceRange(variants);
  if (!range) {
    return (
      <span className="text-ink-muted">
        No price yet
      </span>
    );
  }

  const currency = variants[0]?.currency ?? "usd";
  // Mixing currencies inside one product is `mixed-currency` and blocks
  // publishing. Rendering "from $12" across two of them would be a claim about
  // an amount that does not exist, so the table says what is actually wrong.
  if (variants.some((variant) => variant.currency !== currency)) {
    return <span className="text-danger">Mixed currencies</span>;
  }

  try {
    return (
      <span className="tabular-nums">
        {range.single
          ? formatMinor(range.min, currency)
          : `${formatMinor(range.min, currency)} – ${formatMinor(range.max, currency)}`}
      </span>
    );
  } catch {
    // `formatMinor` throws RangeError on a currency code Intl does not know.
    // That is a bad row rather than a bad render, and one of them must not take
    // the whole table down with it.
    return <span className="text-danger">Unknown currency &ldquo;{currency}&rdquo;</span>;
  }
}

function EmptyState({
  canCreate,
  filtered,
}: {
  readonly canCreate: boolean;
  readonly filtered: boolean;
}) {
  return (
    <div className="mt-4 rounded-[--radius-card] border border-dashed border-line bg-surface p-6">
      <p className="text-sm text-ink">
        {filtered
          ? "No products with that status."
          : "No products yet."}
      </p>
      <p className="mt-1 max-w-[62ch] text-sm text-ink-muted">
        A product is anything sellable: a boxed item you post, a licence key, a
        seat billed monthly. It starts as a draft and sells nothing. Before it
        can be published it needs at least one variant with a price — without
        one the storefront can list it and nobody can buy it.
        {canCreate ? null : " You do not hold the permission to create one."}
      </p>
      {/* Where it ends up, said before anybody has one. Creating a product and
          then having to guess at the public URL is the thing this list used to
          leave people doing; naming /products here means the answer is on the
          screen you start from rather than the one you never reach. Not shown
          under a status filter — "no archived products" is not the moment to
          explain the storefront. */}
      {filtered ? null : (
        <p className="mt-1 max-w-[62ch] text-sm text-ink-muted">
          Once a product is active it appears on the public storefront at{" "}
          <Link
            href="/products"
            className={`text-accent underline underline-offset-2 ${FOCUS}`}
          >
            /products
          </Link>
          , and every active row in this table links straight to its live page.
          Drafts and archived products are never shown there.
        </p>
      )}
      {canCreate && !filtered ? (
        <Link
          href="/admin/products/new"
          className={`mt-3 inline-block rounded-[--radius-card] bg-accent px-3.5 py-2 text-sm font-medium text-white ${FOCUS}`}
        >
          Create the first product
        </Link>
      ) : null}
    </div>
  );
}

function NotConfigured() {
  return (
    <>
      <Header />
      <p className="mt-4 max-w-[62ch] text-sm text-ink-muted">
        No database yet. Products, variants and grants all live in Postgres, so
        there is nothing to show until <code className="text-ink">DATABASE_URL</code>{" "}
        is set. <Link href="/setup" className="text-accent underline underline-offset-2">/setup</Link>{" "}
        lists what is missing and where to get it; then run{" "}
        <code className="text-ink">pnpm db:migrate</code>.
      </p>
    </>
  );
}

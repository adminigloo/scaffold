import Link from "next/link";
import type { ReactNode } from "react";
import { formatMinor, priceRange, type ProductStatus } from "__SCOPE__/catalog";
import { isDbConfigured } from "__SCOPE__/db";
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

  let can: Awaited<ReturnType<typeof loadStaffPermissions>> = null;
  try {
    const principal = await currentPrincipal();
    can = principal ? await loadStaffPermissions({ principal }) : null;
  } catch (error) {
    // Narrow on purpose. A genuinely unreachable database — a paused Neon
    // branch, a rotated password — must NOT be dressed up as "not configured
    // yet": that sends whoever is on call to read /setup instead of the status
    // page. Only the typed "you have not set DATABASE_URL" error gets the
    // friendly screen.
    if (!isDatabaseNotConfigured(error)) throw error;
    return <NotConfigured />;
  }

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
  if (products === null) return <NotConfigured />;

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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** The list, or null when the only thing wrong is a missing DATABASE_URL. */
async function loadProducts(status: ProductStatus | undefined) {
  try {
    const caller = await api();
    const { products } = await caller.catalog.list(status ? { status } : {});
    return products;
  } catch (error) {
    if (isDatabaseNotConfigured(error)) return null;
    throw error;
  }
}

/**
 * Matched by NAME, never with `instanceof`.
 *
 * pnpm resolves a peer mismatch by installing a second physical copy of a
 * package, and `instanceof` is false across the two class objects while the
 * name survives. Every error class in this codebase declares `readonly name` as
 * an own property for exactly this reason.
 */
function isDatabaseNotConfigured(error: unknown): boolean {
  return error instanceof Error && error.name === "DatabaseNotConfiguredError";
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

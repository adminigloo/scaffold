import Link from "next/link";
import { isDbConfigured } from "__SCOPE__/db";
import { ProductForm } from "@/components/admin/ProductForm";
import { db } from "@/db";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * A new product.
 *
 * The same `ProductForm` the edit page uses, with no `initial`. It saves in two
 * steps — `catalog.create` writes the product, then `catalog.upsertVariant`
 * writes each price — because creating a product and setting what a customer is
 * charged are separate permissions, and one procedure doing both would collapse
 * them into whichever is weaker.
 */
export default async function NewProductPage() {
  // Before anything queries. `currentPrincipal()` reads the users table, so a
  // fresh clone with no DATABASE_URL would otherwise throw before this page
  // could explain itself.
  if (!isDbConfigured(db)) return <NotConfigured />;

  let can: Awaited<ReturnType<typeof loadStaffPermissions>> = null;
  try {
    const principal = await currentPrincipal();
    can = principal ? await loadStaffPermissions({ principal }) : null;
  } catch (error) {
    // Only the typed "DATABASE_URL is not set" error gets the friendly screen.
    // An unreachable database is an incident, and disguising it as setup advice
    // sends the wrong person to the wrong page.
    if (!(error instanceof Error && error.name === "DatabaseNotConfiguredError")) {
      throw error;
    }
    return <NotConfigured />;
  }

  // Re-checked on `catalog.create` itself. This is what stops the form being
  // rendered at all, which is kinder than letting someone fill it in and be
  // refused at the end.
  if (!can?.can("catalog.products.create")) {
    return (
      <>
        <Header />
        <p className="mt-4 text-sm text-ink-muted">
          You do not have permission to create products.
        </p>
      </>
    );
  }

  return (
    <>
      <Header />
      <div className="mt-6">
        <ProductForm
          canEditPrices={can.can("catalog.prices.edit")}
          // Neither is reachable until the product exists and has an id, so
          // both are false here regardless of what this person holds.
          canPublishProducts={false}
          canArchiveProducts={false}
        />
      </div>
    </>
  );
}

function Header() {
  return (
    <div>
      <p className="text-sm">
        <Link
          href="/admin/products"
          className="text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          ← Products
        </Link>
      </p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink">
        New product
      </h1>
      <p className="mt-1 max-w-[62ch] text-sm text-ink-muted">
        It starts as a draft and sells nothing. Add at least one variant with a
        price, then publish — publishing is the moment a row stops being a form
        somebody is filling in and starts being something a card is charged for.
      </p>
    </div>
  );
}

function NotConfigured() {
  return (
    <>
      <Header />
      <p className="mt-4 max-w-[62ch] text-sm text-ink-muted">
        No database yet, so there is nowhere to save a product.{" "}
        <Link href="/setup" className="text-accent underline underline-offset-2">
          /setup
        </Link>{" "}
        lists what is missing; then run{" "}
        <code className="text-ink">pnpm db:migrate</code>.
      </p>
    </>
  );
}

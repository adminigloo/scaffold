import Link from "next/link";
import { notFound } from "next/navigation";
import { isDbConfigured } from "__SCOPE__/db";
import { defaultVariant, formatMinor } from "__SCOPE__/catalog";
import {
  Badge,
  Card,
  CardBody,
  Notice,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  buttonClass,
} from "@/components/ui";
import { db } from "@/db";
import {
  type StorefrontProduct,
  type StorefrontVariant,
} from "@/server/routers/checkout";
import { api } from "@/trpc/server";

/** Per request, for the same reason as the listing: a cached price is a lie. */
export const dynamic = "force-dynamic";

export default async function ProductPage({
  params,
}: {
  // A Promise since Next 15. Destructuring it synchronously compiles and then
  // renders `[object Promise]` into the URL lookup, which 404s every product.
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;

  // Before the read, not around it. See the listing page: the read goes through
  // a tRPC caller, which wraps whatever a procedure throws, so catching the
  // throw and matching its name could never recognise a missing database.
  if (!isDbConfigured(db)) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <PageHeader
          title="This product cannot be loaded"
          description="The catalog lives in Postgres, and this deployment has no connection to one yet."
        />
        <Notice tone="warn" title="DATABASE_URL is not set">
          Add it to <code>.env.local</code> and restart. Until then no product
          page can render, because there is nothing to render from.
        </Notice>
      </main>
    );
  }

  const product: StorefrontProduct | null = await (
    await api()
  ).checkout.getProduct({ slug });

  // A genuine 404 rather than an "unavailable" page: a draft or archived
  // product must be indistinguishable from one that never existed, or the
  // storefront becomes a way to enumerate an unreleased catalog by guessing
  // slugs.
  if (product === null) notFound();

  const preferred = defaultVariant(product.variants);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <p className="mb-4 text-sm">
        <Link href="/products" className="text-ink-muted underline underline-offset-2">
          ← All products
        </Link>
      </p>

      <PageHeader
        title={product.name}
        description={product.description ?? "No description has been written for this product yet."}
        actions={
          product.kind === "subscription" ? <Badge tone="accent">Subscription</Badge> : undefined
        }
      />

      {product.images[0] && (
        // eslint-disable-next-line @next/next/no-img-element -- catalog images
        // are arbitrary remote URLs entered by an admin, and next/image refuses
        // any host absent from next.config's remotePatterns. A product added on
        // a Tuesday must not fail to render because nobody edited the build
        // config, so this trades optimisation for a page that always works.
        <img
          src={product.images[0].url}
          alt={product.images[0].alt ?? product.name}
          className="mb-6 w-full rounded-[--radius-card] border border-line object-cover"
        />
      )}

      <Card>
        {product.variants.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-muted">
              This product has no purchasable options. An admin needs to add a
              variant with a price before it can be bought.
            </p>
          </CardBody>
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Option</TH>
                <TH>Price</TH>
                <TH>Availability</TH>
                <TH className="text-right">&nbsp;</TH>
              </TR>
            </THead>
            <TBody>
              {product.variants.map((variant) => (
                <VariantRow
                  key={variant.id}
                  slug={product.slug}
                  variant={variant}
                  preferred={variant.id === preferred?.id}
                />
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </main>
  );
}

function VariantRow({
  slug,
  variant,
  preferred,
}: {
  readonly slug: string;
  readonly variant: StorefrontVariant;
  readonly preferred: boolean;
}) {
  // NULL is untracked stock — a digital download has no inventory to speak of.
  // 0 is genuinely sold out. Collapsing the two would mark every downloadable
  // product in the catalog as unavailable.
  const soldOut = variant.inventory === 0;

  return (
    <TR>
      <TD>
        <span className="font-medium">{variant.name}</span>
        {preferred && (
          <span className="ml-2 align-middle">
            <Badge tone="accent">Default</Badge>
          </span>
        )}
        {variant.sku && (
          <span className="mt-0.5 block font-mono text-xs text-ink-muted">
            {variant.sku}
          </span>
        )}
      </TD>
      <TD className="tabular-nums">
        {/* formatMinor, always. Dividing by 100 by hand renders every JPY price
            at a hundredth of its value, and the result still looks like money. */}
        {formatMinor(variant.priceMinor, variant.currency)}
        {variant.interval && (
          <span className="text-ink-muted"> / {variant.interval}</span>
        )}
      </TD>
      <TD className="text-ink-muted">
        {soldOut
          ? "Sold out"
          : variant.inventory === null
            ? "Available"
            : `${variant.inventory} left`}
      </TD>
      <TD className="text-right">
        {soldOut ? (
          <span className="text-sm text-ink-muted">—</span>
        ) : (
          <Link
            // The slug travels alongside the variant id so the checkout page can
            // load the product in one query and render the line item itself. The
            // amount is NOT in this URL and never will be: the checkout reads it
            // from the variant row, so editing this link changes what you are
            // buying and not what you pay.
            href={`/checkout?product=${encodeURIComponent(slug)}&variant=${encodeURIComponent(variant.id)}&qty=1`}
            className={buttonClass("primary")}
          >
            {variant.interval ? "Subscribe" : "Buy"}
          </Link>
        )}
      </TD>
    </TR>
  );
}

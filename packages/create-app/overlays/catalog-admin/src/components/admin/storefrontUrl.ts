import type { ProductStatus } from "__SCOPE__/catalog";
import { productHref } from "@/storefront";

/**
 * Whether a product has a public page yet, and where it is.
 *
 * The storefront query filters on `status = 'active'` — a draft is a form
 * somebody is still filling in and an archived product is retired — so a link
 * on any other row leads to a 404. A 404 reached by clicking your own admin
 * reads as "the product I just saved has gone", and the next thing that happens
 * is somebody saves it again. Returning null instead means the difference is
 * something the table can render, at a glance, before anybody clicks.
 *
 * `active` is the ONLY difference worth testing here. The admin list already
 * filters out soft-deleted rows and reads the same tenant the storefront does,
 * so status is all that separates the two queries.
 *
 * A plain `.ts` module rather than a helper inside the pages, for the reason
 * spelled out at the top of money.ts: tsconfig sets `jsx: "preserve"`, esbuild
 * refuses to transform a `.tsx` under it, and a rule living in a component file
 * is a rule no unit test can import. Both admin pages call this one so they
 * cannot drift into disagreeing about which products are public.
 */
export interface StorefrontLinkable {
  readonly slug: string;
  readonly status: ProductStatus;
}

/** The product's public URL, or null when it does not have one yet. */
export function storefrontUrlFor(product: StorefrontLinkable): string | null {
  return product.status === "active" ? productHref(product.slug) : null;
}

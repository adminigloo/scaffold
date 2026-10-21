/**
 * Where a product lives on the public storefront.
 *
 * One function, and every surface that wants to point at a live product goes
 * through it. The admin pages are copied source in a DIFFERENT overlay to the
 * shop routes, so a hand-written `/products/${slug}` in the product list is a
 * second copy of a route the admin cannot see: move the shop under /shop and
 * the admin carries on emitting links to a page that no longer exists, with
 * nothing failing to build and nobody noticing until a customer is sent one.
 * Named once, that move breaks a single line.
 *
 * `encodeURIComponent` rather than raw interpolation. Slugs are typed by an
 * admin and validated as a slug, but a stray space or slash would otherwise
 * split the value across path segments and 404 the product it named — the one
 * failure that looks like the product was lost rather than mislinked.
 *
 * The module ships only with the Stripe overlay, which is to say only in
 * projects that have a storefront at all, and that is why the return type is a
 * plain string with no null case: where there is nothing to sell the file is
 * absent and the import does not resolve, which is a build error rather than a
 * link that quietly points nowhere. Nothing outside the stripe and
 * catalog-admin overlays may import it; catalog-admin is only ever selected
 * alongside stripe, so its imports always resolve.
 */

/** Public URL of one product's page. */
export function productHref(slug: string): string {
  return `/products/${encodeURIComponent(slug)}`;
}

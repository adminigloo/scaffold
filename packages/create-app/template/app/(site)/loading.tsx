/**
 * What a public page looks like while its data is still arriving.
 *
 * A `loading.tsx` is a Suspense boundary Next builds for the segment, and
 * placing it here rather than at the root is what keeps the header and the
 * footer on screen while only the content swaps. A root-level one would blank
 * the chrome on every navigation, so the site would appear to vanish and
 * reappear between pages.
 *
 * It matters most on the pages a new project actually has: `/setup` is
 * force-dynamic and reads the whole environment, and the storefront queries the
 * database. Without a fallback the browser sits on the previous page with no
 * sign that anything is happening, and people click the link again.
 *
 * Shapes, not a spinner. The bars stand roughly where the page header and the
 * first card will be, so the layout does not jump when the content lands.
 */
export default function SiteLoading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12" aria-busy="true">
      {/* One live region for the whole screen. A screen reader is told the page
          is loading once, rather than being read a list of grey rectangles. */}
      <span className="sr-only" role="status">
        Loading
      </span>
      <div aria-hidden className="animate-pulse">
        <div className="h-7 w-1/2 rounded-[--radius-card] bg-line" />
        <div className="mt-3 h-4 w-3/4 rounded-[--radius-card] bg-line" />
        <div className="mt-8 h-24 rounded-[--radius-card] border border-line bg-surface" />
        <div className="mt-4 h-24 rounded-[--radius-card] border border-line bg-surface" />
      </div>
    </div>
  );
}

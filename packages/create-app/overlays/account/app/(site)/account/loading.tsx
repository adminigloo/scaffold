/**
 * The account pages while their data arrives.
 *
 * HERE, not for the whole site (create-app 0.39). A `loading.tsx` is a
 * Suspense boundary: everything under it streams in after the first response
 * has gone out, so a redirect becomes a 200 with a meta refresh, a not-found
 * becomes a 200, and a crawler reading the first chunk sees "Loading" instead
 * of the page. That is why the public pages have none. Here it is safe: the
 * account layout above it draws the heading ("Your account") and the tabs
 * before this boundary, these pages are behind a sign-in (never indexed), and
 * none of them redirects.
 */
export default function AccountLoading() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading
      </span>
      <div aria-hidden className="animate-pulse">
        <div className="h-24 rounded-[--radius-card] border border-line bg-surface" />
        <div className="mt-4 h-24 rounded-[--radius-card] border border-line bg-surface" />
      </div>
    </div>
  );
}

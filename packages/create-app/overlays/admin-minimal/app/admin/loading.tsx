/**
 * What an admin page looks like while its query is running.
 *
 * Every page in here reads the database before it can render anything, and
 * several read a permission set first. Without a fallback a click on the
 * sidebar does nothing visible until the query returns — so people click again,
 * and the second click is the one that files a support ticket about the admin
 * panel being slow.
 *
 * Inside `app/admin`, so the sidebar stays put and only the content column
 * swaps. Rows rather than a spinner, because most of these pages are tables and
 * a fallback shaped like the answer stops the layout jumping when it lands.
 */
export default function AdminLoading() {
  return (
    <div aria-busy="true">
      {/* Announced once, as a whole. A screen reader should hear that the page
          is loading, not be read eight grey rectangles. */}
      <span className="sr-only" role="status">
        Loading
      </span>
      <div aria-hidden className="animate-pulse">
        <div className="h-7 w-64 rounded-[--radius-card] bg-line" />
        <div className="mt-3 h-4 w-96 max-w-full rounded-[--radius-card] bg-line" />
        <div className="mt-8 overflow-hidden rounded-[--radius-card] border border-line bg-surface">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="border-b border-line px-4 py-3 last:border-0">
              <div className="h-4 w-full rounded-[--radius-card] bg-line" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

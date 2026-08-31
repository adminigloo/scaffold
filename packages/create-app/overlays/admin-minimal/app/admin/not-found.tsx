import Link from "next/link";
import { buttonClass } from "@/components/ui";

/**
 * `notFound()` was called by an admin page.
 *
 * Admin routes are almost all keyed on a record — a product, a person, a
 * __TENANT_LABEL_LOWER__ — and the page calls `notFound()` when the id in the
 * URL resolves to nothing. Without this file that lands on the root 404, which
 * renders outside the admin shell: the sidebar vanishes and a stale bookmark to
 * one deleted product looks like the admin panel itself has gone.
 *
 * It says the record is missing rather than that the page does not exist,
 * because the page does. A row that has been deleted, a link from a stale tab
 * and a mistyped id are the three ways to get here and all three are ordinary.
 */
export default function AdminNotFound() {
  return (
    <div className="grid min-h-[60dvh] place-items-center px-6">
      <div className="max-w-[44ch] text-center">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          That record does not exist
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          It may have been deleted since this link was made, or the id in the
          address may be wrong. Nothing has been changed.
        </p>
        <Link href="/admin" className={buttonClass("secondary", "mt-5")}>
          Back to the dashboard
        </Link>
      </div>
    </div>
  );
}

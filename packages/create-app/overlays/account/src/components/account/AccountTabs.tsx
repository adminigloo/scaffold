"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";

/**
 * The three destinations inside the account area, with the current one marked.
 *
 * MOUNTED BY THE LAYOUT, not by each page, for the same reason `AuthHeader` is
 * mounted by `app/(site)/layout.tsx`: a nav that lives in a page is a nav the
 * next page forgets. There are four routes under `/account` and one of them is
 * dynamic, so "remember to add the tabs" is a rule that would be broken by the
 * first order-detail page somebody copies.
 *
 * A CLIENT COMPONENT ONLY BECAUSE OF `usePathname`. Nothing else here needs the
 * browser, and it holds no state — which is why it is this small strip rather
 * than the layout itself: making the layout a client component would push every
 * page under it across the boundary and cost the account area its server-side
 * database reads.
 *
 * `startsWith` on the orders tab rather than equality, so `/account/orders/
 * ORD-…` keeps Orders lit. Equality would leave a customer on an order detail
 * page with no tab marked at all, which reads as having navigated out of the
 * account area.
 */
const TABS: readonly { readonly href: string; readonly label: string }[] = [
  { href: "/account", label: "Overview" },
  { href: "/account/orders", label: "Orders" },
  { href: "/account/billing", label: "Billing" },
];

export function AccountTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Account"
      className="mb-6 flex flex-wrap items-center gap-1 border-b border-line"
    >
      {TABS.map((tab) => {
        // The overview is the prefix of everything else, so it is the one tab
        // that has to match exactly — otherwise it stays lit on every page and
        // the strip stops telling the reader anything.
        const active =
          tab.href === "/account"
            ? pathname === "/account"
            : pathname.startsWith(tab.href);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-sm no-underline transition-colors",
              active
                ? "border-accent text-ink"
                : "border-transparent text-ink-muted hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

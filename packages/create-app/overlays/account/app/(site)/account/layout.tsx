import type { ReactNode } from "react";
import { AccountTabs } from "@/components/account/AccountTabs";
import { PageHeader } from "@/components/ui";

/**
 * Chrome for everything under `/account`: one heading and one tab strip.
 *
 * A LAYOUT RATHER THAN A SHARED COMPONENT EACH PAGE REMEMBERS TO CALL. There
 * are four routes in here, one of them dynamic, and the next one somebody adds
 * will be a copy of an existing page — so a nav that has to be imported per
 * page is a nav that will be missing from the fifth. The same argument
 * `app/(site)/layout.tsx` makes about the site header, one level down.
 *
 * IT CHECKS NOTHING. Every page below does its own sign-in check and its own
 * ownership check, and that is deliberate rather than duplication: "the parent
 * layout checked" is not a property the type system enforces, a page can be
 * rendered by a route that does not sit under the layout you assumed, and this
 * layout is a server component that would have to do a database read on every
 * navigation to say anything useful anyway. Chrome here, authorisation there.
 *
 * NESTED INSIDE `(site)`, so the account area gets the same header and footer
 * as the storefront it is the other half of. A customer moves between
 * `/products` and `/account` constantly and must not feel like they left.
 */
export default function AccountLayout({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        title="Your account"
        description="What you have bought, what it granted you, and what you are being charged for."
      />
      <AccountTabs />
      {children}
    </main>
  );
}

import Link from "next/link";
import { planColumns, type PlanColumn } from "__SCOPE__/billing";
import { buttonClass } from "@/components/ui";
import { PlanCard, PlanCardCell, PlanCards } from "@/components/plans/PlanCard";
import { HEADLINE_FEATURES, plans } from "@/plans";

/**
 * Where "Talk to us" goes for a plan with no published price.
 *
 * `example.com` is reserved by RFC 2606 precisely so a placeholder cannot reach
 * a real inbox. Replace it with the address somebody reads.
 */
const SALES_CONTACT = "mailto:sales@example.com";

/**
 * Where choosing a plan goes: the plan chooser on /account/billing, with the
 * plan marked (`?plan=`), so the next click is the checkout. Someone signed
 * out goes through sign-up first, and sign-up brings them back to it.
 */
export function planHref(tierKey: string, signedIn: boolean): string {
  const chooser = `/account/billing?plan=${encodeURIComponent(tierKey)}`;
  return signedIn ? chooser : `/sign-up?redirect_url=${encodeURIComponent(chooser)}`;
}

/**
 * One product line's plans, as cards: the record's free tier first (when it
 * declares one), then every tier on sale or coming — `planColumns` from
 * @__SCOPE_NAME__/billing, drawn by the shared `PlanCard`. Every word and
 * number is the record's; this file owns only the buttons.
 */
export function PlanColumns({
  line,
  interval,
  currency,
  signedIn,
}: {
  /** The product line (billing 0.5); the only one when omitted. */
  readonly line?: string;
  readonly interval: "month" | "year";
  readonly currency: string;
  readonly signedIn: boolean;
}) {
  const columns = planColumns(plans, { ...(line === undefined ? {} : { line }), interval, currency, headline: HEADLINE_FEATURES });
  return (
    <PlanCards>
      {columns.map((column) => (
        <PlanCardCell key={column.key}>
          <PlanCard column={column} action={<Action column={column} signedIn={signedIn} />} />
        </PlanCardCell>
      ))}
    </PlanCards>
  );
}

function Action({ column, signedIn }: { readonly column: PlanColumn; readonly signedIn: boolean }) {
  if (column.free) {
    return signedIn ? (
      <Link href="/account" className={buttonClass("secondary", "w-full")}>
        Your account
      </Link>
    ) : (
      <Link href="/sign-up" className={buttonClass("secondary", "w-full")}>
        Start free
      </Link>
    );
  }
  if (column.onSale === "coming") {
    // Shown with its price so people know it's on the way; never sold before it exists.
    return (
      <span aria-disabled="true" className={buttonClass("secondary", "w-full cursor-default opacity-60")}>
        Coming soon
      </span>
    );
  }
  if (column.price.kind === "enquire") {
    return (
      <a href={SALES_CONTACT} className={buttonClass("secondary", "w-full")}>
        Talk to us
      </a>
    );
  }
  return (
    <Link href={planHref(column.key, signedIn)} className={buttonClass(column.highlight ? "primary" : "secondary", "w-full")}>
      Choose {column.name}
    </Link>
  );
}

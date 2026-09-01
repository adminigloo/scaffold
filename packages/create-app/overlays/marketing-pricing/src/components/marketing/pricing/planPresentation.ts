import { formatMinor } from "__SCOPE__/catalog";
import type { PlanCatalog, PlanFeature, PlanInterval, PlanTier } from "__SCOPE__/billing";

/**
 * Everything the pricing page has to DECIDE, with no JSX and no database.
 *
 * SPLIT OUT SO IT CAN BE TESTED. The page itself is a server component that
 * reads a request and a table; none of that can be exercised on a laptop with
 * nothing configured. What can go wrong here is different and worse: a tier
 * whose price renders blank, an unlimited allowance printed as "0", a query
 * string that reaches `Intl` and throws, an annual saving computed from the
 * wrong side of a subtraction. Every one of those compiles, and every one of
 * them is a number a customer reads before they pay.
 *
 * NOTHING HERE INVENTS A VALUE. Each function either answers from the record or
 * says it cannot — `priceDisplay` returns a discriminated union rather than
 * falling back to zero, because zero renders as "Free" and "Free" is a specific
 * and wrong claim about a tier that simply is not sold on the cadence the reader
 * is looking at.
 */

/**
 * One locale for the whole page, pinned rather than inherited.
 *
 * WHAT IT PREVENTS. This page is rendered on a build agent, so an unpinned
 * locale is whatever ICU default that machine happens to have — and the same
 * commit built on two runners can produce "£2,400.00" and "£2 400,00". Worse,
 * prices and quotas are formatted by different code paths, so an inherited
 * locale can punctuate the price one way and the allowance beside it another,
 * on the same card.
 *
 * Change it once, here, and the whole page moves with it.
 */
export const PAGE_LOCALE = "en-GB";

/** "Monthly", for a toggle. `once` is a lifetime purchase, not a cadence. */
export function intervalName(interval: PlanInterval): string {
  if (interval === "month") return "Monthly";
  if (interval === "year") return "Annual";
  return "One-time";
}

/** What goes under the amount: "per month". */
export function perLabel(interval: PlanInterval): string {
  if (interval === "month") return "per month";
  if (interval === "year") return "per year";
  return "one-time payment";
}

/**
 * The intervals a toggle may offer, from the ones this catalog actually prices.
 *
 * `once` IS DELIBERATELY EXCLUDED. A lifetime purchase is not the same product
 * billed differently, so putting it on a monthly/annual switch asks the reader
 * to compare two things that do not compare — and a tier sold only as a lifetime
 * purchase should print its price whichever way the switch is set, which is what
 * `priceDisplay` does.
 *
 * Fewer than two and the page renders no toggle at all: a switch with one
 * position is a control that does nothing, and it reads as a page that is
 * broken.
 */
export function toggleableIntervals(
  catalog: PlanCatalog,
): readonly PlanInterval[] {
  return catalog.intervals.filter(
    (interval) => interval === "month" || interval === "year",
  );
}

/**
 * The interval this request is asking for, or the catalog's default.
 *
 * A QUERY STRING IS UNTRUSTED INPUT, and this page is public. `?interval=🙂`
 * must select the default rather than reach anything that formats it. The same
 * function is what makes the toggle a set of links instead of a client
 * component: the state is in the URL, so it survives a share, a refresh and a
 * reader with JavaScript disabled, and the page stays a server component that
 * can also read the database.
 */
export function resolveInterval(
  requested: string | undefined,
  catalog: PlanCatalog,
): PlanInterval {
  const offered = toggleableIntervals(catalog);
  const match = offered.find((interval) => interval === requested);
  // `month` when the record prices nothing on a toggleable cadence at all —
  // every tier is then either unpriced or a lifetime purchase, and the value is
  // never read.
  return match ?? offered[0] ?? "month";
}

/**
 * The currency this request is asking for, or the catalog's first.
 *
 * The validation is not decorative. `formatMinor` asks `Intl` for a currency's
 * minor-unit exponent, and `Intl` throws `RangeError` on anything that is not
 * three letters — so an unchecked `?currency=` from a crawler or a mistyped link
 * is a 500 on the pricing page, which is the one page that must never be down.
 */
export function resolveCurrency(
  requested: string | undefined,
  catalog: PlanCatalog,
): string {
  const match = catalog.currencies.find((currency) => currency === requested);
  return match ?? catalog.currencies[0] ?? "usd";
}

/**
 * What this tier costs on this cadence, or why there is no number.
 *
 * THREE ANSWERS, because there are three situations and collapsing them loses
 * the one that matters:
 *
 *   amount          it is sold on this cadence, at this price.
 *   enquire         it is sold, and not at a published price. "Enterprise —
 *                   talk to us" is a real tier, and the record models it as a
 *                   tier with no prices at all.
 *   other-interval  it is sold, but not on the cadence the reader is looking
 *                   at. A monthly-only tier on the annual view is this, and it
 *                   must say so — rendering nothing there leaves a blank card
 *                   between two priced ones and the reader assumes a bug.
 *
 * The lifetime fallback is the one substitution made here: a tier priced `once`
 * shows that price under either position of the toggle, because a lifetime
 * purchase does not have a monthly version to hide.
 */
export type PriceDisplay =
  | {
      readonly kind: "amount";
      readonly amountMinor: bigint;
      /** What was actually priced — `once` when the lifetime fallback applied. */
      readonly interval: PlanInterval;
    }
  | { readonly kind: "enquire" }
  | { readonly kind: "other-interval"; readonly available: readonly PlanInterval[] };

export function priceDisplay(
  tier: PlanTier,
  interval: PlanInterval,
  currency: string,
): PriceDisplay {
  const asked = tier.prices[interval]?.[currency];
  if (asked !== undefined) return { kind: "amount", amountMinor: asked, interval };

  const lifetime = tier.prices.once?.[currency];
  if (lifetime !== undefined) {
    return { kind: "amount", amountMinor: lifetime, interval: "once" };
  }

  const available = (["month", "year", "once"] as const).filter(
    (candidate) => tier.prices[candidate]?.[currency] !== undefined,
  );
  if (available.length === 0) return { kind: "enquire" };
  return { kind: "other-interval", available };
}

/**
 * An amount, as a customer reads it.
 *
 * ZERO IS "FREE", NOT "£0.00". They are the same number and they are not the
 * same claim: a card at the top of a pricing page reading £0.00 looks like a
 * price that failed to load, and the record deliberately writes a free tier as
 * 0 rather than as an absent price precisely so this decision is made once here
 * instead of by every reader.
 */
export function amountLabel(amountMinor: bigint, currency: string): string {
  if (amountMinor === 0n) return "Free";
  return formatMinor(amountMinor, currency, PAGE_LOCALE);
}

/**
 * What a tier's annual price saves against paying monthly, as a percentage, or
 * `null` when there is nothing to claim.
 *
 * `null` COVERS FIVE CASES AND THEY ALL MEAN THE SAME THING to the page: no
 * monthly price, no annual price, a free tier, an annual price that saves
 * nothing, and an annual price that costs MORE than twelve months. The last is
 * the interesting one — it is a pricing mistake, and printing "save -8%" beside
 * it would advertise the mistake in the client's own voice.
 *
 * Rounded DOWN, so a saving is never overstated. 16.7% prints as 16%.
 */
export function annualSavingPercent(
  tier: PlanTier,
  currency: string,
): number | null {
  const monthly = tier.prices.month?.[currency];
  const yearly = tier.prices.year?.[currency];
  if (monthly === undefined || yearly === undefined) return null;

  const full = monthly * 12n;
  if (full <= 0n || yearly >= full) return null;
  const percent = Number(((full - yearly) * 100n) / full);
  return percent > 0 ? percent : null;
}

/** `1234` -> `1,234`, in the page's one locale. */
function count(value: number): string {
  return new Intl.NumberFormat(PAGE_LOCALE).format(value);
}

/**
 * `priority` -> `Priority`. Values are slugs; labels are already prose.
 *
 * `slice` rather than an index, so there is no non-null assertion to be wrong
 * about: `noUncheckedIndexedAccess` makes `value[0]` possibly-undefined on a
 * plain string, and an empty slug returns an empty string here rather than
 * throwing on a page a customer is reading.
 */
function capitalise(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

/**
 * One line on a plan card, or `null` when the tier does not have the thing.
 *
 * A CARD LISTS WHAT YOU GET. A bullet reading "No single sign-on" belongs in the
 * comparison table, where the columns are being weighed against each other, and
 * nowhere near the card somebody is deciding to buy. So a false flag and a zero
 * quota both return `null` and contribute no line — the same generated-array
 * shape the rest of this scaffold uses, applied to a list of bullets.
 *
 * THE GRAMMAR IS THE RECORD'S. A quota's label is written to follow a number
 * ("exports a month", giving "5,000 exports a month" and "Unlimited exports a
 * month"), and an option's label is a noun its value qualifies ("Support" with
 * "priority", giving "Priority support"). Both contracts are stated in
 * `definePlans`, and both are why the label is not simply title-cased here.
 *
 * A QUOTA OF EXACTLY ONE takes `labelOne` from the record when the record
 * supplies it, and falls back to the plural when it does not — which still
 * reads "1 projects", visibly, rather than guessing. Deriving the
 * singular by trimming an "s" is the suffix rule this codebase already banned
 * once, in `tenantLabelPlural`, after it put "Companys" on the admin sidebar —
 * it would give "1 export a month" correctly and "1 businesse" the moment
 * somebody writes a label that does not end in a bare s. The fix belongs in the
 * record, as a second label, and until it is there the honest options are a
 * label that reads either way ("seats included") or a quota that is not one.
 */
export function featureBullet(feature: PlanFeature): string | null {
  if (feature.kind === "quota") {
    if (feature.limit === null) return `Unlimited ${feature.label}`;
    if (feature.limit === 0) return null;
    // A quota of one takes the record's singular when it has one. Without it
    // the free tier reads "1 projects", on the first screen a customer sees.
    if (feature.limit === 1 && feature.labelOne) {
      return `1 ${feature.labelOne}`;
    }
    return `${count(feature.limit)} ${feature.label}`;
  }
  if (feature.kind === "flag") {
    return feature.included ? feature.label : null;
  }
  // Best first, and the tuple is non-empty by construction — which is why there
  // is no `??` here for a case `definePlans` refuses to build.
  return `${capitalise(feature.allowed[0])} ${feature.label.toLowerCase()}`;
}

/**
 * One cell of the comparison table: what to print, and whether it counts as
 * included.
 *
 * SEPARATE FROM `featureBullet` BECAUSE THE ROW HEADING ALREADY CARRIES THE
 * LABEL. Repeating it in the cell gives a table whose every row reads "exports
 * a month | 500 exports a month | 5,000 exports a month", which is three times
 * the words and a column that will not fit on a phone.
 *
 * `included: false` is what the page renders as a dash rather than as text. It
 * is never the absence of a value: a withheld feature still has a cell, because
 * a blank cell in a comparison table is indistinguishable from a table that
 * failed to load a row.
 */
export interface FeatureCell {
  readonly text: string;
  readonly included: boolean;
}

export function featureCell(feature: PlanFeature): FeatureCell {
  if (feature.kind === "quota") {
    if (feature.limit === null) return { text: "Unlimited", included: true };
    if (feature.limit === 0) return { text: "None", included: false };
    return { text: count(feature.limit), included: true };
  }
  if (feature.kind === "flag") {
    return feature.included
      ? { text: "Included", included: true }
      : { text: "Not included", included: false };
  }
  return { text: capitalise(feature.allowed[0]), included: true };
}

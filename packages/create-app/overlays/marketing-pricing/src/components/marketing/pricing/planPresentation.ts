import { planIntervals, PLAN_LOCALE, type PlanCatalog, type PlanFeature, type PlanInterval } from "__SCOPE__/billing";

/**
 * What the pricing page decides around the cards, with no JSX and no
 * database: which cadence and currency it shows, and what a comparison cell
 * says. The cards themselves are `planColumns` (@__SCOPE_NAME__/billing) drawn
 * by `PlanCard` — the one plan presentation the pricing page, the landing page
 * and /account/billing share (create-app 0.39).
 */

/** One locale for the whole page, pinned so two build agents punctuate prices alike. */
export const PAGE_LOCALE = PLAN_LOCALE;

/** "Yearly", for a toggle. `once` is a lifetime purchase, not a cadence. */
export function intervalName(interval: PlanInterval): string {
  if (interval === "month") return "Monthly";
  if (interval === "year") return "Yearly";
  return "One-time";
}

/**
 * The cadences the toggle offers, YEARLY FIRST: one charge a year rather than
 * twelve, and the better deal for the person paying. `once` is never on it.
 * Fewer than two and the page renders no toggle at all.
 */
export function toggleableIntervals(catalog: Pick<PlanCatalog, "intervals">): readonly ("year" | "month")[] {
  return planIntervals(catalog);
}

/**
 * The cadence this request asks for, or the page's default: yearly whenever a
 * plan is sold yearly. A query string is untrusted input on a public page:
 * `?interval=🙂` (or `once`) selects the default and reaches nothing that
 * formats it.
 */
export function resolveInterval(requested: string | undefined, catalog: Pick<PlanCatalog, "intervals">): "year" | "month" {
  const offered = toggleableIntervals(catalog);
  const match = offered.find((interval) => interval === requested);
  return match ?? offered[0] ?? "month";
}

/**
 * The currency this request asks for, or US dollars where the record prices
 * in them, else its first. Validated, because `Intl` throws on anything that
 * isn't three letters and an unchecked `?currency=` would 500 the pricing page.
 */
export function resolveCurrency(requested: string | undefined, catalog: Pick<PlanCatalog, "currencies">): string {
  const match = catalog.currencies.find((currency) => currency === requested);
  return match ?? (catalog.currencies.includes("usd") ? "usd" : catalog.currencies[0]) ?? "usd";
}

function count(value: number): string {
  return new Intl.NumberFormat(PAGE_LOCALE).format(value);
}

function capitalise(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

/**
 * One cell of the comparison table: what to print, and whether it counts as
 * included. Without the label, which the row heading already carries. A
 * withheld feature still has a cell (rendered as a dash): a blank cell reads as
 * a row that failed to load.
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

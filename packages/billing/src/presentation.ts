import { formatPrice } from "./money.js";
import type { PlanCatalog, PlanFeature, PlanFreeTier, PlanInterval, PlanTier } from "./plans.js";

/**
 * HOW A PLAN IS SHOWN (billing 0.6) — the one answer the pricing page, the
 * landing page's plans and the plan chooser on /account/billing all render,
 * so the three can never describe the same plan differently.
 *
 * Pure: the record in, columns out, no JSX and no database, so every rule is
 * tested here once:
 *
 *   - a column LISTS WHAT THE PLAN INCLUDES — never "No pro tools". A feature
 *     a plan doesn't have contributes no line.
 *   - the next tier up says "Everything in Basic, plus:" and lists only what
 *     it adds; the first column (Free, when the record declares a free tier)
 *     lists everything it has. A tier that has LESS of something than the one
 *     before it lists everything instead — "everything in X, plus" would be
 *     untrue.
 *   - prices in whole units when there's nothing after the point ("$10", not
 *     "$10.00"); yearly first when a plan has both, with "2 months free".
 *   - a tier `onSale: "coming"` is shown with its price and marked coming; an
 *     `onSale: false` or retired tier is not shown at all.
 *   - "Most popular" only where the record set `highlight`.
 */

/** One line in a column: the feature it is, and how it reads. */
export interface PlanBullet {
  readonly feature: string;
  readonly text: string;
}

export type PlanColumnPrice =
  /** The line's free tier: nothing to pay, no cadence. */
  | { readonly kind: "free"; readonly label: string }
  | {
      readonly kind: "amount";
      /** "$100", in whole units when exact. */
      readonly label: string;
      /** What was priced: the cadence asked for, or `once` for a lifetime price. */
      readonly interval: PlanInterval;
      /** "/yr", "/mo", or "" for a one-time price. */
      readonly per: string;
      /** "2 months free" against paying monthly, or null. */
      readonly note: string | null;
    }
  /** Sold, at no published price: "Talk to us". */
  | { readonly kind: "enquire" }
  /** Sold, but not on the cadence being looked at. */
  | { readonly kind: "other-interval"; readonly available: readonly PlanInterval[] };

export interface PlanColumn {
  /** The tier's key, or `free` for the line's free tier. */
  readonly key: string;
  readonly line: string;
  readonly name: string;
  readonly description: string | null;
  /** The line's free tier (what an account with no plan holds). */
  readonly free: boolean;
  /** true: sold today; "coming": shown with its price, not sold yet. */
  readonly onSale: true | "coming";
  /** "Most popular": only where the record set `highlight`. */
  readonly highlight: boolean;
  readonly price: PlanColumnPrice;
  /** "Everything in {buildsOn}, plus:" — the column this one adds to, or null. */
  readonly buildsOn: string | null;
  /** What the column lists: everything for the first, what it adds for the rest. */
  readonly includes: readonly PlanBullet[];
  /** Every feature it includes, for a "What's included" detail. */
  readonly everything: readonly PlanBullet[];
}

export interface PlanColumnsOptions {
  /** The product line. Defaults to the catalog's first (its only one, without `lines`). */
  readonly line?: string;
  readonly interval: "month" | "year";
  readonly currency: string;
  readonly locale?: string;
  /** Feature keys a column lists first, in this order (HEADLINE_FEATURES). */
  readonly headline?: readonly string[];
}

/** The page's one locale, pinned so two build machines can't punctuate a price differently. */
export const PLAN_LOCALE = "en-US";

/**
 * The cadences a plans page offers, YEARLY FIRST: a yearly price is one charge
 * a year instead of twelve (Stripe's fee is a smaller share of it), and it is
 * the better deal for the person. `once` is never a cadence.
 */
export function planIntervals(catalog: Pick<PlanCatalog, "intervals">): readonly ("year" | "month")[] {
  const offered: ("year" | "month")[] = [];
  if (catalog.intervals.includes("year")) offered.push("year");
  if (catalog.intervals.includes("month")) offered.push("month");
  return offered;
}

/** The cadence a plans page opens on: yearly whenever any plan is sold yearly. */
export function defaultPlanInterval(catalog: Pick<PlanCatalog, "intervals">): "year" | "month" {
  return planIntervals(catalog)[0] ?? "month";
}

/** "Yearly" / "Monthly", for a toggle. */
export function planIntervalName(interval: PlanInterval): string {
  if (interval === "year") return "Yearly";
  if (interval === "month") return "Monthly";
  return "One-time";
}

/**
 * Whole months free when paying yearly, against twelve monthly payments —
 * rounded DOWN so it is never overstated — or null when it saves nothing (or
 * either price is missing). $10/mo and $100/yr is 2 months free.
 */
export function monthsFree(tier: Pick<PlanTier, "prices">, currency: string): number | null {
  const monthly = tier.prices.month?.[currency];
  const yearly = tier.prices.year?.[currency];
  if (monthly === undefined || yearly === undefined || monthly <= 0n) return null;
  const saved = monthly * 12n - yearly;
  if (saved <= 0n) return null;
  const months = Number(saved / monthly);
  return months >= 1 ? months : null;
}

/**
 * One feature as a line a person reads, or null when the plan doesn't have it.
 * A quota's label follows its number ("25 saved items", "Unlimited saved
 * items", "1 saved item" with `labelOne`); a flag reads its label when
 * included and nothing when not; an option names its best value.
 */
export function planFeatureBullet(feature: PlanFeature, locale: string = PLAN_LOCALE): string | null {
  if (feature.kind === "quota") {
    if (feature.limit === null) return `Unlimited ${feature.label}`;
    if (feature.limit === 0) return null;
    if (feature.limit === 1 && feature.labelOne) return `1 ${feature.labelOne}`;
    return `${new Intl.NumberFormat(locale).format(feature.limit)} ${feature.label}`;
  }
  if (feature.kind === "flag") return feature.included ? feature.label : null;
  const best = feature.allowed[0];
  return `${best.slice(0, 1).toUpperCase()}${best.slice(1)} ${feature.label.toLowerCase()}`;
}

/** Is `a` more than `b` (a flag on that was off, a bigger quota, an option value `b` lacks)? */
function more(a: PlanFeature, b: PlanFeature | undefined): boolean {
  if (b === undefined) return planFeatureBullet(a) !== null;
  if (a.kind === "flag" && b.kind === "flag") return a.included && !b.included;
  if (a.kind === "quota" && b.kind === "quota") {
    if (a.limit === null) return b.limit !== null;
    return b.limit !== null && a.limit > b.limit;
  }
  if (a.kind === "option" && b.kind === "option") return a.allowed.some((value) => !b.allowed.includes(value));
  return false;
}

/** Is `a` less than `b`? Then "everything in b, plus" would be untrue. */
function less(a: PlanFeature, b: PlanFeature | undefined): boolean {
  if (b === undefined) return false;
  if (a.kind === "flag" && b.kind === "flag") return !a.included && b.included;
  if (a.kind === "quota" && b.kind === "quota") {
    if (b.limit === null) return a.limit !== null;
    return a.limit !== null && a.limit < b.limit;
  }
  if (a.kind === "option" && b.kind === "option") return b.allowed.some((value) => !a.allowed.includes(value));
  return false;
}

/** Bullets in the record's order, the headline features first. */
function bulletsOf(
  features: Readonly<Record<string, PlanFeature>>,
  keep: (feature: PlanFeature) => boolean,
  headline: readonly string[],
  locale: string,
): PlanBullet[] {
  const all = Object.values(features)
    .filter(keep)
    .map((feature) => ({ feature: feature.feature, text: planFeatureBullet(feature, locale) }))
    .filter((bullet): bullet is PlanBullet => bullet.text !== null);
  const first = headline.flatMap((key) => all.filter((bullet) => bullet.feature === key));
  return [...first, ...all.filter((bullet) => !headline.includes(bullet.feature))];
}

function priceOf(tier: PlanTier, interval: "month" | "year", currency: string, locale: string): PlanColumnPrice {
  const asked = tier.prices[interval]?.[currency];
  if (asked !== undefined) {
    const months = interval === "year" ? monthsFree(tier, currency) : null;
    return {
      kind: "amount",
      label: formatPrice(asked, currency, locale),
      interval,
      per: interval === "year" ? "/yr" : "/mo",
      note: months === null ? null : months === 1 ? "1 month free" : `${months} months free`,
    };
  }
  const lifetime = tier.prices.once?.[currency];
  if (lifetime !== undefined) return { kind: "amount", label: formatPrice(lifetime, currency, locale), interval: "once", per: "", note: null };
  const available = (["year", "month", "once"] as const).filter((candidate) => tier.prices[candidate]?.[currency] !== undefined);
  if (available.length === 0) return { kind: "enquire" };
  return { kind: "other-interval", available };
}

/**
 * The columns of one product line, in the record's order: its free tier first
 * (when it declares one), then every tier on sale or coming. Retired tiers
 * and `onSale: false` ones are left out.
 */
export function planColumns(catalog: PlanCatalog, options: PlanColumnsOptions): readonly PlanColumn[] {
  const locale = options.locale ?? PLAN_LOCALE;
  const headline = options.headline ?? [];
  const line = options.line === undefined ? catalog.lines[0] : catalog.line(options.line);
  if (line === undefined) return [];

  const shown: { readonly key: string; readonly name: string; readonly description: string | null; readonly features: Readonly<Record<string, PlanFeature>>; readonly tier: PlanTier | null; readonly free: PlanFreeTier | null }[] = [];
  if (line.free !== null) shown.push({ key: "free", name: line.free.name, description: line.free.description, features: line.free.features, tier: null, free: line.free });
  for (const tier of line.tiers) {
    if (!tier.isActive || tier.onSale === false) continue;
    shown.push({ key: tier.key, name: tier.name, description: tier.description, features: tier.features, tier, free: null });
  }

  return shown.map((column, index) => {
    const before = index > 0 ? shown[index - 1] : undefined;
    const everything = bulletsOf(column.features, () => true, headline, locale);
    // "Everything in Basic, plus:" only when nothing here is LESS than Basic.
    const buildsOn =
      before !== undefined && !Object.values(column.features).some((feature) => less(feature, before.features[feature.feature]))
        ? before.name
        : null;
    const includes = buildsOn === null || before === undefined
      ? everything
      : bulletsOf(column.features, (feature) => more(feature, before.features[feature.feature]), headline, locale);
    const price: PlanColumnPrice =
      column.tier === null ? { kind: "free", label: "Free" } : priceOf(column.tier, options.interval, options.currency, locale);
    return {
      key: column.key,
      line: line.key,
      name: column.name,
      description: column.description,
      free: column.tier === null,
      onSale: column.tier === null || column.tier.onSale === true ? true : "coming",
      highlight: column.tier?.highlight ?? false,
      price,
      buildsOn,
      includes,
      everything,
    };
  });
}

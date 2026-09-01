/**
 * WHAT A PLAN ENTITLES YOU TO, written down once.
 *
 * The `plans` table has always known what a plan COSTS — key, name, interval,
 * price, currency, cached Stripe ids. It has never known what a plan INCLUDES.
 * So the answer lived wherever it was needed: a limit hardcoded beside the check
 * that enforced it, a bullet list typed into a pricing page, a number pasted
 * into a Stripe seed. Three copies of "what does Pro include", none of them
 * named as such, and the first one to drift is always the pricing page —
 * because it is the copy a customer reads and the only one no test exercises. A
 * page that advertises a tier the code does not honour is a refund and a support
 * thread, and nothing in the repository says which of the three was right.
 *
 * This module is the one description. `grantsForPlan` reads it to produce
 * entitlement rows, a pricing page reads it to render a comparison table, and
 * the projection below turns it into the `plans` rows the Stripe sync caches ids
 * on.
 *
 * IT LIVES IN THE PACKAGE, NOT IN AN OVERLAY. The pricing page is copied source
 * — every client restyles it — and copied source cannot be imported by
 * @adminigloo/billing, where the enforcement lives. Put the record in the
 * overlay and the enforcement has no way to read it; put it here and both do.
 * The client's own catalog is a `definePlans` call in the generated project,
 * exactly as their permission catalog is a `definePermissions` call: this
 * package owns the vocabulary and the invariants, the project owns the values.
 *
 * PURE. No drizzle, no Stripe, no database. It is imported by a React component
 * rendering a price, so a value import of `./schema.js` here would drag
 * drizzle-orm/pg-core into the browser bundle — the thing index.ts exists to
 * prevent. `PlanInterval` is declared HERE and re-exported by schema.ts rather
 * than the other way round, which keeps schema's own rule intact: schema imports
 * from pure modules, never the reverse.
 */

/** `once` is a lifetime purchase: it never renews, so it never prorates. */
export type PlanInterval = "month" | "year" | "once";

/**
 * The order a pricing page's interval toggle is written in. Sorting the
 * intervals alphabetically would put "month, once, year" on the toggle, which
 * reads as a mistake to everybody who sees it.
 */
const INTERVAL_ORDER: readonly PlanInterval[] = ["month", "year", "once"];

/**
 * A tier key, and the shape it has to have.
 *
 * The same slug rule the product catalog uses, for a stricter reason: the key
 * becomes `entitlements.source_ref`, part of a `plans.key`, and a segment of a
 * URL on the pricing page. The colon is what separates the three parts of a row
 * key, so a tier key that could contain one would make that key ambiguous —
 * this pattern is what makes the separator safe.
 */
const TIER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The separator `planGrantDiff` builds a row identity from.
 *
 * DECLARED HERE, where feature names are first accepted, and imported by
 * grants.ts rather than spelled in both. Rejecting a feature that contains it is
 * the only place the collision can be prevented at all: by the time two rows
 * share an identity the diff has already reconciled one against the other, and
 * the result looks entirely reasonable. Written as an escape rather than as the
 * byte itself, because a literal NUL makes the file binary to grep, to diff and
 * to every review tool that reads it.
 *
 * Not re-exported from the package barrel. It is a detail two modules in here
 * share, not something an application should be handed.
 */
export const IDENTITY_SEPARATOR = "\u0000";

// ---------------------------------------------------------------------------
// The feature vocabulary
// ---------------------------------------------------------------------------

/**
 * A countable allowance: seats, projects, exports a month.
 *
 * The only kind that reaches `entitlements.limit_value` as itself, because that
 * column is an integer and a quota is the only feature that is genuinely a
 * number. `null` is unlimited, matching the column, and it is not zero — zero is
 * a feature explicitly withheld while the row stays for the audit trail.
 */
export interface PlanQuotaDecl {
  readonly kind: "quota";
  /**
   * Rendered AFTER the number: "500 exports a month". Written that way round
   * because the pricing page has no other way to know the grammar, and a label
   * of "Exports" produces "500 Exports" on one row and "Unlimited Exports" on
   * the next, one of which is wrong.
   */
  readonly label: string;
  /**
   * The same label for a quota of exactly one: "project", to `label`'s
   * "projects".
   *
   * Optional, because most quotas are never one and a required field nobody
   * needs is a field everybody copies wrongly. Supply it when a tier can hold
   * the value 1 — a free tier almost always can — or the page prints
   * "1 projects" and looks unfinished on the first screen a customer sees.
   *
   * NOT DERIVED BY STRIPPING AN "s". That works for "projects" and fails for
   * "entries", "gigabytes of storage" and any label ending in a word that is
   * not a bare plural, and a pricing page is the last place to guess at
   * English. Declared or absent.
   */
  readonly labelOne?: string;
}

/** On or off. Single sign-on, a custom domain, a white-label logo. */
export interface PlanFlagDecl {
  readonly kind: "flag";
  readonly label: string;
}

/**
 * A choice from a closed set, which is neither a flag nor a count.
 *
 * THE KIND CLIENT PRICING ACTUALLY NEEDS, and the one a record of booleans
 * cannot express. A monitoring product sells "check every 10 minutes on Pro,
 * every minute on Business"; a support tier is community, email or priority.
 * Neither is a number you can add up and neither is a switch you can flip.
 *
 * That is also why an option NEVER becomes an entitlement row. Entitlement rows
 * SUM — that is the whole design, so a plan's 5 seats and an add-on's 3 make 8 —
 * and adding "every 10 minutes" to "every minute" produces nothing at all. An
 * option is enforced by reading the tier, through `planAllows`, and a pricing
 * page renders `allowed[0]`.
 */
export interface PlanOptionDecl {
  readonly kind: "option";
  readonly label: string;
  /**
   * Every value any tier may offer, best first. A tier's own list is checked
   * against this one at construction AND by the type system, which is what makes
   * the option genuinely enum-restricted rather than a string field with a
   * comment above it.
   */
  readonly values: readonly [string, ...string[]];
}

export type PlanFeatureDecl = PlanQuotaDecl | PlanFlagDecl | PlanOptionDecl;

/** The catalog's vocabulary: every feature any tier may speak about. */
export type PlanFeatureDecls = Readonly<Record<string, PlanFeatureDecl>>;

/**
 * What a tier has to supply for one declared feature.
 *
 * THE REASON THE VOCABULARY IS DECLARED ONCE AND THE TIERS SUPPLY ONLY VALUES.
 * With each tier declaring its own features, a feature added to Pro and
 * forgotten on Starter is silent in both directions: the comparison table gets a
 * hole, and `checkEntitlement(resolved, "seats")` on Starter answers
 * `no-entitlement` — "your plan does not include seats at all" — when the truth
 * is that somebody missed a line. Here it is a compile error, because this
 * mapped type is over `keyof F` and TypeScript requires every key.
 */
export type PlanFeatureValueFor<D> = D extends { readonly kind: "quota" }
  ? number | null
  : D extends { readonly kind: "flag" }
    ? boolean
    : D extends {
          readonly kind: "option";
          readonly values: infer V extends readonly string[];
        }
      ? readonly [V[number], ...V[number][]]
      : never;

// ---------------------------------------------------------------------------
// The resolved shapes — what readers actually hold
// ---------------------------------------------------------------------------

export interface PlanQuota {
  readonly kind: "quota";
  /** The `entitlements.feature` name. */
  readonly feature: string;
  readonly label: string;
  /** The declaration's singular, carried through so a page can render "1 project". */
  readonly labelOne?: string;
  /** NULL is unlimited, matching `entitlements.limit_value`. Not zero. */
  readonly limit: number | null;
}

export interface PlanFlag {
  readonly kind: "flag";
  readonly feature: string;
  readonly label: string;
  readonly included: boolean;
}

export interface PlanOption {
  readonly kind: "option";
  readonly feature: string;
  readonly label: string;
  /**
   * Best first, so a pricing page renders `allowed[0]` as the headline. A
   * non-empty tuple rather than an array: under `noUncheckedIndexedAccess` a
   * `readonly string[]` makes `allowed[0]` possibly-undefined, and every pricing
   * page would then carry a `??` fallback for a case the catalog forbids.
   */
  readonly allowed: readonly [string, ...string[]];
}

/**
 * One feature as a tier holds it: the declaration and the value, merged.
 *
 * Merged rather than "look the kind up in the catalog", so a `PlanTier` is
 * self-describing. `grantsForPlan` takes a tier and nothing else, which is what
 * keeps it testable against a literal and what stops a caller pairing one
 * catalog's tier with another catalog's vocabulary.
 */
export type PlanFeature = PlanQuota | PlanFlag | PlanOption;

/** A vocabulary entry with no tier attached: the rows of a comparison table. */
export interface PlanFeatureHeading {
  readonly feature: string;
  readonly kind: PlanFeature["kind"];
  readonly label: string;
}

/**
 * Prices, by interval and then by currency, in minor units.
 *
 * A MAP FROM THE START, not one amount and one currency. Retrofitting a second
 * currency onto a single-price record means touching the record, the projection
 * into `plans`, the Stripe sync and every page that renders a price, all at
 * once, on a deadline set by whichever client has just asked to sell in euros.
 * The cost of a map now is one extra level of nesting; the cost of it later is a
 * migration of live pricing.
 *
 * `bigint`, because `plans.price_minor` is a bigint column and `formatMinor`
 * takes a bigint. No conversion anywhere: the minor unit for JPY is the yen, so
 * a "multiply by 100" step in any of these layers charges every Japanese
 * customer a hundredfold and renders as a plausible price.
 *
 * Currency is the inner KEY rather than a field, so one currency priced twice on
 * one interval is unrepresentable rather than a state to detect.
 */
export type PlanPrices = {
  readonly [I in PlanInterval]?: Readonly<Record<string, bigint>>;
};

/** What a `definePlans` call supplies for one tier. */
export interface PlanTierInput<F extends PlanFeatureDecls> {
  readonly key: string;
  /** What `plans.name` carries, and what the billing page prints. */
  readonly name: string;
  readonly description?: string;
  /**
   * Retired, not deleted. Defaults to true.
   *
   * A TIER IS NEVER REMOVED FROM THIS RECORD. Subscriptions reference the rows
   * it projects, `entitlements.source_ref` carries its key, and deleting the
   * declaration leaves every one of those subscribers holding rows no diff can
   * reconcile — `planGrantDiff` would be handed a plan it has never heard of and
   * would remove the lot. `isActive: false` keeps the tier readable by
   * everything that has to reason about existing subscribers, while taking it
   * off the pricing page.
   */
  readonly isActive?: boolean;
  /** "Most popular". At most one tier in a catalog may claim it. */
  readonly highlight?: boolean;
  /**
   * An empty object is a legitimate tier: "Enterprise — talk to us". It projects
   * no `plans` row, because there is nothing to charge and nothing for Stripe to
   * hold a price for.
   */
  readonly prices: PlanPrices;
  readonly features: { readonly [K in keyof F]: PlanFeatureValueFor<F[K]> };
}

/** One tier, resolved: every feature carries its kind, its label and its value. */
export interface PlanTier {
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  readonly highlight: boolean;
  /**
   * Derived from declaration order, never supplied.
   *
   * The array in the `definePlans` call IS the pricing page's order, and a
   * `sortOrder` field beside it is a second statement of the same fact that can
   * disagree with the first. Reordering the array reorders the page and rewrites
   * `plans.sort_order` on the next seed.
   */
  readonly sortOrder: number;
  readonly prices: PlanPrices;
  readonly features: Readonly<Record<string, PlanFeature>>;
}

/**
 * One `plans` row this catalog projects to: a tier, at one interval, in one
 * currency.
 *
 * THREE-PART KEY, because that is what a Stripe Price is. A Price fixes an
 * amount, a currency and a recurring interval, and none of the three can be
 * changed afterwards — so "Pro" cannot be one row. `plans.stripe_price_id` has
 * room for exactly one id, and monthly USD and yearly GBP are four different
 * Stripe objects.
 *
 * `entitlements.source_ref` DELIBERATELY does not carry this key; it carries the
 * TIER key. A customer moving from monthly to yearly, or paying in euros after
 * relocating, has not changed what they are entitled to — and if the ref carried
 * the cadence, that billing change would rewrite every entitlement row the
 * tenant holds for no reason at all.
 *
 * `tenant_id` is absent on purpose: this record is code, so every row it
 * projects is firm-wide and takes the column's `FIRM_WIDE` default. A
 * tenant-specific plan is a row somebody wrote by hand, and this projection
 * never touches it.
 */
export interface PlanRow {
  readonly key: string;
  readonly tierKey: string;
  readonly name: string;
  readonly description: string | null;
  readonly interval: PlanInterval;
  readonly priceMinor: bigint;
  readonly currency: string;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface PlanCatalog {
  /** The vocabulary in declaration order — the rows of a comparison table. */
  readonly features: readonly PlanFeatureHeading[];
  /** Every tier, retired ones included, in declaration order. */
  readonly tiers: readonly PlanTier[];
  /** Every currency the catalog prices in, sorted. Drives the currency picker. */
  readonly currencies: readonly string[];
  /** Every interval some tier is priced on, in `month, year, once` order. */
  readonly intervals: readonly PlanInterval[];
  /** The `plans` rows this catalog projects to, in pricing-page order. */
  readonly rows: readonly PlanRow[];
  /** A tier by its own key. `undefined` for a key no tier declares. */
  tier(key: string): PlanTier | undefined;
  /**
   * A tier from a `plans.key` — the inverse of the projection, and the step
   * between a `subscriptions` row and what the subscriber is entitled to.
   * `undefined` means the row is an orphan; see `reconcilePlans`.
   */
  tierForRow(rowKey: string): PlanTier | undefined;
}

// ---------------------------------------------------------------------------
// Errors. All three are thrown at CONSTRUCTION, which is module load, which is
// the deploy — never during a customer's checkout.
// ---------------------------------------------------------------------------

export class InvalidPlanKeyError extends Error {
  readonly name = "InvalidPlanKeyError";
  constructor(key: string, reason: string) {
    super(
      `"${key}" cannot be a plan key: ${reason} The key becomes ` +
        `entitlements.source_ref and part of plans.key, and the unique index ` +
        `indexes coalesce(source_ref, '') — so a key that is empty, duplicated ` +
        `or ambiguous does not fail loudly. It upserts two different plans' ` +
        `entitlements onto one row.`,
    );
  }
}

export class InvalidGrantLimitError extends Error {
  readonly name = "InvalidGrantLimitError";
  constructor(planKey: string, feature: string, limit: number) {
    super(
      `Plan "${planKey}" gives ${feature} a quota of ${limit}. A quota must be ` +
        `a whole number >= 0, or null for unlimited. A fraction would be ` +
        `written into an integer column and silently truncated by the driver, ` +
        `and a negative quota is a plan that takes capacity away — which is an ` +
        `override, deliberately written as a negative row by an admin, not ` +
        `something a purchase should do behind one.`,
    );
  }
}

export class InvalidPlanCatalogError extends Error {
  readonly name = "InvalidPlanCatalogError";
  constructor(reason: string) {
    super(
      `This plan catalog is not internally consistent: ${reason} It is checked ` +
        `at construction rather than at the point of use, so the failure lands ` +
        `on the deploy that introduced it instead of on the first customer to ` +
        `open the pricing page.`,
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * `pro` + `month` + `usd` -> `pro:month:usd`.
 *
 * Exported because the seed, an admin screen and anything reconciling against
 * Stripe all have to spell the same key, and a second implementation of this one
 * line is a second chance to write a row nothing can find.
 */
export function planRowKey(
  tierKey: string,
  interval: PlanInterval,
  currency: string,
): string {
  return `${tierKey}:${interval}:${currency}`;
}

/**
 * The amount a tier charges on one interval in one currency, or `undefined`.
 *
 * `undefined` is a real answer, not a gap to paper over: a tier priced monthly
 * and not yearly is a normal thing to sell, and so is a tier with no price at
 * all. A caller rendering a price has to say "not available" rather than
 * substitute a zero, which reads as free.
 */
export function priceFor(
  tier: PlanTier,
  interval: PlanInterval,
  currency: string,
): bigint | undefined {
  return tier.prices[interval]?.[currency];
}

/**
 * May a tenant on this tier choose `value` for `feature`?
 *
 * The enforcement half of `PlanOptionDecl`. False for a feature the tier does
 * not declare and for a feature that is not an option at all, because both mean
 * the same thing to the caller — this tier does not permit that — and a throw
 * would put an error boundary on a page over a typo in a string.
 */
export function planAllows(
  tier: PlanTier,
  feature: string,
  value: string,
): boolean {
  const declared = tier.features[feature];
  if (declared === undefined || declared.kind !== "option") return false;
  return declared.allowed.includes(value);
}

/**
 * Build a plan catalog, checking everything a wrong one would otherwise only
 * reveal in production.
 *
 * The same constructor pattern as `definePermissions` and `defineAuditedActions`:
 * a terse literal in, a resolved and validated object out, with the derived
 * indexes attached so no caller re-derives them differently. The input is
 * deliberately not the output shape — repeating a feature's kind and label on
 * every tier is five copies of one fact, and the fifth is the one that is wrong.
 */
export function definePlans<const F extends PlanFeatureDecls>(input: {
  readonly features: F;
  readonly tiers: readonly PlanTierInput<F>[];
}): PlanCatalog {
  const headings: PlanFeatureHeading[] = [];
  for (const [feature, decl] of Object.entries(input.features)) {
    if (feature.length === 0) {
      throw new InvalidPlanCatalogError(
        "a feature is declared under an empty name. It would become " +
          "`entitlements.feature = ''`, which every later lookup misses and no " +
          "admin screen can display — while it still sums in resolveEntitlements.",
      );
    }
    if (feature.includes(IDENTITY_SEPARATOR)) {
      throw new InvalidPlanCatalogError(
        `feature "${feature}" contains a NUL byte. planGrantDiff joins the ` +
          `source and the feature with NUL to identify a row, so two different ` +
          `features could collapse into one identity and silently reconcile ` +
          `against each other.`,
      );
    }
    if (decl.kind === "option" && decl.values.length === 0) {
      throw new InvalidPlanCatalogError(
        `option "${feature}" declares no values, so no tier can offer it and ` +
          `the pricing page has nothing to print.`,
      );
    }
    headings.push({ feature, kind: decl.kind, label: decl.label });
  }

  const tiers: PlanTier[] = [];
  const seenKeys = new Set<string>();
  let highlighted: string | undefined;

  for (const [index, declared] of input.tiers.entries()) {
    const key = declared.key;
    if (key.length === 0) throw new InvalidPlanKeyError(key, "it is empty.");
    if (!TIER_KEY_PATTERN.test(key)) {
      throw new InvalidPlanKeyError(
        key,
        "use lowercase letters, digits and single hyphens between them. The " +
          "colon in particular is reserved, because it separates the three " +
          "parts of a plans.key.",
      );
    }
    if (seenKeys.has(key)) {
      throw new InvalidPlanKeyError(key, "two tiers declare it.");
    }
    seenKeys.add(key);

    if (declared.highlight === true) {
      if (highlighted !== undefined) {
        throw new InvalidPlanCatalogError(
          `both "${highlighted}" and "${key}" are highlighted. Two "most ` +
            `popular" badges on one pricing page is not a recommendation, and ` +
            `which one a reader believes depends on where their eye lands.`,
        );
      }
      highlighted = key;
    }

    const features: Record<string, PlanFeature> = {};
    for (const heading of headings) {
      const decl = input.features[heading.feature];
      // Present for every heading — the loop is over the same object. The guard
      // is for `noUncheckedIndexedAccess`, not for a case that can occur.
      if (decl === undefined) continue;
      const value = (declared.features as Readonly<Record<string, unknown>>)[
        heading.feature
      ];
      features[heading.feature] = resolveFeature(key, heading.feature, decl, value);
    }

    tiers.push({
      key,
      name: declared.name,
      description: declared.description ?? null,
      isActive: declared.isActive ?? true,
      highlight: declared.highlight ?? false,
      // Spaced by ten, so a plan added to the database by hand can be slipped
      // between two of these without renumbering the catalog.
      sortOrder: index * 10,
      prices: declared.prices,
      features,
    });
  }

  const currencies = collectCurrencies(tiers);
  assertEveryPriceIsComplete(tiers, currencies);

  const intervals = INTERVAL_ORDER.filter((interval) =>
    tiers.some((tier) => tier.prices[interval] !== undefined),
  );

  const rows = projectRows(tiers);
  const byKey = new Map(tiers.map((tier) => [tier.key, tier]));
  // Built FROM the projection rather than by taking a row key apart. Parsing
  // would be a second implementation of `planRowKey`, and the two would disagree
  // the first time the key format moved.
  const byRowKey = new Map(rows.map((row) => [row.key, row.tierKey]));

  return {
    features: headings,
    tiers,
    currencies,
    intervals,
    rows,
    tier: (key) => byKey.get(key),
    tierForRow: (rowKey) => {
      const tierKey = byRowKey.get(rowKey);
      return tierKey === undefined ? undefined : byKey.get(tierKey);
    },
  };
}

function resolveFeature(
  tierKey: string,
  feature: string,
  decl: PlanFeatureDecl,
  value: unknown,
): PlanFeature {
  if (decl.kind === "quota") {
    if (value !== null && typeof value !== "number") {
      throw new InvalidPlanCatalogError(
        `"${tierKey}" gives the quota ${feature} a ${typeof value}. A quota is ` +
          `a whole number, or null for unlimited.`,
      );
    }
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new InvalidGrantLimitError(tierKey, feature, value);
    }
    return {
      kind: "quota",
      feature,
      label: decl.label,
      // Spread rather than `labelOne: decl.labelOne`, because
      // `exactOptionalPropertyTypes` distinguishes an absent property from one
      // present and undefined, and the resolved shape declares it absent.
      ...(decl.labelOne === undefined ? {} : { labelOne: decl.labelOne }),
      limit: value,
    };
  }

  if (decl.kind === "flag") {
    if (typeof value !== "boolean") {
      throw new InvalidPlanCatalogError(
        `"${tierKey}" gives the flag ${feature} a ${typeof value}. A flag is ` +
          `true or false — a tier that withholds it says so with false, which ` +
          `still writes a row with a limit of 0 and therefore still appears on ` +
          `the comparison table and in the audit trail.`,
      );
    }
    return { kind: "flag", feature, label: decl.label, included: value };
  }

  if (!Array.isArray(value)) {
    throw new InvalidPlanCatalogError(
      `"${tierKey}" gives the option ${feature} a ${typeof value}. An option ` +
        `takes the list of values this tier may choose, best first.`,
    );
  }
  const chosen = value as readonly string[];
  const first = chosen[0];
  if (first === undefined) {
    throw new InvalidPlanCatalogError(
      `"${tierKey}" offers no values at all for the option ${feature}. A tier ` +
        `that genuinely has the least of it still needs a value that says so — ` +
        `"community" rather than an empty list — or the pricing page prints a ` +
        `blank cell and planAllows denies everything with nothing to explain why.`,
    );
  }
  const seen = new Set<string>();
  for (const candidate of chosen) {
    if (!decl.values.includes(candidate)) {
      throw new InvalidPlanCatalogError(
        `"${tierKey}" offers "${candidate}" for ${feature}, which is not one ` +
          `of the declared values (${decl.values.join(", ")}). An option is ` +
          `enum-restricted precisely so a value nobody implemented cannot be ` +
          `sold on the pricing page.`,
      );
    }
    if (seen.has(candidate)) {
      throw new InvalidPlanCatalogError(
        `"${tierKey}" offers "${candidate}" twice for ${feature}.`,
      );
    }
    seen.add(candidate);
  }
  return {
    kind: "option",
    feature,
    label: decl.label,
    // The non-empty check above is what licenses this shape. The type cannot
    // carry it across the `Array.isArray` narrowing.
    allowed: [first, ...chosen.slice(1)],
  };
}

/** Every currency any tier prices in, checked for shape and sorted. */
function collectCurrencies(tiers: readonly PlanTier[]): readonly string[] {
  const found = new Set<string>();
  for (const tier of tiers) {
    for (const interval of INTERVAL_ORDER) {
      const byCurrency = tier.prices[interval];
      if (byCurrency === undefined) continue;
      for (const [currency, amount] of Object.entries(byCurrency)) {
        // The same rule the product catalog enforces, for the same reason:
        // `formatMinor` asks Intl for this currency's minor-unit exponent and
        // Intl throws RangeError on anything that is not three letters. Caught
        // here it is a deploy failure naming the tier; missed, it is an uncaught
        // exception on the pricing page.
        if (!/^[a-z]{3}$/.test(currency)) {
          throw new InvalidPlanCatalogError(
            `"${tier.key}" prices in "${currency}", which is not a lowercase ` +
              `three-letter currency code. Stripe stores the lowercase form and ` +
              `so does plans.currency, and Intl refuses to format anything else.`,
          );
        }
        if (amount < 0n) {
          throw new InvalidPlanCatalogError(
            `"${tier.key}" has a negative ${interval} price in ${currency}. ` +
              `Free is 0, not below it — Stripe rejects a negative unit_amount ` +
              `outright, so this would fail at checkout rather than at deploy.`,
          );
        }
        found.add(currency);
      }
    }
  }
  return [...found].sort();
}

/**
 * Every priced interval must be priced in EVERY currency the catalog uses.
 *
 * The failure this prevents is a blank price. A pricing page picks one currency
 * for the whole page — from a locale, from a geo lookup, from a picker — and
 * renders every tier under it. A tier priced monthly in USD and not in GBP puts
 * an empty card on the GBP page beside three that have prices, and nothing in
 * the code says which tier will be the empty one.
 *
 * The interval axis is deliberately NOT checked. A tier sold monthly and not
 * yearly is an ordinary pricing decision, and `once` — a lifetime purchase —
 * belongs to no toggle at all. `catalog.intervals` reports what is actually
 * offered, so a page builds its toggle from the record instead of guessing.
 */
function assertEveryPriceIsComplete(
  tiers: readonly PlanTier[],
  currencies: readonly string[],
): void {
  for (const tier of tiers) {
    for (const interval of INTERVAL_ORDER) {
      const byCurrency = tier.prices[interval];
      if (byCurrency === undefined) continue;
      for (const currency of currencies) {
        if (byCurrency[currency] === undefined) {
          throw new InvalidPlanCatalogError(
            `"${tier.key}" has a ${interval} price but none in ${currency}, ` +
              `which other tiers are priced in. A pricing page rendered in ` +
              `${currency} would show this tier with no price at all, beside ` +
              `tiers that have one. Price it, or drop the ${interval} cadence ` +
              `for this tier entirely.`,
          );
        }
      }
    }
  }
}

/** One row per priced cell, in the order the pricing page lists tiers. */
function projectRows(tiers: readonly PlanTier[]): readonly PlanRow[] {
  const rows: PlanRow[] = [];
  for (const tier of tiers) {
    for (const interval of INTERVAL_ORDER) {
      const byCurrency = tier.prices[interval];
      if (byCurrency === undefined) continue;
      // Sorted, so two runs of the seed write the same rows in the same order
      // and a diff of a write plan is signal rather than noise.
      for (const currency of Object.keys(byCurrency).sort()) {
        const priceMinor = byCurrency[currency];
        if (priceMinor === undefined) continue;
        rows.push({
          key: planRowKey(tier.key, interval, currency),
          tierKey: tier.key,
          name: tier.name,
          description: tier.description,
          interval,
          priceMinor,
          currency,
          isActive: tier.isActive,
          sortOrder: tier.sortOrder,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Reconciliation: what to do when the table and the record disagree
// ---------------------------------------------------------------------------

/** The part of a stored `plans` row this reads. A full row satisfies it. */
export interface ExistingPlanRow {
  readonly key: string;
  readonly isActive: boolean;
}

export interface OrphanedPlanRow {
  readonly key: string;
  readonly isActive: boolean;
  /** Written for whoever is reading a seed log or an admin screen. */
  readonly why: string;
}

export interface PlanReconciliation {
  /**
   * Every row the record projects, to be upserted on `key`. It includes rows
   * that already match: the upsert is idempotent, and re-stating them is what
   * makes a price somebody edited in the table snap back to the record.
   */
  readonly upsert: readonly PlanRow[];
  /** Rows in the table that no tier projects. */
  readonly orphaned: readonly OrphanedPlanRow[];
  /** At least one orphan is still purchasable. Somebody has to act. */
  readonly needsAttention: boolean;
}

/**
 * What has to happen for the `plans` table to match the record.
 *
 * THE RECORD IS THE SOURCE OF TRUTH AND THE TABLE IS A PROJECTION OF IT, plus a
 * cache of the two Stripe ids. The other direction was never really available:
 * `grantsForPlan` has always taken its declarations as an argument rather than
 * reading them off the plan row, precisely so that a limit cannot be edited in a
 * table and silently re-entitle every subscriber with no deploy and no review.
 * Making the table authoritative would reverse that, and it would also make the
 * pricing page a database read that returns nothing on a fresh clone — the same
 * failure `plans`' own comment condemns about reading prices back out of Stripe.
 *
 * THE TWO CANNOT BE MADE TO AGREE BY CONSTRUCTION, because they are written by
 * different events: the record changes on a deploy, the table changes when
 * somebody runs the seed, and there is always a window between them. So
 * disagreement is made LOUD instead — this function reports it, the seed prints
 * it, and nothing downstream has to guess.
 *
 * NOTHING IS EVER DELETED. `subscriptions.plan_id` is `on delete restrict`, so
 * deleting an orphan would either fail or take a paying customer's subscription
 * with it. An orphan is retired by hand, or — better — the tier is put back into
 * the record with `isActive: false`, which is what `isActive` is for.
 */
export function reconcilePlans(
  catalog: PlanCatalog,
  existing: readonly ExistingPlanRow[],
): PlanReconciliation {
  const projected = new Set(catalog.rows.map((row) => row.key));
  const orphaned: OrphanedPlanRow[] = [];

  for (const row of existing) {
    if (projected.has(row.key)) continue;
    orphaned.push({
      key: row.key,
      isActive: row.isActive,
      why: row.isActive
        ? `No tier projects "${row.key}", and it is still active — so it is on ` +
          `sale, checkout can resolve it, and grantsForPlan has no tier to ` +
          `entitle the buyer from. Either put the tier back in the record with ` +
          `isActive: false, or set is_active = false on this row by hand.`
        : `No tier projects "${row.key}". It is already retired, so nothing new ` +
          `can be sold on it; it is kept because subscriptions still name it ` +
          `and plan_id is on delete restrict.`,
    });
  }

  return {
    upsert: catalog.rows,
    orphaned,
    needsAttention: orphaned.some((row) => row.isActive),
  };
}

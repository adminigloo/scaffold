import { fmt, snap, unitTypeLabel, type QuantityKind, type QuantityRange, type Quantities } from "./recipes.js";
import { midpointOf } from "./pricing.js";
import type { CostLine } from "./wire.js";

/**
 * The price build (section 4 of the 0.3 contract): a product's price from the
 * owner's OWN costs — the supplies they buy (cost per supplier unit × how much
 * per foot of ramp, per item or per job), labor hours × a rate plus setup
 * hours, waste on what is bought by length or area, then markup on cost OR a
 * target margin, a minimum, and the options the customer picked. Pure.
 *
 * One engine prices the low, the point and the high quantity sets a recipe
 * derived (rule C: the range IS the measurement's uncertainty, priced), and
 * explains itself to staff with a cost breakdown at the point. The customer
 * only ever sees prices: a `CostLine`, a cost and a margin never leave the
 * server on a public route or the quote route.
 */

export type SupplyUnitType = "per_linear_ft" | "per_sqft" | "per_unit" | "flat";

export interface BuildSupply {
  assignmentId: string;
  supplyId: string;
  name: string;
  unitType: SupplyUnitType;
  /** Cents per supplier unit. */
  unitCost: number;
  /** Thousandths, per `per`. */
  quantityMilli: number;
  /** A quantity key, "item", "job", or null (0.2: scale by unitType). */
  per: string | null;
  sortOrder: number;
  /**
   * Bought whole: the quantity for one item (or the job) is rounded UP to a
   * whole supplier unit before it is priced — 21 ft of ramp at a post every
   * 4 ft is 6 posts, not 5.25 (review EST-R09). Rounding up IS the spare, so
   * no waste is added on top.
   */
  roundUp?: boolean;
}

export interface BuildInput {
  quantities: QuantityRange;
  primaryKey: string;
  quantityKinds: Record<string, QuantityKind>;
  supplies: BuildSupply[];
  /** 0.2's price knobs, priced as costs once per item. */
  lump: { basePrice: number; pricePerSqFt: number | null; pricePerLinearFt: number | null; laborCost: number };
  labor: { hoursPerUnitMilli: number; setupHoursMilli: number; rateCents: number };
  wasteBp: number;
  pricing: { basis: "markup"; markupBp: number } | { basis: "margin"; marginBp: number };
  /** Cents, a PRICE per item (added after markup). */
  optionModifiers: number[];
  /** Items on the line (a count recipe: the count). */
  quantity: number;
  minimumCharge: number;
  range: { mode: "measured"; contingencyBp: number } | { mode: "percent"; lowBp: number; highBp: number };
  /** CONTRACT: additions, for the breakdown's words only ("Labor 7.35 h × $65.00", "Surface: Heavy-duty grit"). */
  currency?: string;
  locale?: string;
  optionLabels?: string[];
}

export interface PriceBuild {
  /** Line prices, cents, at the low, point and high quantity sets. */
  low: number;
  point: number;
  high: number;
  /** What the customer is shown. */
  estimateLow: number;
  estimateHigh: number;
  single: boolean;
  /** What a line is saved at: the point (percent mode: the band's midpoint, 0.2's rule). */
  lineTotal: number;
  /** Cost at the point, cents. */
  cost: number;
  /** round((point − cost) / point × 10000); 0 when the point is 0. */
  marginBp: number;
  /** The minimum charge set the point price. */
  minimumApplied: boolean;
  /** Pricing's own reasons for a range ("Contingency ±5%"). */
  reasons: string[];
  /** At the point, in display order. Rounded per line; the total comes from the exact values. */
  breakdown: CostLine[];
}

const BP = 10_000;

/**
 * Whole cents: snap float noise to six decimals, then round half up.
 * `494547.5 × 1.4` is `692366.4999…` in floating point; snapped it is
 * `692366.5` and rounds to 692367, the price a person would work out. Every
 * price a person reads is a `cents()`; intermediate sums are not rounded.
 */
export function cents(value: number): number {
  return Math.round(Math.round(value * 1e6) / 1e6);
}

/** Basis points as a percentage: 725 → "7.25%", 500 → "5%". */
export function pct(bp: number): string {
  return `${fmt(bp / 100)}%`;
}

function money(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount / 100);
  } catch {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount / 100);
  }
}

interface SupplyUse {
  supply: BuildSupply;
  scope: "item" | "job";
  /** Supplier units for ONE item (item scope) or the job. */
  units: number;
  /** Cents for one item (item scope) or the job. */
  amount: number;
  wasteable: boolean;
}

function useOf(supply: BuildSupply, q: Quantities, kinds: Record<string, QuantityKind>): SupplyUse {
  const each = supply.quantityMilli / 1000;
  let scope: "item" | "job" = "item";
  let factor = 1;
  let wasteable = false;
  if (supply.per === "job") {
    scope = "job";
  } else if (supply.per === "item") {
    factor = 1;
  } else if (supply.per === null) {
    // 0.2: scale by the supply's own unit, and waste on all of it.
    wasteable = true;
    factor =
      supply.unitType === "per_sqft"
        ? (q["sqFt"] ?? 0)
        : supply.unitType === "per_linear_ft"
          ? (q["linearFt"] ?? 0)
          : supply.unitType === "per_unit"
            ? (q["units"] ?? 1)
            : 1;
  } else {
    factor = q[supply.per] ?? 0;
    const kind = kinds[supply.per];
    wasteable = kind === "length" || kind === "area";
  }
  const raw = each * factor;
  const units = supply.roundUp ? Math.ceil(snap(raw)) : raw;
  if (supply.roundUp) wasteable = false;
  return { supply, scope, units, amount: supply.unitCost * units, wasteable };
}

interface SetPrice {
  uses: SupplyUse[];
  lumps: { base: number; perSqFt: number; perLinearFt: number; labor: number };
  waste: number;
  laborHours: number;
  labor: number;
  setupHours: number;
  setup: number;
  cost: number;
  priceBeforeOptions: number;
  options: number;
  /** The line price, cents. */
  price: number;
  minimumApplied: boolean;
}

function priceSet(input: BuildInput, q: Quantities): SetPrice {
  const quantity = Math.max(1, Math.trunc(input.quantity));
  const uses = input.supplies.map((supply) => useOf(supply, q, input.quantityKinds));
  const itemSupplies = uses.filter((u) => u.scope === "item").reduce((sum, u) => sum + u.amount, 0);
  const jobSupplies = uses.filter((u) => u.scope === "job").reduce((sum, u) => sum + u.amount, 0);
  const lumps = {
    base: input.lump.basePrice,
    perSqFt: input.lump.pricePerSqFt ? input.lump.pricePerSqFt * (q["sqFt"] ?? 0) : 0,
    perLinearFt: input.lump.pricePerLinearFt ? input.lump.pricePerLinearFt * (q["linearFt"] ?? 0) : 0,
    labor: input.lump.laborCost,
  };
  const lumpCosts = lumps.base + lumps.perSqFt + lumps.perLinearFt;
  // Waste is the cut-off and spare on what is bought by the foot or the
  // square foot — not on a permit, a delivery or a landing platform. A 0.2
  // attachment (no `per`) and the lump costs keep 0.2's "waste on all
  // materials".
  const wasteBase = (uses.filter((u) => u.scope === "item" && u.wasteable).reduce((sum, u) => sum + u.amount, 0) + lumpCosts) * quantity;
  const waste = wasteBase * (input.wasteBp / BP);
  const rate = input.labor.rateCents;
  const laborHours = (input.labor.hoursPerUnitMilli / 1000) * (q[input.primaryKey] ?? 0) * quantity;
  const labor = laborHours * rate + lumps.labor * quantity;
  const setupHours = input.labor.setupHoursMilli / 1000;
  const setup = setupHours * rate;
  const cost = (itemSupplies + lumpCosts) * quantity + jobSupplies + waste + labor + setup;
  const priceBeforeOptions =
    input.pricing.basis === "margin"
      ? cost / (1 - Math.min(input.pricing.marginBp, 9500) / BP)
      : cost * (1 + input.pricing.markupBp / BP);
  // An option value is a price the customer was shown ("+$120"), so it goes
  // on AFTER markup: at 25% markup a "+$60" option used to add $75.
  const options = input.optionModifiers.reduce((sum, m) => sum + m, 0) * quantity;
  const beforeMinimum = priceBeforeOptions + options;
  const minimumApplied = beforeMinimum < input.minimumCharge;
  return {
    uses,
    lumps,
    waste,
    laborHours,
    labor,
    setupHours,
    setup,
    cost,
    priceBeforeOptions,
    options,
    price: cents(Math.max(beforeMinimum, input.minimumCharge)),
    minimumApplied,
  };
}

function round3(value: number): number {
  return Math.round(snap(value) * 1000) / 1000;
}

function breakdownOf(input: BuildInput, set: SetPrice): CostLine[] {
  const quantity = Math.max(1, Math.trunc(input.quantity));
  const currency = input.currency ?? "USD";
  const locale = input.locale ?? "en-US";
  const lines: CostLine[] = [];
  const order = (a: SupplyUse, b: SupplyUse) => a.supply.sortOrder - b.supply.sortOrder;
  for (const use of set.uses.filter((u) => u.scope === "item").sort(order)) {
    lines.push({
      kind: "supply",
      label: use.supply.name,
      quantity: round3(use.units * quantity),
      unit: unitTypeLabel(use.supply.unitType),
      unitCost: use.supply.unitCost,
      amount: cents(use.amount * quantity),
    });
  }
  for (const use of set.uses.filter((u) => u.scope === "job").sort(order)) {
    lines.push({
      kind: "supply",
      label: use.supply.name,
      quantity: round3(use.units),
      unit: unitTypeLabel(use.supply.unitType),
      unitCost: use.supply.unitCost,
      amount: cents(use.amount),
    });
  }
  const q = input.quantities.point;
  if (set.lumps.base !== 0) {
    lines.push({ kind: "lump", label: "Base price", quantity, unit: "each", unitCost: input.lump.basePrice, amount: cents(set.lumps.base * quantity) });
  }
  if (set.lumps.perSqFt !== 0) {
    lines.push({
      kind: "lump",
      label: "Rate per sq ft",
      quantity: round3((q["sqFt"] ?? 0) * quantity),
      unit: "sq ft",
      unitCost: input.lump.pricePerSqFt,
      amount: cents(set.lumps.perSqFt * quantity),
    });
  }
  if (set.lumps.perLinearFt !== 0) {
    lines.push({
      kind: "lump",
      label: "Rate per ft",
      quantity: round3((q["linearFt"] ?? 0) * quantity),
      unit: "ft",
      unitCost: input.lump.pricePerLinearFt,
      amount: cents(set.lumps.perLinearFt * quantity),
    });
  }
  if (set.lumps.labor !== 0) {
    lines.push({ kind: "lump", label: "Labor (set amount)", quantity, unit: "each", unitCost: input.lump.laborCost, amount: cents(set.lumps.labor * quantity) });
  }
  if (input.wasteBp > 0) {
    lines.push({ kind: "waste", label: `Waste ${pct(input.wasteBp)}`, quantity: null, unit: null, unitCost: null, amount: cents(set.waste) });
  }
  const rate = input.labor.rateCents;
  if (set.laborHours > 0) {
    lines.push({
      kind: "labor",
      label: `Labor ${fmt(set.laborHours)} h × ${money(rate, currency, locale)}`,
      quantity: round3(set.laborHours),
      unit: "h",
      unitCost: rate,
      amount: cents(set.laborHours * rate),
    });
  }
  if (set.setupHours > 0) {
    lines.push({
      kind: "setup",
      label: `Setup ${fmt(set.setupHours)} h × ${money(rate, currency, locale)}`,
      quantity: round3(set.setupHours),
      unit: "h",
      unitCost: rate,
      amount: cents(set.setup),
    });
  }
  const added = set.priceBeforeOptions - set.cost;
  if (input.pricing.basis === "markup" && input.pricing.markupBp > 0) {
    lines.push({ kind: "markup", label: `Markup ${pct(input.pricing.markupBp)}`, quantity: null, unit: null, unitCost: null, amount: cents(added) });
  } else if (input.pricing.basis === "margin" && input.pricing.marginBp > 0) {
    lines.push({ kind: "margin", label: `Margin ${pct(input.pricing.marginBp)}`, quantity: null, unit: null, unitCost: null, amount: cents(added) });
  }
  input.optionModifiers.forEach((modifier, index) => {
    if (modifier === 0) return;
    lines.push({
      kind: "option",
      label: input.optionLabels?.[index] ?? "Option",
      quantity,
      unit: "each",
      unitCost: modifier,
      amount: cents(modifier * quantity),
    });
  });
  if (set.minimumApplied) {
    lines.push({
      kind: "minimum",
      label: `Minimum charge ${money(input.minimumCharge, currency, locale)}`,
      quantity: null,
      unit: null,
      unitCost: null,
      amount: cents(input.minimumCharge - (set.priceBeforeOptions + set.options)),
    });
  }
  return lines;
}

/**
 * Price a line at its three quantity sets (4.1), the range the customer is
 * shown (4.2), and the staff breakdown at the point (4.4).
 *
 *   measured: estimateLow = max(minimum, low × (1 − c)), estimateHigh =
 *     max(estimateLow, high × (1 + c)), c the contingency. The line is saved
 *     at the POINT: contingency widens what is shown; it is not a price.
 *   percent (0.2's band, opt-in): low × lowBp and high × highBp, the low end
 *     floored at the minimum (ES-18); the line is saved at their midpoint,
 *     exactly 0.2's rule for these products.
 */
export function buildPrice(input: BuildInput): PriceBuild {
  const low = priceSet(input, input.quantities.low);
  const point = priceSet(input, input.quantities.point);
  const high = priceSet(input, input.quantities.high);

  let estimateLow: number;
  let estimateHigh: number;
  let lineTotal: number;
  const reasons: string[] = [];
  if (input.range.mode === "measured") {
    const c = input.range.contingencyBp / BP;
    estimateLow = Math.max(input.minimumCharge, cents(low.price * (1 - c)));
    estimateHigh = Math.max(estimateLow, cents(high.price * (1 + c)));
    lineTotal = point.price;
    if (input.range.contingencyBp > 0) reasons.push(`Contingency ±${pct(input.range.contingencyBp)}`);
  } else {
    estimateLow = Math.max(input.minimumCharge, cents(low.price * (input.range.lowBp / BP)));
    estimateHigh = Math.max(estimateLow, cents(high.price * (input.range.highBp / BP)));
    lineTotal = midpointOf(estimateLow, estimateHigh);
    reasons.push(`Price band ${pct(input.range.lowBp)}–${pct(input.range.highBp)} of the price (your setting)`);
  }

  const cost = cents(point.cost);
  const marginBp = point.price === 0 ? 0 : Math.round(((point.price - cost) / point.price) * BP);
  return {
    low: low.price,
    point: point.price,
    high: high.price,
    estimateLow,
    estimateHigh,
    single: estimateLow === estimateHigh,
    lineTotal,
    cost,
    marginBp,
    minimumApplied: point.minimumApplied,
    reasons,
    breakdown: breakdownOf(input, point),
  };
}

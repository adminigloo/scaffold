/**
 * The estimator's pricing engine — pure functions, no database, no I/O.
 *
 * Ported from the SG Glass & Metal estimator (a proven, unit-tested engine that
 * quotes real jobs) and generalized so it serves any trade, not just glass:
 *
 *   - Measurement is a DIRECT input, not always derived from a width×height
 *     rectangle. A glass panel gives width/height in inches and we derive area
 *     and perimeter; a wheelchair ramp gives linear feet of run and railing
 *     straight up. `resolveMeasurement` accepts either.
 *   - The three knobs the original never applied are here: a MINIMUM charge, a
 *     material WASTE %, and a MARKUP-on-cost. All optional; set them to zero
 *     and the math is identical to the original (the ported tests prove it).
 *
 * Money is integer MINOR UNITS (cents) in and out — never a float in storage,
 * matching the house rule. Ratios are integer basis points (bp): 10_000 bp =
 * 1.0 = 100%. Quantities can be fractional (2.33 sq ft), so the engine rounds
 * to whole cents only at the boundaries a person reads.
 */

export type ComponentUnitType = "per_sqft" | "per_linear_ft" | "per_unit" | "flat";

/** 10_000 basis points = 1.0. */
const BP = 10_000;

/**
 * The tax rate a total falls back to when none is given: 825 bp = 8.25%, the
 * SG Glass (Utah) rate the engine was ported with. It is a DEFAULT, not a
 * policy — a public submit takes its rate from the tenant's configuration
 * (`createPublicEstimate`'s `taxRateBp`), never from the request body.
 */
export const DEFAULT_TAX_RATE_BP = 825;

/**
 * What a job is measured in — ONE of the product (the line's `quantity` says
 * how many). Give width/height in inches for a rectangle and area + perimeter
 * are derived; or give sqFt / linearFt directly for a trade that is not a
 * rectangle (a ramp's run in linear feet). Direct values win over derived ones.
 *
 * `units` is the count of sub-units INSIDE one of the product — the hinges on
 * one door, the posts in one run of fence — and is what a `per_unit` component
 * scales by. It defaults to 1. It is not the line quantity: a unit-mode "how
 * many" is `quantity`, and sending the same count as `units` too would bill a
 * per-unit material quantity² times.
 */
export interface Measurement {
  widthIn?: number | null;
  heightIn?: number | null;
  sqFt?: number | null;
  linearFt?: number | null;
  units?: number | null;
}

export interface ResolvedMeasurement {
  sqFt: number;
  linearFt: number;
  units: number;
}

/**
 * Resolve a measurement to the three quantities the engine prices against.
 * Direct sqFt/linearFt are used as given; otherwise a width×height in inches
 * derives area (w·h) and perimeter (2·(w+h)), the glass-panel default. `units`
 * is independent of both (default 1) — it used to count as a "direct" value,
 * so `{ widthIn, heightIn, units }` silently priced a panel at 0 sq ft.
 */
export function resolveMeasurement(m: Measurement): ResolvedMeasurement {
  const units = m.units ?? 1;
  const hasDirect = m.sqFt != null || m.linearFt != null;
  if (!hasDirect && m.widthIn != null && m.heightIn != null) {
    const widthFt = m.widthIn / 12;
    const heightFt = m.heightIn / 12;
    return {
      sqFt: widthFt * heightFt,
      linearFt: 2 * (widthFt + heightFt),
      units,
    };
  }
  return {
    sqFt: m.sqFt ?? 0,
    linearFt: m.linearFt ?? 0,
    units,
  };
}

/**
 * Does this measurement give the product's mode (`estimatorProducts
 * .measurementMode`: "area" | "linear" | "unit") something real to price?
 * Checked on the RESOLVED quantities, so an area product accepts either a
 * width×height (both > 0) or a direct sqFt > 0, and a linear product a direct
 * linearFt > 0 (or a perimeter from width×height). A unit product needs only
 * `units` > 0, which it has by default.
 *
 * Without this a zero or missing measurement priced an area product at its
 * base price alone — a "$150" quote for a shower door of no size, saved as the
 * customer's estimate. An unknown mode (a row written outside the schema) is
 * never priceable.
 */
export function measurementFitsMode(mode: string, m: Measurement): boolean {
  const r = resolveMeasurement(m);
  switch (mode) {
    case "area":
      return r.sqFt > 0;
    case "linear":
      return r.linearFt > 0;
    case "unit":
      return r.units > 0;
    default:
      return false;
  }
}

export interface ComponentInput {
  /** Cost of one unit of this material, in cents. */
  unitCost: number;
  unitType: ComponentUnitType;
  /** How many of the unit this product uses, in thousandths (1000 = 1.0). */
  quantityMilli: number;
  isActive: boolean;
}

export interface EstimatePriceInput {
  /** Flat starting price for the product, in cents. */
  basePrice: number;
  /** Added per square foot, in cents. */
  pricePerSqFt?: number | null;
  /** Added per linear foot, in cents. */
  pricePerLinearFt?: number | null;
  /** Labor, in cents (added to cost, not marked up as material). */
  laborCost?: number | null;
  measurement: Measurement;
  /** How many of this product. Multiplies the whole per-unit subtotal, once. */
  quantity: number;
  /** Flat dollar (cent) modifiers from selected options. */
  optionModifiers?: number[];
  /** Materials attached to this product (a bill of materials). */
  components?: ComponentInput[];
  /** Material waste/overage, in bp of the material subtotal (1000 = +10%). */
  wasteBp?: number | null;
  /** Markup on total cost, in bp (3500 = +35%). */
  markupBp?: number | null;
  /** Floor for the per-line subtotal, in cents. Never quote below this. */
  minimumCharge?: number | null;
  /** Low end of the shown range, in bp of subtotal. Default 9000 (0.90). */
  estimateLowBp?: number | null;
  /** High end of the shown range, in bp of subtotal. Default 11500 (1.15). */
  estimateHighBp?: number | null;
}

export interface EstimatePriceResult {
  sqFt: number;
  linearFt: number;
  units: number;
  /** The computed per-line subtotal in cents (after waste/markup/minimum). */
  subtotal: number;
  /** Low and high ends of the quoted range, in cents. */
  estimateLow: number;
  estimateHigh: number;
}

/** Round a fractional cent value to a whole cent. */
function cents(value: number): number {
  return Math.round(value);
}

/**
 * The full estimate calculation, from catalog inputs to a low–high range.
 *
 * Material subtotal = base + per-sqft·area + per-linear-ft·perimeter + Σ
 * components (each scaled by its unit type and quantity multiplier). Waste is
 * added to materials; labor and option modifiers are added as cost; markup is
 * applied to the whole cost; the result is multiplied by quantity, floored at
 * the minimum, and finally banded into a low–high range.
 *
 * Everything before the quantity multiply describes ONE of the product, so a
 * `per_unit` component scales by `measurement.units` (default 1), not by
 * `quantity`. The original scaled it by quantity and then multiplied the whole
 * subtotal by quantity again — qty 3 billed nine of a per-unit material.
 *
 * With wasteBp/markupBp/minimumCharge all zero (and no per-unit component) the
 * result equals the original SG Glass engine:
 * subtotal = (base + options + labor + components) × qty.
 */
export function calculateEstimatePrice(input: EstimatePriceInput): EstimatePriceResult {
  const dims = resolveMeasurement(input.measurement);

  let materialSubtotal = input.basePrice;
  if (input.pricePerSqFt) materialSubtotal += input.pricePerSqFt * dims.sqFt;
  if (input.pricePerLinearFt) materialSubtotal += input.pricePerLinearFt * dims.linearFt;

  if (input.components) {
    for (const comp of input.components) {
      if (!comp.isActive) continue;
      const multiplier = comp.quantityMilli / 1000;
      switch (comp.unitType) {
        case "per_sqft":
          materialSubtotal += comp.unitCost * dims.sqFt * multiplier;
          break;
        case "per_linear_ft":
          materialSubtotal += comp.unitCost * dims.linearFt * multiplier;
          break;
        case "per_unit":
          materialSubtotal += comp.unitCost * dims.units * multiplier;
          break;
        case "flat":
          materialSubtotal += comp.unitCost * multiplier;
          break;
      }
    }
  }

  const wasteBp = input.wasteBp ?? 0;
  const waste = materialSubtotal * (wasteBp / BP);

  let optionTotal = 0;
  if (input.optionModifiers) {
    for (const mod of input.optionModifiers) optionTotal += mod;
  }

  const laborCost = input.laborCost ?? 0;
  const cost = materialSubtotal + waste + laborCost + optionTotal;

  const markupBp = input.markupBp ?? 0;
  const markup = cost * (markupBp / BP);

  const perUnitSubtotal = cost + markup;
  let lineSubtotal = perUnitSubtotal * input.quantity;

  const minimum = input.minimumCharge ?? 0;
  if (lineSubtotal < minimum) lineSubtotal = minimum;

  const lowBp = input.estimateLowBp ?? 9000;
  const highBp = input.estimateHighBp ?? 11500;

  return {
    sqFt: Math.round(dims.sqFt * 100) / 100,
    linearFt: Math.round(dims.linearFt * 100) / 100,
    units: dims.units,
    subtotal: cents(lineSubtotal),
    estimateLow: cents(lineSubtotal * (lowBp / BP)),
    estimateHigh: cents(lineSubtotal * (highBp / BP)),
  };
}

/**
 * The saved value of a quoted range: its rounded midpoint. Price the line at
 * its REAL quantity and the midpoint IS the line total — quantity is already
 * inside the range, and the engine is not linear in it (a minimum charge, and
 * per-unit materials), so "midpoint at qty 1, times qty" is a different number
 * from the range the customer was shown.
 */
export function midpointOf(estimateLow: number, estimateHigh: number): number {
  return Math.round((estimateLow + estimateHigh) / 2);
}

/** A staff-entered line: (unitPrice + laborPrice) × quantity, in cents. */
export function calculateItemTotal(
  unitPrice: number,
  laborPrice: number,
  quantity: number,
): number {
  return (unitPrice + laborPrice) * quantity;
}

export interface TotalsInput {
  /** Each line's total, in cents. */
  itemTotals: number[];
  /** Tax, in basis points (825 = 8.25%). */
  taxRateBp?: number | null;
  /** Discount, in cents, applied before tax. */
  discount?: number | null;
  /** Amount already paid, in cents. */
  amountPaid?: number | null;
}

export interface TotalsResult {
  subtotal: number;
  taxableAmount: number;
  taxAmount: number;
  total: number;
  balanceDue: number;
}

/**
 * Estimate / invoice totals, in cents.
 * subtotal = Σ items; taxable = subtotal − discount; tax = taxable × rate;
 * total = taxable + tax; balance = total − paid.
 *
 * A discount larger than the subtotal (or a negative one) is REFUSED with a
 * RangeError rather than clamped: it made a negative taxable amount, so the
 * "estimate" came out as negative tax and a total the business owes the
 * customer. Clamping would hide what is always a data-entry mistake; callers
 * that take a discount from a person validate it first (`createEstimate`
 * answers `discount_exceeds_subtotal`) and this is the backstop.
 */
export function calculateTotals(input: TotalsInput): TotalsResult {
  let subtotal = 0;
  for (const t of input.itemTotals) subtotal += t;

  const taxRateBp = input.taxRateBp ?? DEFAULT_TAX_RATE_BP;
  const discount = input.discount ?? 0;
  if (discount < 0 || discount > subtotal) {
    throw new RangeError(`discount ${discount} is outside 0..${subtotal} (the subtotal)`);
  }
  const taxableAmount = subtotal - discount;
  const taxAmount = cents(taxableAmount * (taxRateBp / BP));
  const total = taxableAmount + taxAmount;
  const amountPaid = input.amountPaid ?? 0;
  const balanceDue = total - amountPaid;

  return { subtotal, taxableAmount, taxAmount, total, balanceDue };
}

/** Format cents as a currency string, e.g. 90400 → "$904.00". */
export function formatCents(value: number, currency = "USD", locale = "en-US"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value / 100);
}

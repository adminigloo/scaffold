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
 * What a job is measured in. Give width/height in inches for a rectangle and
 * area + perimeter are derived; or give sqFt / linearFt / units directly for a
 * trade that is not a rectangle (a ramp's run in linear feet, a count of
 * fixtures). Direct values win over derived ones.
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
 * Direct sqFt/linearFt/units are used as given; otherwise a width×height in
 * inches derives area (w·h) and perimeter (2·(w+h)), the glass-panel default.
 */
export function resolveMeasurement(m: Measurement): ResolvedMeasurement {
  const hasDirect =
    m.sqFt != null || m.linearFt != null || m.units != null;
  if (!hasDirect && m.widthIn != null && m.heightIn != null) {
    const widthFt = m.widthIn / 12;
    const heightFt = m.heightIn / 12;
    return {
      sqFt: widthFt * heightFt,
      linearFt: 2 * (widthFt + heightFt),
      units: 1,
    };
  }
  return {
    sqFt: m.sqFt ?? 0,
    linearFt: m.linearFt ?? 0,
    units: m.units ?? 1,
  };
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
  /** How many of this product. Multiplies the whole per-unit subtotal. */
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
 * With wasteBp/markupBp/minimumCharge all zero the result equals the original
 * SG Glass engine: subtotal = (base + options + labor + components) × qty.
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
          materialSubtotal += comp.unitCost * input.quantity * multiplier;
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
 * The public "instant estimate" line: unit price is the midpoint of the shown
 * range, and the line total is that times quantity. (Quantity is already inside
 * the range subtotal, so the midpoint IS the line — quantity is not applied
 * twice; this returns the per-submission figures a saved estimate item stores.)
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
 */
export function calculateTotals(input: TotalsInput): TotalsResult {
  let subtotal = 0;
  for (const t of input.itemTotals) subtotal += t;

  const taxRateBp = input.taxRateBp ?? 825;
  const discount = input.discount ?? 0;
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

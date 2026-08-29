/**
 * Cart arithmetic. No database, no network, no Stripe.
 *
 * EVERY AMOUNT IN THIS PACKAGE IS A bigint IN MINOR UNITS. Not a number, not a
 * decimal string, not "dollars with two places". trailcards prices in floats
 * and reconciles against Stripe's integer cents at the end, which is why its
 * order totals drift by a cent on carts with a percentage discount: 0.1 + 0.2
 * is 0.30000000000000004, and the cart total, the Stripe charge and the
 * invoice PDF each round it at a different step.
 *
 * bigint rather than number-as-integer because a number silently stops being
 * exact above 2^53. That is unreachable for one order in cents, but not for a
 * tenant-wide revenue sum over a year in a zero-decimal currency, and the two
 * are the same type once they leave here.
 */

/** `percent` is whole percent; `fixed` is minor units. See `applyDiscount`. */
export type DiscountKind = "percent" | "fixed";

export interface CartDiscount {
  readonly kind: DiscountKind;
  /** Whole percent for `percent`, minor units for `fixed`. */
  readonly value: number;
}

/**
 * Per-line free-form data: engraving text, a gift note, a chosen colour.
 *
 * string -> string, not `unknown`, because these are copied verbatim into
 * Stripe metadata and Stripe stringifies whatever it is handed. A nested object
 * arrives in the dashboard as `[object Object]`, which is how the engraving
 * text stops reaching the person packing the box.
 */
export type CartLineMetadata = Readonly<Record<string, string>>;

export interface CartLine {
  /** The caller's product identifier. Opaque here — this package owns no catalogue. */
  readonly productRef: string;
  /** Absent means the product has no variants, not "the default variant". */
  readonly variantRef?: string;
  /**
   * Snapshotted at add-to-cart time, and snapshotted again onto the order row.
   * Never resolved from the catalogue at read time: renaming a product must not
   * rewrite what a customer was told they bought.
   */
  readonly name: string;
  readonly unitPriceMinor: bigint;
  readonly quantity: number;
  readonly imageUrl?: string;
  readonly metadata?: CartLineMetadata;
}

/**
 * Sum of `unitPriceMinor * quantity` across the cart.
 *
 * `BigInt(quantity)` THROWS on a fractional quantity rather than truncating,
 * and that is the point. `Math.floor` would turn a quantity of 1.5 — which only
 * ever arrives from a form field parsed with `parseFloat` — into 1, and the
 * customer receives one item, is charged for one, and nothing anywhere records
 * that they asked for more. Run `validateCart` first if the input came from a
 * request body.
 */
export function cartSubtotalMinor(lines: readonly CartLine[]): bigint {
  let total = 0n;
  for (const line of lines) {
    total += line.unitPriceMinor * BigInt(line.quantity);
  }
  return total;
}

/**
 * The subtotal AFTER the discount. Returns what remains, not the amount taken
 * off — `computeDiscountMinor` in ./discounts.ts returns that, by subtracting
 * from this, so the rounding and the clamp exist in exactly one place and
 * cannot disagree by a cent.
 *
 * Percent rounds HALF UP on integer minor units, as
 * `(2 * subtotal * pct + 100) / 200` in bigint. Nothing here becomes a float:
 * `subtotal * pct / 100` in floating point gives 33% of 100 cents as
 * 33.000000000000004, and `Math.round` on a value one ulp above .5 rounds the
 * other way from the one below it. Half up rather than banker's rounding
 * because it is what a storefront's customers already expect, and because
 * Stripe's own coupon maths rounds the same way — matching it is what keeps the
 * order row equal to the charge.
 *
 * Both kinds clamp into [0, subtotal]. A 120% coupon, or 50.00 off a 30.00
 * cart, must floor at zero: a negative total is a Stripe 400 at best and a
 * credit nobody authorised at worst.
 */
export function applyDiscount(
  subtotalMinor: bigint,
  discount: CartDiscount,
): bigint {
  if (subtotalMinor <= 0n) return 0n;

  if (discount.kind === "percent") {
    // Clamped before the multiply, so a stored 1000 — someone typing basis
    // points into a whole-percent column — cannot produce a negative total.
    const pct = BigInt(clampInteger(discount.value, 0, 100));
    const off = (2n * subtotalMinor * pct + 100n) / 200n;
    return subtotalMinor - min(off, subtotalMinor);
  }

  const off = BigInt(clampInteger(discount.value, 0, Number.MAX_SAFE_INTEGER));
  return subtotalMinor - min(off, subtotalMinor);
}

export interface CartTotalsInput {
  readonly lines: readonly CartLine[];
  readonly discount?: CartDiscount;
  /** A carrier quote or a Stripe shipping rate. Never derived here. */
  readonly shippingMinor?: bigint;
  /** Stripe Tax or another engine's answer. Never derived here. */
  readonly taxMinor?: bigint;
}

export interface CartTotals {
  readonly subtotal: bigint;
  /** The amount taken off, positive. Already subtracted from `total`. */
  readonly discount: bigint;
  readonly shipping: bigint;
  readonly tax: bigint;
  readonly total: bigint;
}

/**
 * The five numbers a checkout page shows, all bigint minor units.
 *
 * The discount applies to the SUBTOTAL ONLY. Shipping and tax are added
 * afterwards and never discounted here, because both are somebody else's
 * answer: shipping is a carrier quote, tax is a jurisdiction's rate on the
 * post-discount goods. A percentage applied to the grand total quietly
 * discounts the sales tax, which the merchant still owes the state in full —
 * and the shortfall does not surface until a filing.
 *
 * `total` is `subtotal - discount + shipping + tax`, so the returned fields
 * always reconcile. A caller that recomputes one of them from the others is how
 * the order row and the Stripe charge start to disagree.
 */
export function cartTotals(input: CartTotalsInput): CartTotals {
  const subtotal = cartSubtotalMinor(input.lines);
  const discounted = input.discount
    ? applyDiscount(subtotal, input.discount)
    : subtotal;

  const shipping = input.shippingMinor ?? 0n;
  const tax = input.taxMinor ?? 0n;

  return {
    subtotal,
    discount: subtotal - discounted,
    shipping,
    tax,
    total: discounted + shipping + tax,
  };
}

export type CartProblemCode =
  | "empty-cart"
  | "quantity-below-one"
  | "quantity-not-integer"
  | "negative-price"
  | "duplicate-line";

export interface CartProblem {
  readonly code: CartProblemCode;
  /** Safe to show a customer. Carries no internal id beyond `productRef`. */
  readonly message: string;
  /** Index into the input array. Absent for whole-cart problems. */
  readonly lineIndex?: number;
  readonly productRef?: string;
}

/**
 * Everything wrong with this cart, as a list. Empty means it is safe to price.
 *
 * Returns ALL problems rather than throwing on the first. A checkout form that
 * surfaces one problem per round trip trains people to fix-and-retry, and the
 * fifth retry is where the cart gets abandoned.
 *
 * Deliberately does not decide what to do about them. "Quantity 0" is a line
 * the UI should drop; "duplicate line" is two lines the UI should merge;
 * "negative price" is a bug in the caller's catalogue and must never be quietly
 * normalised into a discount.
 */
export function validateCart(lines: readonly CartLine[]): readonly CartProblem[] {
  const problems: CartProblem[] = [];

  if (lines.length === 0) {
    problems.push({ code: "empty-cart", message: "Your cart is empty." });
    return problems;
  }

  const firstSeenAt = new Map<string, number>();

  for (const [index, line] of lines.entries()) {
    if (!Number.isInteger(line.quantity)) {
      problems.push({
        code: "quantity-not-integer",
        message: `"${line.name}" has a fractional quantity.`,
        lineIndex: index,
        productRef: line.productRef,
      });
    } else if (line.quantity < 1) {
      // `else if`: a quantity of 0.5 is already reported as fractional, and
      // reporting it twice shows the customer two errors for one field.
      problems.push({
        code: "quantity-below-one",
        message: `"${line.name}" has a quantity below one.`,
        lineIndex: index,
        productRef: line.productRef,
      });
    }

    // Zero is allowed — free gifts and included accessories are real lines.
    // Negative is not: it is a discount smuggled in as a product, which is
    // exactly the shape `buildStripeLineItems` refuses to send to Stripe.
    if (line.unitPriceMinor < 0n) {
      problems.push({
        code: "negative-price",
        message: `"${line.name}" has a negative price.`,
        lineIndex: index,
        productRef: line.productRef,
      });
    }

    const key = duplicateKey(line);
    const first = firstSeenAt.get(key);
    if (first === undefined) {
      firstSeenAt.set(key, index);
    } else {
      problems.push({
        code: "duplicate-line",
        message:
          `"${line.name}" appears twice (lines ${first + 1} and ${index + 1}); ` +
          `the quantities should have been merged.`,
        lineIndex: index,
        productRef: line.productRef,
      });
    }
  }

  return problems;
}

const KEY_SEPARATOR = String.fromCharCode(0);

/**
 * NUL as the separator, not "|" or "-".
 *
 * With any printable separator, productRef "sku|red" with no variant and
 * productRef "sku" with variant "red" produce the same key. They are two
 * genuinely different lines, and reporting them as duplicates makes the UI
 * merge them — silently dropping one of the two things the customer is buying.
 * NUL cannot appear in a Postgres `text` value, so no ref can contain it.
 */
function duplicateKey(line: CartLine): string {
  return line.productRef + KEY_SEPARATOR + (line.variantRef ?? "");
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Truncates before clamping. A non-integer percent cannot be represented by the
 * `value integer` column it came from, so it can only have arrived from a
 * caller doing float maths — and rounding it up hands out a discount nobody
 * configured. NaN falls to the low bound rather than propagating: `BigInt(NaN)`
 * throws, and a coupon must not be able to 500 the checkout page.
 */
function clampInteger(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}

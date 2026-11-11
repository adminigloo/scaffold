import { formatCredits, type CreditUnitLabel } from "__SCOPE__/wallet";

/**
 * HOW EACH KIND OF CREDIT THIS SITE SELLS IS WRITTEN (wallet 0.1).
 *
 * A product's `credits` grant names a unit slug (`crowns`, `ai-credits`); this
 * is where the slug becomes words. Add one line per unit you sell:
 *
 *   crowns: { one: "crown", many: "crowns" },
 *
 * A unit with no entry is written as its slug ("3 ai-credits"), which is never
 * wrong about the number and is the honest default for a unit nobody named.
 */
export const CREDIT_UNITS: Readonly<Record<string, CreditUnitLabel>> = {};

/** "25 crowns", using the label above when there is one. */
export function creditsLabel(amount: number, unit: string): string {
  return formatCredits(amount, unit, CREDIT_UNITS[unit]);
}

/**
 * @adminigloo/wallet: spendable balances.
 *
 *   .          units, amounts, refusals, `formatCredits` and the staff
 *              permission keys. Safe in a browser.
 *   ./schema   the drizzle tables (wallet_balances, wallet_ledger)
 *   ./server   credit, spend, refund, adjust, and the reads
 *
 * Tables are reachable ONLY from "./schema", for the reason catalog gives: a
 * client component importing `formatCredits` must not drag the query builder
 * into its bundle, and tsup emits a table into both dist files if two entries
 * reach it, so CJS consumers would hold two objects for one table.
 */
export {
  assertCreditAmount,
  assertCreditUnit,
  CREDIT_UNIT_PATTERN,
  formatCredits,
  InsufficientCreditsError,
  InvalidCreditAmountError,
  InvalidCreditUnitError,
  isCreditUnit,
  MAX_CREDIT_AMOUNT,
  WALLET_REASONS,
} from "./units.js";
export type { CreditUnitLabel, WalletReason } from "./units.js";

export { walletPermissions } from "./permissions.js";
export type { WalletPermission } from "./permissions.js";

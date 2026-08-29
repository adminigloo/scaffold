export {
  cartSubtotalMinor,
  applyDiscount,
  cartTotals,
  validateCart,
} from "./cart.js";
export type {
  CartDiscount,
  CartLine,
  CartLineMetadata,
  CartProblem,
  CartProblemCode,
  CartTotals,
  CartTotalsInput,
  DiscountKind,
} from "./cart.js";

export {
  discountState,
  computeDiscountMinor,
  normaliseDiscountCode,
} from "./discounts.js";
export type {
  DiscountCodeState,
  DiscountContext,
  DiscountStatus,
} from "./discounts.js";

export {
  formatOrderNumber,
  verifyOrderNumberCheck,
  InvalidOrderNumberInputError,
} from "./order-number.js";
export type { OrderNumberInput } from "./order-number.js";

export {
  buildStripeLineItems,
  buildCheckoutDiscounts,
  buildOrderCheckoutParams,
  StripeAmountRangeError,
} from "./checkout.js";
export type { CheckoutDiscountRef, OrderCheckoutInput } from "./checkout.js";

export {
  checkoutSessionKey,
  decidePaymentIntentWrite,
  decideSessionWrite,
  orderWriteStatements,
  CHECKOUT_SESSION_KEY_PREFIX,
  InvalidOrderIdempotencyKeyError,
  OrderPaymentIntentMismatchError,
} from "./orders.js";
export type {
  ExistingOrderRow,
  OrderWriteOutcome,
  PaymentIntentWriteInput,
  SessionPaymentStatus,
  SessionWriteInput,
} from "./orders.js";

export { commercePermissions } from "./permissions.js";
export type { CommercePermission } from "./permissions.js";

/**
 * Tables are reachable ONLY from "@adminigloo/commerce/schema", matching auth,
 * stripe, permissions and tenancy.
 *
 * Re-exporting them here costs twice. The root entry becomes a static import of
 * drizzle-orm/pg-core, so a client component importing `cartTotals` — which is
 * pure integer arithmetic and the single most likely thing to run in a browser
 * — drags the whole query builder into the bundle, and with no
 * `sideEffects: false` anywhere in the repo a bundler must assume the chunk
 * matters and cannot drop it. Worse, tsup does not code-split CJS: the same
 * `pgTable` call is emitted into BOTH dist/index.cjs and dist/schema.cjs, so a
 * CJS consumer holds two distinct objects for one physical table and reference
 * equality — which Drizzle relations and getTableConfig rely on — silently
 * fails.
 *
 * Types are safe to re-export: they erase at build time and pull in nothing.
 */
export type { OrderAddress, OrderStatus } from "./schema.js";

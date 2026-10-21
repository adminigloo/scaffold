/**
 * @adminigloo/commerce/widget — the store's screens (commerce 0.2). A client
 * entry ("use client" is stamped on the bundle by tsup). React is its only
 * peer; the screens talk to the app only through the base URL each is given.
 *
 *   <StoreAdmin baseUrl storefrontUrl />   the owner's products and orders
 *   <StoreAttention baseUrl />             "Needs your attention" (the payments screen)
 *   <Storefront baseUrl />                 the store page and its cart
 *   <StoreThanks baseUrl checkoutId />     the thank-you page
 */
export {
  StoreAdmin,
  draftOf,
  orderStatusWords,
  paidInPersonWords,
  productBody,
  stockWords,
  type ProductDraft,
  type StoreAdminProps,
} from "./widget/StoreAdmin.js";
export { StoreAttention } from "./widget/StoreAttention.js";
export { Storefront, StoreThanks, cartTotal, type StorefrontProps } from "./widget/Storefront.js";
export { emptyCart, loadCart, saveCart, clearCart, withQuantity, type Cart, type CartLine } from "./widget/cart.js";
export { formatMoney, parseMoneyInput, moneyInputValue, currencyDigits } from "./widget/money.js";
export { storeCss } from "./widget/styles.js";
export type * from "./store-wire.js";

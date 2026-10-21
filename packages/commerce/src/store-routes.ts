import type { StorePermission } from "./permissions.js";

/**
 * A STORE OF ITS OWN (commerce 0.2): every route of the store's two handlers,
 * as data. The tests read it back, and a companies project's isolation proof
 * (create-app) drives every row as another company. Declared here, never
 * imported from a shared package.
 */
export interface StoreRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/products/{store-product}". */
  readonly path: string;
  /** The permission `authorize` is asked for (staff routes); null on the store's public routes. */
  readonly permission: StorePermission | null;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body the route accepts. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type StoreAdminRouteKind =
  | "status"
  | "products"
  | "product-create"
  | "product-update"
  | "product-photo"
  | "product-remove"
  | "product-release"
  | "settings-save"
  | "orders"
  | "order-sent"
  | "attention"
  | "attention-resolve"
  | "sale-record";

export type StorePublicRouteKind = "store" | "checkout" | "checkout-status";

/** The permission each staff route asks for. */
export const STORE_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<StoreAdminRouteKind, StorePermission>> = {
  status: "store.view",
  products: "store.view",
  "product-create": "store.manage",
  "product-update": "store.manage",
  "product-photo": "store.manage",
  "product-remove": "store.manage",
  "product-release": "store.manage",
  "settings-save": "store.manage",
  orders: "store.view",
  "order-sent": "store.manage",
  attention: "store.view",
  "attention-resolve": "store.manage",
  // commerce 0.4: a sale recorded by hand (in person) — staff who run the store.
  "sale-record": "store.manage",
};

function freeze<T extends readonly StoreRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/** A 1×1 PNG, base64: the smallest photo the photo route reads. */
const PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Entities: `{store-product}` (a product), `{store-order}` (an order),
 * `{store-alert}` (a payment that needs the owner), `{store-checkout}` (one
 * "Check out" press). A placeholder in the PATH means the route reads that
 * row: another company's row is "not found".
 */
export const STORE_ADMIN_ROUTES: readonly StoreRoute<StoreAdminRouteKind>[] = freeze([
  { kind: "status", method: "GET", path: "v1/admin/status", permission: "store.view" },
  { kind: "products", method: "GET", path: "v1/admin/products", permission: "store.view" },
  {
    kind: "product-create",
    method: "POST",
    path: "v1/admin/products",
    permission: "store.manage",
    body: { name: "Isolation probe", priceMinor: 1_000, currency: "usd" },
  },
  { kind: "product-update", method: "POST", path: "v1/admin/products/{store-product}", permission: "store.manage", body: { name: "Isolation probe" } },
  {
    kind: "product-photo",
    method: "POST",
    path: "v1/admin/products/{store-product}/photo",
    permission: "store.manage",
    body: { contentType: "image/png", data: PROBE_PNG },
  },
  { kind: "product-remove", method: "POST", path: "v1/admin/products/{store-product}/remove", permission: "store.manage", body: {} },
  // "Release held items": close the open checkout pages holding this product.
  { kind: "product-release", method: "POST", path: "v1/admin/products/{store-product}/release", permission: "store.manage", body: {} },
  // How customers get their order (ship or pickup), shipping, and the tax wording.
  { kind: "settings-save", method: "POST", path: "v1/admin/settings", permission: "store.manage", body: { fulfilment: "pickup" } },
  { kind: "orders", method: "GET", path: "v1/admin/orders", permission: "store.view" },
  { kind: "order-sent", method: "POST", path: "v1/admin/orders/{store-order}/sent", permission: "store.manage", body: {} },
  { kind: "attention", method: "GET", path: "v1/admin/attention", permission: "store.view" },
  { kind: "attention-resolve", method: "POST", path: "v1/admin/attention/{store-alert}/resolve", permission: "store.manage", body: {} },
  // commerce 0.4: a sale by hand — the product named in the BODY is the row it reads (another company's is "not found").
  {
    kind: "sale-record",
    method: "POST",
    path: "v1/admin/sales",
    permission: "store.manage",
    body: { lines: [{ productId: "{store-product}", quantity: 1 }], method: "cash", requestKey: "isolation-probe-sale" },
  },
] as const);

/**
 * The customer's side: the store page, "Check out" (the cart names products
 * and quantities only — every price is the server's), and the thank-you
 * page's "is my order in?".
 */
export const STORE_PUBLIC_ROUTES: readonly StoreRoute<StorePublicRouteKind>[] = freeze([
  { kind: "store", method: "GET", path: "v1/store", permission: null },
  {
    kind: "checkout",
    method: "POST",
    path: "v1/store/checkout",
    permission: null,
    body: { cartId: "isolation-probe-cart", lines: [{ productId: "{store-product}", quantity: 1 }] },
  },
  { kind: "checkout-status", method: "GET", path: "v1/store/checkouts/{store-checkout}", permission: null },
] as const);

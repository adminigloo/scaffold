import { ESTIMATOR_ADMIN_ROUTE_PERMISSIONS, type AdminRouteKind } from "./admin-handlers.js";

/**
 * The estimator handlers' routes, as data (Tenancy 2a, 3.1). The package's
 * own tests call `handle` once per row and assert it routed to that kind and
 * that each example reaches its row lookup; the emitted isolation proof
 * (create-app section 12) drives every row as another company. Declared
 * here, never imported from a shared package (D4).
 */
export interface EstimatorRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/estimates/{estimate}/send". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  /** Query parameters to send: literal values, or a placeholder. */
  readonly query?: Readonly<Record<string, string>>;
  /** A minimal valid JSON body for a POST: enough to get past the body's zod schema to the row lookup. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type EstimatorAdminRouteKind = AdminRouteKind;
export type EstimatorPublicRouteKind = "config" | "options" | "calculate" | "photo" | "takeoff" | "submit" | "quote" | "accept" | "decline";

/**
 * A 1×1 JPEG, base64: the smallest photo the photo routes accept, so their
 * examples get past the body's checks to the row lookup.
 */
export const PROBE_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

function freeze<T extends readonly EstimatorRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

type Row = Omit<EstimatorRoute<EstimatorAdminRouteKind>, "permission">;

/**
 * One row per kind of ESTIMATOR_ADMIN_ROUTE_PERMISSIONS, with the method and
 * path the router matches. Entities: `{product}`, `{supply}`, `{attachment}`
 * (a supply on a product), `{option}`, `{option-value}`, `{estimate}`,
 * `{line}`, `{photo}`, `{key}`. A placeholder in the PATH means the route
 * reads that row (another company's → 404); one in a body is a reference.
 */
const ADMIN_ROWS: readonly Row[] = [
  { kind: "status", method: "GET", path: "v1/admin/status" },
  { kind: "usage", method: "GET", path: "v1/admin/usage" },
  { kind: "settings-get", method: "GET", path: "v1/admin/settings" },
  { kind: "settings-update", method: "POST", path: "v1/admin/settings", body: { quoteValidDays: 30 } },
  { kind: "products-list", method: "GET", path: "v1/admin/products" },
  { kind: "product-create", method: "POST", path: "v1/admin/products", body: { name: "Isolation probe" } },
  { kind: "products-reorder", method: "POST", path: "v1/admin/products/reorder", body: { ids: ["{product}"] } },
  { kind: "products-preview", method: "POST", path: "v1/admin/products/preview", body: { productId: "{product}" } },
  { kind: "product-get", method: "GET", path: "v1/admin/products/{product}" },
  { kind: "product-update", method: "POST", path: "v1/admin/products/{product}", body: { name: "Renamed probe" } },
  { kind: "product-deactivate", method: "POST", path: "v1/admin/products/{product}/deactivate", body: {} },
  { kind: "product-reactivate", method: "POST", path: "v1/admin/products/{product}/reactivate", body: {} },
  { kind: "supply-attach", method: "POST", path: "v1/admin/products/{product}/supplies", body: { supplyId: "{supply}", quantityMilli: 1000 } },
  { kind: "attachment-update", method: "POST", path: "v1/admin/products/{product}/supplies/{attachment}", body: { quantityMilli: 2000 } },
  { kind: "attachment-remove", method: "POST", path: "v1/admin/products/{product}/supplies/{attachment}/remove", body: {} },
  { kind: "option-create", method: "POST", path: "v1/admin/products/{product}/options", body: { name: "Probe option" } },
  { kind: "option-update", method: "POST", path: "v1/admin/options/{option}", body: { name: "Renamed option" } },
  { kind: "option-remove", method: "POST", path: "v1/admin/options/{option}/remove", body: {} },
  { kind: "option-value-create", method: "POST", path: "v1/admin/options/{option}/values", body: { label: "Probe value" } },
  { kind: "option-value-update", method: "POST", path: "v1/admin/option-values/{option-value}", body: { label: "Renamed value" } },
  { kind: "option-value-default", method: "POST", path: "v1/admin/option-values/{option-value}/default", body: {} },
  { kind: "option-value-remove", method: "POST", path: "v1/admin/option-values/{option-value}/remove", body: {} },
  { kind: "supplies-list", method: "GET", path: "v1/admin/supplies" },
  { kind: "supply-create", method: "POST", path: "v1/admin/supplies", body: { name: "Probe supply" } },
  { kind: "supply-update", method: "POST", path: "v1/admin/supplies/{supply}", body: { name: "Renamed supply" } },
  { kind: "supply-deactivate", method: "POST", path: "v1/admin/supplies/{supply}/deactivate", body: {} },
  { kind: "supply-reactivate", method: "POST", path: "v1/admin/supplies/{supply}/reactivate", body: {} },
  { kind: "sample-catalog", method: "POST", path: "v1/admin/sample-catalog", body: {} },
  { kind: "estimates-list", method: "GET", path: "v1/admin/estimates" },
  { kind: "estimate-create", method: "POST", path: "v1/admin/estimates", body: { customerName: "Isolation Probe" } },
  { kind: "estimate-get", method: "GET", path: "v1/admin/estimates/{estimate}" },
  { kind: "estimate-update", method: "POST", path: "v1/admin/estimates/{estimate}", body: { notes: "probe" } },
  { kind: "line-add", method: "POST", path: "v1/admin/estimates/{estimate}/items", body: { productId: "{product}" } },
  { kind: "line-update", method: "POST", path: "v1/admin/estimates/{estimate}/items/{line}", body: { quantity: 2 } },
  { kind: "line-remove", method: "POST", path: "v1/admin/estimates/{estimate}/items/{line}/remove", body: {} },
  { kind: "photo-add", method: "POST", path: "v1/admin/estimates/{estimate}/photos", body: { imageBase64: PROBE_JPEG_BASE64, mediaType: "image/jpeg" } },
  { kind: "photo-remove", method: "POST", path: "v1/admin/estimates/{estimate}/photos/{photo}/remove", body: {} },
  { kind: "quote-send", method: "POST", path: "v1/admin/estimates/{estimate}/send", body: {} },
  { kind: "quote-resend", method: "POST", path: "v1/admin/estimates/{estimate}/resend", body: {} },
  { kind: "quote-revise", method: "POST", path: "v1/admin/estimates/{estimate}/revise", body: {} },
  { kind: "estimate-status", method: "POST", path: "v1/admin/estimates/{estimate}/status", body: { status: "approved" } },
  { kind: "quote-link", method: "POST", path: "v1/admin/estimates/{estimate}/link", body: {} },
  { kind: "estimate-archive", method: "POST", path: "v1/admin/estimates/{estimate}/archive", body: {} },
  { kind: "estimate-unarchive", method: "POST", path: "v1/admin/estimates/{estimate}/unarchive", body: {} },
  { kind: "estimate-duplicate", method: "POST", path: "v1/admin/estimates/{estimate}/duplicate", body: {} },
  { kind: "estimate-convert", method: "POST", path: "v1/admin/estimates/{estimate}/convert", body: {} },
  { kind: "expire", method: "POST", path: "v1/admin/expire", body: {} },
  { kind: "keys-list", method: "GET", path: "v1/admin/keys" },
  { kind: "key-issue", method: "POST", path: "v1/admin/keys", body: { label: "Probe key" } },
  { kind: "key-update", method: "POST", path: "v1/admin/keys/{key}", body: { label: "Renamed key" } },
  { kind: "key-revoke", method: "POST", path: "v1/admin/keys/{key}/revoke", body: {} },
];

export const ESTIMATOR_ADMIN_ROUTES: readonly EstimatorRoute<EstimatorAdminRouteKind>[] = freeze(
  ADMIN_ROWS.map((row) => ({ ...row, permission: ESTIMATOR_ADMIN_ROUTE_PERMISSIONS[row.kind] })),
);

export const ESTIMATOR_PUBLIC_ROUTES: readonly EstimatorRoute<EstimatorPublicRouteKind>[] = freeze([
  { kind: "config", method: "GET", path: "v1/config", permission: null },
  { kind: "options", method: "POST", path: "v1/options", permission: null, body: { productId: "{product}" } },
  { kind: "calculate", method: "POST", path: "v1/calculate", permission: null, body: { productId: "{product}", quantity: 1 } },
  { kind: "photo", method: "POST", path: "v1/photo", permission: null, body: { imageBase64: PROBE_JPEG_BASE64, mediaType: "image/jpeg" } },
  {
    kind: "takeoff",
    method: "POST",
    path: "v1/takeoff",
    permission: null,
    body: { productId: "{product}", imageBase64: PROBE_JPEG_BASE64, mediaType: "image/jpeg" },
  },
  {
    kind: "submit",
    method: "POST",
    path: "v1/submit",
    permission: null,
    body: { name: "Isolation Probe", email: "probe@isolation.test", items: [{ productId: "{product}", quantity: 1 }], fillMs: 5000 },
  },
  { kind: "quote", method: "GET", path: "v1/quote/{quote-token}", permission: null },
  { kind: "accept", method: "POST", path: "v1/quote/{quote-token}/accept", permission: null, body: { version: 1, name: "Isolation Probe" } },
  { kind: "decline", method: "POST", path: "v1/quote/{quote-token}/decline", permission: null, body: { version: 1 } },
] as const);

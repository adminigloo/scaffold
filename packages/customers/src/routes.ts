import type { CustomersPermission } from "./permissions.js";

/**
 * Every route of the customer screen's handler, as data (customers 0.1). The
 * package tests read it back, and a companies project's isolation proof
 * (create-app) drives every row as another company.
 */
export interface CustomersRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/customers/{customer}". */
  readonly path: string;
  readonly permission: CustomersPermission;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body the route accepts. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type CustomersAdminRouteKind =
  | "list"
  | "create"
  | "get"
  | "update"
  | "timeline"
  | "address-add"
  | "address-remove"
  | "merge"
  | "notice"
  | "import-preview"
  | "import-apply"
  | "export";

export const CUSTOMERS_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<CustomersAdminRouteKind, CustomersPermission>> = {
  list: "customers.view",
  create: "customers.manage",
  get: "customers.view",
  update: "customers.manage",
  timeline: "customers.view",
  "address-add": "customers.manage",
  "address-remove": "customers.manage",
  merge: "customers.manage",
  notice: "customers.manage",
  "import-preview": "customers.manage",
  "import-apply": "customers.manage",
  export: "customers.manage",
};

function freeze<T extends readonly CustomersRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

const PROBE_CSV = "Name,Email,Phone\nIsolation Probe,isolation.probe@example.invalid,";

/**
 * Entities: `{customer}` (a customer), `{customer-address}` (one of its
 * addresses), `{spare-customer}` (a second customer, the one a merge folds
 * in), `{customer-notice}` (something on the customer's record for staff to
 * decide: new details from a form, a possible duplicate). A placeholder in the PATH means the route reads that row: another
 * company's is "not found". One in the BODY (merge's) is read inside the
 * company in the path too.
 */
export const CUSTOMERS_ADMIN_ROUTES: readonly CustomersRoute<CustomersAdminRouteKind>[] = freeze([
  { kind: "list", method: "GET", path: "v1/admin/customers", permission: "customers.view", query: { q: "probe" } },
  { kind: "create", method: "POST", path: "v1/admin/customers", permission: "customers.manage", body: { name: "Isolation probe" } },
  { kind: "get", method: "GET", path: "v1/admin/customers/{customer}", permission: "customers.view" },
  { kind: "update", method: "POST", path: "v1/admin/customers/{customer}", permission: "customers.manage", body: { notes: "Isolation probe" } },
  { kind: "timeline", method: "GET", path: "v1/admin/customers/{customer}/timeline", permission: "customers.view" },
  { kind: "address-add", method: "POST", path: "v1/admin/customers/{customer}/addresses", permission: "customers.manage", body: { text: "1 Probe Street" } },
  { kind: "address-remove", method: "POST", path: "v1/admin/customers/{customer}/addresses/{customer-address}/remove", permission: "customers.manage", body: {} },
  { kind: "merge", method: "POST", path: "v1/admin/customers/{customer}/merge", permission: "customers.manage", body: { mergeId: "{spare-customer}" } },
  // Add or ignore new details from a form; "not the same person"; "understood".
  { kind: "notice", method: "POST", path: "v1/admin/customers/{customer}/notices/{customer-notice}", permission: "customers.manage", body: { action: "ignore" } },
  { kind: "import-preview", method: "POST", path: "v1/admin/import/preview", permission: "customers.manage", body: { csv: PROBE_CSV } },
  { kind: "import-apply", method: "POST", path: "v1/admin/import/apply", permission: "customers.manage", body: { csv: PROBE_CSV } },
  { kind: "export", method: "GET", path: "v1/admin/export", permission: "customers.manage" },
] as const);

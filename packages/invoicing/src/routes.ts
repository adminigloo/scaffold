import type { InvoicingPermission } from "./permissions.js";

/**
 * One route of a feature's handler, as data (Tenancy 2a, 3.1). The tests read
 * it back; the emitted isolation proof (create-app section 12) drives every
 * row as another company. Declared here, never imported from a shared package
 * (D4).
 */
export interface InvoicingRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/invoices/{invoice}/send". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  /** Query parameters to send: literal values, or a placeholder. */
  readonly query?: Readonly<Record<string, string>>;
  /** A minimal valid JSON body for a POST: enough to get past the body's zod schema to the row lookup. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type InvoicingAdminRouteKind =
  | "status"
  | "list"
  | "create"
  | "get"
  | "item-add"
  | "item-update"
  | "item-remove"
  | "status-set"
  | "send"
  | "link"
  | "payment-record"
  | "payment-reverse";

export type InvoicingPublicRouteKind = "invoice" | "viewed";

/** The permission each staff route asks for: the contract's table (10.5), as data. */
export const INVOICING_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<InvoicingAdminRouteKind, InvoicingPermission>> = {
  status: "invoices.view",
  list: "invoices.view",
  create: "invoices.manage",
  get: "invoices.view",
  "item-add": "invoices.manage",
  "item-update": "invoices.manage",
  "item-remove": "invoices.manage",
  "status-set": "invoices.manage",
  send: "invoices.manage",
  // The customer's link is a key to the invoice: only those who may send it get it.
  link: "invoices.manage",
  "payment-record": "invoices.payments.record",
  "payment-reverse": "invoices.payments.reverse",
};

function freeze<T extends readonly InvoicingRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Entities: `{invoice}`, `{item}` (a line), `{payment}`, `{invoice-token}`.
 * A placeholder in the PATH means the route reads that row (another company's
 * row → 404); every body below is the smallest one its schema accepts.
 */
export const INVOICING_ADMIN_ROUTES: readonly InvoicingRoute<InvoicingAdminRouteKind>[] = freeze([
  { kind: "status", method: "GET", path: "v1/admin/status", permission: "invoices.view" },
  { kind: "list", method: "GET", path: "v1/admin/invoices", permission: "invoices.view" },
  {
    kind: "create",
    method: "POST",
    path: "v1/admin/invoices",
    permission: "invoices.manage",
    body: { customerName: "Isolation Probe", items: [{ description: "Probe", quantity: 1, unitPrice: 100 }] },
  },
  { kind: "get", method: "GET", path: "v1/admin/invoices/{invoice}", permission: "invoices.view" },
  {
    kind: "item-add",
    method: "POST",
    path: "v1/admin/invoices/{invoice}/items",
    permission: "invoices.manage",
    body: { description: "Probe line", quantity: 1, unitPrice: 100 },
  },
  { kind: "item-update", method: "POST", path: "v1/admin/items/{item}", permission: "invoices.manage", body: { quantity: 2 } },
  { kind: "item-remove", method: "POST", path: "v1/admin/items/{item}/remove", permission: "invoices.manage", body: {} },
  { kind: "status-set", method: "POST", path: "v1/admin/invoices/{invoice}/status", permission: "invoices.manage", body: { status: "void" } },
  { kind: "send", method: "POST", path: "v1/admin/invoices/{invoice}/send", permission: "invoices.manage", body: {} },
  { kind: "link", method: "GET", path: "v1/admin/invoices/{invoice}/link", permission: "invoices.manage" },
  {
    kind: "payment-record",
    method: "POST",
    path: "v1/admin/invoices/{invoice}/payments",
    permission: "invoices.payments.record",
    body: { amount: 100, method: "cash" },
  },
  {
    kind: "payment-reverse",
    method: "POST",
    path: "v1/admin/payments/{payment}/reverse",
    permission: "invoices.payments.reverse",
    body: { reason: "Isolation probe" },
  },
] as const);

export const INVOICING_PUBLIC_ROUTES: readonly InvoicingRoute<InvoicingPublicRouteKind>[] = freeze([
  { kind: "invoice", method: "GET", path: "v1/invoice/{invoice-token}", permission: null },
  { kind: "viewed", method: "POST", path: "v1/invoice/{invoice-token}/viewed", permission: null, body: {} },
] as const);

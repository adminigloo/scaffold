import type { CommsPermission } from "./permissions.js";

/**
 * One route of a feature's handler, as data (Tenancy 2a, 3.1). The tests read
 * it back; the emitted isolation proof (create-app section 12) drives every
 * row as another company and expects not-found, or nothing of the first
 * company, from each.
 *
 * Declared here, not imported from a shared package (D4): every feature
 * package carries the same structural shape.
 */
export interface CommsRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/templates/{template-key}". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  /** Query parameters to send: literal values, or a placeholder like "{template-key}". */
  readonly query?: Readonly<Record<string, string>>;
  /** A minimal valid JSON body for a POST: enough to get past the body's zod schema to the row lookup. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type CommsAdminRouteKind = "status" | "templates" | "template-save" | "template-active" | "messages" | "run-due";

/** The permission each staff route asks for: the contract's table (9.5), as data. */
export const COMMS_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<CommsAdminRouteKind, CommsPermission>> = {
  status: "comms.view",
  templates: "comms.view",
  "template-save": "comms.manage",
  "template-active": "comms.manage",
  messages: "comms.view",
  "run-due": "comms.manage",
};

function freeze<T extends readonly CommsRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Every staff route, in the router's own terms. `{template-key}` is a key the
 * company has (the proof plants `alpha_only_note` for company A only), so
 * another company asking for it answers 404.
 */
export const COMMS_ADMIN_ROUTES: readonly CommsRoute<CommsAdminRouteKind>[] = freeze([
  { kind: "status", method: "GET", path: "v1/admin/status", permission: "comms.view" },
  { kind: "templates", method: "GET", path: "v1/admin/templates", permission: "comms.view" },
  {
    kind: "template-save",
    method: "POST",
    path: "v1/admin/templates/{template-key}",
    permission: "comms.manage",
    body: { subject: "Isolation probe", body: "Isolation probe body" },
  },
  {
    kind: "template-active",
    method: "POST",
    path: "v1/admin/templates/{template-key}/active",
    permission: "comms.manage",
    body: { active: true },
  },
  { kind: "messages", method: "GET", path: "v1/admin/messages", permission: "comms.view", query: { limit: "50" } },
  { kind: "run-due", method: "POST", path: "v1/admin/run-due", permission: "comms.manage", body: {} },
] as const);

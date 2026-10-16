import type { NotificationsPermission } from "./permissions.js";

/**
 * One route of a feature's handler, as data (Tenancy 2a, 3.1; 2b-1, 3.1). The
 * tests read it back; the emitted isolation proof (create-app 14.1) drives
 * every row as another company and expects not-found, or nothing of the first
 * company, from each.
 *
 * Declared here, not imported from a shared package (2a D4): every feature
 * package carries the same structural shape.
 */
export interface NotificationsRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/alerts/{alert}/read". */
  readonly path: string;
  /**
   * The permission `authorize` is asked for (private routes); null on public
   * routes. Null on a PRIVATE route means "the row it reads decides" (3.1);
   * notifications has no such route.
   */
  readonly permission: string | null;
  /** Query parameters to send: literal values, or a placeholder like "{alert}". */
  readonly query?: Readonly<Record<string, string>>;
  /** A minimal valid JSON body for a POST: enough to get past the body's zod schema to the row lookup. Placeholders allowed in string values. */
  readonly body?: unknown;
  /** Required when `permission` is null on a private route: what the row it reads must grant (D12). */
  readonly access?: {
    /** "file": the `{file}` placeholder's file decides; "record": the `record`/`id` query's record decides. */
    readonly scope: "file" | "record";
    /** "view" (open, list, link), "manage" (remove), "add" (attach). */
    readonly needs: "view" | "manage" | "add";
  };
}

export type NotificationsAdminRouteKind = "count" | "list" | "read" | "read-all" | "preferences" | "preference-set" | "routing" | "routing-set";

/** The permission each route asks for: the contract's table (4.7), as data. */
export const NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<NotificationsAdminRouteKind, NotificationsPermission>> = Object.freeze({
  count: "alerts.view",
  list: "alerts.view",
  read: "alerts.view",
  "read-all": "alerts.view",
  preferences: "alerts.view",
  "preference-set": "alerts.view",
  routing: "alerts.manage",
  "routing-set": "alerts.manage",
});

function freeze<T extends readonly NotificationsRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Every route, in the router's own terms. Entities (3.1): `{alert}` (an alert
 * of A's owner) and `{person}` (a member of A, a body reference). A
 * placeholder in the PATH means the route reads that row (another company's
 * or person's alert → 404); `routing-set`'s person is a body reference, so B
 * sending A's member is a 400 whose issue never names the id.
 */
export const NOTIFICATIONS_ADMIN_ROUTES: readonly NotificationsRoute<NotificationsAdminRouteKind>[] = freeze([
  { kind: "count", method: "GET", path: "v1/admin/count", permission: "alerts.view" },
  { kind: "list", method: "GET", path: "v1/admin/alerts", permission: "alerts.view", query: { limit: "20" } },
  { kind: "read", method: "POST", path: "v1/admin/alerts/{alert}/read", permission: "alerts.view", body: {} },
  { kind: "read-all", method: "POST", path: "v1/admin/read-all", permission: "alerts.view", body: {} },
  { kind: "preferences", method: "GET", path: "v1/admin/preferences", permission: "alerts.view" },
  {
    kind: "preference-set",
    method: "POST",
    path: "v1/admin/preferences",
    permission: "alerts.view",
    body: { kind: "unknown.kind", channel: "in_app" },
  },
  { kind: "routing", method: "GET", path: "v1/admin/routing", permission: "alerts.manage" },
  {
    kind: "routing-set",
    method: "POST",
    path: "v1/admin/routing",
    permission: "alerts.manage",
    body: { key: "estimates", mode: "chosen", userIds: ["{person}"], extraEmails: [] },
  },
] as const);

import type { AnalyticsPermission } from "./permissions.js";

/**
 * One route of the analytics handlers, as data (the Tenancy 2a route-table
 * shape, 3.1). The package's tests read it back; a generated companies
 * project's isolation proof drives every row as ANOTHER company. Declared
 * here, never imported from a shared package.
 */
export interface AnalyticsRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/websites/{website}/remove". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body its schema accepts. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type AnalyticsAdminRouteKind =
  | "report"
  | "websites"
  | "website-add"
  | "website-report"
  | "website-update"
  | "website-remove"
  | "mine"
  | "mine-undo";

export type AnalyticsPublicRouteKind = "collect" | "script";

/** The permission each private route asks for, as data. */
export const ANALYTICS_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<AnalyticsAdminRouteKind, AnalyticsPermission>> = {
  report: "analytics.view",
  websites: "analytics.view",
  "website-add": "analytics.manage",
  "website-report": "analytics.view",
  "website-update": "analytics.manage",
  "website-remove": "analytics.manage",
  mine: "analytics.manage",
  "mine-undo": "analytics.manage",
};

function freeze<T extends readonly AnalyticsRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Every private route, under `{mount}/` (a companies project mounts it at
 * /api/app/{company id}/website/). The one entity is `{website}`, a website
 * of the company's own: another company's is "not found", like an id that
 * never existed.
 */
export const ANALYTICS_ADMIN_ROUTES: readonly AnalyticsRoute<AnalyticsAdminRouteKind>[] = freeze([
  { kind: "report", method: "GET", path: "v1/report", permission: "analytics.view", query: { days: "30" } },
  { kind: "websites", method: "GET", path: "v1/websites", permission: "analytics.view" },
  {
    kind: "website-add",
    method: "POST",
    path: "v1/websites",
    permission: "analytics.manage",
    body: { name: "Isolation probe website", domains: ["probe.example"] },
  },
  { kind: "website-report", method: "GET", path: "v1/websites/{website}/report", permission: "analytics.view", query: { days: "30" } },
  {
    kind: "website-update",
    method: "POST",
    path: "v1/websites/{website}",
    permission: "analytics.manage",
    body: { name: "Isolation probe rename" },
  },
  { kind: "website-remove", method: "POST", path: "v1/websites/{website}/remove", permission: "analytics.manage", body: {} },
  { kind: "mine", method: "POST", path: "v1/visits/mine", permission: "analytics.manage", body: {} },
  { kind: "mine-undo", method: "POST", path: "v1/visits/mine/undo", permission: "analytics.manage", body: {} },
] as const);

/**
 * Every public route, under `{mount}/` — a company's own pages here mount it
 * at /api/t/{web address}/website/, and the keyed endpoint every company's
 * own website calls at /api/w/. `collect` always answers 204; `script` is the
 * snippet's script.
 */
export const ANALYTICS_PUBLIC_ROUTES: readonly AnalyticsRoute<AnalyticsPublicRouteKind>[] = freeze([
  { kind: "collect", method: "POST", path: "v1/collect", permission: null, body: { t: "pageview", d: "isolationprobe1", p: "/" } },
  { kind: "script", method: "GET", path: "v1/beacon.js", permission: null },
] as const);

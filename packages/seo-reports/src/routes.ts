import type { SeoReportsPermission } from "./permissions.js";

/**
 * One route of the search check handlers, as data (the Tenancy 2a route-table
 * shape). The package's tests read it back; a generated companies project's
 * isolation proof drives every row as ANOTHER company. Declared here, never
 * imported from a shared package.
 */
export interface SeoReportsRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/checks/{site-check}". */
  readonly path: string;
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body its schema accepts. */
  readonly body?: unknown;
}

export type SeoReportsAdminRouteKind = "checks" | "check" | "check-now";

export const SEO_REPORTS_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<SeoReportsAdminRouteKind, SeoReportsPermission>> = {
  checks: "seo_reports.view",
  check: "seo_reports.view",
  "check-now": "seo_reports.run",
};

function freeze<T extends readonly SeoReportsRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Every private route, under `{mount}/` (a companies project mounts it at
 * /api/app/{company id}/search-check/). The one entity is `{site-check}`, a
 * check of the company's own: another company's is "not found".
 */
export const SEO_REPORTS_ADMIN_ROUTES: readonly SeoReportsRoute<SeoReportsAdminRouteKind>[] = freeze([
  { kind: "checks", method: "GET", path: "v1/checks", permission: "seo_reports.view" },
  { kind: "check", method: "GET", path: "v1/checks/{site-check}", permission: "seo_reports.view" },
  { kind: "check-now", method: "POST", path: "v1/checks", permission: "seo_reports.run", body: {} },
] as const);

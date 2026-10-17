import type { AudiencePermission } from "./permissions.js";

/**
 * One route of the audience handlers, as data (the Tenancy 2a route-table
 * shape, 3.1): the package's tests read it back, and a generated companies
 * project's isolation proof drives every row as ANOTHER company.
 */
export interface AudienceRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/rules/{rule}/remove". */
  readonly path: string;
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body its schema accepts. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type AudienceRouteKind = "rules" | "rule-preview" | "rule-add" | "rule-remove";

export const AUDIENCE_ROUTE_PERMISSIONS: Readonly<Record<AudienceRouteKind, AudiencePermission>> = {
  rules: "audience.manage",
  "rule-preview": "audience.manage",
  "rule-add": "audience.manage",
  "rule-remove": "audience.manage",
};

function freeze<T extends readonly AudienceRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Every route, under `{mount}/` (a companies project mounts it at
 * /api/app/{company id}/audience/). The one entity is `{rule}`: a rule of
 * another company's is "not found", like one that never existed.
 */
export const AUDIENCE_ADMIN_ROUTES: readonly AudienceRoute<AudienceRouteKind>[] = freeze([
  { kind: "rules", method: "GET", path: "v1/rules", permission: "audience.manage" },
  {
    kind: "rule-preview",
    method: "POST",
    path: "v1/rules/preview",
    permission: "audience.manage",
    body: { kind: "email", value: "probe@isolation-probe.example" },
  },
  {
    kind: "rule-add",
    method: "POST",
    path: "v1/rules",
    permission: "audience.manage",
    body: { kind: "email_domain", value: "isolation-probe.example" },
  },
  { kind: "rule-remove", method: "POST", path: "v1/rules/{rule}/remove", permission: "audience.manage", body: {} },
] as const);

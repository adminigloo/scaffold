import type { AeoPermission } from "./permissions.js";

/**
 * One route of the AI mentions handlers, as data (the Tenancy 2a route-table
 * shape). The package's tests read it back; a generated companies project's
 * isolation proof drives every row as ANOTHER company. Declared here, never
 * imported from a shared package.
 */
export interface AeoRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/questions/{question}". */
  readonly path: string;
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body its schema accepts. */
  readonly body?: unknown;
}

export type AeoAdminRouteKind = "overview" | "profile" | "question-add" | "question" | "question-remove" | "question-check" | "check";

export const AEO_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<AeoAdminRouteKind, AeoPermission>> = {
  overview: "aeo.view",
  profile: "aeo.manage",
  "question-add": "aeo.manage",
  question: "aeo.view",
  "question-remove": "aeo.manage",
  "question-check": "aeo.manage",
  check: "aeo.manage",
};

function freeze<T extends readonly AeoRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Every private route, under `{mount}/` (a companies project mounts it at
 * /api/app/{company id}/ai-mentions/). The one entity is `{question}`, one of
 * the company's own questions: another company's is "not found".
 */
export const AEO_ADMIN_ROUTES: readonly AeoRoute<AeoAdminRouteKind>[] = freeze([
  { kind: "overview", method: "GET", path: "v1/mentions", permission: "aeo.view" },
  { kind: "profile", method: "POST", path: "v1/profile", permission: "aeo.manage", body: { brand: "Isolation probe business" } },
  { kind: "question-add", method: "POST", path: "v1/questions", permission: "aeo.manage", body: { question: "isolation probe question" } },
  { kind: "question", method: "GET", path: "v1/questions/{question}", permission: "aeo.view" },
  { kind: "question-check", method: "POST", path: "v1/questions/{question}/check", permission: "aeo.manage", body: {} },
  { kind: "check", method: "POST", path: "v1/check", permission: "aeo.manage", body: {} },
  { kind: "question-remove", method: "POST", path: "v1/questions/{question}/remove", permission: "aeo.manage", body: {} },
] as const);

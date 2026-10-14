import type { SchedulingPermission } from "./permissions.js";

/**
 * The scheduling handlers' routes, as data (Tenancy 2a, 3.1). The package's
 * own tests call `handle` once per row and assert it routed to that kind and
 * that each example reaches its row lookup; the emitted isolation proof
 * (create-app section 12) drives every row as another company and expects
 * not-found, or nothing of the first company, from each.
 *
 * Declared here, never imported from a shared package (D4).
 */
export interface SchedulingRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/visits/{visit}/accept". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  /** Query parameters to send: literal values, or a placeholder like "{resource}". */
  readonly query?: Readonly<Record<string, string>>;
  /** A minimal valid JSON body for a POST: enough to get past the body's zod schema to the row lookup. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type SchedulingAdminRouteKind =
  | "calendar"
  | "crew-day"
  | "health"
  | "people"
  | "progress"
  | "suggest"
  | "visit-create"
  | "visit-get"
  | "accept"
  | "decline"
  | "status"
  | "reschedule"
  | "assign"
  | "details"
  | "expire"
  | "settings-get"
  | "settings-update"
  | "resources-list"
  | "resource-create"
  | "resource-update"
  | "resource-deactivate"
  | "resource-reactivate"
  | "availability-get"
  | "availability-set"
  | "time-off-add"
  | "time-off-remove";

export type SchedulingPublicRouteKind = "config" | "slots" | "request" | "visit" | "reschedule" | "cancel" | "ics";

/** The permission each staff route asks for — the contract's table, as data (the tests read it back). */
export const SCHEDULING_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<SchedulingAdminRouteKind, SchedulingPermission>> = {
  calendar: "schedule.view",
  // A crew member's own day. Another crew's day ALSO needs schedule.view
  // (asked in the route), so a crew-only login sees its own stops and no one
  // else's customers.
  "crew-day": "schedule.route",
  health: "schedule.view",
  people: "schedule.resources.manage",
  // Start / complete / couldn't-do / undo on a stop of the caller's OWN crew;
  // any other crew's stop also needs schedule.manage (asked in the route).
  progress: "schedule.route",
  suggest: "schedule.view",
  "visit-create": "schedule.manage",
  "visit-get": "schedule.view",
  accept: "schedule.manage",
  decline: "schedule.manage",
  status: "schedule.manage",
  reschedule: "schedule.manage",
  assign: "schedule.manage",
  details: "schedule.manage",
  expire: "schedule.manage",
  "settings-get": "schedule.view",
  "settings-update": "schedule.resources.manage",
  "resources-list": "schedule.view",
  "resource-create": "schedule.resources.manage",
  "resource-update": "schedule.resources.manage",
  "resource-deactivate": "schedule.resources.manage",
  "resource-reactivate": "schedule.resources.manage",
  "availability-get": "schedule.view",
  "availability-set": "schedule.resources.manage",
  "time-off-add": "schedule.resources.manage",
  "time-off-remove": "schedule.resources.manage",
};

function freeze<T extends readonly SchedulingRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Entities: `{resource}` (a crew), `{visit}`, `{time-off}` (a day off on a
 * crew), `{visit-token}` (a customer's manage token). A placeholder in the
 * PATH means the route reads that row (another company's row → 404); one
 * only in the query or body is a reference (any answer below 500 that says
 * nothing of the other company).
 */
export const SCHEDULING_ADMIN_ROUTES: readonly SchedulingRoute<SchedulingAdminRouteKind>[] = freeze([
  { kind: "calendar", method: "GET", path: "v1/admin/calendar", permission: "schedule.view", query: { resources: "{resource}" } },
  { kind: "crew-day", method: "GET", path: "v1/admin/crew-day", permission: "schedule.route", query: { resource: "{resource}" } },
  { kind: "health", method: "GET", path: "v1/admin/status", permission: "schedule.view" },
  { kind: "people", method: "GET", path: "v1/admin/people", permission: "schedule.resources.manage" },
  { kind: "progress", method: "POST", path: "v1/admin/visits/{visit}/progress", permission: "schedule.route", body: { status: "in_progress" } },
  { kind: "suggest", method: "GET", path: "v1/admin/suggest", permission: "schedule.view", query: { minutes: "60", resource: "{resource}" } },
  {
    kind: "visit-create",
    method: "POST",
    path: "v1/admin/visits",
    permission: "schedule.manage",
    body: { resourceId: "{resource}", date: "2031-03-03", startTime: "09:00", customerName: "Isolation Probe" },
  },
  { kind: "visit-get", method: "GET", path: "v1/admin/visits/{visit}", permission: "schedule.view" },
  { kind: "accept", method: "POST", path: "v1/admin/visits/{visit}/accept", permission: "schedule.manage", body: {} },
  { kind: "decline", method: "POST", path: "v1/admin/visits/{visit}/decline", permission: "schedule.manage", body: {} },
  { kind: "status", method: "POST", path: "v1/admin/visits/{visit}/status", permission: "schedule.manage", body: { status: "confirmed" } },
  {
    kind: "reschedule",
    method: "POST",
    path: "v1/admin/visits/{visit}/reschedule",
    permission: "schedule.manage",
    body: { date: "2031-03-04", startTime: "10:00" },
  },
  { kind: "assign", method: "POST", path: "v1/admin/visits/{visit}/assign", permission: "schedule.manage", body: { resourceId: "{resource}" } },
  { kind: "details", method: "POST", path: "v1/admin/visits/{visit}/details", permission: "schedule.manage", body: { notes: "probe" } },
  { kind: "expire", method: "POST", path: "v1/admin/expire", permission: "schedule.manage", body: {} },
  { kind: "settings-get", method: "GET", path: "v1/admin/settings", permission: "schedule.view" },
  { kind: "settings-update", method: "POST", path: "v1/admin/settings", permission: "schedule.resources.manage", body: { slotStepMinutes: 30 } },
  { kind: "resources-list", method: "GET", path: "v1/admin/resources", permission: "schedule.view" },
  { kind: "resource-create", method: "POST", path: "v1/admin/resources", permission: "schedule.resources.manage", body: { name: "Probe crew" } },
  {
    kind: "resource-update",
    method: "POST",
    path: "v1/admin/resources/{resource}",
    permission: "schedule.resources.manage",
    body: { name: "Renamed crew" },
  },
  {
    kind: "resource-deactivate",
    method: "POST",
    path: "v1/admin/resources/{resource}/deactivate",
    permission: "schedule.resources.manage",
    body: {},
  },
  {
    kind: "resource-reactivate",
    method: "POST",
    path: "v1/admin/resources/{resource}/reactivate",
    permission: "schedule.resources.manage",
    body: {},
  },
  { kind: "availability-get", method: "GET", path: "v1/admin/resources/{resource}/availability", permission: "schedule.view" },
  {
    kind: "availability-set",
    method: "POST",
    path: "v1/admin/resources/{resource}/availability",
    permission: "schedule.resources.manage",
    body: { weekly: [] },
  },
  {
    kind: "time-off-add",
    method: "POST",
    path: "v1/admin/resources/{resource}/time-off",
    permission: "schedule.resources.manage",
    body: { from: "2031-03-03", to: "2031-03-03" },
  },
  {
    kind: "time-off-remove",
    method: "POST",
    path: "v1/admin/resources/{resource}/time-off/{time-off}/remove",
    permission: "schedule.resources.manage",
    body: {},
  },
] as const);

export const SCHEDULING_PUBLIC_ROUTES: readonly SchedulingRoute<SchedulingPublicRouteKind>[] = freeze([
  { kind: "config", method: "GET", path: "v1/config", permission: null },
  { kind: "slots", method: "GET", path: "v1/slots", permission: null, query: { manage: "{visit-token}" } },
  {
    kind: "request",
    method: "POST",
    path: "v1/request",
    permission: null,
    body: { slotId: "probe", service: "visit", name: "Isolation Probe", email: "probe@isolation.test", fillMs: 5000 },
  },
  { kind: "visit", method: "GET", path: "v1/visit/{visit-token}", permission: null },
  { kind: "reschedule", method: "POST", path: "v1/visit/{visit-token}/reschedule", permission: null, body: { slotId: "probe" } },
  { kind: "cancel", method: "POST", path: "v1/visit/{visit-token}/cancel", permission: null, body: {} },
  { kind: "ics", method: "GET", path: "v1/visit/{visit-token}/ics", permission: null },
] as const);

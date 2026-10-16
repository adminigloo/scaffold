import type { FeedbackPermission } from "./permissions.js";

/**
 * The feedback handlers' routes, as data (Tenancy 2a, 3.1). The package's own
 * tests call `handle` once per row and assert it routed to that kind and that
 * each example reaches its row lookup; the emitted isolation proof
 * (create-app, feature-isolation.test.ts) drives every row as another company
 * and expects not-found, or nothing of the first company, from each.
 *
 * Declared here, never imported from a shared package (2a D4): every feature
 * package carries the same structural shape.
 */
export interface FeedbackRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/tickets/{ticket}/move". */
  readonly path: string;
  /** The permission `authorize` is asked for (private routes); null on public routes. */
  readonly permission: string | null;
  /** Query parameters to send: literal values, or a placeholder like "{ticket}". */
  readonly query?: Readonly<Record<string, string>>;
  /**
   * A minimal valid body for a POST: enough to get past the body's zod schema
   * to the row lookup. Placeholders allowed in string values. `{ multipart:
   * "file" }` is a file upload (the proof sends a one-pixel image).
   */
  readonly body?: unknown;
}

export type FeedbackAdminRouteKind =
  | "board"
  | "ticket-get"
  | "messages"
  | "reply"
  | "assign"
  | "move"
  | "move-many"
  | "archive"
  | "unarchive"
  | "archive-done"
  | "read"
  | "columns"
  | "column-create"
  | "column-update"
  | "column-delete"
  | "columns-order"
  | "categories"
  | "category-create"
  | "category-update"
  | "category-delete"
  | "categories-order"
  | "keys"
  | "key-issue"
  | "key-revoke";

export type FeedbackPublicRouteKind = "config" | "upload" | "submit" | "thread" | "reply";

/** The permission each staff route asks for, as data (the tests read it back against the table). */
export const FEEDBACK_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<FeedbackAdminRouteKind, FeedbackPermission>> = Object.freeze({
  board: "feedback.view",
  "ticket-get": "feedback.view",
  messages: "feedback.view",
  reply: "feedback.manage",
  assign: "feedback.manage",
  move: "feedback.manage",
  "move-many": "feedback.manage",
  archive: "feedback.manage",
  unarchive: "feedback.manage",
  "archive-done": "feedback.manage",
  // Opening a ticket IS reading it: the unread mark clears for whoever may
  // see the board, the way an inbox clears by looking.
  read: "feedback.view",
  // The columns as the board shows them: anyone who sees the board.
  columns: "feedback.view",
  "column-create": "feedback.settings.manage",
  "column-update": "feedback.settings.manage",
  "column-delete": "feedback.settings.manage",
  "columns-order": "feedback.settings.manage",
  categories: "feedback.view",
  "category-create": "feedback.settings.manage",
  "category-update": "feedback.settings.manage",
  "category-delete": "feedback.settings.manage",
  "categories-order": "feedback.settings.manage",
  // Even the list: a key's label and when it was made say which websites
  // carry the company's button, which is the settings holder's business.
  keys: "feedback.settings.manage",
  "key-issue": "feedback.settings.manage",
  "key-revoke": "feedback.settings.manage",
});

function freeze<T extends readonly FeedbackRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Entities: `{ticket}` (a ticket on the company's board), `{column}` (one of
 * its columns), `{category}` (one of its categories), `{feedback-key}` (one
 * of its website keys). A placeholder in the PATH means the route reads that
 * row (another company's → 404); one only in the body is a reference (any
 * answer below 500 that says nothing of the other company).
 */
export const FEEDBACK_ADMIN_ROUTES: readonly FeedbackRoute<FeedbackAdminRouteKind>[] = freeze([
  { kind: "board", method: "GET", path: "v1/admin/board", permission: "feedback.view", query: { archived: "1" } },
  { kind: "ticket-get", method: "GET", path: "v1/admin/tickets/{ticket}", permission: "feedback.view" },
  { kind: "messages", method: "GET", path: "v1/admin/tickets/{ticket}/messages", permission: "feedback.view" },
  { kind: "reply", method: "POST", path: "v1/admin/tickets/{ticket}/messages", permission: "feedback.manage", body: { body: "Isolation probe reply" } },
  { kind: "assign", method: "POST", path: "v1/admin/tickets/{ticket}/assign", permission: "feedback.manage", body: { assignee: "Probe" } },
  { kind: "move", method: "POST", path: "v1/admin/tickets/{ticket}/move", permission: "feedback.manage", body: { status: "in_progress" } },
  {
    kind: "move-many",
    method: "POST",
    path: "v1/admin/tickets/move",
    permission: "feedback.manage",
    body: { ticketIds: ["{ticket}"], status: "in_progress" },
  },
  { kind: "archive", method: "POST", path: "v1/admin/tickets/{ticket}/archive", permission: "feedback.manage", body: {} },
  { kind: "unarchive", method: "POST", path: "v1/admin/tickets/{ticket}/unarchive", permission: "feedback.manage", body: {} },
  { kind: "archive-done", method: "POST", path: "v1/admin/archive-done", permission: "feedback.manage", body: {} },
  { kind: "read", method: "POST", path: "v1/admin/tickets/{ticket}/read", permission: "feedback.view", body: {} },
  { kind: "columns", method: "GET", path: "v1/admin/columns", permission: "feedback.view" },
  {
    kind: "column-create",
    method: "POST",
    path: "v1/admin/columns",
    permission: "feedback.settings.manage",
    body: { key: "probe_column", label: "Probe column" },
  },
  { kind: "column-update", method: "POST", path: "v1/admin/columns/{column}", permission: "feedback.settings.manage", body: { label: "Renamed" } },
  { kind: "column-delete", method: "POST", path: "v1/admin/columns/{column}/delete", permission: "feedback.settings.manage", body: {} },
  { kind: "columns-order", method: "POST", path: "v1/admin/columns-order", permission: "feedback.settings.manage", body: { ids: ["{column}"] } },
  { kind: "categories", method: "GET", path: "v1/admin/categories", permission: "feedback.view" },
  {
    kind: "category-create",
    method: "POST",
    path: "v1/admin/categories",
    permission: "feedback.settings.manage",
    body: { key: "probe_category", label: "Probe category" },
  },
  {
    kind: "category-update",
    method: "POST",
    path: "v1/admin/categories/{category}",
    permission: "feedback.settings.manage",
    body: { label: "Renamed" },
  },
  {
    kind: "category-delete",
    method: "POST",
    path: "v1/admin/categories/{category}/delete",
    permission: "feedback.settings.manage",
    body: {},
  },
  {
    kind: "categories-order",
    method: "POST",
    path: "v1/admin/categories-order",
    permission: "feedback.settings.manage",
    body: { ids: ["{category}"] },
  },
  { kind: "keys", method: "GET", path: "v1/admin/keys", permission: "feedback.settings.manage" },
  { kind: "key-issue", method: "POST", path: "v1/admin/keys", permission: "feedback.settings.manage", body: { label: "Probe website" } },
  { kind: "key-revoke", method: "POST", path: "v1/admin/keys/{feedback-key}/revoke", permission: "feedback.settings.manage", body: {} },
] as const);

/**
 * The intake (what a reporter's widget calls). Entities: `{ticket-number}`
 * and `{ticket-token}` (a reporter's follow-up pair), body references only —
 * a reporter's thread is looked up by the pair INSIDE the company the request
 * names, so another company's pair is "not found".
 */
export const FEEDBACK_PUBLIC_ROUTES: readonly FeedbackRoute<FeedbackPublicRouteKind>[] = freeze([
  { kind: "config", method: "GET", path: "v1/config", permission: null },
  { kind: "upload", method: "POST", path: "v1/upload", permission: null, body: { multipart: "file" } },
  {
    kind: "submit",
    method: "POST",
    path: "v1/submit",
    permission: null,
    body: {
      description: "Isolation probe: a report from the proof.",
      priority: "low",
      clientMetadata: {
        browser: "Probe",
        os: "Probe",
        viewport: { width: 1, height: 1 },
        url: "http://localhost/probe",
        pathname: "/probe",
        clickTrail: [],
        sessionId: "probe",
        capturedAt: 0,
      },
    },
  },
  {
    kind: "thread",
    method: "POST",
    path: "v1/thread",
    permission: null,
    body: { ticketNumber: "{ticket-number}", ticketToken: "{ticket-token}" },
  },
  {
    kind: "reply",
    method: "POST",
    path: "v1/reply",
    permission: null,
    body: { ticketNumber: "{ticket-number}", ticketToken: "{ticket-token}", body: "Isolation probe reply" },
  },
] as const);

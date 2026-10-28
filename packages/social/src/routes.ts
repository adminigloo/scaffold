import type { SocialPermission } from "./permissions.js";

/**
 * Every route of the posts screen's handler, as data (social 0.1). The
 * package tests read it back, and a companies project's isolation proof
 * (create-app) drives every row as another company.
 */
export interface SocialRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  /** Relative to the handler's mount, e.g. "v1/admin/posts/{post}/skip". */
  readonly path: string;
  readonly permission: SocialPermission;
  readonly query?: Readonly<Record<string, string>>;
  /** The smallest body the route accepts. Placeholders allowed in string values. */
  readonly body?: unknown;
}

export type SocialAdminRouteKind = "list" | "compose" | "approve" | "edit" | "posted" | "skip" | "approved" | "card-formats";

export const SOCIAL_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<SocialAdminRouteKind, SocialPermission>> = {
  list: "social.view",
  compose: "social.manage",
  approve: "social.manage",
  edit: "social.manage",
  posted: "social.manage",
  skip: "social.manage",
  approved: "social.view",
  "card-formats": "social.view",
};

function freeze<T extends readonly SocialRoute[]>(routes: T): T {
  for (const route of routes) Object.freeze(route);
  return Object.freeze(routes) as T;
}

/**
 * Entities: `{post}` (one of the company's drafts, on one platform). A
 * placeholder in the PATH means the route reads that row: another company's
 * is "not found". One in the BODY (approve's ids) is only ever matched inside
 * the company in the path, so another company's id changes nothing.
 */
export const SOCIAL_ADMIN_ROUTES: readonly SocialRoute<SocialAdminRouteKind>[] = freeze([
  // The queue as the page shows it: today, earlier drafts, ready to post, history.
  { kind: "list", method: "GET", path: "v1/admin/posts", permission: "social.view" },
  // A post from the person's own facts: one draft per platform.
  { kind: "compose", method: "POST", path: "v1/admin/compose", permission: "social.manage", body: { facts: "Isolation probe: open on Saturdays.", link: "" } },
  { kind: "approve", method: "POST", path: "v1/admin/approve", permission: "social.manage", body: { ids: ["{post}"] } },
  { kind: "edit", method: "POST", path: "v1/admin/posts/{post}", permission: "social.manage", body: { text: "Isolation probe", hook: "Isolation probe", firstComment: null } },
  { kind: "posted", method: "POST", path: "v1/admin/posts/{post}/posted", permission: "social.manage", body: { url: "https://example.com/isolation-probe" } },
  { kind: "skip", method: "POST", path: "v1/admin/posts/{post}/skip", permission: "social.manage", body: {} },
  // The posting session's list: every approved post with what to paste and attach.
  { kind: "approved", method: "GET", path: "v1/admin/approved", permission: "social.view" },
  // Every card format, as samples, in the company's own brand.
  { kind: "card-formats", method: "GET", path: "v1/admin/card-formats", permission: "social.view" },
] as const);

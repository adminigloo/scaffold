/**
 * The company's payments screen (/app/payments) as data: one route per row,
 * the way every per-company package publishes its routes, so a project's
 * isolation proof drives each one as another company (stripe 0.4).
 *
 * Mounted at `/api/app/{company id}/payments/`. No row names an entity: each
 * acts on the company in the path and nothing else.
 */
export interface StripeConnectRoute<K extends string = string> {
  readonly kind: K;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly permission: string | null;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export type StripeConnectAdminRouteKind = "status" | "connect" | "disconnect";

export const STRIPE_CONNECT_ADMIN_ROUTE_PERMISSIONS: Readonly<Record<StripeConnectAdminRouteKind, "payments.view" | "payments.manage">> = {
  status: "payments.view",
  connect: "payments.manage",
  disconnect: "payments.manage",
};

export const STRIPE_CONNECT_ADMIN_ROUTES: readonly StripeConnectRoute<StripeConnectAdminRouteKind>[] = Object.freeze(
  (
    [
      { kind: "status", method: "GET", path: "v1/admin/status", permission: "payments.view" },
      { kind: "connect", method: "POST", path: "v1/admin/connect", permission: "payments.manage", body: {} },
      { kind: "disconnect", method: "POST", path: "v1/admin/disconnect", permission: "payments.manage", body: {} },
    ] as const
  ).map((route) => Object.freeze(route)),
);

export { stripeConnectPermissions } from "./permissions.js";

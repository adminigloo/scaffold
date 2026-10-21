import type { StripeClient } from "./client.js";
import {
  accountTakesCharges,
  applyAccountUpdate,
  connectedAccountFor,
  describePlatformFee,
  disconnectConnectedAccount,
  platformFeeMinor,
  startConnectOnboarding,
  type StripeDb,
} from "./connect.js";
import { STRIPE_CONNECT_ADMIN_ROUTE_PERMISSIONS, type StripeConnectAdminRouteKind } from "./connect-routes.js";
import { describeStripeFailure, stripeFailureWire, stripeNotSetUp, type StripeFailure } from "./failure.js";

/**
 * The company's payments screen API (stripe 0.4), mounted at
 * `/api/app/{company id}/payments/`:
 *
 *   GET  v1/admin/status       connected? charges and payouts on? the fee
 *   POST v1/admin/connect      → { url }: Stripe's onboarding for this company
 *   POST v1/admin/disconnect   no new card payments
 *
 * Every route asks `authorize(req, permission, tenantId)` for its one key
 * (STRIPE_CONNECT_ADMIN_ROUTE_PERMISSIONS) before anything else; a `Response`
 * is returned as is, `false` is 403. Same-origin only. With no Stripe key on
 * the site, status says so and connect answers 409 — never a 500.
 *
 * WHEN STRIPE SAYS NO (stripe 0.5): every failure is reported (`onError`, with
 * what it means as `context.stripe`) and answered in the owner's words —
 * "Card payments aren't switched on for this site yet. We've told whoever runs
 * it." when the site's own Stripe setup is missing (not signed up for Connect,
 * a wrong or restricted key, no key), a try-again sentence when Stripe didn't
 * answer. The site's staff (`staffDetail`) also get Stripe's own sentence and
 * the link to fix it, as `error.staff`; nobody else ever does.
 */

export type ConnectAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateConnectAdminHandlersOptions {
  readonly db: StripeDb;
  /** The site's Stripe client; null when STRIPE_SECRET_KEY isn't set. */
  readonly stripe: () => StripeClient | null;
  readonly resolveTenant: (req: Request) => string | null | Promise<string | null>;
  readonly authorize: (req: Request, permission: string, tenantId: string) => ConnectAuthorizeResult | Promise<ConnectAuthorizeResult>;
  /** Absolute URLs back to the company's payments screen. */
  readonly returnUrl: (tenantId: string) => string | Promise<string>;
  readonly refreshUrl: (tenantId: string) => string | Promise<string>;
  /** PLATFORM_FEE_BPS: this site's cut of each payment, 0 for none. */
  readonly feeBps: number;
  /** The company's contact email, prefilled on Stripe's form. */
  readonly accountEmail?: (tenantId: string) => string | null | Promise<string | null>;
  /** Is the Connect webhook set up (STRIPE_CONNECT_WEBHOOK_SECRET)? Without it payments can't be recorded, so connect is refused. */
  readonly webhookReady: boolean;
  /** This site's name, for the owner's "contact {site}" when card payments aren't set up (never a variable's name). */
  readonly siteName: string;
  /** The owner disconnected: close the company's open payment pages (invoicing's `expireCompanyCheckouts`). */
  readonly onDisconnect?: (tenantId: string) => void | Promise<void>;
  /**
   * stripe 0.5: is the caller staff of the SITE (its operator)? They also read
   * Stripe's own message and where to fix it when a call fails. Default: nobody.
   */
  readonly staffDetail?: (req: Request) => boolean | Promise<boolean>;
  /** Every failure, with — when Stripe was involved — what it means (`stripe`): log it and put it where the operator reads errors. */
  readonly onError?: (error: unknown, context: { tenantId: string | null; route: string; stripe?: StripeFailure }) => void;
}

export interface PaymentsStatusWire {
  /** This site has a Stripe key and the Connect webhook. */
  configured: boolean;
  configuredReason: string | null;
  connected: boolean;
  disconnected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /** Customers see "Pay now" on their invoices. */
  takingPayments: boolean;
  feeBps: number;
  /** The fee on a $100.00 payment, in cents. */
  feeOn100: number;
  feeText: string;
  /** Which Stripe account is connected: its business name (or email) and the last 4 of its id. */
  account: { name: string | null; last4: string } | null;
  /** The connected account's own Stripe dashboard (payouts, refunds, disputes). */
  dashboardUrl: string;
}

/** Countries a company can connect from (Stripe asks for it once; it can't change later). */
export const CONNECT_COUNTRIES = ["US", "CA", "GB", "IE", "AU", "NZ"] as const;

const DASHBOARD_URL = "https://dashboard.stripe.com/";
const COUNTRY = /^[A-Z]{2}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function refuse(code: string, status: number, message: string): Response {
  return json({ error: { code, message } }, status);
}

function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return !["same-origin", "none"].includes(site.trim().toLowerCase());
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

function route(method: string, pathname: string): StripeConnectAdminRouteKind | null {
  const at = pathname.indexOf("/v1/admin/");
  if (at < 0) return null;
  const rest = pathname.slice(at + "/v1/admin/".length).replace(/\/+$/, "");
  if (rest === "status" && method === "GET") return "status";
  if (rest === "connect" && method === "POST") return "connect";
  if (rest === "disconnect" && method === "POST") return "disconnect";
  return null;
}

export function createConnectAdminHandlers(options: CreateConnectAdminHandlersOptions): { handle: (req: Request) => Promise<Response> } {
  const report = (error: unknown, tenantId: string | null, kind: string, stripe?: StripeFailure) => {
    try {
      options.onError?.(error, { tenantId, route: kind, ...(stripe ? { stripe } : {}) });
    } catch {
      /* never let a reporter break an answer */
    }
  };
  const isStaff = async (req: Request): Promise<boolean> => {
    try {
      return options.staffDetail ? (await options.staffDetail(req)) === true : false;
    } catch {
      return false;
    }
  };
  /** A failure in the owner's words, with Stripe's own for staff. */
  const failed = async (req: Request, found: StripeFailure): Promise<Response> => json({ error: stripeFailureWire(found, await isStaff(req)) }, found.status);
  // Plain words for an owner: what is missing is the site's to fix, so the
  // owner is told whom to ask — never the name of a setting.
  const notConfigured = (): string | null =>
    options.stripe() && options.webhookReady ? null : `Card payments aren't set up on this site yet — contact ${options.siteName}.`;

  async function status(tenantId: string): Promise<PaymentsStatusWire> {
    let row = await connectedAccountFor(options.db, tenantId);
    const client = options.stripe();
    // Back from Stripe's onboarding: read the account now, so the screen shows
    // "on" without waiting for the webhook. A failed read keeps the stored flags.
    if (row && row.disconnectedAt === null && client && !row.chargesEnabled) {
      try {
        await applyAccountUpdate(options.db, await client.stripe.accounts.retrieve(row.accountId), new Date());
        row = await connectedAccountFor(options.db, tenantId);
      } catch (error) {
        report(error, tenantId, "status", describeStripeFailure(error));
      }
    }
    const reason = notConfigured();
    return {
      configured: reason === null,
      configuredReason: reason,
      connected: row !== null && row.disconnectedAt === null,
      disconnected: row !== null && row.disconnectedAt !== null,
      chargesEnabled: row?.chargesEnabled ?? false,
      payoutsEnabled: row?.payoutsEnabled ?? false,
      detailsSubmitted: row?.detailsSubmitted ?? false,
      takingPayments: reason === null && accountTakesCharges(row),
      feeBps: options.feeBps,
      feeOn100: platformFeeMinor(10_000, options.feeBps),
      feeText: describePlatformFee(options.feeBps),
      account: row ? { name: row.displayName, last4: row.accountId.slice(-4) } : null,
      dashboardUrl: row ? `${DASHBOARD_URL}${encodeURIComponent(row.accountId)}/payouts` : DASHBOARD_URL,
    };
  }

  async function handle(req: Request): Promise<Response> {
    const kind = route(req.method, new URL(req.url).pathname);
    if (!kind) return refuse("not_found", 404, "There's nothing here.");
    if (req.method === "POST" && crossSite(req)) return refuse("cross_site", 403, "This request came from another site, so it was refused.");
    let tenantId: string | null = null;
    try {
      tenantId = await options.resolveTenant(req);
      if (!tenantId) return refuse("not_found", 404, "There's nothing here.");
      const verdict = await options.authorize(req, STRIPE_CONNECT_ADMIN_ROUTE_PERMISSIONS[kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (!verdict) return refuse("forbidden", 403, "You don't have permission to do that.");
      if (kind === "status") return json(await status(tenantId));
      if (kind === "disconnect") {
        await disconnectConnectedAccount(options.db, tenantId);
        try {
          await options.onDisconnect?.(tenantId);
        } catch (error) {
          report(error, tenantId, kind);
        }
        return json(await status(tenantId));
      }
      // The country the company's Stripe account is in (default the US).
      let country = "US";
      try {
        const body = (await req.json()) as { country?: unknown };
        if (typeof body?.country === "string" && COUNTRY.test(body.country.toUpperCase())) country = body.country.toUpperCase();
      } catch {
        /* no body: the default */
      }
      const client = options.stripe();
      if (!client || !options.webhookReady) {
        // The site's operator has to switch card payments on: tell them (the
        // error log), and tell the owner they have been.
        const found = stripeNotSetUp(!client ? "STRIPE_SECRET_KEY" : "STRIPE_CONNECT_WEBHOOK_SECRET");
        report(new Error(`Connect Stripe was pressed, but ${found.stripeMessage}`), tenantId, kind, found);
        return failed(req, found);
      }
      const scoped = tenantId;
      const { url } = await startConnectOnboarding(options.db, client, {
        tenantId: scoped,
        returnUrl: await options.returnUrl(scoped),
        refreshUrl: await options.refreshUrl(scoped),
        email: options.accountEmail ? await options.accountEmail(scoped) : null,
        country,
      });
      return json({ url });
    } catch (error) {
      const found = describeStripeFailure(error);
      report(error, tenantId, kind, found);
      return failed(req, found);
    }
  }

  return { handle };
}

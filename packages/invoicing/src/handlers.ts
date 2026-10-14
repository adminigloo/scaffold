import { and, eq } from "drizzle-orm";
import { moneyFormatOf, resolveInvoicingBusiness, type InvoicingBusiness, type ResolvedInvoicingBusiness } from "./business.js";
import {
  CROSS_SITE_MESSAGE,
  InvoicingHttpError,
  PUBLIC_NOT_FOUND,
  failure,
  isCrossSiteRequest,
  isExpected,
  json,
  readJsonBody,
  segmentsAfter,
} from "./http.js";
import { getInvoiceByToken, markInvoiceViewed, type InvoicingDb } from "./index.js";
import type { InvoicingPublicRouteKind } from "./routes.js";
import { invoices } from "./schema.js";
import type { BusinessWire, InvoiceStatusWire, PaymentMethodWire, PublicInvoiceResponse } from "./wire.js";

/**
 * The customer's side (Tenancy 2a, 10.5): `<InvoiceView>` opens an invoice by
 * its link, no account. Two routes under `{base}/v1/`:
 *
 *   GET  v1/invoice/{token}          the invoice, the business, how to show money
 *   POST v1/invoice/{token}/viewed   the page reports the customer opened it
 *
 *   // app/api/t/[slug]/invoices/[...path]/route.ts
 *   const { handle } = createInvoicingHandlers({ db, resolveTenant, admit, business });
 *   export { handle as GET, handle as POST };
 *
 * THE TOKEN RESOLVES INSIDE THE COMPANY THE URL NAMES (D13). Under
 * `/t/green-acres/…` a Summit token is "not available", exactly like a token
 * that doesn't exist: otherwise one company's page would show another's
 * invoice under its own name and branding.
 *
 * Every answer carries `referrer-policy: no-referrer` and `x-robots-tag:
 * noindex` (each URL carries the token) and `cache-control: no-store`. No
 * CORS: the page is the company's own, on this site.
 */

export type InvoicingAdmission = { readonly open: true } | { readonly open: false; readonly message: string };

export interface CreateInvoicingHandlersOptions {
  db: InvoicingDb;
  /** A fixed tenant (a single business). Pass this or `resolveTenant`. */
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /**
   * Is this business taking requests from the public right now? Asked once per
   * request, after the tenant is known and before any other work. A closed
   * answer is `409 unavailable` with its message (a suspended company's
   * customer is told to get in touch). Default: always open.
   */
  admit?: (tenantId: string, req: Request) => InvoicingAdmission | Promise<InvoicingAdmission>;
  business?: (tenantId: string) => InvoicingBusiness | null | Promise<InvoicingBusiness | null>;
  /** Your rate limit: false → 429. Default: none. */
  rateLimit?: (req: Request, bucket: "read" | "viewed") => boolean | Promise<boolean>;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export interface InvoicingHandlers {
  handle: (req: Request) => Promise<Response>;
}

/** Every public answer carries these: the URL is a key, and the page is nobody's search result. */
const PUBLIC_HEADERS: Readonly<Record<string, string>> = {
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
};

const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

function route(pathname: string): { kind: InvoicingPublicRouteKind; method: "GET" | "POST"; token: string } | null {
  const parts = segmentsAfter(pathname, "/v1/");
  if (!parts || parts[0] !== "invoice") return null;
  const token = parts[1] ?? "";
  if (parts.length === 2) return { kind: "invoice", method: "GET", token };
  if (parts.length === 3 && parts[2] === "viewed") return { kind: "viewed", method: "POST", token };
  return null;
}

function businessWire(b: ResolvedInvoicingBusiness): BusinessWire {
  return {
    name: b.name,
    logoUrl: b.logoUrl,
    brandColor: b.brandColor,
    contactEmail: b.contactEmail,
    contactPhone: b.contactPhone,
    paymentInstructions: b.paymentInstructions,
    footer: b.footer,
  };
}

export function createInvoicingHandlers(options: CreateInvoicingHandlersOptions): InvoicingHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createInvoicingHandlers: pass tenantId or resolveTenant");
  }
  const notFound = () => new InvoicingHttpError("not_found", 404, PUBLIC_NOT_FOUND);
  const report = (error: unknown, tenantId: string | null, kind: string) => {
    try {
      options.onError?.(error, { tenantId, route: kind });
    } catch {
      /* never let a reporter break an answer */
    }
  };
  const answer = (body: unknown, status = 200) => json(body, status, PUBLIC_HEADERS);
  const refuse = (error: unknown) => failure(error, PUBLIC_HEADERS);

  async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...PUBLIC_HEADERS } });
    const matched = route(new URL(req.url).pathname);
    if (!matched) return refuse(notFound());
    if (req.method !== matched.method) {
      return json({ error: { code: "invalid", message: `Use ${matched.method} for this address.` } }, 405, { allow: matched.method, ...PUBLIC_HEADERS });
    }
    if (req.method === "POST" && isCrossSiteRequest(req)) {
      return refuse(new InvoicingHttpError("cross_site", 403, CROSS_SITE_MESSAGE));
    }
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return refuse(notFound());
      // Admission before the rate limit and before any invoicing query (D7):
      // a suspended company's pages and its old links say so, and nothing
      // else happens.
      if (options.admit) {
        const admission = await options.admit(tenantId, req);
        if (!admission.open) return refuse(new InvoicingHttpError("unavailable", 409, admission.message));
      }
      if (options.rateLimit && !(await options.rateLimit(req, matched.kind === "viewed" ? "viewed" : "read"))) {
        return refuse(new InvoicingHttpError("rate_limited", 429, "Too many requests. Wait a minute and try again."));
      }
      if (!TOKEN_RE.test(matched.token)) return refuse(notFound());

      if (matched.kind === "viewed") {
        await readJsonBody(req);
        // 404 for a token that isn't this company's (or a draft), like the
        // GET, so a stranger's POST can't probe which tokens exist elsewhere.
        const [row] = (await options.db
          .select({ status: invoices.status })
          .from(invoices)
          .where(and(eq(invoices.viewToken, matched.token), eq(invoices.tenantId, tenantId)))
          .limit(1)) as Array<{ status: string }>;
        if (!row || row.status === "draft") return refuse(notFound());
        const viewed = await markInvoiceViewed(options.db, matched.token, { tenantId });
        return answer({ viewed });
      }

      const found = await getInvoiceByToken(options.db, matched.token, { tenantId });
      if (!found) return refuse(notFound());
      let business: ResolvedInvoicingBusiness;
      try {
        business = resolveInvoicingBusiness(options.business ? await options.business(tenantId) : null);
      } catch (error) {
        report(error, tenantId, matched.kind);
        business = resolveInvoicingBusiness(null);
      }
      const inv = found.invoice;
      const body: PublicInvoiceResponse = {
        invoice: {
          number: inv.invoiceNumber,
          status: inv.status as InvoiceStatusWire,
          customerName: inv.customerName,
          subtotal: inv.subtotal,
          discount: inv.discount,
          taxRateBp: inv.taxRateBp,
          taxAmount: inv.taxAmount,
          total: inv.total,
          amountPaid: inv.amountPaid,
          balanceDue: inv.balanceDue,
          dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
          issuedAt: inv.issuedAt.toISOString(),
          lines: found.items.map((line) => ({ ...line })),
          payments: found.payments.map((p) => ({
            amount: p.amount,
            method: (["card", "cash", "check", "ach", "other"].includes(p.method) ? p.method : "other") as PaymentMethodWire,
            paidAt: p.paidAt.toISOString(),
          })),
        },
        business: businessWire(business),
        format: moneyFormatOf(business),
      };
      return answer(body);
    } catch (error) {
      if (!isExpected(error)) report(error, tenantId, matched.kind);
      return refuse(error);
    }
  }

  return { handle };
}

import { buildInvoicingPublicHandlers } from "@/server/invoicing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The customer's invoice page API: /invoice/[token] calls
 * /api/invoices/v1/invoice/:token, and …/viewed when the customer opens it
 * (never the GET, so a link preview doesn't count). The token is the whole
 * key; a draft is "not available". Every answer carries no-referrer and
 * noindex; no CORS.
 */
const { handle } = buildInvoicingPublicHandlers();

export const GET = handle;
export const POST = handle;

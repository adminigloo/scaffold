import { buildInvoicingPublicHandlers } from "@/server/invoicing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's invoice page API: /t/{web address}/invoice/[token] calls
 * /api/t/{web address}/invoices/v1/invoice/:token (and …/viewed when the
 * customer opens it — never the GET, so a link preview doesn't count).
 *
 * The token is read INSIDE the company whose web address is in the path: a
 * token from another company's invoice is "not available" here, never that
 * company's invoice under this one's name (D13). Every answer carries
 * no-referrer and noindex; no CORS.
 */
const { handle } = buildInvoicingPublicHandlers();

export const GET = handle;
export const POST = handle;

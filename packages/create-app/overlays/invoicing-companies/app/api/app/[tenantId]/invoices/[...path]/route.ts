import { buildInvoicingAdminHandlers } from "@/server/invoicing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A company's own ledger, for its screens: /app/invoices and one invoice's
 * page call /api/app/{company id}/invoices/v1/admin/….
 *
 * THE COMPANY IS THE ONE IN THE PATH, asked on every call whether the caller
 * is signed in, a member, not suspended and holding the route's key
 * (`invoices.view` to look, `invoices.manage` to raise and send,
 * `invoices.payments.record` / `.reverse` for the money). Totals are the
 * package's — the browser never sends a figure it made up. Never cross-origin.
 */
const { handle } = buildInvoicingAdminHandlers();

export const GET = handle;
export const POST = handle;

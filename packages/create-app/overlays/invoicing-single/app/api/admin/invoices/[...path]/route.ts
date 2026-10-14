import { buildInvoicingAdminHandlers } from "@/server/invoicing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The business's ledger, for the staff screens: /admin/invoices and one
 * invoice's page call /api/admin/invoices/v1/admin/….
 *
 * The package's handlers (Tenancy 2a, D3) — the same ones every company of a
 * companies project runs on — behind THIS project's sign-in and staff keys:
 * `staff.invoices.view` to look, `staff.invoices.manage` to raise, send and
 * take payments (src/server/invoicing.ts). Signed out is a 401; not staff, or
 * staff without the key, a 403. Never cross-origin.
 */
const { handle } = buildInvoicingAdminHandlers();

export const GET = handle;
export const POST = handle;

import { buildWebsiteBeaconHandlers } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * EVERY WEBSITE'S visit counter (Tenancy 2b-4a): the one line a business
 * pastes on its own website loads /api/w/v1/beacon.js, which posts to
 * /api/w/v1/collect?site={its key}.
 *
 * The key is public (it is in the website's page source): it says WHICH
 * website, and a visit counts only when the page it came from is on one of
 * that website's addresses — a copied snippet on someone else's site counts
 * nothing. Always 204 for the beacon.
 */
const { handle } = buildWebsiteBeaconHandlers();

export const GET = handle;
export const POST = handle;

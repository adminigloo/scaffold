import { buildCompanyBeaconHandlers } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A __TENANT_LABEL_LOWER__'s pages' visit counter: every /t/{web address} page posts to
 * /api/t/{web address}/website/v1/collect. The web address names the
 * __TENANT_LABEL_LOWER__; a suspended one, or one whose plan ended, isn't counted. Always
 * 204, so it says nothing to anyone probing it.
 */
const { handle } = buildCompanyBeaconHandlers();

export const GET = handle;
export const POST = handle;

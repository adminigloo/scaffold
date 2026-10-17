import { buildSiteBeaconHandlers } from "@/server/website";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THIS SITE'S OWN visit counter (Tenancy 2b-4a): the beacon on every page of
 * the (site) layout posts to /api/analytics/v1/collect.
 *
 * Always 204 — a refused origin, a privacy signal, a bot, a throttled network
 * and a counted page view look the same from outside, so the endpoint is no
 * oracle for what it accepts. Only a page on this deployment is counted.
 */
const { handle } = buildSiteBeaconHandlers();

export const GET = handle;
export const POST = handle;

import { BEACON_SCRIPT } from "./beacon-script.js";
import { errorResponse, NOT_HERE, segmentsAfter } from "./http.js";
import type { AnalyticsHandlerConfig } from "./ingest.js";
import type { Analytics } from "./instance.js";
import type { ResolvedSite } from "./websites.js";

/**
 * THE PUBLIC SIDE (0.3): the beacon endpoint and the snippet's script, every
 * route under `{mount}/v1/` (ANALYTICS_PUBLIC_ROUTES):
 *
 *   POST v1/collect     the beacon (always 204 — see `createHandler`)
 *   GET  v1/beacon.js   the script a website of the company's own loads
 *
 * Two mounts in a companies project, one handler shape:
 *
 *   /api/t/{web address}/website/   a company's pages here: `resolveSite`
 *                                   names the company from the web address,
 *                                   and the page must be on this deployment
 *   /api/w/                         every company's own website: the site
 *                                   key names the website (`analytics.siteResolver`)
 *
 * The plan and suspension gate rides `resolveSite`: a company that isn't
 * taking requests resolves to null, and its beacons are dropped.
 */

export interface CreateAnalyticsPublicHandlersOptions extends Omit<AnalyticsHandlerConfig, "tenantId" | "allowedHosts" | "resolveSite"> {
  analytics: Analytics;
  /** Whose beacon this is, per request — see `AnalyticsHandlerConfig.resolveSite`. */
  resolveSite: (req: Request) => ResolvedSite | null | Promise<ResolvedSite | null>;
  /** How long a browser may keep the script, in seconds. Default 3600 (an hour: a fix reaches every website within it). */
  scriptMaxAge?: number;
}

export interface AnalyticsPublicHandlers {
  handle: (req: Request) => Promise<Response>;
}

export function createAnalyticsPublicHandlers(options: CreateAnalyticsPublicHandlersOptions): AnalyticsPublicHandlers {
  const { analytics, scriptMaxAge = 3600, ...config } = options;
  const beacon = analytics.createHandler(config);
  return {
    async handle(req: Request): Promise<Response> {
      const parts = segmentsAfter(new URL(req.url).pathname, "/v1/");
      const [a] = parts ?? [];
      if (parts?.length === 1 && a === "collect") return beacon.handle(req);
      if (parts?.length === 1 && a === "beacon.js" && (req.method === "GET" || req.method === "HEAD")) {
        return new Response(req.method === "HEAD" ? null : BEACON_SCRIPT, {
          status: 200,
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "cache-control": `public, max-age=${Math.max(0, Math.floor(scriptMaxAge))}`,
            // Any website may load it: that is what it is for. It reads nothing.
            "cross-origin-resource-policy": "cross-origin",
            "x-content-type-options": "nosniff",
          },
        });
      }
      return errorResponse("not_found", 404, NOT_HERE);
    },
  };
}

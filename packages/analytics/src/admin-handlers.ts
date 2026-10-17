import { z } from "zod";
import { isAnalyticsError } from "./context.js";
import { websiteSnippet } from "./beacon-script.js";
import {
  AnalyticsHttpError,
  CROSS_SITE_MESSAGE,
  errorResponse,
  INTERNAL_MESSAGE,
  isCrossSiteRequest,
  isIdShaped,
  json,
  MANAGE_FORBIDDEN_MESSAGE,
  NOT_HERE,
  readJsonBody,
  segmentsAfter,
  VIEW_FORBIDDEN_MESSAGE,
} from "./http.js";
import type { Analytics } from "./instance.js";
import type { AnalyticsPermission } from "./permissions.js";
import { buildWebsiteReport, reportDaysOf } from "./report.js";
import { ANALYTICS_ADMIN_ROUTE_PERMISSIONS, type AnalyticsAdminRouteKind } from "./routes.js";
import { websiteLimitSentence, type Website, type WebsiteAddressRules } from "./websites.js";
import type { MineWire, WebsiteFilterWire, WebsitesWire, WebsiteWire } from "./wire.js";

/**
 * A COMPANY'S WEBSITE NUMBERS AND ITS WEBSITES (0.3): one fetch handler for
 * the traffic report, the site register and "these are my visits", every
 * route under `{mount}/v1/` (ANALYTICS_ADMIN_ROUTES):
 *
 *   // app/api/app/[tenantId]/website/[...path]/route.ts
 *   const { handle } = createAnalyticsAdminHandlers({ analytics, resolveTenant, authorize, scriptUrl, clientIp });
 *   export { handle as GET, handle as POST };
 *
 * WHOSE COMPANY: the id in the PATH (`resolveTenant`), asked of `authorize`
 * for the route's one permission on every call — never the session's active
 * company. Everything after that is that company's: its reports read only
 * its rows, and a website id of another company's is "not found", exactly
 * like one that never existed.
 *
 * Seams, so it installs in an app built differently: `resolveTenant` (whose
 * company), `authorize` (may this person, here — a Response is returned as it
 * is, `false` is 403), `timeZone` (the company's), `websiteLimit` (its plan's
 * websites), `ownPages` (what its pages here are called), `clientIp` (the
 * same IP the beacon's handler reads, for "these are my visits").
 */

export type AnalyticsAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateAnalyticsAdminHandlersOptions {
  analytics: Analytics;
  /** One fixed tenant (a single site, or this site's own numbers). Pass this or `resolveTenant`. */
  tenantId?: string;
  /** The company a request is for — in a companies project, the id in the PATH. null → "not found". */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** May this person do this, in this company? `analytics.view` or `analytics.manage`. */
  authorize: (
    req: Request,
    permission: AnalyticsPermission,
    tenantId: string,
  ) => AnalyticsAuthorizeResult | Promise<AnalyticsAuthorizeResult>;
  /** The zone the report's days are drawn in: the company's own. Default UTC. */
  timeZone?: string | ((tenantId: string) => string | null | Promise<string | null>);
  /**
   * The snippet's script, absolute: `{app}/api/w/v1/beacon.js`. Null (no
   * public address yet): the websites list shows no line to paste, and
   * `onError` hears about it once (a setup step for whoever runs the app,
   * never a sentence on an owner's screen).
   */
  scriptUrl?: string | null;
  /**
   * Addresses a company's website may not have: the app's own (its pages
   * here are already counted) and, on a deployed app, a laptop's
   * (`local: true`). Refused in words when a website is added or changed.
   */
  addressRules?: WebsiteAddressRules | ((req: Request) => WebsiteAddressRules);
  /** The most websites a company may have (its plan's). A number: the limit; null/undefined: none. */
  websiteLimit?: (tenantId: string) => number | null | undefined | Promise<number | null | undefined>;
  /** The company's own pages here: what to call them and their address (always counted, never in the register). */
  ownPages?: (tenantId: string) => { label: string; url: string | null } | Promise<{ label: string; url: string | null }>;
  /** The client IP, exactly as the beacon's handler reads it — "these are my visits" marks that device's keys. */
  clientIp?: (req: Request) => string | null;
  /** The beacon handler's `timeZone` (the day its salts rotate on). Default UTC. */
  saltTimeZone?: string;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export interface AnalyticsAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

interface Matched {
  kind: AnalyticsAdminRouteKind;
  id?: string;
}

/** The route a path names for a method; null for an unknown one. */
function route(pathname: string, method: string): Matched | null {
  const parts = segmentsAfter(pathname, "/v1/");
  if (!parts) return null;
  const get = method === "GET" || method === "HEAD";
  const post = method === "POST";
  const [a, b, c] = parts;
  const n = parts.length;
  if (a === "report" && n === 1 && get) return { kind: "report" };
  if (a === "websites") {
    if (n === 1 && get) return { kind: "websites" };
    if (n === 1 && post) return { kind: "website-add" };
    if (n === 2 && post) return { kind: "website-update", id: b as string };
    if (n === 3 && c === "report" && get) return { kind: "website-report", id: b as string };
    if (n === 3 && c === "remove" && post) return { kind: "website-remove", id: b as string };
  }
  if (a === "visits" && b === "mine") {
    if (n === 2 && post) return { kind: "mine" };
    if (n === 3 && c === "undo" && post) return { kind: "mine-undo" };
  }
  return null;
}

const addSchema = z.object({
  name: z.string().trim().min(1, "Give the website a name, like “Our website”.").max(80, "Keep the name under 80 characters."),
  domains: z.union([z.array(z.string().max(300)).max(20), z.string().max(3000)]),
});
const updateSchema = z.object({
  name: z.string().trim().min(1, "Give the website a name.").max(80, "Keep the name under 80 characters.").optional(),
  domains: z.union([z.array(z.string().max(300)).max(20), z.string().max(3000)]).optional(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  throw new AnalyticsHttpError("invalid", 400, result.error.issues[0]?.message ?? "Some details need another look.");
}

function userIdOf(verdict: AnalyticsAuthorizeResult): string | null {
  return typeof verdict === "object" && !(verdict instanceof Response) && verdict.userId != null && verdict.userId !== ""
    ? String(verdict.userId)
    : null;
}

export function createAnalyticsAdminHandlers(options: CreateAnalyticsAdminHandlersOptions): AnalyticsAdminHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new TypeError("createAnalyticsAdminHandlers needs `tenantId` (one site) or `resolveTenant` (one per company).");
  }
  if (typeof options.authorize !== "function") throw new TypeError("createAnalyticsAdminHandlers needs `authorize`.");
  if (!options.analytics) throw new TypeError("createAnalyticsAdminHandlers needs `analytics` (createAnalytics(...)).");
  const { analytics } = options;
  const now = options.now ?? (() => new Date());

  async function zoneOf(tenantId: string): Promise<string> {
    const zone = typeof options.timeZone === "function" ? await options.timeZone(tenantId) : options.timeZone;
    return zone || "UTC";
  }

  async function ownPagesOf(tenantId: string): Promise<{ label: string; url: string | null }> {
    return (await options.ownPages?.(tenantId)) ?? { label: "Your pages here", url: null };
  }

  async function limitOf(tenantId: string): Promise<number | null> {
    const limit = await options.websiteLimit?.(tenantId);
    return typeof limit === "number" ? limit : null;
  }

  let toldNoScript = false;
  function toWire(website: Website, lastVisitAt: Date | null = null): WebsiteWire {
    if (!options.scriptUrl && !toldNoScript) {
      toldNoScript = true;
      options.onError?.(new Error("analytics: no scriptUrl, so companies get no line to paste — set the app's public web address"), { tenantId: website.tenantId, route: "websites" });
    }
    return {
      id: website.id,
      name: website.name,
      domains: [...website.domains],
      siteKey: website.siteKey,
      snippet: options.scriptUrl ? websiteSnippet(options.scriptUrl, website.siteKey) : null,
      createdAt: website.createdAt.toISOString(),
      lastVisitAt: lastVisitAt ? lastVisitAt.toISOString() : null,
    };
  }

  function addressRulesFor(req: Request): WebsiteAddressRules | undefined {
    return typeof options.addressRules === "function" ? options.addressRules(req) : options.addressRules;
  }

  /** May this person ALSO manage (for the list's buttons)? A second ask that only adds, never strips a read. */
  async function canManage(req: Request, tenantId: string): Promise<boolean> {
    const verdict = await options.authorize(req, "analytics.manage", tenantId);
    return verdict !== false && !(verdict instanceof Response);
  }

  async function websites(req: Request, tenantId: string): Promise<WebsitesWire> {
    const [list, manage, limit, ownPages, lastVisits] = await Promise.all([
      analytics.listWebsites(tenantId),
      canManage(req, tenantId),
      limitOf(tenantId),
      ownPagesOf(tenantId),
      analytics.lastVisits(tenantId),
    ]);
    return {
      websites: list.map((website) => toWire(website, lastVisits.get(website.id) ?? null)),
      canManage: manage,
      limit,
      limitMessage: limit !== null && list.length >= limit ? websiteLimitSentence(limit) : null,
      ownPages: { ...ownPages, lastVisitAt: lastVisits.get(null)?.toISOString() ?? null },
    };
  }

  async function report(req: Request, tenantId: string, site: WebsiteFilterWire): Promise<Response> {
    const url = new URL(req.url);
    try {
      const built = await buildWebsiteReport(analytics, {
        tenantId,
        days: reportDaysOf(url.searchParams.get("days")),
        site,
        // Read from the URL, never remembered (the audience's rule).
        includeInternal: url.searchParams.get("includeInternal") === "1",
        timeZone: await zoneOf(tenantId),
        ownPagesLabel: (await ownPagesOf(tenantId)).label,
        now: now(),
      });
      return json(built);
    } catch (error) {
      if (isAnalyticsError(error) && error.code === "not_found") return errorResponse("not_found", 404, NOT_HERE);
      throw error;
    }
  }

  /** The keys this browser is filed under today and yesterday, for this company — the same ones the beacon uses. */
  async function visitorKeysOf(req: Request, tenantId: string): Promise<string[]> {
    const userAgent = req.headers.get("user-agent");
    if (!userAgent) return [];
    const keys = await analytics.resolveVisitorKeys({
      tenantId,
      ip: options.clientIp?.(req) ?? "0.0.0.0",
      userAgent,
      at: now(),
      timeZone: options.saltTimeZone,
    });
    return keys.candidates;
  }

  async function dispatch(req: Request, match: Matched, tenantId: string, userId: string | null): Promise<Response> {
    switch (match.kind) {
      case "report": {
        const site = new URL(req.url).searchParams.get("site");
        return report(req, tenantId, site === null || site === "" ? "all" : site);
      }
      case "website-report": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        return report(req, tenantId, match.id);
      }
      case "websites":
        return json(await websites(req, tenantId));
      case "website-add": {
        const body = parse(addSchema, await readJsonBody(req));
        try {
          const refuse = addressRulesFor(req);
          const added = await analytics.addWebsite({ tenantId, name: body.name, domains: body.domains, by: userId, limit: await limitOf(tenantId), ...(refuse ? { refuse } : {}) });
          return json({ website: toWire(added) }, 201);
        } catch (error) {
          if (isAnalyticsError(error) && error.code === "invalid_input") throw new AnalyticsHttpError("invalid", 400, error.message);
          if (isAnalyticsError(error) && error.code === "limit_reached") throw new AnalyticsHttpError("limit_reached", 409, error.message);
          throw error;
        }
      }
      case "website-update": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        const body = parse(updateSchema, await readJsonBody(req));
        try {
          const refuse = addressRulesFor(req);
          const updated = await analytics.updateWebsite({
            tenantId,
            id: match.id,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.domains !== undefined ? { domains: body.domains } : {}),
            ...(refuse ? { refuse } : {}),
          });
          if (!updated) return errorResponse("not_found", 404, NOT_HERE);
          return json({ website: toWire(updated) });
        } catch (error) {
          if (isAnalyticsError(error) && error.code === "invalid_input") throw new AnalyticsHttpError("invalid", 400, error.message);
          throw error;
        }
      }
      case "website-remove": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        const removed = await analytics.removeWebsite({ tenantId, id: match.id, at: now() });
        if (!removed) return errorResponse("not_found", 404, NOT_HERE);
        return json({ removed: true });
      }
      case "mine": {
        const audience = analytics.audienceFor(tenantId);
        if (!audience?.mark) {
          throw new AnalyticsHttpError("invalid", 409, "Leaving visits out isn't switched on for this site yet.");
        }
        const marked = await analytics.markVisitorInternal({
          tenantId,
          ip: options.clientIp?.(req) ?? null,
          userAgent: req.headers.get("user-agent"),
          by: userId,
          timeZone: options.saltTimeZone,
          at: now(),
        });
        const wire: MineWire = {
          marked: marked.subjectsChanged,
          message:
            marked.visitorIds.length === 0
              ? "This browser couldn't be recognised, so nothing was left out."
              : "Done: this device's visits from yesterday and today are left out of the numbers.",
        };
        return json(wire);
      }
      case "mine-undo": {
        const audience = analytics.audienceFor(tenantId);
        if (!audience?.unmark) {
          throw new AnalyticsHttpError("invalid", 409, "Leaving visits out isn't switched on for this site yet.");
        }
        let cleared = 0;
        for (const visitorId of await visitorKeysOf(req, tenantId)) {
          cleared += (await audience.unmark({ subjectKind: "visitor", subjectId: visitorId, by: userId })).subjectsChanged;
        }
        const wire: MineWire = {
          marked: cleared,
          message: cleared > 0 ? "Done: this device's visits count again." : "This device's visits weren't left out.",
        };
        return json(wire);
      }
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      let tenantId: string | null = null;
      let kind = "unknown";
      try {
        const match = route(new URL(req.url).pathname, req.method);
        if (!match) return errorResponse("not_found", 404, NOT_HERE);
        kind = match.kind;
        if (req.method === "POST" && isCrossSiteRequest(req)) return errorResponse("cross_site", 403, CROSS_SITE_MESSAGE);
        tenantId = options.tenantId ?? (await options.resolveTenant?.(req)) ?? null;
        if (!tenantId) return errorResponse("not_found", 404, NOT_HERE);
        const permission = ANALYTICS_ADMIN_ROUTE_PERMISSIONS[match.kind];
        const verdict = await options.authorize(req, permission, tenantId);
        if (verdict instanceof Response) return verdict;
        if (verdict === false) {
          return errorResponse("forbidden", 403, permission === "analytics.manage" ? MANAGE_FORBIDDEN_MESSAGE : VIEW_FORBIDDEN_MESSAGE);
        }
        return await dispatch(req, match, tenantId, userIdOf(verdict));
      } catch (error) {
        if (error instanceof AnalyticsHttpError) return errorResponse(error.code, error.status, error.message);
        if (isAnalyticsError(error) && error.code === "unlicensed") return errorResponse("unlicensed", 402, error.message);
        options.onError?.(error, { tenantId, route: kind });
        return errorResponse("internal", 500, INTERNAL_MESSAGE);
      }
    },
  };
}

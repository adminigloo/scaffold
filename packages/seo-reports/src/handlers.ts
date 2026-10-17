import { DEFAULT_CRAWL_LIMITS, runSiteCheck, SeoReportsError, type CheckTarget, type CrawlLimits } from "./crawl.js";
import {
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
  SeoReportsHttpError,
  VIEW_FORBIDDEN_MESSAGE,
} from "./http.js";
import type { ResolveHost, Transport } from "./net.js";
import type { SeoReportsPermission } from "./permissions.js";
import { toCheckWire, toSummaryWire } from "./report.js";
import { SEO_REPORTS_ADMIN_ROUTE_PERMISSIONS, type SeoReportsAdminRouteKind } from "./routes.js";
import { beginSiteCheck, failSiteCheck, finishSiteCheck, getSiteCheck, lastSiteCheckAt, listSiteChecks, nextMonthUtc, siteChecksThisMonth, type SeoDb } from "./store.js";
import type { SearchCheckOverviewWire, SeoReportsErrorCodeWire } from "./wire.js";

/**
 * A COMPANY'S SEARCH CHECK (0.2): one fetch handler, every route under
 * `{mount}/v1/` (SEO_REPORTS_ADMIN_ROUTES):
 *
 *   // app/api/app/[tenantId]/search-check/[...path]/route.ts
 *   const { handle } = createSeoReportsHandlers({ db, resolveTenant, authorize, addresses });
 *   export { handle as GET, handle as POST };
 *
 * WHOSE COMPANY: the id in the PATH (`resolveTenant`), asked of `authorize`
 * for the route's one permission on every call. Its reports are its own, and
 * another company's report id is "not found".
 *
 * WHAT IS READ: only `addresses(tenantId)` — the company's own websites and
 * pages, as the app knows them — through the safe fetcher (./net.ts). Never
 * an address from the request.
 *
 * WHAT IT COSTS: a check reads up to 50 pages in up to 45 seconds. The month's
 * checks are the plan's (`monthlyLimit`), counted and held in one lock with
 * the "running" row; `admit` (is the company's plan open?) and `rateLimit`
 * are asked before any page is read.
 */

export type SeoReportsAuthorizeResult = boolean | { userId?: string | number | null } | Response;

/** The checks a month when the app doesn't say (its plan doesn't mention them). */
export const DEFAULT_MONTHLY_CHECKS = 20;
/** The weekly job checks a company again only when its last check is older than this. */
export const SCHEDULE_EVERY_MS = 6.5 * 24 * 60 * 60_000;

export interface CreateSeoReportsHandlersOptions {
  db: SeoDb;
  /** One fixed company (a single business, or this site's own checks). Pass this or `resolveTenant`. */
  tenantId?: string;
  /** The company a request is for — in a companies project, the id in the PATH. null → "not found". */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: SeoReportsPermission, tenantId: string) => SeoReportsAuthorizeResult | Promise<SeoReportsAuthorizeResult>;
  /** The company's own addresses: its websites and its pages on the app. The only things a check reads. */
  addresses: (tenantId: string) => readonly CheckTarget[] | Promise<readonly CheckTarget[]>;
  /** "Check now" presses a month (the weekly check is free): a number; null: unlimited; undefined: DEFAULT_MONTHLY_CHECKS. */
  monthlyLimit?: (tenantId: string) => number | null | undefined | Promise<number | null | undefined>;
  /** May this company do new work right now (its plan open)? true, or the sentence to refuse with. */
  admit?: (tenantId: string) => true | string | Promise<true | string>;
  /** "Check now" pressed too often? true, or the sentence to refuse with. */
  rateLimit?: (who: { tenantId: string; userId: string | null }) => true | string | Promise<true | string>;
  /** Name lookup and transport, for tests (default: the system's, pinned). */
  network?: { resolve?: ResolveHost; transport?: Transport };
  limits?: Partial<CrawlLimits>;
  /** Does a weekly job check the addresses (runScheduled on a schedule)? The screen says when. Default false. */
  automatic?: boolean;
  userAgent?: string;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export type ScheduledCheckOutcome =
  | { readonly ran: true; readonly id: string; readonly score: number }
  | { readonly ran: false; readonly reason: "recent" | "no_addresses" | "closed" | "limit_reached" | "running" };

export interface SeoReportsHandlers {
  handle: (req: Request) => Promise<Response>;
  /**
   * The weekly job's step for one company: a check, unless it had one this
   * week, has nothing to check, or can't. `limits` narrows this one check
   * (the cron gives it only the time it has left).
   */
  runScheduled: (tenantId: string, limits?: Partial<CrawlLimits>) => Promise<ScheduledCheckOutcome>;
}

interface Matched {
  kind: SeoReportsAdminRouteKind;
  id?: string;
}

function route(pathname: string, method: string): Matched | null {
  const parts = segmentsAfter(pathname, "/v1/");
  if (!parts) return null;
  const get = method === "GET" || method === "HEAD";
  const post = method === "POST";
  const [a, b] = parts;
  if (a !== "checks") return null;
  if (parts.length === 1 && get) return { kind: "checks" };
  if (parts.length === 1 && post) return { kind: "check-now" };
  if (parts.length === 2 && get) return { kind: "check", id: b as string };
  return null;
}

function userIdOf(verdict: SeoReportsAuthorizeResult): string | null {
  return typeof verdict === "object" && !(verdict instanceof Response) && verdict.userId != null && verdict.userId !== "" ? String(verdict.userId) : null;
}

const ERROR_STATUS: Record<SeoReportsError["code"], { status: number; code: SeoReportsErrorCodeWire }> = {
  no_addresses: { status: 409, code: "no_addresses" },
  invalid_input: { status: 400, code: "invalid" },
  not_found: { status: 404, code: "not_found" },
  limit_reached: { status: 409, code: "limit_reached" },
  running: { status: 409, code: "running" },
  closed: { status: 403, code: "closed" },
  rate_limited: { status: 429, code: "rate_limited" },
};

/** An address as shown: "greenacres.com", "app.example/t/green-acres". */
function shown(target: CheckTarget): string {
  return `${target.baseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}${target.pathPrefix ?? ""}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Your pages on Snowplow (app.snowplow.test/t/green-acres) and your website “Green Acres” (greenacres.com)". */
export function addressSentence(targets: readonly CheckTarget[]): string {
  const items = targets.map((t) => `${t.label} (${shown(t)})`);
  if (items.length === 0) return "";
  const joined = items.length === 1 ? items[0]! : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return capitalise(joined);
}

export function createSeoReportsHandlers(options: CreateSeoReportsHandlersOptions): SeoReportsHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new TypeError("createSeoReportsHandlers needs `tenantId` (one site) or `resolveTenant` (one per company).");
  }
  if (typeof options.authorize !== "function") throw new TypeError("createSeoReportsHandlers needs `authorize`.");
  if (typeof options.addresses !== "function") throw new TypeError("createSeoReportsHandlers needs `addresses` (the company's own addresses).");
  const { db } = options;
  const now = options.now ?? (() => new Date());
  const limits: CrawlLimits = { ...DEFAULT_CRAWL_LIMITS, ...options.limits };

  async function limitOf(tenantId: string): Promise<number | null> {
    const limit = await options.monthlyLimit?.(tenantId);
    return limit === undefined ? DEFAULT_MONTHLY_CHECKS : limit;
  }

  async function canRun(req: Request, tenantId: string): Promise<boolean> {
    const verdict = await options.authorize(req, "seo_reports.run", tenantId);
    return verdict !== false && !(verdict instanceof Response);
  }

  /** Begin, read, finish: the one path every check takes (Check now and the weekly job). */
  async function check(tenantId: string, trigger: "manual" | "schedule", by: string | null, narrow: Partial<CrawlLimits> = {}) {
    const admitted = (await options.admit?.(tenantId)) ?? true;
    if (admitted !== true) throw new SeoReportsError("closed", admitted);
    const targets = (await options.addresses(tenantId)).filter((t) => !t.pending);
    if (targets.length === 0) throw new SeoReportsError("no_addresses", "There's nothing to check yet. Add your website, or publish your pages, and check again.");
    const at = now();
    const id = await beginSiteCheck(db, {
      tenantId,
      trigger,
      requestedBy: by,
      baseUrl: targets[0]!.baseUrl,
      addresses: targets.map((t) => `${t.label} — ${shown(t)}`),
      monthlyLimit: await limitOf(tenantId),
      now: at,
    });
    try {
      const result = await runSiteCheck({
        targets,
        ...(options.network?.resolve ? { resolve: options.network.resolve } : {}),
        ...(options.network?.transport ? { transport: options.network.transport } : {}),
        limits: { ...limits, ...narrow },
        ...(options.userAgent ? { userAgent: options.userAgent } : {}),
        now,
      });
      await finishSiteCheck(db, tenantId, id, result);
      return { id, score: result.score };
    } catch (error) {
      await failSiteCheck(db, tenantId, id, error, now());
      throw error;
    }
  }

  async function overview(req: Request, tenantId: string): Promise<SearchCheckOverviewWire> {
    const at = now();
    const [checks, run, limit, used, all] = await Promise.all([
      listSiteChecks(db, tenantId, 20),
      canRun(req, tenantId),
      limitOf(tenantId),
      siteChecksThisMonth(db, tenantId, at),
      options.addresses(tenantId),
    ]);
    const targets = all.filter((t) => !t.pending);
    const waiting = all.filter((t) => t.pending).map((t) => `${capitalise(t.label)} (${shown(t)}): ${t.pending}`);
    const newest = checks.find((c) => c.status === "done") ?? null;
    const latest = newest ? await getSiteCheck(db, tenantId, newest.id) : null;
    const resetsAt = nextMonthUtc(at);
    const notice =
      targets.length === 0
        ? "There's nothing to check yet. Add your website, or publish your pages, and check again."
        : limit !== null && used >= limit
          ? `You've used this month's ${limit} Check now press${limit === 1 ? "" : "es"}. They start again on ${resetsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}; the weekly check still runs.`
          : null;
    const last = checks.find((c) => c.status !== "failed") ?? null;
    const nextAutomaticAt =
      options.automatic && targets.length > 0
        ? new Date(Math.max(last ? last.startedAt.getTime() + SCHEDULE_EVERY_MS : 0, at.getTime() + (last ? 0 : 86_400_000))).toISOString()
        : null;
    return {
      checks: checks.map(toSummaryWire),
      latest: latest ? toCheckWire(latest) : null,
      canRun: run,
      addresses: targets.map((t) => `${t.label} — ${shown(t)}`),
      addressSentence: addressSentence(targets),
      waiting,
      month: { used, limit, resetsAt: resetsAt.toISOString() },
      notice,
      nextAutomaticAt,
    };
  }

  async function dispatch(req: Request, match: Matched, tenantId: string, userId: string | null): Promise<Response> {
    switch (match.kind) {
      case "checks":
        return json(await overview(req, tenantId));
      case "check": {
        if (!isIdShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
        const found = await getSiteCheck(db, tenantId, match.id);
        if (!found) return errorResponse("not_found", 404, NOT_HERE);
        return json(toCheckWire(found));
      }
      case "check-now": {
        await readJsonBody(req);
        const limited = (await options.rateLimit?.({ tenantId, userId })) ?? true;
        if (limited !== true) throw new SeoReportsError("rate_limited", limited);
        const { id } = await check(tenantId, "manual", userId);
        const found = await getSiteCheck(db, tenantId, id);
        if (!found) return errorResponse("not_found", 404, NOT_HERE);
        return json(toCheckWire(found), 201);
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
        const permission = SEO_REPORTS_ADMIN_ROUTE_PERMISSIONS[match.kind];
        const verdict = await options.authorize(req, permission, tenantId);
        if (verdict instanceof Response) return verdict;
        if (verdict === false) return errorResponse("forbidden", 403, permission === "seo_reports.run" ? MANAGE_FORBIDDEN_MESSAGE : VIEW_FORBIDDEN_MESSAGE);
        return await dispatch(req, match, tenantId, userIdOf(verdict));
      } catch (error) {
        if (error instanceof SeoReportsHttpError) return errorResponse(error.code, error.status, error.message);
        if (error instanceof SeoReportsError) {
          const mapped = ERROR_STATUS[error.code];
          return errorResponse(mapped.code, mapped.status, error.message);
        }
        options.onError?.(error, { tenantId, route: kind });
        return errorResponse("internal", 500, INTERNAL_MESSAGE);
      }
    },

    async runScheduled(tenantId: string, narrow: Partial<CrawlLimits> = {}): Promise<ScheduledCheckOutcome> {
      const last = await lastSiteCheckAt(db, tenantId);
      if (last && now().getTime() - last.getTime() < SCHEDULE_EVERY_MS) return { ran: false, reason: "recent" };
      try {
        const { id, score } = await check(tenantId, "schedule", null, narrow);
        return { ran: true, id, score };
      } catch (error) {
        if (error instanceof SeoReportsError) {
          if (error.code === "no_addresses") return { ran: false, reason: "no_addresses" };
          if (error.code === "closed") return { ran: false, reason: "closed" };
          if (error.code === "limit_reached") return { ran: false, reason: "limit_reached" };
          if (error.code === "running") return { ran: false, reason: "running" };
        }
        throw error;
      }
    },
  };
}

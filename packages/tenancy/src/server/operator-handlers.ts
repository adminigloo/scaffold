import { z } from "zod";
import { TenancyError } from "./errors.js";
import { methodNotAllowed, type RateLimiter, type TenancyHandlers, type TenancyPrincipal } from "./handlers.js";
import {
  codeResponse,
  defaultRequestFacts,
  errorResponse,
  isCrossOriginRequest,
  issuesOf,
  jsonResponse,
  matchRoute,
  readJson,
} from "./http.js";
import { TENANCY_OPERATOR_ROUTES, type TenancyOperatorRouteKind } from "./routes.js";
import { adminCompanyDetailToWire, adminCompanyListToWire, adminPeopleToWire, adminPersonToWire } from "./to-wire.js";
import type { RequestFacts, TenancyService } from "./types.js";
import type { AuditLineWire } from "../wire.js";

export interface CreateTenancyOperatorHandlersOptions {
  readonly tenancy: TenancyService;
  readonly principal: (req: Request) => Promise<TenancyPrincipal | null>;
  /** Recent activity for a company's detail page, newest first. Absent → activity: null ("not connected"). */
  readonly recentAudit?: (input: { readonly tenantId: string; readonly limit: number }) => Promise<readonly AuditLineWire[]>;
  readonly limit?: RateLimiter;
  readonly requestFacts?: (req: Request) => RequestFacts;
  readonly onError?: (error: unknown, req: Request) => void | Promise<void>;
}

const suspendBody = z.object({ reason: z.string().max(500) });
const ownerBody = z.object({ toUserId: z.string().min(1).max(128) });
const staffRoleBody = z.object({ templateKey: z.string().min(1).max(64).nullable() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new TenancyError("invalid", "Check the highlighted fields.", { issues: issuesOf(result.error) });
  return result.data;
}

function intParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : undefined;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * The operator console's routes (contract 7.2): every company, one company's
 * detail, suspend and reactivate, change owner, release old web addresses,
 * People and staff roles. Mounted under the project's admin API; someone
 * signed in with no staff role gets `403 not_staff`. The same steps as the
 * company handlers (same-origin POSTs, sign-in, rate limit, zod, the service
 * authorises).
 */
export function createTenancyOperatorHandlers(options: CreateTenancyOperatorHandlersOptions): TenancyHandlers {
  const { tenancy } = options;
  const noun = tenancy.noun;
  const facts = options.requestFacts ?? defaultRequestFacts;

  async function detailWithActivity(tenantId: string, detail: Awaited<ReturnType<TenancyService["getCompanyDetail"]>>) {
    let activity: readonly AuditLineWire[] | null = null;
    if (options.recentAudit) activity = await options.recentAudit({ tenantId, limit: 20 });
    return adminCompanyDetailToWire(detail, activity);
  }

  async function run(req: Request, kind: TenancyOperatorRouteKind, p: Readonly<Record<string, string>>, userId: string): Promise<Response> {
    const request = facts(req);
    const url = new URL(req.url);
    const tenantId = p["tenantId"] ?? "";
    switch (kind) {
      case "admin-companies": {
        const q = url.searchParams.get("q");
        const kindParam = oneOf(url.searchParams.get("kind"), ["org", "personal", "all"] as const);
        const status = oneOf(url.searchParams.get("status"), ["active", "suspended", "all"] as const);
        const page = intParam(url.searchParams.get("page"));
        const pageSize = intParam(url.searchParams.get("pageSize"));
        return jsonResponse(
          200,
          adminCompanyListToWire(
            await tenancy.listCompanies({
              actorUserId: userId,
              ...(q ? { q } : {}),
              ...(kindParam ? { kind: kindParam } : {}),
              ...(status ? { status } : {}),
              ...(page ? { page } : {}),
              ...(pageSize ? { pageSize } : {}),
            }),
          ),
        );
      }
      case "admin-company":
        return jsonResponse(200, await detailWithActivity(tenantId, await tenancy.getCompanyDetail({ actorUserId: userId, tenantId })));
      case "admin-suspend": {
        const body = parse(suspendBody, await readJson(req));
        return jsonResponse(200, await detailWithActivity(tenantId, await tenancy.suspendCompany({ actorUserId: userId, tenantId, reason: body.reason, request })));
      }
      case "admin-reactivate":
        await readJson(req);
        return jsonResponse(200, await detailWithActivity(tenantId, await tenancy.reactivateCompany({ actorUserId: userId, tenantId, request })));
      case "admin-assign-owner": {
        const body = parse(ownerBody, await readJson(req));
        return jsonResponse(200, await detailWithActivity(tenantId, await tenancy.assignOwner({ actorUserId: userId, tenantId, toUserId: body.toUserId, request })));
      }
      case "admin-release-addresses":
        await readJson(req);
        return jsonResponse(200, await detailWithActivity(tenantId, await tenancy.releaseRetiredAddresses({ actorUserId: userId, tenantId, request })));
      case "admin-people": {
        const q = url.searchParams.get("q");
        const staffOnly = url.searchParams.get("staffOnly");
        const page = intParam(url.searchParams.get("page"));
        const pageSize = intParam(url.searchParams.get("pageSize"));
        return jsonResponse(
          200,
          adminPeopleToWire(
            await tenancy.listPeople({
              actorUserId: userId,
              ...(q ? { q } : {}),
              ...(staffOnly === "1" || staffOnly === "true" ? { staffOnly: true } : {}),
              ...(page ? { page } : {}),
              ...(pageSize ? { pageSize } : {}),
            }),
          ),
        );
      }
      case "admin-staff-roles":
        return jsonResponse(200, { roles: await tenancy.listStaffRoles({ actorUserId: userId }) });
      case "admin-staff-role-set": {
        const body = parse(staffRoleBody, await readJson(req));
        return jsonResponse(200, {
          person: adminPersonToWire(await tenancy.setStaffRole({ actorUserId: userId, targetUserId: p["userId"]!, templateKey: body.templateKey, request })),
        });
      }
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      if (req.method.toUpperCase() === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      const matched = matchRoute(TENANCY_OPERATOR_ROUTES, req);
      if (!("found" in matched)) {
        if (matched.status === 405) return methodNotAllowed(matched.allow);
        return codeResponse("not_found", noun);
      }
      const { kind, params } = matched.found;
      const route = TENANCY_OPERATOR_ROUTES.find((r) => r.kind === kind)!;
      try {
        if (route.method === "POST" && isCrossOriginRequest(req)) return codeResponse("cross_site", noun);
        const principal = await options.principal(req);
        if (!principal) return codeResponse("signed_out", noun);
        if (route.bucket && options.limit) {
          const verdict = await options.limit({ bucket: route.bucket, key: `user:${principal.userId}` });
          if (!verdict.allowed) {
            return codeResponse("rate_limited", noun, { "retry-after": String(Math.max(1, Math.ceil(verdict.retryAfterSeconds ?? 60))) });
          }
        }
        return await run(req, kind, params, principal.userId);
      } catch (error) {
        if (error instanceof TenancyError) return errorResponse(error.code, error.message, error.details);
        try {
          await options.onError?.(error, req);
        } catch {
          /* the reporter failing must not change the answer */
        }
        return codeResponse("internal", noun);
      }
    },
  };
}

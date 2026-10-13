import { z } from "zod";
import { TenancyError } from "./errors.js";
import {
  codeResponse,
  defaultRequestFacts,
  errorResponse,
  isCrossOriginRequest,
  issuesOf,
  jsonResponse,
  LOGO_BODY_MAX_BYTES,
  matchRoute,
  readJson,
} from "./http.js";
import { TENANCY_ROUTES, type TenancyRateBucket, type TenancyRouteKind } from "./routes.js";
import {
  companyToWire,
  invitationToWire,
  issuedToWire,
  memberToWire,
  previewToWire,
  sessionToWire,
  teamToWire,
} from "./to-wire.js";
import type { AcceptOutcome, IssuedInvitation, RequestFacts, TenancyService } from "./types.js";
import type { AcceptWire } from "../wire.js";

export interface TenancyPrincipal {
  readonly userId: string;
  readonly email: string | null;
}

export interface InvitationDelivery {
  readonly to: string;
  readonly tenantId: string;
  readonly companyName: string;
  /** The inviter's display name or email. */
  readonly invitedBy: string | null;
  readonly roleName: string;
  /** Carries the token; goes in the email only. */
  readonly url: string;
  readonly expiresAt: Date;
  readonly invitationId: string;
}

export type RateLimiter = (input: {
  readonly bucket: TenancyRateBucket;
  readonly key: string;
}) => Promise<{ readonly allowed: boolean; readonly retryAfterSeconds?: number }>;

export interface CreateTenancyHandlersOptions {
  readonly tenancy: TenancyService;
  /** Who is signed in. null → 401 signed_out. create-app passes currentPrincipal (which also provisions). */
  readonly principal: (req: Request) => Promise<TenancyPrincipal | null>;
  /** The caller's VERIFIED addresses, from the identity provider, on the server (D19). Absent → no joining by email. */
  readonly verifiedEmails?: (req: Request) => Promise<readonly string[]>;
  /** The absolute link mailed to an invitee. */
  readonly invitationUrl: (token: string) => string;
  /** Sends the invitation email after commit. Absent → delivery "skipped" and the link is returned to the inviter. */
  readonly deliverInvitation?: (input: InvitationDelivery) => Promise<{ readonly status: "sent" | "skipped" | "failed" }>;
  /** Your rate limiter. Absent → unlimited. */
  readonly limit?: RateLimiter;
  /** The IP and user agent recorded in the audit. Default: X-Forwarded-For's first hop or X-Real-IP, and User-Agent. */
  readonly requestFacts?: (req: Request) => RequestFacts;
  /** Your error reporter, for the 500s only. */
  readonly onError?: (error: unknown, req: Request) => void | Promise<void>;
}

export interface TenancyHandlers {
  handle(req: Request): Promise<Response>;
}

// --- bodies (zod at the boundary) ------------------------------------------

const roleKey = z.enum(["owner", "admin", "member", "viewer"]);
const createBody = z.object({
  name: z.string().max(200),
  slug: z.string().max(80).optional(),
  requestKey: z.string().min(8).max(64),
  purpose: z.enum(["onboarding", "additional"]).optional(),
});
const tokenBody = z.object({ token: z.string().min(1).max(512) });
const activeBody = z.object({ tenantId: z.string().min(1).max(128) });
const profileBody = z.object({ name: z.string().max(200).optional(), slug: z.string().max(80).optional() });
const brandingBody = z.object({ brandColor: z.string().max(20).nullable() });
const settingsBody = z.object({ values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])) });
const roleBody = z.object({ roleKey });
const transferBody = z.object({ toUserId: z.string().min(1).max(128), confirmName: z.string().max(200) });
const inviteBody = z.object({ email: z.string().trim().min(3).max(254), roleKey });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new TenancyError("invalid", "Check the highlighted fields.", { issues: issuesOf(result.error) });
  return result.data;
}

function acceptToWire(outcome: AcceptOutcome): AcceptWire {
  return {
    status: outcome.status,
    company: "company" in outcome ? { id: outcome.company.id, name: outcome.company.name } : null,
    message: outcome.status === "seats-full" ? outcome.message : null,
  };
}

/** 405 with `allow`: the path exists, the method doesn't. */
export function methodNotAllowed(allow: readonly string[]): Response {
  return new Response(JSON.stringify({ error: { code: "invalid", message: "That method isn't allowed here." } }), {
    status: 405,
    headers: { allow: allow.join(", "), "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
  });
}

/** Buckets keyed by the company rather than the person (charged only for members who hold the route's permission). */
const COMPANY_BUCKETS: ReadonlySet<TenancyRateBucket> = new Set(["invite", "logo"]);

/**
 * Every company-lifecycle route (contract 7.1), one `handle(req)` routed by
 * the path after `/v1/`:
 *
 *   // app/api/tenancy/[...path]/route.ts
 *   const { handle } = createTenancyHandlers({ tenancy, principal, invitationUrl, … });
 *   export const GET = handle; export const POST = handle;
 *
 * D2: THE HANDLERS LIVE IN THE PACKAGE, so a security fix to who may remove
 * whom reaches every project by `npm update` instead of being frozen into
 * each generated copy. D3: a company route names its company in the PATH, and
 * the service authorises against THAT id, never "whichever is active".
 *
 * Each request: match the route → (POST) refuse anything not same-origin →
 * sign-in → rate limit → params → body (zod) → the service, which authorises
 * itself → `{ error: { code, message, … } }` on a refusal, 500 `internal` (and
 * `onError`) for anything unexpected, never echoed. Every answer is
 * `cache-control: no-store`. Nothing here is ever cross-origin.
 */
export function createTenancyHandlers(options: CreateTenancyHandlersOptions): TenancyHandlers {
  const { tenancy } = options;
  const noun = tenancy.noun;
  const facts = options.requestFacts ?? defaultRequestFacts;
  // With a deliverer, every invitation sent here is offered to it, so the
  // per-address email limits apply; without one, nothing is sent and nothing
  // is ever held. Whether an email WENT is the deliverer's answer, not this:
  // only "sent" counts (review R4 SEC-T1-B).
  const sendsEmail = options.deliverInvitation !== undefined;

  async function issued(req: Request, tenantId: string, out: IssuedInvitation): Promise<Response> {
    // After the commit: the service has returned. A failed email never
    // un-sends the invitation; it hands the inviter the link instead.
    const url = options.invitationUrl(out.token);
    let delivery: "sent" | "skipped" | "failed" | "held" = "skipped";
    // Saved, but this address has had its emails from this company for now
    // (review R3 SEC-T1-B): nothing is sent, and the inviter gets the link and
    // the reason in a sentence.
    if (out.emailHold) delivery = "held";
    else if (options.deliverInvitation) {
      try {
        const answer: unknown = await options.deliverInvitation({
          to: out.invitation.email,
          tenantId,
          companyName: out.companyName,
          invitedBy: out.invitedBy,
          roleName: out.invitation.roleName,
          url,
          expiresAt: out.expiresAt,
          invitationId: out.invitation.id,
        });
        // "sent" means the provider took it; anything that isn't one of the
        // three answers is a failure, never quietly a send.
        const status = (answer as { status?: unknown } | null | undefined)?.status;
        delivery = status === "sent" || status === "skipped" ? status : "failed";
      } catch (error) {
        delivery = "failed";
        await reportQuietly(error, req);
      }
    }
    // The email was reserved under the company lock; now say what became of
    // it (review R4 SEC-T1-B). Only a "sent" is recorded as an email — the
    // history the limits and the inviter's sentence are read from — so a
    // skipped, failed or thrown delivery frees the address at once, and
    // nobody is later told "We emailed" about it. Recording failing is
    // reported, and the answer is still the truth about this delivery.
    if (out.emailReservation) {
      try {
        await tenancy.settleInvitationEmail({
          tenantId,
          invitationId: out.emailReservation.invitationId,
          reservedAt: out.emailReservation.reservedAt,
          sent: delivery === "sent",
        });
      } catch (error) {
        await reportQuietly(error, req);
      }
    }
    return jsonResponse(200, issuedToWire(out, delivery, url));
  }

  async function reportQuietly(error: unknown, req: Request): Promise<void> {
    try {
      await options.onError?.(error, req);
    } catch {
      /* the reporter failing must not change the answer */
    }
  }

  async function run(req: Request, kind: TenancyRouteKind, p: Readonly<Record<string, string>>, userId: string): Promise<Response> {
    const request = facts(req);
    const url = new URL(req.url);
    const tenantId = p["tenantId"] ?? "";
    const actor = { actorUserId: userId, tenantId, request };
    switch (kind) {
      case "session": {
        const verified = options.verifiedEmails ? await options.verifiedEmails(req) : [];
        return jsonResponse(200, sessionToWire(await tenancy.resolveSession({ userId, verifiedEmails: verified })));
      }
      case "slug-check": {
        const name = url.searchParams.get("name") ?? undefined;
        const slug = url.searchParams.get("slug") ?? undefined;
        const tid = url.searchParams.get("tenantId") ?? undefined;
        if ((name?.length ?? 0) > 200 || (slug?.length ?? 0) > 80 || (tid?.length ?? 0) > 128) throw new TenancyError("invalid", "Check the highlighted fields.");
        return jsonResponse(
          200,
          await tenancy.checkSlug({
            actorUserId: userId,
            ...(name !== undefined ? { name } : {}),
            ...(slug !== undefined && slug !== "" ? { slug } : {}),
            ...(tid ? { tenantId: tid } : {}),
          }),
        );
      }
      case "company-create": {
        if (tenancy.mode === "personal") throw new TenancyError("unavailable", "That isn't available on this site.");
        const body = parse(createBody, await readJson(req));
        const out = await tenancy.createCompany({
          userId,
          name: body.name,
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          requestKey: body.requestKey,
          purpose: body.purpose ?? "onboarding",
          request,
        });
        return jsonResponse(200, { status: out.status, company: companyToWire(out.company) });
      }
      case "active-set": {
        const body = parse(activeBody, await readJson(req));
        return jsonResponse(200, { company: companyToWire(await tenancy.setActiveCompany({ userId, tenantId: body.tenantId })) });
      }
      case "invite-accept": {
        const body = parse(tokenBody, await readJson(req));
        // Every VERIFIED address counts, not only the mirrored primary one (review R2 TB2-10).
        const verified = options.verifiedEmails ? await options.verifiedEmails(req) : [];
        return jsonResponse(200, acceptToWire(await tenancy.acceptInvitation({ token: body.token, userId, verifiedEmails: verified, request })));
      }
      case "invite-preview": {
        const body = parse(tokenBody, await readJson(req));
        const verified = options.verifiedEmails ? await options.verifiedEmails(req) : [];
        return jsonResponse(200, previewToWire(await tenancy.previewInvitation({ token: body.token, userId, verifiedEmails: verified })));
      }
      case "invite-join": {
        if (tenancy.mode === "personal") throw new TenancyError("unavailable", "That isn't available on this site.");
        await readJson(req);
        const verified = options.verifiedEmails ? await options.verifiedEmails(req) : [];
        return jsonResponse(
          200,
          acceptToWire(await tenancy.joinInvitation({ invitationId: p["invitationId"]!, userId, verifiedEmails: verified, request })),
        );
      }
      case "company-get": {
        const out = await tenancy.getCompany(actor);
        return jsonResponse(200, { company: companyToWire(out.company), can: [...out.can], logoUploads: out.logoUploads });
      }
      case "profile-update": {
        const body = parse(profileBody, await readJson(req));
        const company = await tenancy.updateCompanyProfile({
          ...actor,
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
        });
        return jsonResponse(200, { company: companyToWire(company) });
      }
      case "branding-update": {
        const body = parse(brandingBody, await readJson(req));
        const out = await tenancy.updateBranding({ ...actor, brandColor: body.brandColor });
        return jsonResponse(200, { company: companyToWire(out.company), brand: out.brand ? { ...out.brand } : null });
      }
      case "logo-upload": {
        const length = Number(req.headers.get("content-length") ?? "0");
        if (Number.isFinite(length) && length > LOGO_BODY_MAX_BYTES) throw new TenancyError("logo_invalid", "Use a PNG, JPG or WebP image under 1 MB.");
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          throw new TenancyError("invalid", "Send the logo as a file upload.");
        }
        const file = form.get("file");
        if (!file || typeof file === "string") throw new TenancyError("invalid", "Send the logo as a file upload.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > LOGO_BODY_MAX_BYTES) throw new TenancyError("logo_invalid", "Use a PNG, JPG or WebP image under 1 MB.");
        const company = await tenancy.setLogo({
          ...actor,
          file: { bytes, contentType: file.type || "application/octet-stream", ...("name" in file && typeof file.name === "string" ? { filename: file.name } : {}) },
        });
        return jsonResponse(200, { company: companyToWire(company) });
      }
      case "logo-remove":
        await readJson(req);
        return jsonResponse(200, { company: companyToWire(await tenancy.removeLogo(actor)) });
      case "settings-get":
        return jsonResponse(200, await tenancy.getSettings(actor));
      case "settings-update": {
        const body = parse(settingsBody, await readJson(req));
        return jsonResponse(200, { section: await tenancy.updateSettings({ ...actor, section: p["section"]!, values: body.values }) });
      }
      case "checklist-get":
        return jsonResponse(200, await tenancy.getChecklist(actor));
      case "checklist-dismiss":
        await readJson(req);
        return jsonResponse(200, await tenancy.dismissChecklistItem({ ...actor, key: p["itemKey"]! }));
      case "checklist-restore":
        await readJson(req);
        return jsonResponse(200, await tenancy.restoreChecklistItem({ ...actor, key: p["itemKey"]! }));
      case "checklist-hide":
        await readJson(req);
        return jsonResponse(200, await tenancy.hideChecklist(actor));
      case "checklist-show":
        await readJson(req);
        return jsonResponse(200, await tenancy.showChecklist(actor));
      case "team-get":
        return jsonResponse(200, teamToWire(await tenancy.getTeam(actor)));
      case "member-role": {
        const body = parse(roleBody, await readJson(req));
        return jsonResponse(200, { member: memberToWire(await tenancy.changeMemberRole({ ...actor, targetUserId: p["userId"]!, roleKey: body.roleKey })) });
      }
      case "member-remove":
        await readJson(req);
        return jsonResponse(200, await tenancy.removeMember({ ...actor, targetUserId: p["userId"]! }));
      case "leave":
        await readJson(req);
        return jsonResponse(200, await tenancy.leaveCompany({ userId, tenantId, request }));
      case "transfer": {
        const body = parse(transferBody, await readJson(req));
        return jsonResponse(200, teamToWire(await tenancy.transferOwnership({ ...actor, toUserId: body.toUserId, confirmName: body.confirmName })));
      }
      case "invitations-list":
        return jsonResponse(200, { invitations: (await tenancy.listInvitations(actor)).map(invitationToWire) });
      case "invitation-send": {
        const body = parse(inviteBody, await readJson(req));
        return issued(req, tenantId, await tenancy.sendInvitation({ ...actor, email: body.email, roleKey: body.roleKey, sendsEmail }));
      }
      case "invitation-resend":
        await readJson(req);
        return issued(req, tenantId, await tenancy.resendInvitation({ ...actor, invitationId: p["invitationId"]!, sendsEmail }));
      case "invitation-revoke":
        await readJson(req);
        return jsonResponse(200, await tenancy.revokeInvitation({ ...actor, invitationId: p["invitationId"]! }));
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      if (req.method.toUpperCase() === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      const matched = matchRoute(TENANCY_ROUTES, req);
      if (!("found" in matched)) {
        if (matched.status === 405) return methodNotAllowed(matched.allow);
        return codeResponse("not_found", noun);
      }
      const { kind, params } = matched.found;
      const route = TENANCY_ROUTES.find((r) => r.kind === kind)!;
      try {
        if (route.method === "POST" && isCrossOriginRequest(req)) return codeResponse("cross_site", noun);
        const principal = await options.principal(req);
        if (!principal) return codeResponse("signed_out", noun);

        if (route.bucket && options.limit) {
          const charges: { bucket: TenancyRateBucket; key: string }[] = [];
          if (COMPANY_BUCKETS.has(route.bucket)) {
            const tenantId = params["tenantId"] ?? "";
            // Membership FIRST (review T1-06): a stranger who knows a company's
            // id must not be able to spend its invite or logo budget and lock
            // the owner out for an hour.
            const verdict = await tenancy.membership({ userId: principal.userId, tenantId });
            if (verdict === "not-a-member") return codeResponse("not_a_member", noun);
            if (verdict === "company-suspended") return codeResponse("company_suspended", noun);
            // Then the PERMISSION (review R2 SEC-T1-D): a viewer's refused
            // invitations used to spend the company's budget too, so any member
            // could keep the owner from inviting, hour after hour. The service
            // still decides again under the company lock (D7); this is only
            // "may this person spend the company's budget at all".
            if (route.permission && !(await tenancy.hasPermission({ userId: principal.userId, tenantId, permission: route.permission }))) {
              return codeResponse("forbidden", noun);
            }
            // An invitation is also charged to its SENDER, hourly and daily
            // (review R2 SEC-T1-B): otherwise one free account multiplied the
            // company budget by every company it made.
            if (route.bucket === "invite") {
              charges.push({ bucket: "invite-sender", key: `user:${principal.userId}` });
              charges.push({ bucket: "invite-sender-day", key: `user:${principal.userId}` });
            }
            charges.push({ bucket: route.bucket, key: `tenant:${tenantId}` });
          } else {
            charges.push({ bucket: route.bucket, key: `user:${principal.userId}` });
          }
          for (const charge of charges) {
            const verdict = await options.limit(charge);
            if (!verdict.allowed) {
              const retry = Math.max(1, Math.ceil(verdict.retryAfterSeconds ?? 60));
              return codeResponse("rate_limited", noun, { "retry-after": String(retry) });
            }
          }
        }
        return await run(req, kind, params, principal.userId);
      } catch (error) {
        if (error instanceof TenancyError) return errorResponse(error.code, error.message, error.details);
        await reportQuietly(error, req);
        return codeResponse("internal", noun);
      }
    },
  };
}

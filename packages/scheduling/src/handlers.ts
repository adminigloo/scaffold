import { z } from "zod";
import { expirePendingRequests } from "./expiry.js";
import {
  createThrottle,
  HttpError,
  isCrossSiteRequest,
  NOT_FOUND_MESSAGE,
  readJsonBody,
  safeDecode,
  toWireError,
} from "./http.js";
import { buildVisitIcs } from "./ics.js";
import { instantsOf, todayIn } from "./instants.js";
import { cancelVisitByToken, getVisitByToken, rescheduleVisitByToken, visitRowByToken } from "./manage.js";
import { createHaversineMapsProvider, type MapsProvider } from "./maps.js";
import { publicSlotsFor, requestPublicVisit } from "./offer.js";
import { serviceNameFor } from "./services.js";
import { getSchedulingSettings, type SchedulingSettings } from "./settings.js";
import { effectiveStatus, toPublicVisit } from "./snapshot.js";
import { publicLine, singleLine } from "./text.js";
import type { SchedulingEvent, SchedulingEventListener } from "./events.js";
import type { SchedulingDb } from "./types.js";
import type { PublicConfig, SlotsResponse, VisitRequestResponse, VisitResponse } from "./wire.js";
import { addDays, isValidDateString } from "./zone.js";

/**
 * The HTTP surface the customer-facing widget (`<VisitPicker>`,
 * `<ManageVisit>`) speaks — one `handle(req)` routed by path suffix, mounted
 * by the host app at any base path with a catch-all route:
 *
 *   // app/api/schedule/[...path]/route.ts
 *   const { handle } = createSchedulingHandlers({ db, tenantId: "acme", manageUrl });
 *   export { handle as GET, handle as POST, handle as OPTIONS };
 *
 * THE WIRE CONTRACT (section 4 and 7 of the 0.4 contract; shared with
 * @adminigloo/scheduling-widget, change both or neither):
 *
 *   GET  {base}/v1/config                       → PublicConfig
 *   GET  {base}/v1/slots?service&from&days&manage → SlotsResponse
 *   POST {base}/v1/request        VisitRequestBody → 201 VisitRequestResponse (200 when `repeated`)
 *   GET  {base}/v1/visit/:token                  → VisitResponse
 *   POST {base}/v1/visit/:token/reschedule  {slotId} → VisitResponse
 *   POST {base}/v1/visit/:token/cancel      {reason?} → VisitResponse
 *   GET  {base}/v1/visit/:token/ics              → text/calendar (attachment visit.ics)
 *
 * Every response is `Cache-Control: no-store`; routes with a token in the URL
 * (the path, or slots' `manage` query) add `Referrer-Policy: no-referrer` and
 * `X-Robots-Tag: noindex`, so the key in the URL isn't handed to the next site
 * the customer clicks through to, nor indexed if it leaks. Errors are
 * `{ error: { code, message, issues? } }`, and `issues` never echo the input.
 *
 * SPAM. The request form carries a honeypot (`website`, which a person never
 * sees) and how long the form was open (`fillMs`). A filled honeypot, or a
 * form sent faster than `minFillMs` (missing counts as 0), is `spam_suspected`
 * before any database work. The widget waits out the remainder itself, so a
 * fast autofill user never sees it.
 *
 * CSRF. Every POST changes state, and the body parser accepts text/plain — a
 * "simple" request a browser sends cross-site without a preflight. So unless
 * `cors` is configured, a POST a browser sent from another site is refused
 * 403 `forbidden` before any work (see isCrossSiteRequest).
 */

export type SchedulingRateLimitBucket = "read" | "request" | "manage";

export interface CreateSchedulingHandlersOptions {
  db: SchedulingDb;
  /** The tenant every request is served for. Give this or `resolveTenant`. */
  tenantId?: string;
  /** Per-request tenant (a subdomain, a path segment). null → 404. */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** The customer's manage page for a token, e.g. (t) => `https://acme.com/visit/${t}`. */
  manageUrl: (token: string, tenantId: string) => string;
  /** Geocoding and drive checks. Default: keyless Haversine (no geocoding). Use `selectMapsProvider`. */
  maps?: MapsProvider;
  /** After commit, for every visit event (the comms listener's `onEvent`). Awaited and contained. */
  onEvent?: SchedulingEventListener;
  onEventError?: (error: unknown, event: SchedulingEvent) => void;
  /**
   * Throttle by bucket: 'read' (config, slots, viewing a visit, its .ics),
   * 'request' (a new request), 'manage' (reschedule, cancel). Return false
   * to answer 429. Injected — a serverless handler has no ambient counter
   * store, and the app's stack has one.
   */
  rateLimit?: (req: Request, bucket: SchedulingRateLimitBucket) => boolean | Promise<boolean>;
  /**
   * Who is asking, for the per-caller cap and for recognising a repeated
   * request. Default `clientIpKey`: the address the nearest proxy saw (the
   * LAST `X-Forwarded-For` entry), right on Vercel and behind one proxy that
   * appends to the header. Behind two (a CDN in front of nginx), pass
   * `createClientIpKey({ trustProxy: 2 })`. See `clientIpKey`.
   */
  requesterKey?: (req: Request) => string | null | Promise<string | null>;
  /** The fill-time floor for the request form, in ms. Default 2000; 0 turns the check off. */
  minFillMs?: number;
  /**
   * Access-Control-Allow-Origin for cross-origin embeds. Omitted → same-origin
   * only: no CORS headers, and cross-site POSTs are refused 403. With '*' the
   * cross-site check is off; with one origin, POSTs from that origin pass it.
   */
  cors?: string;
  /**
   * Does this deployment email customers (a comms listener on `onEvent` with
   * a sender that really sends)? Echoed in the config, so the widget stops
   * promising an email and shows the manage link to keep instead.
   *
   * Default: true only when `onEvent` is given. It used to default to true
   * outright, so a host that mounted the handler without a listener — the
   * quick-start mount did — had a booking page telling every customer "we've
   * emailed you" while nothing was sent. Pass false when the listener is wired
   * but the sender isn't (no mail key yet).
   */
  emailsEnabled?: boolean;
  /** The .ics UID domain. Never change it once visits exist. Default "scheduling.adminigloo". */
  uidDomain?: string;
  /** Expire overdue requests on a new request, at most once a minute per tenant. Default true. */
  sweepExpired?: boolean;
  now?: () => Date;
}

export interface SchedulingHandlers {
  handle: (req: Request) => Promise<Response>;
}

export interface ClientIpKeyOptions {
  /**
   * How many proxies you run in front of the app, each APPENDING to
   * `X-Forwarded-For`. The caller is the entry that many places from the
   * right. Default 1: Vercel (which sets the header to the caller alone),
   * nginx with `$proxy_add_x_forwarded_for`, Heroku, Render, Fly. A CDN in
   * front of nginx is 2.
   */
  trustProxy?: number;
}

/**
 * "ip:" + the caller's address as your proxies saw it, else X-Real-IP, else
 * null (no proxy headers at all: a laptop, a test).
 *
 * WHY NOT THE FIRST ENTRY. The left end of `X-Forwarded-For` is whatever the
 * client sent. Vercel overwrites the header, so there the first entry was the
 * caller; but nginx's `$proxy_add_x_forwarded_for` keeps the client's value
 * first and appends the real address, and a self-hosted app with no proxy has
 * no protection at all. Keyed on the first entry, a script that sent a
 * different made-up address each time passed the per-caller cap every time —
 * filling the calendar with requests and making the business email whatever
 * addresses it typed. The entry `trustProxy` places from the right is the
 * one your own proxy wrote. With NO proxy in front, every header is the
 * client's: rate-limit at the edge, or derive the key from your platform's
 * socket address, and pass that as `requesterKey`.
 */
export function clientIpKey(req: Request, options: ClientIpKeyOptions = {}): string | null {
  const hops = Math.max(1, Math.trunc(Number.isFinite(options.trustProxy) ? (options.trustProxy as number) : 1));
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (chain.length > 0) return `ip:${chain[Math.max(0, chain.length - hops)]}`;
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? `ip:${real}` : null;
}

/** `clientIpKey` with options, for `requesterKey`: `createClientIpKey({ trustProxy: 2 })`. */
export function createClientIpKey(options: ClientIpKeyOptions): (req: Request) => string | null {
  return (req) => clientIpKey(req, options);
}

/** The request form, in the wire's names. Issue paths come out as the widget's field names. */
const visitRequestBodySchema = z.object({
  slotId: z.string().min(1).max(500),
  service: z.string().trim().min(1, "Pick a service.").max(40),
  // One line each, and no web address in the name or the address: the
  // acknowledgement echoes them to the typed email (see text.ts).
  name: publicLine(200, "your name").refine((name) => name.length > 0, "Enter your name."),
  email: z.string().trim().email("Enter an email address.").max(320),
  phone: singleLine(60).nullish(),
  address: publicLine(500, "the address").nullish(),
  notes: z.string().max(2000).nullish(),
  estimateId: z.string().max(200).nullish(),
  /** "Send it anyway": the map couldn't find the address and the customer is sure of it. */
  addressAsTyped: z.boolean().optional(),
});

const rescheduleBodySchema = z.object({ slotId: z.string().min(1).max(500) });
const cancelBodySchema = z.object({ reason: z.string().trim().max(500).nullish() });

/** The server's names → the wire's, for issues raised past the handler's own parse. */
const REQUEST_RENAMES = { customerName: "name", customerEmail: "email", customerPhone: "phone" } as const;

const SPAM_MESSAGE = "That was quicker than a person can fill in the form. Please check your details and send it again.";

export function createSchedulingHandlers(options: CreateSchedulingHandlersOptions): SchedulingHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createSchedulingHandlers: pass tenantId or resolveTenant");
  }
  const minFillMs = options.minFillMs ?? 2000;
  if (!Number.isFinite(minFillMs) || minFillMs < 0) {
    throw new Error(`createSchedulingHandlers: minFillMs must be 0 or more (got ${String(options.minFillMs)})`);
  }
  const maps = options.maps ?? createHaversineMapsProvider();
  const emailsEnabled = options.emailsEnabled ?? Boolean(options.onEvent);
  const uidDomain = options.uidDomain?.trim() || "scheduling.adminigloo";
  const clock = () => options.now?.() ?? new Date();
  const sweep = createThrottle(60_000);

  const corsHeaders: Record<string, string> = options.cors
    ? {
        "access-control-allow-origin": options.cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        ...(options.cors === "*" ? {} : { vary: "Origin" }),
      }
    : {};
  const privateHeaders = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };

  function headers(extra: Record<string, string>, tokenRoute: boolean): Headers {
    return new Headers({ "cache-control": "no-store", ...corsHeaders, ...(tokenRoute ? privateHeaders : {}), ...extra });
  }
  function json(body: unknown, status: number, tokenRoute: boolean): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: headers({ "content-type": "application/json; charset=utf-8" }, tokenRoute),
    });
  }
  function failure(error: unknown, tokenRoute: boolean, renames: Record<string, string> = {}): Response {
    const wire = toWireError(error, renames);
    return json(
      { error: { code: wire.code, message: wire.message, ...(wire.issues ? { issues: wire.issues } : {}) } },
      wire.status,
      tokenRoute,
    );
  }

  type Route =
    | { kind: "config" | "slots" | "request" }
    | { kind: "visit" | "reschedule" | "cancel" | "ics"; token: string };

  function route(method: string, pathname: string): Route | null {
    const path = pathname.replace(/\/+$/, "");
    if (method === "GET" && path.endsWith("/v1/config")) return { kind: "config" };
    if (method === "GET" && path.endsWith("/v1/slots")) return { kind: "slots" };
    if (method === "POST" && path.endsWith("/v1/request")) return { kind: "request" };
    const visit = /\/v1\/visit\/([^/]+)(?:\/(reschedule|cancel|ics))?$/.exec(path);
    if (visit) {
      const token = safeDecode(visit[1] ?? "");
      const action = visit[2];
      if (!action && method === "GET") return { kind: "visit", token };
      if (action === "ics" && method === "GET") return { kind: "ics", token };
      if (action === "reschedule" && method === "POST") return { kind: "reschedule", token };
      if (action === "cancel" && method === "POST") return { kind: "cancel", token };
    }
    return null;
  }

  const bucketOf = (kind: Route["kind"]): SchedulingRateLimitBucket =>
    kind === "request" ? "request" : kind === "reschedule" || kind === "cancel" ? "manage" : "read";

  const notFound = () => new HttpError("not_found", NOT_FOUND_MESSAGE);

  async function dispatch(
    req: Request,
    matched: Route,
    tenantId: string,
    settings: SchedulingSettings,
    now: Date,
    tokenRoute: boolean,
  ): Promise<Response> {
    const writeOptions = {
      maps,
      now,
      settings,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.onEventError ? { onEventError: options.onEventError } : {}),
    };
    switch (matched.kind) {
      case "config": {
        const config: PublicConfig = {
          businessName: settings.businessName,
          timeZone: settings.timeZone,
          publicBookingEnabled: settings.publicBookingEnabled,
          autoConfirm: settings.autoConfirm,
          services: settings.services.map((service) => ({
            key: service.key,
            name: service.name,
            description: service.description ?? null,
            durationMinutes: service.durationMinutes,
          })),
          minNoticeMinutes: settings.minNoticeMinutes,
          horizonDays: settings.horizonDays,
          requireAddress: settings.requireAddress,
          cancelCutoffHours: settings.cancelCutoffHours,
          contactEmail: settings.contactEmail,
          contactPhone: settings.contactPhone,
          emailsEnabled,
          minFillMs,
        };
        return json(config, 200, false);
      }
      case "slots": {
        const params = new URL(req.url).searchParams;
        const from = params.get("from") || null;
        if (from !== null && !isValidDateString(from)) {
          throw new HttpError("invalid", "Some details need another look.", [
            { path: ["from"], message: "Use a date like 2026-11-02." },
          ]);
        }
        const rawDays = params.get("days");
        let days = 14;
        if (rawDays !== null && rawDays !== "") {
          const parsed = Number(rawDays);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > 31) {
            throw new HttpError("invalid", "Some details need another look.", [
              { path: ["days"], message: "Ask for 1 to 31 days." },
            ]);
          }
          days = parsed;
        }
        const service = params.get("service") || null;
        const manage = params.get("manage") || null;
        const start = from ?? todayIn(now, settings.timeZone);
        if (!settings.publicBookingEnabled) {
          const closed: SlotsResponse = {
            timeZone: settings.timeZone,
            service: service ?? "",
            from: start,
            to: addDays(start, days - 1),
            closed: true,
            slots: [],
          };
          return json(closed, 200, tokenRoute);
        }
        const result = await publicSlotsFor(
          options.db,
          { tenantId, service, from: start, days, manageToken: manage },
          { now, settings },
        );
        const body: SlotsResponse = {
          timeZone: result.timeZone,
          service: result.service,
          from: result.from,
          to: result.to,
          closed: result.closed,
          slots: result.slots,
        };
        return json(body, 200, tokenRoute);
      }
      case "request": {
        const raw = await readJsonBody(req);
        // Spam first, before any database work: a bot learns nothing and costs nothing.
        const website = raw["website"];
        const honeypot = website !== undefined && website !== null && !(typeof website === "string" && website.trim() === "");
        const fillMs = typeof raw["fillMs"] === "number" && Number.isFinite(raw["fillMs"]) ? (raw["fillMs"] as number) : 0;
        if (honeypot || (minFillMs > 0 && fillMs < minFillMs)) throw new HttpError("spam_suspected", SPAM_MESSAGE);
        const body = visitRequestBodySchema.parse(raw);

        if (options.sweepExpired !== false) {
          await sweep(tenantId, now.getTime(), () =>
            expirePendingRequests(options.db, tenantId, {
              now,
              settings,
              ...(options.onEvent ? { onEvent: options.onEvent } : {}),
              ...(options.onEventError ? { onEventError: options.onEventError } : {}),
            }),
          );
        }
        const requesterKey = options.requesterKey ? await options.requesterKey(req) : clientIpKey(req);
        const outcome = await requestPublicVisit(
          options.db,
          {
            tenantId,
            slotId: body.slotId,
            service: body.service,
            customerName: body.name,
            customerEmail: body.email,
            customerPhone: body.phone ?? null,
            address: body.address ?? null,
            notes: body.notes ?? null,
            estimateId: body.estimateId ?? null,
            ...(body.addressAsTyped ? { addressAsTyped: true } : {}),
          },
          { ...writeOptions, requesterKey },
        );
        const token = outcome.receipt.manageToken;
        const response: VisitRequestResponse = {
          // On a repeat, the row is the visit as THIS caller described it, and
          // there is no token: see `recentRepeat`.
          visit: toPublicVisit(outcome.row, settings, { now }),
          manageToken: token,
          manageUrl: token ? options.manageUrl(token, tenantId) : null,
          repeated: outcome.receipt.repeated,
        };
        return json(response, outcome.receipt.repeated ? 200 : 201, false);
      }
      case "visit": {
        const visit = await getVisitByToken(options.db, tenantId, matched.token, { now, settings });
        if (!visit) throw notFound();
        return json({ visit } satisfies VisitResponse, 200, true);
      }
      case "reschedule": {
        const body = rescheduleBodySchema.parse(await readJsonBody(req));
        const visit = await rescheduleVisitByToken(options.db, tenantId, matched.token, body, writeOptions);
        if (!visit) throw notFound();
        return json({ visit } satisfies VisitResponse, 200, true);
      }
      case "cancel": {
        const body = cancelBodySchema.parse(await readJsonBody(req));
        const visit = await cancelVisitByToken(options.db, tenantId, matched.token, { reason: body.reason ?? null }, writeOptions);
        if (!visit) throw notFound();
        return json({ visit } satisfies VisitResponse, 200, true);
      }
      case "ics": {
        const row = await visitRowByToken(options.db, tenantId, matched.token);
        if (!row) throw notFound();
        const { startsAt, endsAt } = instantsOf(row, settings.timeZone);
        const status = effectiveStatus(row, now);
        const cancelled = status === "cancelled" || status === "declined" || status === "expired";
        const ics = buildVisitIcs({
          visitId: row.id,
          startsAt,
          endsAt,
          sequence: row.sequence,
          status,
          serviceName: serviceNameFor(settings.services, row.serviceType),
          businessName: settings.businessName,
          address: row.address,
          manageUrl: options.manageUrl(matched.token, tenantId),
          uidDomain,
          now,
        });
        return new Response(ics, {
          status: 200,
          headers: headers(
            {
              "content-type": `text/calendar; charset=utf-8; method=${cancelled ? "CANCEL" : "PUBLISH"}`,
              "content-disposition": 'attachment; filename="visit.ics"',
            },
            true,
          ),
        });
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers({}, false) });
    const url = new URL(req.url);
    const matched = route(req.method, url.pathname);
    const tokenRoute =
      matched !== null && ("token" in matched || (matched.kind === "slots" && url.searchParams.has("manage")));
    // Before routing, the tenant or the database: a forged cross-site POST
    // does no work at all, not even a 404 lookup.
    if (req.method === "POST" && options.cors !== "*" && isCrossSiteRequest(req)) {
      const origin = req.headers.get("origin");
      if (!(options.cors && origin !== null && origin === options.cors)) {
        return failure(new HttpError("forbidden", "This request came from another site, so it was refused."), tokenRoute);
      }
    }
    if (!matched) return failure(notFound(), false);
    try {
      const tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound(), tokenRoute);
      if (options.rateLimit && !(await options.rateLimit(req, bucketOf(matched.kind)))) {
        return failure(new HttpError("rate_limited", "Too many requests. Please slow down and try again shortly."), tokenRoute);
      }
      const now = clock();
      const settings = await getSchedulingSettings(options.db, tenantId);
      return await dispatch(req, matched, tenantId, settings, now, tokenRoute);
    } catch (error) {
      return failure(error, tokenRoute, matched.kind === "request" ? REQUEST_RENAMES : {});
    }
  }

  return { handle };
}

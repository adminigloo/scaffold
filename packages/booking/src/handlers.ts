/**
 * The HTTP surface the booking widget speaks — one `handle(req)` routed by
 * path suffix, mounted by the host app at any base path (the feedback
 * package's pattern):
 *
 *   // app/api/booking/[...path]/route.ts
 *   const { handle } = createBookingHandlers({ db, tenantId: "acme", uidDomain, manageUrl });
 *   export { handle as GET, handle as POST, handle as OPTIONS };
 *
 * THE WIRE CONTRACT (shared with @adminigloo/booking-widget; change both or neither):
 *
 *   GET  {base}/v1/config                      → { sandbox, hostDisplayName, hostTimezone, types[], defaultCallingCode?,
 *                                                  emailsEnabled?, contactEmail? }
 *        types[] = { key, name, description, durationMinutes, media, minNoticeMinutes, horizonDays }
 *        emailsEnabled absent = true (a server older than the field); contactEmail absent = null.
 *   GET  {base}/v1/slots?type&from&to&manage?  → { slots[{start,end}], busySync }
 *   POST {base}/v1/hold          {type,start,previousHoldToken?,manageToken?} → { holdToken, expiresAt, start, end }
 *   POST {base}/v1/hold/release  {holdToken}                      → { ok: true }
 *   POST {base}/v1/book          {type,start,holdToken?,name,email,phone?,company?,notes?,medium,timezone,source?}
 *                                                                 → { booking, manageToken, manageUrl }
 *   GET  {base}/v1/manage/:token                → { booking }
 *   POST {base}/v1/manage/:token/cancel         {reason?}         → { booking }
 *   POST {base}/v1/manage/:token/reschedule     {start,holdToken?} → { booking }
 *   GET  {base}/v1/manage/:token/ics            → text/calendar (attachment)
 *   GET  {base}/v1/feed/:feedToken.ics          → text/calendar (the host's subscribable feed)
 *
 * `manage` / `manageToken` make the slot list and the hold reschedule-aware:
 * the invitee's own booking stops counting as busy. A token that opens
 * nothing is ignored by slots (no oracle) and is not_found on hold.
 *
 * Errors are `{ error: { code, message, issues? } }`: not_found 404,
 * slot_taken 409, hold_expired 409, already_booked 409 (the same form sent
 * twice — its hold already became a booking), invalid 400, rate_limited 429,
 * unlicensed 402, forbidden 403 (a cross-site POST, below). Every response
 * is `Cache-Control: no-store`; routes with a
 * token in the URL (path, or slots' `manage` query) add
 * `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, so the
 * capability in the URL is not handed to the next site the prospect clicks
 * through to, nor indexed if it leaks.
 *
 * SANDBOX. With `sandbox: true` the factory NEVER calls `onEvent` (nobody is
 * emailed) and NEVER calls `busySource` (no real calendar is read), whatever
 * else is passed. Combined with a throwaway tenant per visitor, a marketing
 * page can let strangers book for real against nothing real (sandbox.ts
 * packages exactly that). Its calendar exports are labelled non-events.
 *
 * CSRF. Every POST changes state (a hold on the host's calendar, a booking,
 * a cancel), and the body parser accepts text/plain — a "simple" request a
 * browser sends cross-site WITHOUT a preflight. Leaving out CORS headers
 * only stops another site READING the answer, not the request being made.
 * So unless `cors` is configured, a POST a browser sent from another site is
 * refused 403 `forbidden` before any work: see isCrossSiteRequest.
 */

import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import type { BusySource } from "./busy-source.js";
import { BookingError, type BookingErrorCode, type BookingIssue } from "./errors.js";
import { emailSchema, normalizeCallingCode } from "./fields.js";
import type { BookingDb, BookingContext, BookingEvent } from "./services/context.js";
import {
  DEFAULT_MAX_HOLDS_PER_SUBJECT,
  book,
  cancelByToken,
  getBookingByToken,
  getPublicConfig,
  holdSlot,
  hostFeed,
  icsByToken,
  listOpenSlots,
  releaseHold,
  rescheduleByToken,
} from "./services/public.js";

export type RateLimitBucket = "read" | "hold" | "book" | "manage";

export interface CreateBookingHandlersOptions {
  db: BookingDb;
  /** The tenant every request is served for. Give this or `resolveTenant`. */
  tenantId?: string;
  /** Per-request tenant (a sandbox cookie, a subdomain). null → 404. */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** A host's real calendar. Ignored in sandbox mode. */
  busySource?: BusySource;
  /** created / rescheduled / cancelled — awaited and caught. Ignored in sandbox mode. */
  onEvent?: (event: BookingEvent) => void | Promise<void>;
  /**
   * Throttle by bucket: 'read' (config, slots, feed), 'hold' (hold, release),
   * 'book', 'manage'. Return false to answer 429. Injected — a serverless
   * handler has no ambient counter store, and the app's stack has one.
   */
  rateLimit?: (req: Request, bucket: RateLimitBucket) => boolean | Promise<boolean>;
  /**
   * The AdminIgloo license gate. A no-op unless configured; `mode: "enforce"`
   * answers 402 before any other work when the license is missing, invalid,
   * expired or lacks "booking".
   */
  license?: {
    readonly key?: string | undefined;
    readonly publicKey?: string | undefined;
    readonly mode?: LicenseMode | undefined;
  };
  now?: () => Date;
  /** The .ics UID domain, e.g. "adminigloo.com". Never change it once bookings exist. */
  uidDomain: string;
  /** The prospect-facing manage page for a token, e.g. t => `https://site/book/manage/${t}`. */
  manageUrl: (token: string) => string;
  /** Demo mode: echoed in config and bookings; suppresses onEvent and busySource. */
  sandbox?: boolean;
  /**
   * Access-Control-Allow-Origin for cross-origin embeds ('*' for a keyed
   * embed on other sites). Omitted → same-origin only: no CORS headers, and
   * cross-site POSTs are refused 403 (see isCrossSiteRequest). With '*' the
   * cross-site check is off; with one origin, POSTs from that origin pass it.
   */
  cors?: string;
  /**
   * The country calling code ("1", "44") a prospect's phone number is read
   * in when typed without "+" or "00": "801 555 0143" becomes +18015550143,
   * and one domestic trunk "0" is dropped ("020 7946 0958" with "44" →
   * +442079460958). With "1", a number must be a real North American shape
   * and "011" reads as international; anything that cannot be normalised is
   * refused rather than guessed (fields.normalizePhone). Advertised in the
   * config so the widget checks numbers the same way. Omitted → the "+" and
   * country code are required. Anything that is not a 1–3 digit calling code
   * throws here, at construction.
   */
  defaultCallingCode?: string;
  /**
   * Does this deployment email the prospect (a listener on `onEvent` that
   * really sends)? Default true. Echoed in the config as `emailsEnabled`, so
   * the widget stops promising a confirmation email when it is false; the
   * package's own copy (`already_booked`) points at the confirmation page and
   * `contactEmail` instead. Pass `Boolean(env.RESEND_API_KEY)` or similar.
   */
  emailsEnabled?: boolean;
  /**
   * A human fallback address the app chooses to show prospects (echoed in
   * the config as `contactEmail`; "" means none). Must be an email address;
   * anything else throws at construction.
   */
  contactEmail?: string | null;
  /**
   * Sandbox only: where a REAL booking is made (e.g. "https://acme.com/book").
   * Appended to sandbox calendar exports as "Book a real call: …".
   */
  realBookingUrl?: string;
  /**
   * Who is asking for a hold — usually the client IP's rate-limit key, or a
   * session id. With it, one requester can hold at most `maxHoldsPerSubject`
   * times at once (holds are anonymous and free, and a script could
   * otherwise keep the whole calendar held). null → no cap for that request.
   * Only a SHA-256 (salted with the tenant) is stored, on the hold row.
   */
  holdSubject?: (req: Request) => string | null | Promise<string | null>;
  /** Live holds per `holdSubject`, not counting the one being replaced. Default 2. */
  maxHoldsPerSubject?: number;
}

export interface BookingHandlers {
  handle: (req: Request) => Promise<Response>;
}

const MAX_BODY_CHARS = 20_000;

function hostOf(value: string): string | null {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Was this request sent by a browser from ANOTHER site? The CSRF check every
 * POST passes before any work (unless `cors` is configured).
 *
 *  1. Sec-Fetch-Site, when present, is the browser's own verdict and cannot
 *     be set by a page: same-origin, same-site (a sibling subdomain of the
 *     same registrable domain) and none (typed, bookmarked) pass; cross-site
 *     does not. Every current browser sends it.
 *  2. Otherwise (an older browser) the Origin header — or, failing that, the
 *     Referer — must name the same host as the request URL. `Origin: null`
 *     (a sandboxed iframe, a file: page, a data: URL) is cross-site by
 *     definition. X-Forwarded-Host also counts as "this host", for apps
 *     behind a proxy that rewrites Host: a page cannot add that header to a
 *     cross-site request without a CORS preflight, which this handler fails.
 *  3. With neither header, the request is allowed only if it carries no
 *     Sec-Fetch-* header at all — i.e. it is not from a browser (a server, a
 *     test, curl). A browser that sends Sec-Fetch-Mode but no Sec-Fetch-Site
 *     or Origin is not one we can vouch for, so it is refused. A non-browser
 *     caller can of course forge any header; CSRF is about a visitor's
 *     browser being driven by another site, and that browser cannot.
 */
export function isCrossSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) {
    const verdict = site.trim().toLowerCase();
    return !(verdict === "same-origin" || verdict === "same-site" || verdict === "none");
  }
  const origin = req.headers.get("origin");
  if (origin !== null && origin.trim().toLowerCase() === "null") return true;
  const source = origin ?? req.headers.get("referer");
  if (source) {
    const from = hostOf(source);
    if (!from) return true;
    const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
    return !(from === hostOf(req.url) || (forwarded !== undefined && forwarded !== "" && from === forwarded));
  }
  for (const name of req.headers.keys()) {
    if (name.toLowerCase().startsWith("sec-fetch-")) return true;
  }
  return false;
}

/** Wire field names differ from the service's in one place: `type` ↔ `typeKey`. */
function wireIssues(issues: BookingIssue[] | undefined): BookingIssue[] | undefined {
  return issues?.map((issue) => ({
    ...issue,
    path: issue.path.map((part, index) => (index === 0 && part === "typeKey" ? "type" : part)),
  }));
}

export function createBookingHandlers(options: CreateBookingHandlersOptions): BookingHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createBookingHandlers: pass tenantId or resolveTenant");
  }
  const sandbox = options.sandbox === true;
  // An empty string (an env var defined but blank) means "not set"; anything
  // else must be a real calling code — a typo here would otherwise silently
  // fall back to the strict rule and nobody would know why "801…" fails.
  const rawCallingCode = options.defaultCallingCode?.trim() ?? "";
  const defaultCallingCode = rawCallingCode ? normalizeCallingCode(rawCallingCode) : null;
  if (rawCallingCode && !defaultCallingCode) {
    throw new Error(
      `createBookingHandlers: defaultCallingCode must be a country calling code like "1" or "44" (got ${JSON.stringify(options.defaultCallingCode)})`,
    );
  }
  // The same "blank means unset, a typo throws" rule: a contact address shown
  // to prospects that is not an address would strand the very people it is for.
  const rawContact = options.contactEmail?.trim() ?? "";
  const contact = rawContact ? emailSchema.safeParse(rawContact) : null;
  if (contact && !contact.success) {
    throw new Error(`createBookingHandlers: contactEmail must be an email address (got ${JSON.stringify(options.contactEmail)})`);
  }
  const contactEmail = contact?.success ? contact.data : null;
  const emailsEnabled = options.emailsEnabled !== false;
  const maxHoldsPerSubject = options.maxHoldsPerSubject ?? DEFAULT_MAX_HOLDS_PER_SUBJECT;
  if (!Number.isInteger(maxHoldsPerSubject) || maxHoldsPerSubject < 1) {
    throw new Error(`createBookingHandlers: maxHoldsPerSubject must be a whole number of at least 1 (got ${String(options.maxHoldsPerSubject)})`);
  }
  const realBookingUrl = options.realBookingUrl?.trim() || null;

  const corsHeaders: Record<string, string> = options.cors
    ? {
        "access-control-allow-origin": options.cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-adminigloo-key",
        "access-control-max-age": "86400",
        ...(options.cors === "*" ? {} : { vary: "Origin" }),
      }
    : {};

  const privateHeaders = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };

  function headers(extra: Record<string, string>, tokenRoute: boolean): Headers {
    return new Headers({
      "cache-control": "no-store",
      ...corsHeaders,
      ...(tokenRoute ? privateHeaders : {}),
      ...extra,
    });
  }

  function json(body: unknown, status = 200, tokenRoute = false): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: headers({ "content-type": "application/json; charset=utf-8" }, tokenRoute),
    });
  }

  function errorResponse(code: BookingErrorCode, message: string, status: number, tokenRoute: boolean, issues?: BookingIssue[]): Response {
    return json({ error: { code, message, ...(issues ? { issues } : {}) } }, status, tokenRoute);
  }

  function calendar(body: string, filename: string, attachment: boolean, method?: string): Response {
    return new Response(body, {
      status: 200,
      headers: headers(
        {
          "content-type": `text/calendar; charset=utf-8${method ? `; method=${method}` : ""}`,
          "content-disposition": `${attachment ? "attachment" : "inline"}; filename="${filename}"`,
        },
        true,
      ),
    });
  }

  /** JSON body, tolerant of sendBeacon's text/plain. Missing → {}. */
  async function body(req: Request): Promise<Record<string, unknown>> {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) throw new BookingError("invalid", "Request body is too large.");
    if (text.trim() === "") return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BookingError("invalid", "Expected a JSON body.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BookingError("invalid", "Expected a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }

  const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

  type Route =
    | { kind: "config" | "slots" | "hold" | "release" | "book" }
    | { kind: "manage" | "cancel" | "reschedule" | "ics"; token: string }
    | { kind: "feed"; token: string };

  function route(method: string, pathname: string): Route | null {
    const path = pathname.replace(/\/+$/, "");
    if (method === "GET" && path.endsWith("/v1/config")) return { kind: "config" };
    if (method === "GET" && path.endsWith("/v1/slots")) return { kind: "slots" };
    if (method === "POST" && path.endsWith("/v1/hold/release")) return { kind: "release" };
    if (method === "POST" && path.endsWith("/v1/hold")) return { kind: "hold" };
    if (method === "POST" && path.endsWith("/v1/book")) return { kind: "book" };
    const feed = /\/v1\/feed\/([^/]+)\.ics$/.exec(path);
    if (feed && method === "GET") return { kind: "feed", token: safeDecode(feed[1] ?? "") };
    const manage = /\/v1\/manage\/([^/]+)(?:\/(cancel|reschedule|ics))?$/.exec(path);
    if (manage) {
      const token = safeDecode(manage[1] ?? "");
      const action = manage[2];
      if (!action && method === "GET") return { kind: "manage", token };
      if (action === "ics" && method === "GET") return { kind: "ics", token };
      if (action === "cancel" && method === "POST") return { kind: "cancel", token };
      if (action === "reschedule" && method === "POST") return { kind: "reschedule", token };
    }
    return null;
  }

  function safeDecode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  }

  const bucketOf = (kind: Route["kind"]): RateLimitBucket =>
    kind === "hold" || kind === "release"
      ? "hold"
      : kind === "book"
        ? "book"
        : kind === "manage" || kind === "cancel" || kind === "reschedule" || kind === "ics"
          ? "manage"
          : "read";

  async function dispatch(req: Request, matched: Route, ctx: BookingContext, tokenRoute: boolean): Promise<Response> {
    const url = new URL(req.url);
    switch (matched.kind) {
      case "config":
        return json(await getPublicConfig(ctx));
      case "slots": {
        const manageToken = url.searchParams.get("manage");
        return json(
          await listOpenSlots(ctx, {
            typeKey: url.searchParams.get("type") ?? "",
            ...(url.searchParams.get("from") ? { from: url.searchParams.get("from") ?? "" } : {}),
            ...(url.searchParams.get("to") ? { to: url.searchParams.get("to") ?? "" } : {}),
            ...(manageToken ? { manageToken } : {}),
          }),
          200,
          tokenRoute,
        );
      }
      case "hold": {
        const input = await body(req);
        const previousHoldToken = str(input["previousHoldToken"]);
        // Absent or null: an ordinary hold. Present but not a string still
        // counts as "acting for a booking", so it is not_found rather than
        // silently holding an ordinary time.
        const rawManage = input["manageToken"];
        const manageToken = rawManage === undefined || rawManage === null ? undefined : (str(rawManage) ?? "");
        const subject = options.holdSubject ? await options.holdSubject(req) : null;
        return json(
          await holdSlot(
            ctx,
            {
              typeKey: str(input["type"]) ?? "",
              start: str(input["start"]) ?? "",
              ...(previousHoldToken ? { previousHoldToken } : {}),
              ...(manageToken !== undefined ? { manageToken } : {}),
            },
            { subject, maxPerSubject: maxHoldsPerSubject },
          ),
        );
      }
      case "release": {
        const input = await body(req);
        return json(await releaseHold(ctx, { holdToken: str(input["holdToken"]) ?? "" }));
      }
      case "book": {
        const input = await body(req);
        const optional = (key: string) => {
          const value = str(input[key]);
          return value === undefined ? {} : { [key]: value };
        };
        const result = await book(ctx, {
          typeKey: str(input["type"]) ?? "",
          start: str(input["start"]) ?? "",
          name: str(input["name"]) ?? "",
          email: str(input["email"]) ?? "",
          medium: (str(input["medium"]) ?? "") as "video",
          ...optional("holdToken"),
          ...optional("phone"),
          ...optional("company"),
          ...optional("notes"),
          ...optional("timezone"),
          ...optional("source"),
        });
        return json({ ...result, manageUrl: options.manageUrl(result.manageToken) });
      }
      case "manage":
        return json({ booking: await getBookingByToken(ctx, matched.token) }, 200, true);
      case "cancel": {
        const input = await body(req);
        const reason = str(input["reason"]);
        return json({ booking: await cancelByToken(ctx, matched.token, reason ? { reason } : {}) }, 200, true);
      }
      case "reschedule": {
        const input = await body(req);
        const holdToken = str(input["holdToken"]);
        return json(
          {
            booking: await rescheduleByToken(ctx, matched.token, {
              start: str(input["start"]) ?? "",
              ...(holdToken ? { holdToken } : {}),
            }),
          },
          200,
          true,
        );
      }
      case "ics": {
        const { ics, method } = await icsByToken(ctx, matched.token, { uidDomain: options.uidDomain });
        // The file name says it too, for whoever finds it in Downloads later.
        return calendar(ics, sandbox ? "sandbox-not-a-real-booking.ics" : "call.ics", true, method);
      }
      case "feed":
        return calendar(await hostFeed(ctx, matched.token, { uidDomain: options.uidDomain }), "calls.ics", false);
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers({}, false) });
    }
    // The license gate first: an unlicensed deployment does no work at all.
    if (options.license) {
      const decision = verifyLicense({ feature: "booking", ...options.license });
      if (!decision.ok) return errorResponse("unlicensed", decision.reason, 402, false);
    }
    const url = new URL(req.url);
    const matched = route(req.method, url.pathname);
    // A capability in the URL — in the path, or a reschedule's slots query.
    const tokenRoute =
      matched !== null && ("token" in matched || (matched.kind === "slots" && url.searchParams.has("manage")));
    // Before routing, the tenant or the database: a forged cross-site POST
    // does no work at all, not even a 404 lookup.
    if (req.method === "POST" && options.cors !== "*" && isCrossSiteRequest(req)) {
      const origin = req.headers.get("origin");
      if (!(options.cors && origin !== null && origin === options.cors)) {
        return errorResponse("forbidden", new BookingError("forbidden").message, 403, tokenRoute);
      }
    }
    if (!matched) return errorResponse("not_found", "Not found.", 404, false);
    try {
      const tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return errorResponse("not_found", "Not found.", 404, tokenRoute);
      if (options.rateLimit && !(await options.rateLimit(req, bucketOf(matched.kind)))) {
        return errorResponse("rate_limited", "Too many requests. Please slow down and try again shortly.", 429, tokenRoute);
      }
      const ctx: BookingContext = {
        db: options.db,
        tenantId,
        now: options.now?.() ?? new Date(),
        manageUrl: options.manageUrl,
        sandbox,
        ...(defaultCallingCode ? { defaultCallingCode } : {}),
        emailsEnabled,
        contactEmail,
        ...(sandbox && realBookingUrl ? { realBookingUrl } : {}),
        // The sandbox guarantee is enforced HERE, by never handing the
        // services the two things that reach the outside world.
        ...(sandbox ? {} : { busySource: options.busySource ?? null }),
        ...(sandbox || !options.onEvent ? {} : { onEvent: options.onEvent }),
      };
      return await dispatch(req, matched, ctx, tokenRoute);
    } catch (error) {
      if (error instanceof BookingError) {
        return errorResponse(error.code, error.message, error.status, tokenRoute, wireIssues(error.issues));
      }
      return json({ error: { code: "internal", message: "Something went wrong. Please try again." } }, 500, tokenRoute);
    }
  }

  return { handle };
}

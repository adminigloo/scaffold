/**
 * A BUSINESS'S OWN CALLS (0.2): one fetch handler for the host's side —
 * bookings, the people taking calls, their hours and time off, holidays and
 * call types — every route under `{mount}/v1/` (BOOKING_ADMIN_ROUTES):
 *
 *   // app/api/app/[tenantId]/calls/[...path]/route.ts
 *   const { handle } = createBookingAdminHandlers({ db, resolveTenant, authorize, feedUrl });
 *   export { handle as GET, handle as POST };
 *
 * WHOSE BUSINESS: the id in the PATH (`resolveTenant`), asked of `authorize`
 * for the route's one permission on every call — never the session's active
 * company. Everything after that is that business's: every service filters on
 * it, and an id of another business's (a booking, a host, a time off, a
 * holiday, a call type) is "not found", exactly like one that never existed.
 *
 * Seams, so it installs in an app built differently: `resolveTenant` (whose),
 * `authorize` (may this person, here — a Response is returned as it is,
 * `false` is 403), `member` (is this email one of the business's own people,
 * and which user — a host must be), `hostLimit` (its plan's people taking
 * calls), `feedUrl` (the host's subscribable feed, on the public mount),
 * `busySource` and `onEvent` (the real calendar, and who hears about a
 * cancel, a confirm or a move).
 *
 * The wire is plain JSON (instants as ISO strings): what
 * @adminigloo/booking-widget/admin's `createBookingAdminFetchAdapter` reads.
 */

import { verifyLicense, type LicenseMode } from "@adminigloo/license";
import type { BusySource } from "./busy-source.js";
import { BookingError, type BookingIssue } from "./errors.js";
import { isCrossSiteRequest } from "./handlers.js";
import type { BookingPermission } from "./permissions.js";
import { BOOKING_ADMIN_ROUTE_PERMISSIONS, type BookingAdminRouteKind } from "./routes.js";
import {
  addBlackout,
  addException,
  cancelAllFromEmail,
  confirmBooking,
  countLiveHolds,
  getAvailability,
  getBooking,
  getHost,
  hostCancelBooking,
  hostLimitSentence,
  hostRescheduleBooking,
  listBlackouts,
  listBookings,
  listHosts,
  listTypes,
  removeBlackout,
  removeException,
  rotateHostFeedToken,
  setOutcome,
  setWeeklyAvailability,
  testBusySource,
  upsertHost,
  upsertType,
} from "./services/admin.js";
import type { AdminBooking, BookingContext, BookingDb, BookingEvent, HostMembers } from "./services/context.js";
import { listOpenSlots } from "./services/public.js";

export type BookingAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateBookingAdminHandlersOptions {
  db: BookingDb;
  /** One fixed business (a single site). Pass this or `resolveTenant`. */
  tenantId?: string;
  /** The business a request is for — in a companies project, the id in the PATH. null → "not found". */
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** May this person do this, in this business? One of the four `booking.*` keys. */
  authorize: (req: Request, permission: BookingPermission, tenantId: string) => BookingAuthorizeResult | Promise<BookingAuthorizeResult>;
  /**
   * Is this email one of the business's own people, and who? A host must be
   * (their user id is kept on the host). Absent → any address may take calls
   * (a single business, whose front desk may have no sign-in).
   */
  member?: (tenantId: string, email: string) => { userId: string } | null | Promise<{ userId: string } | null>;
  /**
   * The business's own people, for "Add a person" (0.2): who could take calls.
   * Absent → the screen asks for an email instead (a single business).
   */
  listMembers?: (tenantId: string) => ReadonlyArray<{ userId: string; name: string; email: string }> | Promise<ReadonlyArray<{ userId: string; name: string; email: string }>>;
  /** Which hosts' people are still members (0.2): a host whose person left offers no times and gets no notices. */
  hostMembers?: HostMembers;
  /** The most people who may take calls at once (its plan's). A number: the limit; null/undefined: none. */
  hostLimit?: (tenantId: string) => number | null | undefined | Promise<number | null | undefined>;
  /** A host's subscribable feed for a freshly minted token: the public mount's `v1/feed/{token}.ics`. */
  feedUrl?: (token: string, tenantId: string) => FeedLinks | Promise<FeedLinks>;
  /** A host's real calendar, for "Test connection" and the move picker. */
  busySource?: BusySource;
  /** confirmed / cancelled / rescheduled by the host — awaited and caught. */
  onEvent?: (event: BookingEvent) => void | Promise<void>;
  license?: { readonly key?: string | undefined; readonly publicKey?: string | undefined; readonly mode?: LicenseMode | undefined };
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

/** A host's subscribable feed: the https address, and the webcal:// one calendar apps subscribe to. */
export interface FeedLinks {
  httpsUrl: string;
  webcalUrl?: string;
}

/** GET v1/team (0.2): who could take calls, and the plan's limit in words once it's reached. */
export interface TeamWire {
  /** false when the app gave no member list (the screen asks for an email instead). */
  available: boolean;
  people: Array<{ userId: string; name: string; email: string; hostId: string | null }>;
  limit: number | null;
  limitMessage: string | null;
}

export interface BookingAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

const NOT_HERE = "Not found.";
const VIEW_FORBIDDEN = "You don't have permission to see the calls here.";
const MANAGE_FORBIDDEN = "You don't have permission to change this.";
const INTERNAL = "Something went wrong. Please try again.";
const MAX_BODY_CHARS = 20_000;
/** The longest a call can be (upsertTypeSchema), so "upcoming" still lists the one under way. */
const LONGEST_CALL_MS = 480 * 60_000;

interface Matched {
  kind: BookingAdminRouteKind;
  id?: string;
}

function segmentsAfterV1(pathname: string): string[] | null {
  const at = pathname.indexOf("/v1/");
  if (at < 0) return null;
  const parts = pathname
    .slice(at + 4)
    .replace(/\/+$/, "")
    .split("/");
  try {
    return parts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

/** The route a path names for a method; null for an unknown one. */
function route(pathname: string, method: string): Matched | null {
  const parts = segmentsAfterV1(pathname);
  if (!parts) return null;
  const get = method === "GET" || method === "HEAD";
  const post = method === "POST";
  const [a, b, c] = parts;
  const n = parts.length;
  const id = b ?? "";
  if (a === "bookings") {
    if (n === 1 && get) return { kind: "bookings" };
    if (n === 2 && post && b === "cancel-from-email") return { kind: "bookings-cancel-email" };
    if (n === 2 && get) return { kind: "booking", id };
    if (n === 3 && post && c === "cancel") return { kind: "booking-cancel", id };
    if (n === 3 && post && c === "confirm") return { kind: "booking-confirm", id };
    if (n === 3 && post && c === "outcome") return { kind: "booking-outcome", id };
    if (n === 3 && post && c === "move") return { kind: "booking-move", id };
    if (n === 3 && get && c === "slots") return { kind: "booking-slots", id };
  }
  if (a === "hosts") {
    if (n === 1 && get) return { kind: "hosts" };
    if (n === 1 && post) return { kind: "host-add" };
    if (n === 2 && post) return { kind: "host-update", id };
    if (n === 3 && post && c === "test-calendar") return { kind: "host-test", id };
    if (n === 3 && post && c === "feed") return { kind: "host-feed", id };
    if (n === 3 && get && c === "availability") return { kind: "availability", id };
    if (n === 3 && post && c === "availability") return { kind: "availability-set", id };
    if (n === 3 && post && c === "exceptions") return { kind: "exception-add", id };
  }
  if (a === "exceptions" && n === 3 && post && c === "remove") return { kind: "exception-remove", id };
  if (a === "holidays") {
    if (n === 1 && get) return { kind: "holidays" };
    if (n === 1 && post) return { kind: "holiday-add" };
    if (n === 3 && post && c === "remove") return { kind: "holiday-remove", id };
  }
  if (a === "types") {
    if (n === 1 && get) return { kind: "types" };
    if (n === 1 && post) return { kind: "type-add" };
    if (n === 2 && post) return { kind: "type-update", id };
  }
  if (a === "holds" && n === 1 && get) return { kind: "holds" };
  if (a === "team" && n === 1 && get) return { kind: "team" };
  return null;
}

/** An id is at most 100 characters of a plain shape; anything else is "not found" before any query. */
function idShaped(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(code: string, status: number, message: string, issues?: BookingIssue[]): Response {
  return json({ error: { code, message, ...(issues ? { issues } : {}) } }, status);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) throw new BookingError("invalid", "Request body is too large.");
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BookingError("invalid", "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BookingError("invalid", "Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function userIdOf(verdict: BookingAuthorizeResult): string | null {
  return typeof verdict === "object" && !(verdict instanceof Response) && verdict.userId != null && verdict.userId !== "" ? String(verdict.userId) : null;
}


export function createBookingAdminHandlers(options: CreateBookingAdminHandlersOptions): BookingAdminHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new TypeError("createBookingAdminHandlers needs `tenantId` (one business) or `resolveTenant` (one per company).");
  }
  if (typeof options.authorize !== "function") throw new TypeError("createBookingAdminHandlers needs `authorize`.");
  if (!options.db) throw new TypeError("createBookingAdminHandlers needs `db`.");

  async function limitOf(tenantId: string): Promise<number | null> {
    const limit = await options.hostLimit?.(tenantId);
    return typeof limit === "number" ? limit : null;
  }

  /** The member a host's email names, or the refusal in words. Absent seam → no one, and no check. */
  async function memberFor(tenantId: string, email: unknown): Promise<string | null | undefined> {
    if (!options.member) return undefined;
    const address = typeof email === "string" ? email.trim().toLowerCase() : "";
    const found = address ? await options.member(tenantId, address) : null;
    if (!found) {
      throw new BookingError("invalid", "Some details need another look.", [
        { path: ["email"], message: "Only people on your team can take calls. Invite them first, then add them here with the email they sign in with." },
      ]);
    }
    return found.userId;
  }

  /** The people who could take calls, for "Add a person" (0.2): the business's own, each with their host card if they have one. */
  async function team(ctx: BookingContext): Promise<TeamWire> {
    const hosts = await listHosts(ctx);
    const limit = await limitOf(ctx.tenantId);
    const active = hosts.filter((host) => host.isActive).length;
    const limitMessage = limit !== null && active >= limit ? hostLimitSentence(limit) : null;
    if (!options.listMembers) return { available: false, people: [], limit, limitMessage };
    const byUser = new Map(hosts.flatMap((host) => (host.userId ? [[host.userId, host.id] as const] : [])));
    const people = (await options.listMembers(ctx.tenantId)).map((person) => ({
      userId: person.userId,
      name: person.name,
      email: person.email,
      hostId: byUser.get(person.userId) ?? null,
    }));
    return { available: true, people, limit, limitMessage };
  }

  async function bookingsOf(ctx: BookingContext, scope: string | null): Promise<AdminBooking[]> {
    const now = ctx.now ?? new Date();
    if (scope === "past") {
      const rows = await listBookings(ctx, { to: now, limit: 1000 });
      return rows.filter((row) => row.end.getTime() <= now.getTime()).reverse().slice(0, 200);
    }
    const rows = await listBookings(ctx, { from: new Date(now.getTime() - LONGEST_CALL_MS), limit: 500 });
    return rows.filter((row) => row.end.getTime() > now.getTime());
  }

  async function dispatch(req: Request, match: Matched, ctx: BookingContext, userId: string | null): Promise<Response> {
    void userId;
    const url = new URL(req.url);
    if (match.id !== undefined && !idShaped(match.id)) return errorResponse("not_found", 404, NOT_HERE);
    const id = match.id ?? "";
    switch (match.kind) {
      case "bookings":
        return json({ bookings: await bookingsOf(ctx, url.searchParams.get("scope")) });
      case "booking": {
        const found = await getBooking(ctx, id);
        return found ? json({ booking: found }) : errorResponse("not_found", 404, NOT_HERE);
      }
      case "booking-cancel": {
        const body = await readBody(req);
        const reason = typeof body["reason"] === "string" ? body["reason"] : null;
        return json({ booking: await hostCancelBooking(ctx, { id, reason }) });
      }
      case "booking-confirm":
        return json({ booking: await confirmBooking(ctx, id) });
      case "booking-outcome": {
        const body = await readBody(req);
        return json({ booking: await setOutcome(ctx, { ...body, id } as Parameters<typeof setOutcome>[1]) });
      }
      case "booking-move": {
        const body = await readBody(req);
        return json({ booking: await hostRescheduleBooking(ctx, { id, start: body["start"] as string }) });
      }
      case "booking-slots": {
        const found = await getBooking(ctx, id);
        if (!found) return errorResponse("not_found", 404, NOT_HERE);
        if (!found.typeKey) return json({ slots: [], busySync: "off" });
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        return json(
          await listOpenSlots(ctx, { typeKey: found.typeKey, ...(from ? { from } : {}), ...(to ? { to } : {}) }, { excludeBookingId: found.id }),
        );
      }
      case "bookings-cancel-email": {
        const body = await readBody(req);
        return json(await cancelAllFromEmail(ctx, { email: typeof body["email"] === "string" ? body["email"] : "" }));
      }
      case "hosts":
        return json({ hosts: await listHosts(ctx) });
      case "host-add": {
        const body = await readBody(req);
        const member = body["isActive"] === false ? undefined : await memberFor(ctx.tenantId, body["email"]);
        const { id: _ignored, ...rest } = body;
        void _ignored;
        const input = { ...rest, ...(member !== undefined ? { userId: member } : {}) } as Parameters<typeof upsertHost>[1];
        return json({ host: await upsertHost(ctx, input, { maxActive: await limitOf(ctx.tenantId) }) }, 201);
      }
      case "host-update": {
        const existing = await getHost(ctx, id);
        const body = await readBody(req);
        // Switching someone OFF never asks whether they're still on the team
        // (0.2): a person who left must be switchable off. Anything that leaves
        // them taking calls does.
        const staysOff = body["isActive"] === false || (body["isActive"] === undefined && !existing.isActive);
        const member = staysOff ? undefined : await memberFor(ctx.tenantId, body["email"] ?? existing.email);
        const input = { ...body, id, ...(member !== undefined ? { userId: member } : {}) } as Parameters<typeof upsertHost>[1];
        return json({ host: await upsertHost(ctx, input, { maxActive: await limitOf(ctx.tenantId) }) });
      }
      case "team":
        return json(await team(ctx));
      case "host-test":
        return json(await testBusySource(ctx, id));
      case "host-feed": {
        await getHost(ctx, id);
        if (!options.feedUrl) throw new BookingError("invalid", "Calendar feeds aren't switched on here.");
        const { feedToken } = await rotateHostFeedToken(ctx, id);
        return json(await options.feedUrl(feedToken, ctx.tenantId));
      }
      case "availability":
        return json(await getAvailability(ctx, { hostId: id }));
      case "availability-set": {
        const body = await readBody(req);
        return json({ weekly: await setWeeklyAvailability(ctx, { hostId: id, windows: body["windows"] as never }) });
      }
      case "exception-add": {
        const body = await readBody(req);
        return json({ exception: await addException(ctx, { ...body, hostId: id } as Parameters<typeof addException>[1]) }, 201);
      }
      case "exception-remove": {
        const { removed } = await removeException(ctx, id);
        return removed ? json({ removed: true }) : errorResponse("not_found", 404, NOT_HERE);
      }
      case "holidays":
        return json({ holidays: await listBlackouts(ctx) });
      case "holiday-add": {
        const body = await readBody(req);
        return json({ holiday: await addBlackout(ctx, body as Parameters<typeof addBlackout>[1]) }, 201);
      }
      case "holiday-remove": {
        const { removed } = await removeBlackout(ctx, id);
        return removed ? json({ removed: true }) : errorResponse("not_found", 404, NOT_HERE);
      }
      case "types":
        return json({ types: await listTypes(ctx) });
      case "type-add": {
        const body = await readBody(req);
        const { id: _ignored, ...rest } = body;
        void _ignored;
        return json({ type: await upsertType(ctx, rest as Parameters<typeof upsertType>[1]) }, 201);
      }
      case "type-update": {
        const body = await readBody(req);
        return json({ type: await upsertType(ctx, { ...body, id } as Parameters<typeof upsertType>[1]) });
      }
      case "holds":
        return json(await countLiveHolds(ctx));
    }
  }

  return {
    async handle(req: Request): Promise<Response> {
      let tenantId: string | null = null;
      let kind = "unknown";
      try {
        if (options.license) {
          const decision = verifyLicense({ feature: "booking", ...options.license });
          if (!decision.ok) return errorResponse("unlicensed", 402, decision.reason);
        }
        const match = route(new URL(req.url).pathname, req.method);
        if (!match) return errorResponse("not_found", 404, NOT_HERE);
        kind = match.kind;
        if (req.method === "POST" && isCrossSiteRequest(req)) return errorResponse("forbidden", 403, new BookingError("forbidden").message);
        tenantId = options.tenantId ?? (await options.resolveTenant?.(req)) ?? null;
        if (!tenantId) return errorResponse("not_found", 404, NOT_HERE);
        const permission = BOOKING_ADMIN_ROUTE_PERMISSIONS[match.kind];
        const verdict = await options.authorize(req, permission, tenantId);
        if (verdict instanceof Response) return verdict;
        if (verdict === false) return errorResponse("forbidden", 403, permission === "booking.calls.view" ? VIEW_FORBIDDEN : MANAGE_FORBIDDEN);
        const ctx: BookingContext = {
          db: options.db,
          tenantId,
          now: options.now?.() ?? new Date(),
          busySource: options.busySource ?? null,
          ...(options.onEvent ? { onEvent: options.onEvent } : {}),
          ...(options.hostMembers ? { hostMembers: options.hostMembers } : {}),
        };
        return await dispatch(req, match, ctx, userIdOf(verdict));
      } catch (error) {
        if (error instanceof BookingError) return errorResponse(error.code, error.status, error.message, error.issues);
        options.onError?.(error, { tenantId, route: kind });
        return errorResponse("internal", 500, INTERNAL);
      }
    },
  };
}

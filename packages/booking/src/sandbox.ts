/**
 * A booking SANDBOX per visitor, ready to mount: the real handlers, run with
 * `sandbox: true` against a throwaway calendar that belongs to one browser
 * session — so a marketing page can let strangers book, move and cancel for
 * real, while nothing reaches the host, nobody is emailed and no real
 * calendar is read. Lifted from the AdminIgloo site's own demo, where it
 * shipped first, and kept framework-free: a `Request` in, a `Response` out,
 * the session in a Set-Cookie header.
 *
 *   // app/api/book-demo/[...path]/route.ts
 *   const demo = createSandboxBookingHandlers({
 *     db, uidDomain: "demo.acme.com", manageUrl: (t) => `https://acme.com/demo/manage/${t}`,
 *     cookieName: prod ? "__Host-acme_bookdemo" : "acme_bookdemo", secureCookie: prod,
 *     tenantPrefix: "bookdemo:", previewTenant: "bookdemo-preview:v1", seed: { host, weekly, types },
 *     realBookingUrl: "https://acme.com/book",
 *   });
 *   export const GET = demo.handle;
 *   export const POST = demo.handle;
 *   // daily cron: await demo.purgeExpired();
 *
 * HOW NOTHING REAL IS REACHED, in layers, so no single mistake undoes it:
 *   1. The inner factory runs with `sandbox: true`: it never calls `onEvent`
 *      or a busy source, whatever is passed.
 *   2. None is passed anyway — the options type leaves out onEvent,
 *      busySource, tenantId, resolveTenant, cors and rateLimit, and the inner
 *      options are built field by field, so not even an untyped caller can
 *      slip one through.
 *   3. Every request is served for a tenant chosen HERE: the prefix plus the
 *      SHA-256 of the visitor's cookie. Every read and write in the package is
 *      tenant-scoped, so a visitor sees only their own sandbox, and the app's
 *      real tenant is a string this module never names.
 *
 * THE SESSION is a capability: 32 random bytes in an httpOnly, SameSite=Lax
 * cookie with no Max-Age (it ends with the browser session). Only its hash
 * becomes the tenant id, so the table never holds the capability. A cookie
 * with no live sandbox behind it is never adopted — a fresh one is minted.
 *
 * WHO GETS A SANDBOX. Reads (config, slots) from a browser with none are
 * served from one shared, read-only PREVIEW tenant with the same schedule, so
 * a page view, a crawler or a bot never creates a row. The first claim on a
 * time (hold or book) mints the sandbox. Manage, release and feed routes are
 * only ever served for the visitor's own sandbox; without one they are the
 * package's ordinary 404.
 *
 * AN ANONYMOUS WRITE INTO THE APP'S DATABASE, so it is fenced: cross-site
 * POSTs refused before anything else (a forged request must not even mint),
 * the app's per-bucket `rateLimit` plus a "mint" bucket for new sandboxes,
 * and hourly ceilings on new sandboxes and on claims, counted in Postgres so
 * they hold across every serverless instance and no rotation of IPs or
 * cookies gets past them.
 *
 * LIFETIME. A sandbox lives `ttlHours` from the moment it is made, enforced
 * where it is USED: a request carrying an older one is treated as having
 * none (the next claim mints a new one) and the old one is deleted after the
 * response. `purgeExpired()` (a daily cron) deletes the rest, and a new
 * sandbox sweeps a few stale ones on its way in.
 */

import { and, asc, count, eq, gte, like, lt } from "drizzle-orm";
import { verifyLicense } from "@adminigloo/license";
import { BookingError, type BookingErrorCode } from "./errors.js";
import {
  createBookingHandlers,
  isCrossSiteRequest,
  type BookingHandlers,
  type CreateBookingHandlersOptions,
  type RateLimitBucket,
} from "./handlers.js";
import { bookingBookings, bookingHosts } from "./schema.js";
import { purgeTenants, seedSandboxTenant, seedSandboxTenantSchema, type SeedSandboxTenantInput } from "./services/maintenance.js";
import { generateToken, hashToken } from "./tokens.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The handler buckets, plus "mint": a new sandbox, which is what a cookie-clearing script spends. */
export type SandboxRateLimitBucket = RateLimitBucket | "mint";

export interface CreateSandboxBookingHandlersOptions
  extends Omit<
    CreateBookingHandlersOptions,
    "tenantId" | "resolveTenant" | "sandbox" | "onEvent" | "busySource" | "rateLimit" | "cors"
  > {
  /**
   * The session cookie's name. Use a `__Host-` name in production (the
   * browser then refuses it unless Secure, host-only and Path=/, so no
   * sibling subdomain can plant a sandbox on a visitor) — which requires
   * `secureCookie: true`.
   */
  cookieName: string;
  /** Send the cookie with `Secure` (every https deployment). */
  secureCookie: boolean;
  /** How long one sandbox lives from the moment it is made. Default 24. */
  ttlHours?: number;
  /**
   * Every visitor sandbox is `${tenantPrefix}<64 hex>`, and purgeExpired
   * sweeps by it — so it must be distinctive and never a prefix of a real
   * tenant id ("bookdemo:", not "a"). 3–36 characters.
   */
  tenantPrefix: string;
  /**
   * The shared read-only calendar a browser with no sandbox is shown. It must
   * NOT start with `tenantPrefix` (the purge would delete it out from under
   * the page). Only reads are ever served from it; bump a version suffix when
   * `seed` changes, since the seed never edits an existing host.
   */
  previewTenant: string;
  /** What every sandbox (and the preview) holds: a host, a week, the types. Validated at construction. */
  seed: Omit<SeedSandboxTenantInput, "tenantId">;
  /** Site-wide, per rolling hour, counted in Postgres. Far above a real crowd; far below a script. */
  ceilings?: {
    /** New sandboxes. Default 300. */
    newSandboxesPerHour?: number;
    /** Claims on time — every hold and booking row made in a sandbox. Default 1,200. */
    holdsPerHour?: number;
  };
  /** Per-requester throttle by bucket (the handler's four, plus "mint"); false → 429. */
  rateLimit?: (req: Request, bucket: SandboxRateLimitBucket) => boolean | Promise<boolean>;
  /**
   * Run work after the response (Next's `after`, Cloudflare's `waitUntil`).
   * Default: start it now without waiting. Failures go to `onError`.
   */
  defer?: (task: () => Promise<unknown>) => void;
  /**
   * A sandbox booking succeeded — e.g. record a demo conversion. Deferred;
   * gets the request's headers and URL, never the booking.
   */
  onBooked?: (info: { headers: Headers; url: string }) => void | Promise<void>;
  /** Told about failures this module swallows (a deferred cleanup, a seed). Default: ignored. */
  onError?: (error: unknown, where: string) => void;
}

export interface SandboxBookingHandlers {
  handle: (req: Request) => Promise<Response>;
  /**
   * The cleanup (a daily cron): every sandbox whose newest activity is older
   * than the lifetime, then the ones past their lifetime that were still
   * being clicked near its end. Bounded by `limit` and an optional deadline.
   */
  purgeExpired: (options?: { now?: Date; limit?: number; deadline?: number }) => Promise<{ idle: number; aged: number }>;
  /** Delete one sandbox now. Anything that is not a full sandbox id is refused (0). */
  removeSandbox: (tenantId: string) => Promise<{ tenants: number }>;
  /** Is this one of this wrapper's visitor sandbox ids? */
  isSandboxTenant: (tenantId: string) => boolean;
  /** Seed the preview calendar now (it is otherwise seeded on the first read). */
  ensurePreview: () => Promise<void>;
}

/** read: own sandbox else the preview · claim: own sandbox else mint one · own: own sandbox else 404. */
type Access = "read" | "claim" | "own";

interface SandboxRoute {
  kind: "config" | "slots" | "hold" | "release" | "book" | "manage" | "feed";
  bucket: RateLimitBucket;
  access: Access;
}

/** The handler's routes, by the same suffix rules as handlers.ts `route`. */
function classify(method: string, pathname: string): SandboxRoute | null {
  const path = pathname.replace(/\/+$/, "");
  if (method === "GET" && path.endsWith("/v1/config")) return { kind: "config", bucket: "read", access: "read" };
  if (method === "GET" && path.endsWith("/v1/slots")) return { kind: "slots", bucket: "read", access: "read" };
  if (method === "POST" && path.endsWith("/v1/hold/release")) return { kind: "release", bucket: "hold", access: "own" };
  if (method === "POST" && path.endsWith("/v1/hold")) return { kind: "hold", bucket: "hold", access: "claim" };
  if (method === "POST" && path.endsWith("/v1/book")) return { kind: "book", bucket: "book", access: "claim" };
  if (/\/v1\/manage\/[^/]+(?:\/(?:cancel|reschedule|ics))?$/.test(path)) return { kind: "manage", bucket: "manage", access: "own" };
  if (method === "GET" && /\/v1\/feed\/[^/]+\.ics$/.test(path)) return { kind: "feed", bucket: "read", access: "own" };
  return null;
}

/** A session token is exactly what generateToken makes: 32 bytes, base64url, 43 characters. */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 6265 cookie-name characters. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** One cookie from a raw Cookie header (a plain Request has no cookie helper). */
function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** `%` and `_` in a prefix are literal characters, not wildcards (maintenance.ts does the same). */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`createSandboxBookingHandlers: ${name} must be a whole number of at least 1`);
  return value;
}

export function createSandboxBookingHandlers(options: CreateSandboxBookingHandlersOptions): SandboxBookingHandlers {
  const { db, tenantPrefix, previewTenant, cookieName } = options;
  if (!COOKIE_NAME.test(cookieName)) throw new Error("createSandboxBookingHandlers: cookieName is not a valid cookie name");
  if (/^__(Host|Secure)-/.test(cookieName) && !options.secureCookie) {
    throw new Error("createSandboxBookingHandlers: a __Host- or __Secure- cookie needs secureCookie: true (browsers refuse it otherwise)");
  }
  if (tenantPrefix.length < 3 || tenantPrefix.length > 36) {
    throw new Error("createSandboxBookingHandlers: tenantPrefix must be 3–36 characters");
  }
  if (!previewTenant || previewTenant.startsWith(tenantPrefix)) {
    throw new Error("createSandboxBookingHandlers: previewTenant must be set and must not start with tenantPrefix");
  }
  const seedCheck = seedSandboxTenantSchema.safeParse({ ...options.seed, tenantId: previewTenant });
  if (!seedCheck.success) {
    const first = seedCheck.error.issues[0];
    throw new Error(`createSandboxBookingHandlers: seed is invalid (${first ? `${first.path.join(".")}: ${first.message}` : "unknown"})`);
  }
  const ttlMs = positiveInt(options.ttlHours, 24, "ttlHours") * HOUR_MS;
  const ceilings = {
    sandboxes: positiveInt(options.ceilings?.newSandboxesPerHour, 300, "ceilings.newSandboxesPerHour"),
    claims: positiveInt(options.ceilings?.holdsPerHour, 1_200, "ceilings.holdsPerHour"),
  };
  const sandboxShape = new RegExp(`^${escapeRegExp(tenantPrefix)}[0-9a-f]{64}$`);
  const pattern = likePrefix(tenantPrefix);
  const clock = () => options.now?.() ?? new Date();
  const report = (error: unknown, where: string) => {
    try {
      options.onError?.(error, where);
    } catch {
      // A broken logger must not break the demo.
    }
  };
  const defer = (where: string, task: () => Promise<unknown>) => {
    const guarded = () => task().catch((error: unknown) => report(error, where));
    try {
      if (options.defer) options.defer(guarded);
      else void guarded();
    } catch {
      void guarded();
    }
  };

  /** The tenant chosen for each request, read back by the inner factory's resolveTenant. */
  const tenantOf = new WeakMap<Request, string | null>();

  // Field by field, so nothing that reaches the outside world can ride in on
  // a spread — not even from a caller who ignored the types.
  const inner: BookingHandlers = createBookingHandlers({
    db,
    resolveTenant: (req) => tenantOf.get(req) ?? null,
    sandbox: true,
    uidDomain: options.uidDomain,
    manageUrl: options.manageUrl,
    ...(options.now ? { now: options.now } : {}),
    ...(options.defaultCallingCode !== undefined ? { defaultCallingCode: options.defaultCallingCode } : {}),
    ...(options.emailsEnabled !== undefined ? { emailsEnabled: options.emailsEnabled } : {}),
    ...(options.contactEmail !== undefined ? { contactEmail: options.contactEmail } : {}),
    ...(options.realBookingUrl !== undefined ? { realBookingUrl: options.realBookingUrl } : {}),
    ...(options.holdSubject ? { holdSubject: options.holdSubject } : {}),
    ...(options.maxHoldsPerSubject !== undefined ? { maxHoldsPerSubject: options.maxHoldsPerSubject } : {}),
  });

  const cookieAttributes = `Path=/; HttpOnly; SameSite=Lax${options.secureCookie ? "; Secure" : ""}`;
  const sessionCookie = (token: string) => `${cookieName}=${token}; ${cookieAttributes}`;
  const clearedCookie = () => `${cookieName}=; Max-Age=0; ${cookieAttributes}`;

  const isSandboxTenant = (tenantId: string) => sandboxShape.test(tenantId);
  const tenantFor = async (token: string) => `${tenantPrefix}${await hashToken(token)}`;

  let previewSeeded: Promise<void> | null = null;
  const ensurePreview = (): Promise<void> => {
    previewSeeded ??= seedSandboxTenant(db, { ...options.seed, tenantId: previewTenant }, { now: clock() }).then(
      () => undefined,
      (error: unknown) => {
        previewSeeded = null;
        throw error;
      },
    );
    return previewSeeded;
  };

  /** When a sandbox was made (its host row), or null when there is none. */
  async function bornAt(tenantId: string): Promise<Date | null> {
    const [row]: Array<{ at: Date }> = await db
      .select({ at: bookingHosts.createdAt })
      .from(bookingHosts)
      .where(eq(bookingHosts.tenantId, tenantId))
      .orderBy(asc(bookingHosts.createdAt))
      .limit(1);
    return row?.at ?? null;
  }

  async function ceilingReached(kind: "sandboxes" | "claims", now: Date): Promise<boolean> {
    const since = new Date(now.getTime() - HOUR_MS);
    const [row]: Array<{ n: number }> =
      kind === "sandboxes"
        ? await db
            .select({ n: count() })
            .from(bookingHosts)
            .where(and(like(bookingHosts.tenantId, pattern), gte(bookingHosts.createdAt, since)))
        : await db
            .select({ n: count() })
            .from(bookingBookings)
            .where(and(like(bookingBookings.tenantId, pattern), gte(bookingBookings.createdAt, since)));
    return Number(row?.n ?? 0) >= ceilings[kind];
  }

  /**
   * The tenant id as the purge prefix, with a cutoff in the future, is
   * "exactly this tenant, whatever its age"; the shape check means it can only
   * ever be a full sandbox id, never something shorter that matches more.
   */
  async function removeSandbox(tenantId: string): Promise<{ tenants: number }> {
    if (!isSandboxTenant(tenantId)) return { tenants: 0 };
    return purgeTenants(db, { prefix: tenantId, olderThan: new Date(clock().getTime() + DAY_MS) });
  }

  async function purgeExpired(input: { now?: Date; limit?: number; deadline?: number } = {}): Promise<{ idle: number; aged: number }> {
    const now = input.now ?? clock();
    const cutoff = new Date(now.getTime() - ttlMs);
    const { tenants: idle } = await purgeTenants(db, { prefix: tenantPrefix, olderThan: cutoff });
    const aged: Array<{ tenantId: string }> = await db
      .selectDistinct({ tenantId: bookingHosts.tenantId })
      .from(bookingHosts)
      .where(and(like(bookingHosts.tenantId, pattern), lt(bookingHosts.createdAt, cutoff)))
      .limit(input.limit ?? 100);
    let removed = 0;
    for (const { tenantId } of aged) {
      if (input.deadline !== undefined && Date.now() > input.deadline) break;
      removed += (await removeSandbox(tenantId)).tenants;
    }
    return { idle, aged: removed };
  }

  let lastSweepAt = Number.NEGATIVE_INFINITY;
  /** A new sandbox sweeps a few stale ones, at most every 15 minutes per instance. */
  function sweepSoon(): void {
    const now = Date.now();
    if (now - lastSweepAt < 15 * 60_000) return;
    lastSweepAt = now;
    defer("sweep", () => purgeExpired({ limit: 10 }));
  }

  const hasCapabilityInUrl = (url: URL) => /\/v1\/(?:manage|feed)\//.test(url.pathname) || url.searchParams.has("manage");

  /** The package's error shape, so the unmodified widget reads it. */
  function errorResponse(code: BookingErrorCode | "internal", message: string, status: number, url: URL, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(hasCapabilityInUrl(url) ? { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } : {}),
        ...extra,
      },
    });
  }

  function withCookie(res: Response, cookie: string | null): Response {
    if (!cookie) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", cookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  const busy = (url: URL) =>
    errorResponse("rate_limited", "The demo is busy right now. Give it a few minutes and try again.", 429, url, {
      "retry-after": "300",
    });
  const slowDown = (url: URL) => errorResponse("rate_limited", new BookingError("rate_limited").message, 429, url);
  const allowed = async (req: Request, bucket: SandboxRateLimitBucket) => !options.rateLimit || (await options.rateLimit(req, bucket));

  async function serve(req: Request, url: URL, route: SandboxRoute): Promise<Response> {
    if (!(await allowed(req, route.bucket))) return slowDown(url);
    const now = clock();
    let cookie: string | null = null;
    let current: string | null = null;
    const presented = readCookie(req.headers.get("cookie"), cookieName);
    if (presented !== undefined) {
      if (SESSION_TOKEN.test(presented)) {
        const tenantId = await tenantFor(presented);
        const born = await bornAt(tenantId);
        if (born && born.getTime() > now.getTime() - ttlMs) {
          current = tenantId;
        } else if (born) {
          // Past its lifetime: unreachable from this moment, deleted after the response.
          defer("remove-expired", () => removeSandbox(tenantId));
        }
      }
      // Anything presented that is not a live sandbox is told to go away; a
      // claim below replaces this with a fresh session.
      if (!current) cookie = clearedCookie();
    }

    // Claims are counted before a sandbox is minted for them: a ceiling hit
    // should not leave a fresh, empty sandbox behind.
    if (route.access === "claim" && (await ceilingReached("claims", now))) return withCookie(busy(url), cookie);

    let tenant: string | null = current;
    if (!tenant && route.access === "read") {
      try {
        await ensurePreview();
      } catch (error) {
        report(error, "preview-seed");
        return withCookie(errorResponse("internal", "The booking demo isn't available right now.", 503, url), cookie);
      }
      tenant = previewTenant;
    } else if (!tenant && route.access === "claim") {
      if (!(await allowed(req, "mint"))) return withCookie(slowDown(url), cookie);
      if (await ceilingReached("sandboxes", now)) return withCookie(busy(url), cookie);
      const token = generateToken();
      tenant = await tenantFor(token);
      await seedSandboxTenant(db, { ...options.seed, tenantId: tenant }, { now });
      cookie = sessionCookie(token);
      sweepSoon();
    }

    tenantOf.set(req, tenant);
    const res = await inner.handle(req);
    if (route.kind === "book" && res.status === 200 && options.onBooked) {
      const info = { headers: new Headers(req.headers), url: req.url };
      const onBooked = options.onBooked;
      defer("on-booked", async () => onBooked(info));
    }
    return withCookie(res, cookie);
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Before anything that writes: a forged cross-site POST must not even
    // mint a sandbox (the inner factory would refuse it too, but only after
    // this wrapper had seeded one).
    if (req.method === "POST" && isCrossSiteRequest(req)) {
      return errorResponse("forbidden", new BookingError("forbidden").message, 403, url);
    }
    if (options.license) {
      const decision = verifyLicense({ feature: "booking", ...options.license });
      if (!decision.ok) return errorResponse("unlicensed", decision.reason, 402, url);
    }
    const route = classify(req.method, url.pathname);
    // Not a route the package knows: no tenant, and the package's own 404.
    if (!route) return inner.handle(req);
    try {
      return await serve(req, url, route);
    } catch (error) {
      // Choosing the tenant talks to the database outside the package's own
      // error handling; a failure there still answers in the package's shape.
      report(error, "request");
      return errorResponse("internal", "Something went wrong. Please try again.", 500, url);
    }
  }

  return { handle, purgeExpired, removeSandbox, isSandboxTenant, ensurePreview };
}

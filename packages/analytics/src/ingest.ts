import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { classifySource, clickIdKindOf, referrerHostOf, SOURCE_CLASSIFIER_VERSION } from "./sources.js";
import { classifyCrawler } from "./crawlers.js";
import {
  contentOf,
  ENGAGED_DURATION_MS,
  ENGAGED_PAGE_VIEWS,
  hmacHex,
  looksLikeToken,
  normalizePath,
  parseUserAgent,
  SESSION_INACTIVITY_MS,
  type ContentType,
  type PathPattern,
} from "./visitor.js";
import { isWebVitalMetric, WEB_VITAL_MAX } from "./vitals.js";
import { dayInZone } from "./periods.js";
import type { CrawlerVerifier } from "./verify.js";
import { AnalyticsError, DEFAULT_LIMITS, type AnalyticsContext, type AnalyticsDb } from "./context.js";
import { DEFAULT_ANALYTICS_PREFIX } from "./schema.js";

/**
 * The WRITE side: the beacon endpoint, server-side conversions, the crawler
 * log and the daily maintenance. Every function takes the instance context
 * (`createAnalytics`), so its tables, limits and caches are that instance's
 * own. The 0.1 top-level functions (`createAnalyticsHandler(options)`,
 * `recordConversion(db, …)`, …) live in legacy.ts as wrappers over a default
 * instance.
 */

// ---------------------------------------------------------------------------
// Daily salts — shared by every server instance, deleted the day after next.
// ---------------------------------------------------------------------------

/** YYYY-MM-DD of `at` in `timeZone` (the day the salt and the reports agree on). */
export function dayIn(at: Date, timeZone = "UTC"): string {
  return dayInZone(at, timeZone);
}

async function saltFor(ctx: AnalyticsContext, day: string, create: boolean): Promise<string | null> {
  const { db, t, saltCache } = ctx;
  const cached = saltCache.get(day);
  if (cached) return cached;
  const read = async () => (await db.select({ salt: t.salts.salt }).from(t.salts).where(eq(t.salts.day, day)).limit(1))[0]?.salt ?? null;
  let salt = await read();
  if (!salt && create) {
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await db.insert(t.salts).values({ day, salt: fresh }).onConflictDoNothing();
    salt = await read();
  }
  if (salt) {
    saltCache.set(day, salt);
    if (saltCache.size > 8) saltCache.delete(saltCache.keys().next().value as string);
  }
  return salt;
}

export interface VisitorKeys {
  /** Today's key — new sessions are filed under it. */
  current: string;
  /** Keys a live session may still be under (today's and yesterday's), so a visit survives the rollover. */
  candidates: string[];
  /** An HMAC of the network alone, for the throttle. */
  network: string;
}

export interface VisitorKeysInput {
  tenantId: string;
  ip: string;
  userAgent: string;
  at: Date;
  timeZone?: string;
}

/**
 * The cookieless identity of a request: HMACs of (ip, user agent, tenant)
 * under today's salt and yesterday's. Nothing about the request is stored but
 * the resulting hex.
 */
export async function resolveVisitorKeysIn(ctx: AnalyticsContext, input: VisitorKeysInput): Promise<VisitorKeys> {
  const today = dayIn(input.at, input.timeZone);
  const yesterday = dayIn(new Date(input.at.getTime() - 24 * 60 * 60 * 1000), input.timeZone);
  const salt = (await saltFor(ctx, today, true)) as string;
  const prevSalt = await saltFor(ctx, yesterday, false);
  const message = `${input.ip}\u0000${input.userAgent}\u0000${input.tenantId}`;
  const current = await hmacHex(salt, message);
  const candidates = [current];
  if (prevSalt) candidates.push(await hmacHex(prevSalt, message));
  const network = await hmacHex(salt, `net\u0000${input.ip}\u0000${input.tenantId}`);
  return { current, candidates, network };
}

// ---------------------------------------------------------------------------
// Scrubbing — nothing person-shaped is stored, whatever the client sent.
// ---------------------------------------------------------------------------

const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
const PHONE = /\+?\d[\d\s().-]{7,}\d/;

/** A label (click text, outbound host) with anything person- or secret-shaped removed; null if nothing is left. */
export function scrubLabel(value: string | null | undefined, max = DEFAULT_LIMITS.maxLabelLength): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (EMAIL.test(text) || PHONE.test(text)) return null;
  if (text.split(" ").some((word) => looksLikeToken(word))) return null;
  return text.slice(0, max);
}

/** A UTM value: a campaign name, not a subscriber id — length capped, odd characters stripped, emails and tokens refused. */
export function scrubUtm(value: string | null | undefined, max = DEFAULT_LIMITS.maxUtmLength): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (EMAIL.test(text) || looksLikeToken(text)) return null;
  const cleaned = text.replace(/[^\p{L}\p{N} _.:/+-]/gu, "").slice(0, max).trim();
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// The beacon endpoint
// ---------------------------------------------------------------------------

/**
 * Everything the app knows when a page view lands on a visit — handed to
 * `onSession`, which is where an app calls `audience.observe(...)`:
 *
 *   onSession: async (visit) => audience.observe({
 *     visitorId: visit.visitorId, sessionId: visit.sessionId,
 *     userId: (await auth()).userId, host: visit.host,
 *     userAgent: visit.userAgent, headers: visit.headers, ip: visit.ip,
 *   })
 *
 * `ip` is here in memory only: analytics never stores it, and neither does
 * the audience (it matches network rules and drops it).
 */
export interface AnalyticsSessionContext {
  /** The beacon request — read your auth cookie from it (Clerk's `auth()` works in the route too). */
  req: Request;
  tenantId: string;
  /** The `…sessions.id` of the visit — what a visit-only audience mark (automation, a network rule) names. */
  sessionId: string;
  /** The visit's stored visitor key — what a visitor (device) audience mark names. */
  visitorId: string;
  /** True on the page view that opened the visit. */
  isNewSession: boolean;
  /** The page, normalized as stored. */
  path: string;
  /** The page's host (from Origin, else Referer), e.g. `adminigloo.com`. */
  host: string | null;
  userAgent: string;
  headers: Headers;
  /** From your `clientIp` hook. In memory only — never stored. */
  ip: string | null;
}

/**
 * What `onSession` may return: the audience's reason ("role", "automation"…)
 * or null — or `{ reason, actorKey }`. Recorded on the session (first
 * non-null answer wins) as `internal_reason` and `actor_key`. Neither is a
 * filter: the audience's marks decide what counts.
 *
 * Both are checked before they are stored, and refused (reported to
 * `onError`, never stored) when they do not look like what they claim to be:
 * a reason is one word (`[A-Za-z0-9_.:-]`, at most 64), and an actor key is a
 * keyed digest (40–128 characters of hex or base64url, like the audience's
 * `userKey(userId)`), so a raw user id or an email returned by mistake never
 * reaches the table.
 */
export type AnalyticsSessionVerdict = string | null | undefined | void | { reason?: string | null; actorKey?: string | null };

/** How long the handler waits for `onSession` before answering without its verdict. */
export const DEFAULT_ON_SESSION_TIMEOUT_MS = 3000;

export interface AnalyticsHandlerConfig {
  tenantId: string;
  /** This site's own hosts: beacons must come from one, and referrals from one are not referrals. */
  allowedHosts: readonly string[];
  /**
   * The client IP — used only inside the HMACs, never stored. Inject what your
   * host guarantees (on Vercel, `x-real-ip` or the first `x-forwarded-for`
   * entry, which Vercel overwrites). Off a trusted proxy, a leftmost
   * X-Forwarded-For is whatever the client typed.
   */
  clientIp: (req: Request) => string | null;
  /** Country code for the request, e.g. from `x-vercel-ip-country`. */
  resolveCountry?: (req: Request) => string | null;
  /** IANA zone whose midnight rotates the salt — the zone the reports use. Default UTC. */
  timeZone?: string;
  /**
   * Honour Sec-GPC / DNT by not counting the request at all (default true).
   * With no stored identifier, an objection cannot be honoured afterwards —
   * only at collection.
   */
  honorPrivacySignals?: boolean;
  /** Route shapes to collapse before the token redaction, e.g. `/invoice/:token`. */
  pathPatterns?: readonly PathPattern[];
  /** Content dimensions read from the path. */
  contentTypes?: readonly ContentType[];
  /** Event names that mark the session converted when sent from the client. */
  conversionEvents?: readonly string[];
  /**
   * Called once per RECORDED page view, after it is written, with the visit's
   * session id and visitor key — the place to call `audience.observe(...)`.
   * Awaited (a serverless function may stop once the response is sent), and
   * never allowed to fail the beacon: an error goes to `onError` and the
   * request still answers 204. Not called for a dropped request (bot, privacy
   * signal, foreign origin, throttled, malformed) or for events and leaves.
   */
  onSession?: (visit: AnalyticsSessionContext) => AnalyticsSessionVerdict | Promise<AnalyticsSessionVerdict>;
  /**
   * How long to wait for `onSession`, in milliseconds (default 3000). A hook
   * still pending then (a hung audience store, an exhausted pool) is reported
   * to `onError` and the beacon answers 204 with the page view recorded and
   * no verdict; the hook is not cancelled, and a later failure is reported too.
   */
  onSessionTimeoutMs?: number;
  /**
   * Told about failures the endpoint swallows. Default: the instance's
   * `onError` (console.warn). A reporter that throws is itself ignored: the
   * beacon still answers 204.
   */
  onError?: (error: unknown, where: string) => void;
  now?: () => Date;
}

/**
 * What the beacon sends. Short keys — it goes out on every page.
 *   d   per-document id (memory only on the client)
 *   p   path
 *   ms  foreground milliseconds since the previous beacon from this document
 *   pageview: r = referrer HOST (first view of the document only), q = location.search (first view only)
 *   event:    n = name, l = label, v = value, i = web-vitals metric id
 * The query string is read here for UTM tags and click ids and then dropped.
 */
const base = {
  d: z.string().min(8).max(40).regex(/^[A-Za-z0-9_-]+$/),
  p: z.string().min(1).max(2000),
  ms: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
};
const payloadSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("pageview"), ...base, r: z.string().max(300).optional(), q: z.string().max(2000).optional() }),
  z.object({
    t: z.literal("event"),
    ...base,
    n: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_:-]*$/i),
    l: z.string().max(200).optional(),
    v: z.number().finite().optional(),
    i: z.string().max(80).optional(),
  }),
  z.object({ t: z.literal("leave"), ...base }),
]);

const noContent = () => new Response(null, { status: 204 });

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

function pageHost(req: Request): string | null {
  return hostOf(req.headers.get("origin")) ?? hostOf(req.headers.get("referer"));
}

function sameSite(req: Request, allowedHosts: readonly string[]): boolean {
  const host = pageHost(req);
  if (!host) return false;
  const bare = host.replace(/^www\./, "");
  return allowedHosts.some((allowed) => bare === allowed.toLowerCase().replace(/^www\./, ""));
}

/** Anything with `get(name)`: a `Headers`, or Next's `headers()` result. */
export interface HeadersLike {
  get(name: string): string | null;
}

/** True when the headers carry Global Privacy Control (`Sec-GPC: 1`) or Do Not Track (`DNT: 1`). */
export function sendsPrivacySignalHeaders(headers: HeadersLike): boolean {
  return headers.get("sec-gpc") === "1" || headers.get("dnt") === "1";
}

export function sendsPrivacySignal(req: Request): boolean {
  return sendsPrivacySignalHeaders(req.headers);
}

export interface AnalyticsHandler {
  handle: (req: Request) => Promise<Response>;
}

/** A recorded reason or key: printable, trimmed. */
function cleanVerdictText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text || null;
}

/** One verdict word: "role", "non_production", "role:admin". Never an email, a sentence or a name. */
const REASON_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;
/**
 * A keyed digest: 40–128 characters of hex or base64url. The audience's
 * `userKey(userId)` (HMAC-SHA256, base64url) is 43; an HMAC-SHA256 in hex is
 * 64. A Clerk id (32), a UUID (36, with dashes), a Firebase uid (28), a
 * numeric id or an email all fail it. A sanity check, not a proof: a raw id
 * that happens to be 40+ such characters would pass.
 */
const ACTOR_KEY_SHAPE = /^[A-Za-z0-9_-]{40,128}$/;

interface ReadVerdict {
  reason: string | null;
  actorKey: string | null;
  /** What was returned but refused for its shape — reported, never stored (and never echoed: it may be personal). */
  refused: Array<"reason" | "actorKey">;
}

function readVerdict(verdict: AnalyticsSessionVerdict): ReadVerdict {
  const raw =
    typeof verdict === "string"
      ? { reason: verdict, actorKey: null }
      : verdict && typeof verdict === "object"
        ? { reason: verdict.reason, actorKey: verdict.actorKey }
        : { reason: null, actorKey: null };
  const out: ReadVerdict = { reason: null, actorKey: null, refused: [] };
  const reason = cleanVerdictText(raw.reason);
  if (reason !== null) {
    if (REASON_SHAPE.test(reason)) out.reason = reason;
    else out.refused.push("reason");
  }
  const actorKey = cleanVerdictText(raw.actorKey);
  if (actorKey !== null) {
    if (ACTOR_KEY_SHAPE.test(actorKey)) out.actorKey = actorKey;
    else out.refused.push("actorKey");
  }
  return out;
}

const REFUSED_MESSAGE: Record<ReadVerdict["refused"][number], string> = {
  reason: "onSession returned a reason that is not one verdict word ([A-Za-z0-9_.:-], at most 64 characters); it was not stored",
  actorKey:
    "onSession returned an actorKey that does not look like a keyed digest (40–128 characters of hex or base64url, e.g. audience.userKey(userId)) — a raw user id or an email? It was not stored",
};

/**
 * The body as text, read no further than `maxBytes` (counted in BYTES, not
 * characters). A declared Content-Length over the cap is refused without
 * reading a byte; a body that turns out longer is cut off as soon as it
 * passes the cap. Null: too big, empty or unreadable.
 */
async function readCappedBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = req.headers.get("content-length")?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const TIMED_OUT: unique symbol = Symbol("onSession timed out");

/**
 * The beacon endpoint. ALWAYS 204 — a bad payload, a foreign origin, a bot, a
 * privacy signal, a throttled network and a counted page view look identical
 * from outside, so there is nothing to probe (and a page's own error
 * recorders never see a failed analytics request).
 */
export function createHandlerIn(ctx: AnalyticsContext, options: AnalyticsHandlerConfig): AnalyticsHandler {
  const { tenantId } = options;
  const { limits } = ctx;
  const now = options.now ?? (() => new Date());
  const conversions = new Set(options.conversionEvents ?? []);
  const honorSignals = options.honorPrivacySignals ?? true;
  const timeoutMs = options.onSessionTimeoutMs ?? DEFAULT_ON_SESSION_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new AnalyticsError("invalid_config", `onSessionTimeoutMs must be a positive whole number of milliseconds (got ${JSON.stringify(timeoutMs)}).`);
  }
  const reporter = options.onError ?? ctx.onError;
  /** Tell the app about a swallowed failure. A reporter that throws is ignored: analytics must never be the thing that errors. */
  const report = (error: unknown, where: string): void => {
    try {
      reporter(error, where);
    } catch {
      /* the beacon still answers 204 */
    }
  };

  /** Ask the app's `onSession` for its verdict, within `timeoutMs`. Undefined: no answer to record. */
  async function askApp(visit: AnalyticsSessionContext): Promise<AnalyticsSessionVerdict> {
    const hook = options.onSession;
    if (!hook) return undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = Promise.resolve().then(() => hook(visit));
    // A hook that fails after the deadline is still reported — and never left as an unhandled rejection.
    answer.catch((error: unknown) => {
      if (timedOut) report(error, "onSession");
    });
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(TIMED_OUT);
      }, timeoutMs);
    });
    try {
      const first = await Promise.race([answer, deadline]);
      if (first === TIMED_OUT) {
        report(new Error(`onSession did not answer within ${timeoutMs} ms; the page view is recorded without its verdict`), "onSession");
        return undefined;
      }
      return first;
    } catch (error) {
      report(error, "onSession");
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The hook's verdict, recorded on the session. Never throws: the page view is already committed. */
  async function tellApp(req: Request, recorded: RecordedPageView, path: string, userAgent: string, ip: string | null): Promise<void> {
    if (!options.onSession) return;
    const verdict = await askApp({
      req,
      tenantId,
      sessionId: recorded.sessionId,
      visitorId: recorded.visitorKey,
      isNewSession: recorded.isNew,
      path,
      host: pageHost(req),
      userAgent,
      headers: req.headers,
      ip,
    });
    const read = readVerdict(verdict);
    for (const what of read.refused) report(new Error(REFUSED_MESSAGE[what]), `onSession:${what}`);
    const reason = read.reason;
    // A browser that asked not to be tracked is never linked to an account,
    // even where the app counts it (`honorPrivacySignals: false`) — the
    // audience's own rule for its links.
    const actorKey = read.actorKey && !sendsPrivacySignal(req) ? read.actorKey : null;
    if (!reason && !actorKey) return;
    const s = ctx.t.sessions;
    try {
      // First answer wins, and a session whose answer is already recorded is
      // not written again: a staff member's every page view would otherwise
      // cost one no-op UPDATE.
      await ctx.db
        .update(s)
        .set({
          ...(reason ? { internalReason: sql`coalesce(${s.internalReason}, ${reason})` } : {}),
          ...(actorKey ? { actorKey: sql`coalesce(${s.actorKey}, ${actorKey})` } : {}),
        })
        .where(and(eq(s.id, recorded.sessionId), or(reason ? isNull(s.internalReason) : undefined, actorKey ? isNull(s.actorKey) : undefined)));
    } catch (error) {
      // The page view is committed; only the verdict record is lost.
      report(error, "onSession:write");
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (!sameSite(req, options.allowedHosts)) return noContent();
    if (honorSignals && sendsPrivacySignal(req)) return noContent();
    const userAgent = req.headers.get("user-agent") ?? "";
    // Crawlers are counted from their own page requests (recordCrawlerHit);
    // one that runs scripts and reaches the beacon is not a visitor. That
    // includes the site's own SEO audit (`adminigloo-seo-reports`).
    if (!userAgent || classifyCrawler(userAgent)) return noContent();

    const raw = await readCappedBody(req, limits.maxBodyBytes);
    if (!raw) return noContent();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return noContent();
    }
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) return noContent();
    const payload = parsed.data;

    try {
      const at = now();
      const clientIp = options.clientIp(req);
      const ip = clientIp ?? "0.0.0.0";
      const keys = await resolveVisitorKeysIn(ctx, { tenantId, ip, userAgent, at, timeZone: options.timeZone });
      if (!(await takeHit(ctx, tenantId, keys.network, at))) return noContent();
      const path = normalizePath(payload.p, options.pathPatterns);
      const durationDelta = Math.min(payload.ms ?? 0, limits.maxDurationDeltaMs);
      await ensureSite(ctx, tenantId, at);

      if (payload.t === "pageview") {
        const recorded = await recordPageView(ctx, {
          tenantId,
          keys,
          docId: payload.d,
          path,
          referrerHost: payload.r ? referrerHostOf(payload.r, options.allowedHosts) : null,
          search: payload.q ?? "",
          userAgent,
          country: options.resolveCountry?.(req) ?? null,
          contentTypes: options.contentTypes ?? [],
          durationDelta,
          at,
        });
        if (recorded) await tellApp(req, recorded, path, userAgent, clientIp);
      } else if (payload.t === "event") {
        await recordEvent(ctx, {
          tenantId,
          keys,
          docId: payload.d,
          path,
          name: payload.n,
          label: payload.l ?? null,
          value: payload.v ?? null,
          metricId: payload.i ?? null,
          converted: conversions.has(payload.n),
          durationDelta,
          at,
        });
      } else {
        await addDuration(ctx, { tenantId, keys, docId: payload.d, durationDelta, at });
      }
    } catch (error) {
      // Analytics must never be the thing that errors. This beacon's write is
      // lost (the hook's failures are handled in tellApp); the page was fine.
      report(error, "beacon");
    }
    return noContent();
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function hourStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000);
}

/** Count a request against its network's hourly budget. False: over budget, drop it. */
async function takeHit(ctx: AnalyticsContext, tenantId: string, network: string, at: Date): Promise<boolean> {
  const { db, t } = ctx;
  const [row] = await db
    .insert(t.rate)
    .values({ tenantId, netKey: network, windowStart: hourStart(at), hits: 1, sessions: 0 })
    .onConflictDoUpdate({
      target: [t.rate.tenantId, t.rate.netKey, t.rate.windowStart],
      set: { hits: sql`${t.rate.hits} + 1` },
    })
    .returning({ hits: t.rate.hits });
  return (row?.hits ?? 0) <= ctx.limits.maxHitsPerNetworkHour;
}

/** Record when tracking began — kept outside the retention window so "tracking since" never moves. */
async function ensureSite(ctx: AnalyticsContext, tenantId: string, at: Date): Promise<void> {
  if (ctx.knownSites.has(tenantId)) return;
  await ctx.db.insert(ctx.t.sites).values({ tenantId, trackingSince: at }).onConflictDoNothing();
  ctx.knownSites.add(tenantId);
}

/** The visit this beacon belongs to: by document first (survives the salt rollover and IP changes), then by visitor key. */
async function liveSession(ctx: AnalyticsContext, input: { tenantId: string; keys: VisitorKeys; docId: string; at: Date }, db: AnalyticsDb = ctx.db) {
  const { t } = ctx;
  const since = new Date(input.at.getTime() - SESSION_INACTIVITY_MS);
  const [session] = await db
    .select({ id: t.sessions.id, visitorKey: t.sessions.visitorKey, pageViewCount: t.sessions.pageViewCount })
    .from(t.sessions)
    .where(
      and(
        eq(t.sessions.tenantId, input.tenantId),
        gte(t.sessions.lastSeenAt, since),
        or(eq(t.sessions.lastDocId, input.docId), inArray(t.sessions.visitorKey, input.keys.candidates)),
      ),
    )
    // A document match beats a key match.
    .orderBy(desc(sql`(${t.sessions.lastDocId} = ${input.docId})`), desc(t.sessions.lastSeenAt))
    .limit(1);
  return session ?? null;
}

/** GA4's rule, evaluated in the same UPDATE that moves the counters (right-hand sides read the OLD row). */
function engagedAfter(ctx: AnalyticsContext, viewsAdded: number, durationAdded: number, converted: boolean) {
  const s = ctx.t.sessions;
  return sql`(${s.isEngaged} OR ${s.pageViewCount} + ${viewsAdded} >= ${ENGAGED_PAGE_VIEWS} OR ${s.durationMs} + ${durationAdded} >= ${ENGAGED_DURATION_MS} OR ${s.converted} OR ${converted})`;
}

interface RecordedPageView {
  sessionId: string;
  /** The key the session is stored under (yesterday's, for a visit across midnight). */
  visitorKey: string;
  isNew: boolean;
}

async function recordPageView(
  ctx: AnalyticsContext,
  input: {
    tenantId: string;
    keys: VisitorKeys;
    docId: string;
    path: string;
    referrerHost: string | null;
    search: string;
    userAgent: string;
    country: string | null;
    contentTypes: readonly ContentType[];
    durationDelta: number;
    at: Date;
  },
): Promise<RecordedPageView | null> {
  const { t, limits } = ctx;
  // 0.1's lock key for the default tables, so a rolling deploy from 0.1 shares it.
  const lockKey = `${t.prefix === DEFAULT_ANALYTICS_PREFIX ? "analytics" : t.prefix}:${input.tenantId}:${input.keys.current}`;
  return ctx.db.transaction(async (tx) => {
    // Two first beacons from one visitor arrive together often enough; the
    // lock makes the second find the first one's session, not open a duplicate.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`);
    let session = await liveSession(ctx, input, tx);
    let isNew = false;
    if (!session) {
      // Only a page view may open a session, and only within the network's budget.
      const [budget] = await tx
        .update(t.rate)
        .set({ sessions: sql`${t.rate.sessions} + 1` })
        .where(and(eq(t.rate.tenantId, input.tenantId), eq(t.rate.netKey, input.keys.network), eq(t.rate.windowStart, hourStart(input.at))))
        .returning({ sessions: t.rate.sessions });
      if ((budget?.sessions ?? 1) > limits.maxSessionsPerNetworkHour) return null;

      const params = new URLSearchParams(input.search.startsWith("?") ? input.search.slice(1) : input.search);
      const clickIdKind = clickIdKindOf(params);
      const utmSource = scrubUtm(params.get("utm_source"), limits.maxUtmLength);
      const utmMedium = scrubUtm(params.get("utm_medium"), limits.maxUtmLength);
      const ua = parseUserAgent(input.userAgent);
      const [created] = await tx
        .insert(t.sessions)
        .values({
          tenantId: input.tenantId,
          visitorKey: input.keys.current,
          lastDocId: input.docId,
          startedAt: input.at,
          lastSeenAt: input.at,
          landingPath: input.path,
          referrerHost: input.referrerHost,
          utmSource,
          utmMedium,
          utmCampaign: scrubUtm(params.get("utm_campaign"), limits.maxUtmLength),
          utmContent: scrubUtm(params.get("utm_content"), limits.maxUtmLength),
          utmTerm: scrubUtm(params.get("utm_term"), limits.maxUtmLength),
          clickIdKind,
          sourceBucket: classifySource({ referrerHost: input.referrerHost, utmSource, utmMedium, clickIdKind }),
          classifierVersion: SOURCE_CLASSIFIER_VERSION,
          country: input.country?.slice(0, 8) ?? null,
          device: ua.device,
          browser: ua.browser,
          os: ua.os,
        })
        .returning({ id: t.sessions.id, visitorKey: t.sessions.visitorKey, pageViewCount: t.sessions.pageViewCount });
      if (!created) return null;
      session = created;
      isNew = true;
    }
    if (session.pageViewCount >= limits.maxPageViewsPerSession) return null;
    const [updated] = await tx
      .update(t.sessions)
      .set({
        pageViewCount: sql`${t.sessions.pageViewCount} + 1`,
        durationMs: sql`${t.sessions.durationMs} + ${input.durationDelta}`,
        isEngaged: engagedAfter(ctx, 1, input.durationDelta, false),
        lastSeenAt: input.at,
        lastDocId: input.docId,
      })
      .where(eq(t.sessions.id, session.id))
      .returning({ sequence: t.sessions.pageViewCount });
    const content = contentOf(input.path, input.contentTypes);
    await tx.insert(t.pageViews).values({
      sessionId: session.id,
      tenantId: input.tenantId,
      path: input.path,
      contentType: content?.type ?? null,
      contentKey: content?.key ?? null,
      sequence: updated?.sequence ?? 1,
      occurredAt: input.at,
    });
    return { sessionId: session.id, visitorKey: session.visitorKey, isNew };
  });
}

async function recordEvent(
  ctx: AnalyticsContext,
  input: {
    tenantId: string;
    keys: VisitorKeys;
    docId: string;
    path: string;
    name: string;
    label: string | null;
    value: number | null;
    metricId: string | null;
    converted: boolean;
    durationDelta: number;
    at: Date;
  },
): Promise<void> {
  const { db, t } = ctx;
  // Events never open a session: a click with no page view behind it is not a visit.
  const session = await liveSession(ctx, input);
  if (!session) return;

  const isVital = input.name === "web_vital";
  let label: string | null;
  let value: number | null = null;
  if (isVital) {
    label = input.label;
    if (!label || !isWebVitalMetric(label) || input.value === null || input.value < 0 || input.value > WEB_VITAL_MAX[label]) return;
    value = input.value;
  } else {
    label = scrubLabel(input.label, ctx.limits.maxLabelLength);
  }

  await db
    .update(t.sessions)
    .set({
      // Vitals are measurements, not interactions: they never inflate event_count.
      ...(isVital ? {} : { eventCount: sql`${t.sessions.eventCount} + 1` }),
      durationMs: sql`${t.sessions.durationMs} + ${input.durationDelta}`,
      isEngaged: engagedAfter(ctx, 0, input.durationDelta, input.converted),
      lastSeenAt: input.at,
      ...(input.converted ? { converted: true } : {}),
    })
    .where(eq(t.sessions.id, session.id));
  await db.insert(t.events).values({
    sessionId: session.id,
    tenantId: input.tenantId,
    name: input.name,
    path: input.path,
    label,
    value,
    metricId: isVital ? (input.metricId?.slice(0, 80) ?? null) : null,
    occurredAt: input.at,
  });
}

/** Foreground time reported as the visitor leaves (or hides) the page — what makes a long single-page read count as engaged. */
async function addDuration(ctx: AnalyticsContext, input: { tenantId: string; keys: VisitorKeys; docId: string; durationDelta: number; at: Date }): Promise<void> {
  if (input.durationDelta <= 0) return;
  const session = await liveSession(ctx, input);
  if (!session) return;
  const { t } = ctx;
  await ctx.db
    .update(t.sessions)
    .set({
      durationMs: sql`${t.sessions.durationMs} + ${input.durationDelta}`,
      isEngaged: engagedAfter(ctx, 0, input.durationDelta, false),
      lastSeenAt: input.at,
    })
    .where(eq(t.sessions.id, session.id));
}

// ---------------------------------------------------------------------------
// Server-side conversions — no client wiring, still cookieless.
// ---------------------------------------------------------------------------

export interface ConversionInput {
  tenantId: string;
  ip: string | null;
  userAgent: string | null;
  name: string;
  path?: string;
  label?: string | null;
  timeZone?: string;
  at?: Date;
  /**
   * The request's headers, read for Global Privacy Control (`Sec-GPC: 1`) and
   * Do Not Track (`DNT: 1`). An opted-out request records nothing and returns
   * null, as the beacon drops it — without this, its conversion could land on
   * another browser profile's visit that shares the IP and user agent.
   */
  headers?: HeadersLike | null;
  /** Your own privacy verdict, when you have no headers to pass. `true`: record nothing. */
  privacyOptOut?: boolean | null;
  /** Honour the signals in `headers` (default true), like the handler's option of the same name. */
  honorPrivacySignals?: boolean;
}

/** The visit a server-side conversion landed on — pass both to `audience.classifyActor` when the actor may be internal. */
export interface RecordedConversion {
  sessionId: string;
  visitorId: string;
}

/**
 * Mark the requesting visitor's live session converted ("filed a demo
 * ticket", "booked a call") from the server code where the thing actually
 * happened, using the same daily key the beacon used. A request with no live
 * session (beacon blocked, a bot) or that opted out (`headers` with GPC/DNT,
 * or `privacyOptOut`) records nothing (null).
 */
export async function recordConversionIn(ctx: AnalyticsContext, input: ConversionInput): Promise<RecordedConversion | null> {
  if (input.privacyOptOut === true) return null;
  if ((input.honorPrivacySignals ?? true) && input.headers && sendsPrivacySignalHeaders(input.headers)) return null;
  if (!input.userAgent || classifyCrawler(input.userAgent)) return null;
  const { db, t } = ctx;
  const at = input.at ?? new Date();
  const keys = await resolveVisitorKeysIn(ctx, { tenantId: input.tenantId, ip: input.ip ?? "0.0.0.0", userAgent: input.userAgent, at, timeZone: input.timeZone });
  const since = new Date(at.getTime() - SESSION_INACTIVITY_MS);
  const [session] = await db
    .select({ id: t.sessions.id, visitorKey: t.sessions.visitorKey, landingPath: t.sessions.landingPath })
    .from(t.sessions)
    .where(and(eq(t.sessions.tenantId, input.tenantId), gte(t.sessions.lastSeenAt, since), inArray(t.sessions.visitorKey, keys.candidates)))
    .orderBy(desc(t.sessions.lastSeenAt))
    .limit(1);
  if (!session) return null;
  await db
    .update(t.sessions)
    .set({ converted: true, isEngaged: true, eventCount: sql`${t.sessions.eventCount} + 1`, lastSeenAt: at })
    .where(eq(t.sessions.id, session.id));
  await db.insert(t.events).values({
    sessionId: session.id,
    tenantId: input.tenantId,
    name: "conversion",
    path: normalizePath(input.path ?? session.landingPath),
    label: scrubLabel(input.label ?? input.name, ctx.limits.maxLabelLength),
    occurredAt: at,
  });
  return { sessionId: session.id, visitorId: session.visitorKey };
}

// ---------------------------------------------------------------------------
// "These are my visits" — a device's last ~48 hours, through the audience.
// ---------------------------------------------------------------------------

export interface MarkVisitorInternalInput {
  tenantId: string;
  /** The IP your handler's `clientIp` would return for this browser (null as there: "0.0.0.0"). In memory only. */
  ip: string | null;
  /** The browser's User-Agent header, as the beacon sends it. */
  userAgent: string | null;
  /** Who asked (an admin's id or email), for the audience's run history. */
  by?: string | null;
  /** The handler's `timeZone`: the day the salts rotate on. Default UTC. */
  timeZone?: string;
  at?: Date;
}

export interface MarkVisitorInternalResult {
  /** The visitor keys marked: today's, and yesterday's when that day's salt still exists. */
  visitorIds: string[];
  /** Keys that were not already marked (the audience's count). */
  subjectsChanged: number;
}

/**
 * Leave one device's visits out, about 48 hours back: the cookieless keys it
 * is filed under today and yesterday (the same two keys a live visit is
 * looked up by) are marked `device` through the audience's `mark`, which the
 * audience's run history records and `unmark` undoes. Its signed-out visits
 * yesterday and today, and for the rest of today, stop counting at once.
 *
 * Call it from a signed-in staff action on the device itself ("These are my
 * visits" in your admin), passing that request's IP and User-Agent. Not
 * from the beacon: each call writes audience run rows.
 *
 * A key is shared by everyone with that IP and user agent that day (one
 * household, an office behind one address, a carrier NAT with the same phone
 * build), so their visits are left out too — the same visitor the cookieless
 * model already counts them as. Throws `invalid_config` without an audience
 * for the tenant. Records nothing for a crawler or an empty user agent.
 */
export async function markVisitorInternalIn(ctx: AnalyticsContext, input: MarkVisitorInternalInput): Promise<MarkVisitorInternalResult> {
  const audience = ctx.audienceFor(input.tenantId);
  if (!audience) {
    throw new AnalyticsError("invalid_config", `markVisitorInternal needs an audience for tenant ${JSON.stringify(input.tenantId)}: createAnalytics({ audience }).`);
  }
  if (typeof audience.mark !== "function") {
    throw new AnalyticsError("invalid_config", "markVisitorInternal needs an audience that can mark a visitor by hand (`mark`, @adminigloo/audience ^0.1).");
  }
  if (!input.userAgent || classifyCrawler(input.userAgent)) return { visitorIds: [], subjectsChanged: 0 };
  const keys = await resolveVisitorKeysIn(ctx, {
    tenantId: input.tenantId,
    ip: input.ip ?? "0.0.0.0",
    userAgent: input.userAgent,
    at: input.at ?? new Date(),
    timeZone: input.timeZone,
  });
  let subjectsChanged = 0;
  for (const visitorId of keys.candidates) {
    subjectsChanged += (await audience.mark({ subjectKind: "visitor", subjectId: visitorId, reason: "device", by: input.by ?? null })).subjectsChanged;
  }
  return { visitorIds: [...keys.candidates], subjectsChanged };
}

// ---------------------------------------------------------------------------
// Crawlers — called from the app's own request handling, not the beacon.
// ---------------------------------------------------------------------------

export interface CrawlerHitInput {
  tenantId: string;
  userAgent: string | null | undefined;
  /** The request path. Normalized here — query, hash and tokens never reach the table. */
  path: string;
  /** Used only to check the operator's published ranges; never stored. */
  ip?: string | null;
  country?: string | null;
  /** Overrides the instance's verifier for this call. */
  verifier?: CrawlerVerifier;
  pathPatterns?: readonly PathPattern[];
  at?: Date;
}

/**
 * Log a crawler request. Returns what it was, or null when the User-Agent is
 * not a crawler (nothing written). Every crawler is recorded, the site's own
 * SEO audit too: the reports decide what to leave out, so that choice can
 * change without losing history.
 */
export async function recordCrawlerHitIn(ctx: AnalyticsContext, input: CrawlerHitInput): Promise<{ name: string; kind: string; verified: boolean } | null> {
  const match = classifyCrawler(input.userAgent);
  if (!match) return null;
  const { db, t } = ctx;
  const at = input.at ?? new Date();
  const verifier = input.verifier ?? ctx.verifier;
  const verified = verifier ? await verifier.verify(match.name, input.ip).catch(() => false) : false;
  const bucketMs = ctx.limits.crawlerBucketMs;
  await ensureSite(ctx, input.tenantId, at);
  await db
    .insert(t.crawlerHits)
    .values({
      tenantId: input.tenantId,
      botName: match.name,
      botKind: match.kind,
      operator: match.operator,
      path: normalizePath(input.path, input.pathPatterns),
      country: input.country?.slice(0, 8) ?? null,
      verified,
      bucketStart: new Date(Math.floor(at.getTime() / bucketMs) * bucketMs),
      hits: 1,
      lastAt: at,
    })
    .onConflictDoUpdate({
      target: [t.crawlerHits.tenantId, t.crawlerHits.botName, t.crawlerHits.path, t.crawlerHits.bucketStart, t.crawlerHits.verified],
      set: { hits: sql`${t.crawlerHits.hits} + 1`, lastAt: at },
    });
  return { name: match.name, kind: match.kind, verified };
}

// ---------------------------------------------------------------------------
// Maintenance — run daily (the app's cron).
// ---------------------------------------------------------------------------

export interface MaintenanceResult {
  saltsDeleted: number;
  rateRowsDeleted: number;
  sessionsDeleted: number;
  crawlerRowsDeleted: number;
}

export interface MaintenanceInput {
  /** Default: the instance's `limits.retentionDays` (395). */
  retentionDays?: number;
  timeZone?: string;
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  /**
   * Only the crawler log: retention on crawler rows, nothing else. For an
   * install that migrated just the crawler half (`crawlerHits` + `sites`,
   * Riddler Go's shape) and so has no salts, throttle or session tables.
   */
  crawlersOnly?: boolean;
}

/**
 * Delete salts older than yesterday (stored keys become unlinkable for good),
 * empty the throttle's past windows, and enforce retention on raw rows in
 * batches (sessions cascade their page views and events). Never gated by the
 * license: deleting what is no longer kept is a promise, not a feature.
 */
export async function runMaintenanceIn(ctx: AnalyticsContext, input: MaintenanceInput = {}): Promise<MaintenanceResult> {
  const { db, t } = ctx;
  const at = input.now ?? new Date();
  const cutoff = new Date(at.getTime() - (input.retentionDays ?? ctx.limits.retentionDays) * 24 * 60 * 60 * 1000);
  const batch = input.batchSize ?? 2000;
  const maxBatches = input.maxBatches ?? 50;
  let saltsDeleted = 0;
  let rateRowsDeleted = 0;
  let sessionsDeleted = 0;
  let crawlerRowsDeleted = 0;

  if (!input.crawlersOnly) {
    const keepFrom = dayIn(new Date(at.getTime() - 24 * 60 * 60 * 1000), input.timeZone);
    const salts = await db.delete(t.salts).where(lt(t.salts.day, keepFrom)).returning({ day: t.salts.day });
    for (const { day } of salts) ctx.saltCache.delete(day);
    saltsDeleted = salts.length;
    const rate = await db
      .delete(t.rate)
      .where(lt(t.rate.windowStart, new Date(at.getTime() - 2 * 3_600_000)))
      .returning({ key: t.rate.netKey });
    rateRowsDeleted = rate.length;
  }

  for (let i = 0; !input.crawlersOnly && i < maxBatches; i++) {
    const rows = await db
      .delete(t.sessions)
      .where(inArray(t.sessions.id, db.select({ id: t.sessions.id }).from(t.sessions).where(lt(t.sessions.startedAt, cutoff)).limit(batch)))
      .returning({ id: t.sessions.id });
    sessionsDeleted += rows.length;
    if (rows.length < batch) break;
  }
  for (let i = 0; i < maxBatches; i++) {
    const rows = await db
      .delete(t.crawlerHits)
      .where(inArray(t.crawlerHits.id, db.select({ id: t.crawlerHits.id }).from(t.crawlerHits).where(lt(t.crawlerHits.bucketStart, cutoff)).limit(batch)))
      .returning({ id: t.crawlerHits.id });
    crawlerRowsDeleted += rows.length;
    if (rows.length < batch) break;
  }
  return { saltsDeleted, rateRowsDeleted, sessionsDeleted, crawlerRowsDeleted };
}

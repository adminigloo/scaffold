import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  analyticsCrawlerHits,
  analyticsEvents,
  analyticsPageViews,
  analyticsRate,
  analyticsSalts,
  analyticsSessions,
  analyticsSites,
} from "./schema.js";
import { classifySource, clickIdKindOf, referrerHostOf } from "./sources.js";
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

/** Structural, as every @adminigloo package types it: never the app's concrete db. */
export type AnalyticsDb = PgDatabase<any, any, any>;

// ---------------------------------------------------------------------------
// Limits — the ingest is anonymous by nature, and its numbers may be public.
// ---------------------------------------------------------------------------

/** Requests (page views + events + leaves) per network per hour. */
export const MAX_HITS_PER_NETWORK_HOUR = 600;
/** New sessions per network per hour — a household or an office, not a script. */
export const MAX_SESSIONS_PER_NETWORK_HOUR = 30;
/** Page views per session; past this a "session" is a loop. */
export const MAX_PAGE_VIEWS_PER_SESSION = 500;
/** Foreground time one beacon may add — a tab cannot report more than the inactivity window. */
export const MAX_DURATION_DELTA_MS = SESSION_INACTIVITY_MS;
/** Crawler rows are bucketed by this, with a hit counter. */
export const CRAWLER_BUCKET_MS = 10 * 60 * 1000;

const MAX_BODY_BYTES = 4096;
const UTM_MAX = 100;

// ---------------------------------------------------------------------------
// Daily salts — shared by every instance, deleted the day after next.
// ---------------------------------------------------------------------------

const saltCache = new Map<string, string>();

/** YYYY-MM-DD of `at` in `timeZone` (the day the salt and the reports agree on). */
export function dayIn(at: Date, timeZone = "UTC"): string {
  return dayInZone(at, timeZone);
}

async function saltFor(db: AnalyticsDb, day: string, create: boolean): Promise<string | null> {
  const cached = saltCache.get(day);
  if (cached) return cached;
  const read = async () => (await db.select({ salt: analyticsSalts.salt }).from(analyticsSalts).where(eq(analyticsSalts.day, day)).limit(1))[0]?.salt ?? null;
  let salt = await read();
  if (!salt && create) {
    const fresh = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    await db.insert(analyticsSalts).values({ day, salt: fresh }).onConflictDoNothing();
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

/**
 * The cookieless identity of a request: HMACs of (ip, user agent, tenant)
 * under today's salt and yesterday's. Nothing about the request is stored but
 * the resulting hex.
 */
export async function resolveVisitorKeys(
  db: AnalyticsDb,
  input: { tenantId: string; ip: string; userAgent: string; at: Date; timeZone?: string },
): Promise<VisitorKeys> {
  const today = dayIn(input.at, input.timeZone);
  const yesterday = dayIn(new Date(input.at.getTime() - 24 * 60 * 60 * 1000), input.timeZone);
  const salt = (await saltFor(db, today, true)) as string;
  const prevSalt = await saltFor(db, yesterday, false);
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
export function scrubLabel(value: string | null | undefined, max = 120): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (EMAIL.test(text) || PHONE.test(text)) return null;
  if (text.split(" ").some((word) => looksLikeToken(word))) return null;
  return text.slice(0, max);
}

/** A UTM value: a campaign name, not a subscriber id — length capped, odd characters stripped, emails and tokens refused. */
export function scrubUtm(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  if (EMAIL.test(text) || looksLikeToken(text)) return null;
  const cleaned = text.replace(/[^\p{L}\p{N} _.:/+-]/gu, "").slice(0, UTM_MAX).trim();
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// The beacon endpoint
// ---------------------------------------------------------------------------

export interface AnalyticsHandlerOptions {
  db: AnalyticsDb;
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

function sameSite(req: Request, allowedHosts: readonly string[]): boolean {
  const host = hostOf(req.headers.get("origin")) ?? hostOf(req.headers.get("referer"));
  if (!host) return false;
  const bare = host.replace(/^www\./, "");
  return allowedHosts.some((allowed) => bare === allowed.toLowerCase().replace(/^www\./, ""));
}

export function sendsPrivacySignal(req: Request): boolean {
  return req.headers.get("sec-gpc") === "1" || req.headers.get("dnt") === "1";
}

export interface AnalyticsHandler {
  handle: (req: Request) => Promise<Response>;
}

/**
 * The beacon endpoint. ALWAYS 204 — a bad payload, a foreign origin, a bot, a
 * privacy signal, a throttled network and a counted page view look identical
 * from outside, so there is nothing to probe (and a page's own error
 * recorders never see a failed analytics request).
 */
export function createAnalyticsHandler(options: AnalyticsHandlerOptions): AnalyticsHandler {
  const { db, tenantId } = options;
  const now = options.now ?? (() => new Date());
  const conversions = new Set(options.conversionEvents ?? []);
  const honorSignals = options.honorPrivacySignals ?? true;

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    if (!sameSite(req, options.allowedHosts)) return noContent();
    if (honorSignals && sendsPrivacySignal(req)) return noContent();
    const userAgent = req.headers.get("user-agent") ?? "";
    // Crawlers are counted from their own page requests (recordCrawlerHit);
    // one that runs scripts and reaches the beacon is not a visitor.
    if (!userAgent || classifyCrawler(userAgent)) return noContent();

    const raw = await req.text().catch(() => "");
    if (!raw || raw.length > MAX_BODY_BYTES) return noContent();
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
      const ip = options.clientIp(req) ?? "0.0.0.0";
      const keys = await resolveVisitorKeys(db, { tenantId, ip, userAgent, at, timeZone: options.timeZone });
      if (!(await takeHit(db, tenantId, keys.network, at))) return noContent();
      const path = normalizePath(payload.p, options.pathPatterns);
      const durationDelta = Math.min(payload.ms ?? 0, MAX_DURATION_DELTA_MS);
      await ensureSite(db, tenantId, at);

      if (payload.t === "pageview") {
        await recordPageView(db, {
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
      } else if (payload.t === "event") {
        await recordEvent(db, {
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
        await addDuration(db, { tenantId, keys, docId: payload.d, durationDelta, at });
      }
    } catch {
      // Analytics must never be the thing that errors. The row is lost; the page was fine.
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
async function takeHit(db: AnalyticsDb, tenantId: string, network: string, at: Date): Promise<boolean> {
  const [row] = await db
    .insert(analyticsRate)
    .values({ tenantId, netKey: network, windowStart: hourStart(at), hits: 1, sessions: 0 })
    .onConflictDoUpdate({
      target: [analyticsRate.tenantId, analyticsRate.netKey, analyticsRate.windowStart],
      set: { hits: sql`${analyticsRate.hits} + 1` },
    })
    .returning({ hits: analyticsRate.hits });
  return (row?.hits ?? 0) <= MAX_HITS_PER_NETWORK_HOUR;
}

const knownSites = new Set<string>();

/** Record when tracking began — kept outside the retention window so "tracking since" never moves. */
async function ensureSite(db: AnalyticsDb, tenantId: string, at: Date): Promise<void> {
  if (knownSites.has(tenantId)) return;
  await db.insert(analyticsSites).values({ tenantId, trackingSince: at }).onConflictDoNothing();
  knownSites.add(tenantId);
}

/** The visit this beacon belongs to: by document first (survives the salt rollover and IP changes), then by visitor key. */
async function liveSession(db: AnalyticsDb, input: { tenantId: string; keys: VisitorKeys; docId: string; at: Date }) {
  const since = new Date(input.at.getTime() - SESSION_INACTIVITY_MS);
  const [session] = await db
    .select({ id: analyticsSessions.id, pageViewCount: analyticsSessions.pageViewCount })
    .from(analyticsSessions)
    .where(
      and(
        eq(analyticsSessions.tenantId, input.tenantId),
        gte(analyticsSessions.lastSeenAt, since),
        or(eq(analyticsSessions.lastDocId, input.docId), inArray(analyticsSessions.visitorKey, input.keys.candidates)),
      ),
    )
    // A document match beats a key match.
    .orderBy(desc(sql`(${analyticsSessions.lastDocId} = ${input.docId})`), desc(analyticsSessions.lastSeenAt))
    .limit(1);
  return session ?? null;
}

/** GA4's rule, evaluated in the same UPDATE that moves the counters (right-hand sides read the OLD row). */
function engagedAfter(viewsAdded: number, durationAdded: number, converted: boolean) {
  return sql`(${analyticsSessions.isEngaged} OR ${analyticsSessions.pageViewCount} + ${viewsAdded} >= ${ENGAGED_PAGE_VIEWS} OR ${analyticsSessions.durationMs} + ${durationAdded} >= ${ENGAGED_DURATION_MS} OR ${analyticsSessions.converted} OR ${converted})`;
}

async function recordPageView(
  db: AnalyticsDb,
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
): Promise<void> {
  await db.transaction(async (tx) => {
    // Two first beacons from one visitor arrive together often enough; the
    // lock makes the second find the first one's session, not open a duplicate.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`analytics:${input.tenantId}:${input.keys.current}`}))`);
    let session = await liveSession(tx, input);
    if (!session) {
      // Only a page view may open a session, and only within the network's budget.
      const [budget] = await tx
        .update(analyticsRate)
        .set({ sessions: sql`${analyticsRate.sessions} + 1` })
        .where(and(eq(analyticsRate.tenantId, input.tenantId), eq(analyticsRate.netKey, input.keys.network), eq(analyticsRate.windowStart, hourStart(input.at))))
        .returning({ sessions: analyticsRate.sessions });
      if ((budget?.sessions ?? 1) > MAX_SESSIONS_PER_NETWORK_HOUR) return;

      const params = new URLSearchParams(input.search.startsWith("?") ? input.search.slice(1) : input.search);
      const clickIdKind = clickIdKindOf(params);
      const utmSource = scrubUtm(params.get("utm_source"));
      const utmMedium = scrubUtm(params.get("utm_medium"));
      const ua = parseUserAgent(input.userAgent);
      const [created] = await tx
        .insert(analyticsSessions)
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
          utmCampaign: scrubUtm(params.get("utm_campaign")),
          utmContent: scrubUtm(params.get("utm_content")),
          utmTerm: scrubUtm(params.get("utm_term")),
          clickIdKind,
          sourceBucket: classifySource({ referrerHost: input.referrerHost, utmSource, utmMedium, clickIdKind }),
          country: input.country?.slice(0, 8) ?? null,
          device: ua.device,
          browser: ua.browser,
          os: ua.os,
        })
        .returning({ id: analyticsSessions.id, pageViewCount: analyticsSessions.pageViewCount });
      if (!created) return;
      session = created;
    }
    if (session.pageViewCount >= MAX_PAGE_VIEWS_PER_SESSION) return;
    const [updated] = await tx
      .update(analyticsSessions)
      .set({
        pageViewCount: sql`${analyticsSessions.pageViewCount} + 1`,
        durationMs: sql`${analyticsSessions.durationMs} + ${input.durationDelta}`,
        isEngaged: engagedAfter(1, input.durationDelta, false),
        lastSeenAt: input.at,
        lastDocId: input.docId,
      })
      .where(eq(analyticsSessions.id, session.id))
      .returning({ sequence: analyticsSessions.pageViewCount });
    const content = contentOf(input.path, input.contentTypes);
    await tx.insert(analyticsPageViews).values({
      sessionId: session.id,
      tenantId: input.tenantId,
      path: input.path,
      contentType: content?.type ?? null,
      contentKey: content?.key ?? null,
      sequence: updated?.sequence ?? 1,
      occurredAt: input.at,
    });
  });
}

async function recordEvent(
  db: AnalyticsDb,
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
  // Events never open a session: a click with no page view behind it is not a visit.
  const session = await liveSession(db, input);
  if (!session) return;

  const isVital = input.name === "web_vital";
  let label: string | null;
  let value: number | null = null;
  if (isVital) {
    label = input.label;
    if (!label || !isWebVitalMetric(label) || input.value === null || input.value < 0 || input.value > WEB_VITAL_MAX[label]) return;
    value = input.value;
  } else {
    label = scrubLabel(input.label);
  }

  await db
    .update(analyticsSessions)
    .set({
      // Vitals are measurements, not interactions: they never inflate event_count.
      ...(isVital ? {} : { eventCount: sql`${analyticsSessions.eventCount} + 1` }),
      durationMs: sql`${analyticsSessions.durationMs} + ${input.durationDelta}`,
      isEngaged: engagedAfter(0, input.durationDelta, input.converted),
      lastSeenAt: input.at,
      ...(input.converted ? { converted: true } : {}),
    })
    .where(eq(analyticsSessions.id, session.id));
  await db.insert(analyticsEvents).values({
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
async function addDuration(db: AnalyticsDb, input: { tenantId: string; keys: VisitorKeys; docId: string; durationDelta: number; at: Date }): Promise<void> {
  if (input.durationDelta <= 0) return;
  const session = await liveSession(db, input);
  if (!session) return;
  await db
    .update(analyticsSessions)
    .set({
      durationMs: sql`${analyticsSessions.durationMs} + ${input.durationDelta}`,
      isEngaged: engagedAfter(0, input.durationDelta, false),
      lastSeenAt: input.at,
    })
    .where(eq(analyticsSessions.id, session.id));
}

// ---------------------------------------------------------------------------
// Server-side conversions — no client wiring, still cookieless.
// ---------------------------------------------------------------------------

/**
 * Mark the requesting visitor's live session converted ("filed a demo
 * ticket", "booked a call") from the server code where the thing actually
 * happened, using the same daily key the beacon used. A request with no live
 * session (beacon blocked, privacy signal, a bot) records nothing.
 */
export async function recordConversion(
  db: AnalyticsDb,
  input: { tenantId: string; ip: string | null; userAgent: string | null; name: string; path?: string; label?: string | null; timeZone?: string; at?: Date },
): Promise<boolean> {
  if (!input.userAgent || classifyCrawler(input.userAgent)) return false;
  const at = input.at ?? new Date();
  const keys = await resolveVisitorKeys(db, { tenantId: input.tenantId, ip: input.ip ?? "0.0.0.0", userAgent: input.userAgent, at, timeZone: input.timeZone });
  const since = new Date(at.getTime() - SESSION_INACTIVITY_MS);
  const [session] = await db
    .select({ id: analyticsSessions.id, landingPath: analyticsSessions.landingPath })
    .from(analyticsSessions)
    .where(and(eq(analyticsSessions.tenantId, input.tenantId), gte(analyticsSessions.lastSeenAt, since), inArray(analyticsSessions.visitorKey, keys.candidates)))
    .orderBy(desc(analyticsSessions.lastSeenAt))
    .limit(1);
  if (!session) return false;
  await db
    .update(analyticsSessions)
    .set({ converted: true, isEngaged: true, eventCount: sql`${analyticsSessions.eventCount} + 1`, lastSeenAt: at })
    .where(eq(analyticsSessions.id, session.id));
  await db.insert(analyticsEvents).values({
    sessionId: session.id,
    tenantId: input.tenantId,
    name: "conversion",
    path: normalizePath(input.path ?? session.landingPath),
    label: scrubLabel(input.label ?? input.name),
    occurredAt: at,
  });
  return true;
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
  verifier?: CrawlerVerifier;
  pathPatterns?: readonly PathPattern[];
  at?: Date;
}

/** Log a crawler request. Returns what it was, or null when the User-Agent is not a crawler (nothing written). */
export async function recordCrawlerHit(db: AnalyticsDb, input: CrawlerHitInput): Promise<{ name: string; kind: string; verified: boolean } | null> {
  const match = classifyCrawler(input.userAgent);
  if (!match) return null;
  const at = input.at ?? new Date();
  const verified = input.verifier ? await input.verifier.verify(match.name, input.ip).catch(() => false) : false;
  await ensureSite(db, input.tenantId, at);
  await db
    .insert(analyticsCrawlerHits)
    .values({
      tenantId: input.tenantId,
      botName: match.name,
      botKind: match.kind,
      operator: match.operator,
      path: normalizePath(input.path, input.pathPatterns),
      country: input.country?.slice(0, 8) ?? null,
      verified,
      bucketStart: new Date(Math.floor(at.getTime() / CRAWLER_BUCKET_MS) * CRAWLER_BUCKET_MS),
      hits: 1,
      lastAt: at,
    })
    .onConflictDoUpdate({
      target: [analyticsCrawlerHits.tenantId, analyticsCrawlerHits.botName, analyticsCrawlerHits.path, analyticsCrawlerHits.bucketStart, analyticsCrawlerHits.verified],
      set: { hits: sql`${analyticsCrawlerHits.hits} + 1`, lastAt: at },
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

/**
 * Delete salts older than yesterday (stored keys become unlinkable for good),
 * empty the throttle's past windows, and enforce retention on raw rows in
 * batches (sessions cascade their page views and events).
 */
export async function runAnalyticsMaintenance(
  db: AnalyticsDb,
  input: { retentionDays?: number; timeZone?: string; now?: Date; batchSize?: number; maxBatches?: number } = {},
): Promise<MaintenanceResult> {
  const at = input.now ?? new Date();
  const keepFrom = dayIn(new Date(at.getTime() - 24 * 60 * 60 * 1000), input.timeZone);
  const salts = await db.delete(analyticsSalts).where(lt(analyticsSalts.day, keepFrom)).returning({ day: analyticsSalts.day });
  for (const { day } of salts) saltCache.delete(day);
  const rate = await db
    .delete(analyticsRate)
    .where(lt(analyticsRate.windowStart, new Date(at.getTime() - 2 * 3_600_000)))
    .returning({ key: analyticsRate.netKey });

  const cutoff = new Date(at.getTime() - (input.retentionDays ?? 395) * 24 * 60 * 60 * 1000);
  const batch = input.batchSize ?? 2000;
  const maxBatches = input.maxBatches ?? 50;
  let sessionsDeleted = 0;
  let crawlerRowsDeleted = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await db
      .delete(analyticsSessions)
      .where(inArray(analyticsSessions.id, db.select({ id: analyticsSessions.id }).from(analyticsSessions).where(lt(analyticsSessions.startedAt, cutoff)).limit(batch)))
      .returning({ id: analyticsSessions.id });
    sessionsDeleted += rows.length;
    if (rows.length < batch) break;
  }
  for (let i = 0; i < maxBatches; i++) {
    const rows = await db
      .delete(analyticsCrawlerHits)
      .where(inArray(analyticsCrawlerHits.id, db.select({ id: analyticsCrawlerHits.id }).from(analyticsCrawlerHits).where(lt(analyticsCrawlerHits.bucketStart, cutoff)).limit(batch)))
      .returning({ id: analyticsCrawlerHits.id });
    crawlerRowsDeleted += rows.length;
    if (rows.length < batch) break;
  }
  return { saltsDeleted: salts.length, rateRowsDeleted: rate.length, sessionsDeleted, crawlerRowsDeleted };
}

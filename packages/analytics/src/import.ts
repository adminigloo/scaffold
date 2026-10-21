import { and, eq, inArray, sql } from "drizzle-orm";
import { AnalyticsError, type AnalyticsContext } from "./context.js";
import { classifySource, referrerHostOf, SOURCE_CLASSIFIER_VERSION } from "./sources.js";
import { hmacHex, isEngaged, normalizePath } from "./visitor.js";
import { scrubUtm } from "./ingest.js";

/**
 * PAST VISITS BROUGHT IN FROM RECORDS (analytics 0.4): a business moving to
 * this site from another tool brings its visit history with it, so its
 * numbers don't start at zero. Server-side only — there is no route; call it
 * from a staff-only import job or script.
 *
 *   await analytics.importVisits({ tenantId, visits: [
 *     { key: "ga-row-1", at: "2025-06-14T15:00:00Z", path: "/pricing", source: "google.com", visitor: "ga-client-123" },
 *   ] });
 *
 * - IDEMPOTENT by the importer's own `key` (unique per company): importing the
 *   same file twice brings each visit in once (`alreadyImported`).
 * - THE AUDIENCE STILL DECIDES what counts. An imported visit is filed under a
 *   visitor key made from the importer's visitor id (hashed with the
 *   company, so the raw id is never stored, and the same id is the same
 *   visitor every time); every report leaves it out exactly as it would a
 *   live one when that visitor or visit is marked. With `userId` (the site's
 *   own user, when the old tool knew who it was), the audience's rules about
 *   people (the company's own team, the people it names) are applied to it,
 *   the same way they are at a live visit.
 * - "TRACKING SINCE" moves back to the earliest visit brought in, never
 *   forward.
 * - A date in the future, before 2000, or older than the days visits are kept
 *   (`limits.retentionDays`, which the daily maintenance would delete at once)
 *   is refused for that visit, with a sentence; the rest come in.
 */
export interface ImportVisitInput {
  /** The importer's own key for this visit (a row id in the old tool's export): the same key twice is one visit. 1–200 characters. */
  readonly key: string;
  /** When the visit began. */
  readonly at: Date | string;
  /** The page it landed on: a path ("/pricing") or a full address on the site. */
  readonly path: string;
  /** Later pages in that visit, in order (each at its own time, or the visit's). At most 100. */
  readonly pages?: readonly { readonly path: string; readonly at?: Date | string }[];
  /**
   * Where it came from: a referring address or host ("https://www.google.com/",
   * "google.com"), or its campaign tags. Classified by the same rules as a
   * live visit. Absent: direct.
   */
  readonly source?:
    | string
    | { readonly referrer?: string | null; readonly utmSource?: string | null; readonly utmMedium?: string | null; readonly utmCampaign?: string | null }
    | null;
  /** Who visited, in the old tool's terms (its visitor or client id). Hashed with the company before it is stored. */
  readonly visitor: string;
  /** The site's own user id, when the old tool knew who it was: the audience's people rules are applied to the visit. */
  readonly userId?: string | null;
  /** One of the company's websites (its id), or absent/null for its pages here. */
  readonly siteId?: string | null;
  readonly device?: "desktop" | "mobile" | "tablet" | null;
  /** A two-letter country code. */
  readonly country?: string | null;
}

export interface ImportVisitsInput {
  readonly tenantId: string;
  /** At most 1000 a call. */
  readonly visits: readonly ImportVisitInput[];
  /** Default the clock. */
  readonly now?: Date;
}

export interface ImportVisitsResult {
  /** Visits brought in by this call. */
  readonly imported: number;
  /** Visits whose key was brought in before (left as they were). */
  readonly alreadyImported: number;
  /** Visits left out, each with why, in plain words. */
  readonly refused: readonly { readonly key: string; readonly reason: string }[];
  /** When the company's counting now begins (null: it has no visits at all). */
  readonly trackingSince: Date | null;
}

export const MAX_IMPORT_VISITS = 1000;
const MAX_IMPORT_PAGES = 100;
const EARLIEST = Date.UTC(2000, 0, 1);
const DAY_MS = 24 * 60 * 60 * 1000;

/** The visitor key an imported visitor id is filed under: the company and the id, hashed — never the raw id. */
export async function importedVisitorKey(tenantId: string, visitor: string): Promise<string> {
  return `imp_${await hmacHex("adminigloo-analytics-import", `${tenantId}\u0000${visitor}`)}`;
}

function dateOf(value: Date | string | undefined | null): Date | null {
  if (value === undefined || value === null) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface Prepared {
  readonly key: string;
  readonly at: Date;
  readonly siteId: string | null;
  readonly visitorKey: string;
  readonly userId: string | null;
  readonly pages: readonly { readonly path: string; readonly at: Date }[];
  readonly referrerHost: string | null;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly device: string | null;
  readonly country: string | null;
}

export async function importVisitsIn(ctx: AnalyticsContext, input: ImportVisitsInput): Promise<ImportVisitsResult> {
  const tenantId = typeof input?.tenantId === "string" ? input.tenantId.trim() : "";
  if (!tenantId) throw new AnalyticsError("invalid_input", "importVisits needs the company (tenantId).");
  if (!Array.isArray(input.visits)) throw new AnalyticsError("invalid_input", "importVisits needs a list of visits.");
  if (input.visits.length > MAX_IMPORT_VISITS) {
    throw new AnalyticsError("invalid_input", `Import at most ${MAX_IMPORT_VISITS} visits at a time (got ${input.visits.length}).`);
  }
  const { db, t, limits } = ctx;
  const now = input.now ?? new Date();
  const oldest = now.getTime() - limits.retentionDays * DAY_MS;
  const refused: { key: string; reason: string }[] = [];
  const prepared: Prepared[] = [];
  const seen = new Set<string>();
  const sites = new Map<string, boolean>();

  for (const visit of input.visits) {
    const key = typeof visit?.key === "string" ? visit.key.trim() : "";
    if (!key || key.length > 200) {
      refused.push({ key: String(visit?.key ?? ""), reason: "Give each visit its own key (1 to 200 characters)." });
      continue;
    }
    if (seen.has(key)) {
      refused.push({ key, reason: "This key is in the list twice; the first one was brought in." });
      continue;
    }
    const at = dateOf(visit.at);
    if (!at) {
      refused.push({ key, reason: "Give the date the visit happened, like 2025-06-14." });
      continue;
    }
    if (at.getTime() > now.getTime()) {
      refused.push({ key, reason: "That date is in the future." });
      continue;
    }
    if (at.getTime() < EARLIEST) {
      refused.push({ key, reason: "That date is before 2000. Check the year." });
      continue;
    }
    if (at.getTime() < oldest) {
      refused.push({ key, reason: `That's older than the ${limits.retentionDays} days visits are kept.` });
      continue;
    }
    const visitor = typeof visit.visitor === "string" ? visit.visitor.trim() : "";
    if (!visitor || visitor.length > 500) {
      refused.push({ key, reason: "Say who visited (the old tool's visitor id)." });
      continue;
    }
    if (typeof visit.path !== "string" || !visit.path.trim()) {
      refused.push({ key, reason: "Give the page the visit landed on." });
      continue;
    }
    const siteId = typeof visit.siteId === "string" && visit.siteId ? visit.siteId : null;
    if (siteId) {
      if (!sites.has(siteId)) {
        const [site] = await db
          .select({ id: t.websites.id })
          .from(t.websites)
          .where(and(eq(t.websites.tenantId, tenantId), eq(t.websites.id, siteId)))
          .limit(1);
        sites.set(siteId, Boolean(site));
      }
      if (!sites.get(siteId)) {
        refused.push({ key, reason: "That website isn't this company's." });
        continue;
      }
    }
    const later = Array.isArray(visit.pages) ? visit.pages.slice(0, MAX_IMPORT_PAGES - 1) : [];
    const pages: { path: string; at: Date }[] = [{ path: normalizePath(visit.path), at }];
    let bad = false;
    for (const page of later) {
      const pageAt = page?.at === undefined ? at : dateOf(page.at);
      if (!pageAt || pageAt.getTime() < at.getTime() || pageAt.getTime() > now.getTime() || typeof page.path !== "string" || !page.path.trim()) {
        bad = true;
        break;
      }
      pages.push({ path: normalizePath(page.path), at: pageAt });
    }
    if (bad) {
      refused.push({ key, reason: "A later page has no path, or a time before the visit began or in the future." });
      continue;
    }
    const source = visit.source ?? null;
    const tags = typeof source === "object" && source !== null ? source : null;
    const referrer = typeof source === "string" ? source : (tags?.referrer ?? null);
    const country = typeof visit.country === "string" && /^[A-Za-z]{2}$/.test(visit.country.trim()) ? visit.country.trim().toUpperCase() : null;
    const device = visit.device === "desktop" || visit.device === "mobile" || visit.device === "tablet" ? visit.device : null;
    seen.add(key);
    prepared.push({
      key,
      at,
      siteId,
      visitorKey: await importedVisitorKey(tenantId, visitor),
      userId: typeof visit.userId === "string" && visit.userId.trim() ? visit.userId.trim() : null,
      pages,
      referrerHost: referrerHostOf(referrer, []),
      utmSource: scrubUtm(tags?.utmSource ?? null, limits.maxUtmLength),
      utmMedium: scrubUtm(tags?.utmMedium ?? null, limits.maxUtmLength),
      utmCampaign: scrubUtm(tags?.utmCampaign ?? null, limits.maxUtmLength),
      device,
      country,
    });
  }

  let imported = 0;
  let alreadyImported = 0;
  const brought: { sessionId: string; visitorKey: string; userId: string | null }[] = [];
  if (prepared.length > 0) {
    const existing = await db
      .select({ key: t.sessions.importKey })
      .from(t.sessions)
      .where(and(eq(t.sessions.tenantId, tenantId), inArray(t.sessions.importKey, prepared.map((p) => p.key))));
    const done = new Set(existing.map((row) => row.key));
    for (const visit of prepared) {
      if (done.has(visit.key)) {
        alreadyImported += 1;
        continue;
      }
      const last = visit.pages[visit.pages.length - 1]!.at;
      const durationMs = Math.min(limits.maxDurationDeltaMs * visit.pages.length, Math.max(0, last.getTime() - visit.at.getTime()));
      const sessionId = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(t.sessions)
          .values({
            tenantId,
            siteId: visit.siteId,
            visitorKey: visit.visitorKey,
            startedAt: visit.at,
            lastSeenAt: last,
            landingPath: visit.pages[0]!.path,
            referrerHost: visit.referrerHost,
            utmSource: visit.utmSource,
            utmMedium: visit.utmMedium,
            utmCampaign: visit.utmCampaign,
            sourceBucket: classifySource({ referrerHost: visit.referrerHost, utmSource: visit.utmSource, utmMedium: visit.utmMedium, clickIdKind: null }),
            classifierVersion: SOURCE_CLASSIFIER_VERSION,
            country: visit.country,
            device: visit.device,
            pageViewCount: visit.pages.length,
            durationMs,
            isEngaged: isEngaged({ durationMs, pageViewCount: visit.pages.length, converted: false }),
            importKey: visit.key,
          })
          .onConflictDoNothing()
          .returning({ id: t.sessions.id });
        if (!created) return null;
        await tx.insert(t.pageViews).values(
          visit.pages.map((page, index) => ({
            sessionId: created.id,
            tenantId,
            path: page.path,
            sequence: index + 1,
            occurredAt: page.at,
          })),
        );
        return created.id;
      });
      if (sessionId === null) {
        alreadyImported += 1;
        continue;
      }
      imported += 1;
      brought.push({ sessionId, visitorKey: visit.visitorKey, userId: visit.userId });
    }
  }

  // Counting began at the earliest visit there is — moved back, never forward.
  const earliest = prepared.length ? new Date(Math.min(...prepared.map((p) => p.at.getTime()))) : null;
  if (imported > 0 && earliest) {
    await db
      .insert(t.sites)
      .values({ tenantId, trackingSince: earliest })
      .onConflictDoUpdate({ target: t.sites.tenantId, set: { trackingSince: sql`least(${t.sites.trackingSince}, excluded.tracking_since)` } });
    ctx.knownSites.add(tenantId);
  }

  // The audience's rules about people, applied to each visit it can say who made.
  const audience = ctx.audienceFor(tenantId);
  if (audience?.classifyActor) {
    for (const visit of brought) {
      if (!visit.userId) continue;
      try {
        await audience.classifyActor({ visitorId: visit.visitorKey, sessionId: visit.sessionId, userId: visit.userId, privacyOptOut: true });
      } catch (error) {
        ctx.onError(error, "importVisits.audience");
      }
    }
  }

  const [site] = await db.select({ since: t.sites.trackingSince }).from(t.sites).where(eq(t.sites.tenantId, tenantId)).limit(1);
  return { imported, alreadyImported, refused, trackingSince: site?.since ?? null };
}

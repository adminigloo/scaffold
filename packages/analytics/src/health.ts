import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { AnalyticsContext } from "./context.js";
import { getTrackingSince } from "./reports.js";

/**
 * Pipeline health — so the reports can never be silently empty.
 *
 * Deliberately UNFILTERED, and in its own file so the guard test can say so:
 * it asks "is anything arriving at all?", and a staff member's page view
 * proves the beacon, the route and the database work as well as a
 * customer's does. Leaving the internal audience out here would turn "the
 * founder clicked around this morning" into "nothing since Tuesday".
 */

export interface PipelineHealth {
  trackingSince: string | null;
  lastPageView: string | null;
  lastEvent: string | null;
  lastWebVital: string | null;
  lastConversion: string | null;
  lastCrawlerHit: string | null;
  lastAiCrawlerHit: string | null;
}

export async function getPipelineHealth(ctx: AnalyticsContext, tenantId: string): Promise<PipelineHealth> {
  const { db, t } = ctx;
  const iso = (value: unknown) => (value ? new Date(value as Date).toISOString() : null);
  const [since, pv, ev, vital, conv, hit, aiHit] = await Promise.all([
    getTrackingSince(ctx, tenantId),
    db.select({ at: max(t.pageViews.occurredAt) }).from(t.pageViews).where(eq(t.pageViews.tenantId, tenantId)),
    db.select({ at: max(t.events.occurredAt) }).from(t.events).where(and(eq(t.events.tenantId, tenantId), sql`${t.events.name} not in ('web_vital', 'conversion')`)),
    db.select({ at: max(t.events.occurredAt) }).from(t.events).where(and(eq(t.events.tenantId, tenantId), eq(t.events.name, "web_vital"))),
    db.select({ at: max(t.events.occurredAt) }).from(t.events).where(and(eq(t.events.tenantId, tenantId), eq(t.events.name, "conversion"))),
    db.select({ at: max(t.crawlerHits.lastAt) }).from(t.crawlerHits).where(eq(t.crawlerHits.tenantId, tenantId)),
    db
      .select({ at: max(t.crawlerHits.lastAt) })
      .from(t.crawlerHits)
      .where(and(eq(t.crawlerHits.tenantId, tenantId), inArray(t.crawlerHits.botKind, ["ai-assistant", "ai-search", "ai-training"]))),
  ]);
  return {
    trackingSince: since?.toISOString() ?? null,
    lastPageView: iso(pv[0]?.at),
    lastEvent: iso(ev[0]?.at),
    lastWebVital: iso(vital[0]?.at),
    lastConversion: iso(conv[0]?.at),
    lastCrawlerHit: iso(hit[0]?.at),
    lastAiCrawlerHit: iso(aiHit[0]?.at),
  };
}

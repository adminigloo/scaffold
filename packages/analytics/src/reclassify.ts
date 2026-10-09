import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import type { AnalyticsContext } from "./context.js";
import { classifySource, SOURCE_CLASSIFIER_VERSION, type ClickIdKind, type SourceBucket } from "./sources.js";

/**
 * Re-run the source classifier over sessions already stored — after an
 * upgrade taught it new hosts (0.2 learned Microsoft 365 Copilot, AI Studio,
 * the Claude and Perplexity Android apps…), so last month's
 * `copilot.cloud.microsoft` visits move from "Referral" to "AI assistants"
 * like this month's. Fully retroactive, because everything the classifier
 * reads is stored: the referrer host, the utm source and medium, and which
 * ad click id was present.
 *
 * It REWRITES `source_bucket` and `classifier_version`, and only those, on
 * every session in the window below the current classifier version
 * (`force: true`: up to and including it). A session a NEWER classifier
 * stored (a newer package, mid rolling deploy) is never touched, force or
 * not: an older classifier would downgrade it. That is not a count, so the
 * internal audience is irrelevant here: a staff session is reclassified like
 * any other, and the reports still leave it out. Idempotent: a second run
 * finds nothing to do. Batched by id, so it is safe on a large table and can
 * be stopped and re-run.
 */

export interface ReclassifyWindow {
  tenantId: string;
  /** Sessions started at or after this. Omit for all of history. */
  from?: Date | null;
  /** Sessions started before this. */
  to?: Date | null;
}

export interface ReclassifyOptions {
  /** Re-run over every session in the window at or below the current version (never one a newer classifier stored). */
  force?: boolean;
  /** Count what would change and write nothing. */
  dryRun?: boolean;
  /** Default 1000. */
  batchSize?: number;
  /** Stop after this many batches (re-run to continue). Default 1000. */
  maxBatches?: number;
}

export interface ReclassifyResult {
  /** Sessions read. */
  scanned: number;
  /** Sessions whose bucket changed (or would, in a dry run). */
  changed: number;
  /** Each move, biggest first: `{ from: "referral", to: "aiAssistant", sessions: 12 }`. */
  changes: Array<{ from: SourceBucket; to: SourceBucket; sessions: number }>;
  /** The classifier version the sessions now carry. */
  version: number;
  dryRun: boolean;
  /** False when `maxBatches` stopped it early; run it again to finish. */
  complete: boolean;
}

export async function reclassifySources(ctx: AnalyticsContext, window: ReclassifyWindow, options: ReclassifyOptions = {}): Promise<ReclassifyResult> {
  const { db } = ctx;
  const s = ctx.t.sessions;
  const batchSize = options.batchSize ?? 1000;
  const maxBatches = options.maxBatches ?? 1000;
  const dryRun = options.dryRun === true;
  const moves = new Map<string, number>();
  let scanned = 0;
  let changed = 0;
  let after: string | null = null;
  let complete = false;

  for (let batch = 0; batch < maxBatches; batch++) {
    const conditions: Array<SQL | undefined> = [
      eq(s.tenantId, window.tenantId),
      window.from ? gte(s.startedAt, window.from) : undefined,
      window.to ? lt(s.startedAt, window.to) : undefined,
      // Below the current version — or, with `force`, up to it. Never ABOVE it:
      // a newer package (a rolling deploy) wrote those, and an older
      // classifier must not overwrite what it does not know.
      or(isNull(s.classifierVersion), (options.force ? lte : lt)(s.classifierVersion, SOURCE_CLASSIFIER_VERSION)),
      after === null ? undefined : gt(s.id, after),
    ];
    const rows = await db
      .select({
        id: s.id,
        referrerHost: s.referrerHost,
        utmSource: s.utmSource,
        utmMedium: s.utmMedium,
        clickIdKind: s.clickIdKind,
        sourceBucket: s.sourceBucket,
      })
      .from(s)
      .where(and(...conditions))
      .orderBy(asc(s.id))
      .limit(batchSize);
    if (rows.length === 0) {
      complete = true;
      break;
    }
    scanned += rows.length;
    after = rows[rows.length - 1]!.id;

    const byBucket = new Map<SourceBucket, string[]>();
    for (const row of rows) {
      const bucket = classifySource({
        referrerHost: row.referrerHost,
        utmSource: row.utmSource,
        utmMedium: row.utmMedium,
        clickIdKind: row.clickIdKind as ClickIdKind | null,
      });
      if (bucket !== row.sourceBucket) {
        changed += 1;
        const key = `${row.sourceBucket}\u0000${bucket}`;
        moves.set(key, (moves.get(key) ?? 0) + 1);
      }
      const ids = byBucket.get(bucket) ?? [];
      ids.push(row.id);
      byBucket.set(bucket, ids);
    }
    if (!dryRun) {
      // One UPDATE per resulting bucket (at most eight per batch). Unchanged
      // rows are written too, to record the version that checked them.
      for (const [bucket, ids] of byBucket) {
        await db.update(s).set({ sourceBucket: bucket, classifierVersion: SOURCE_CLASSIFIER_VERSION }).where(inArray(s.id, ids));
      }
    }
    if (rows.length < batchSize) {
      complete = true;
      break;
    }
  }

  const changes = [...moves.entries()]
    .map(([key, sessions]) => {
      const [from, to] = key.split("\u0000") as [SourceBucket, SourceBucket];
      return { from, to, sessions };
    })
    .sort((a, b) => b.sessions - a.sessions || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { scanned, changed, changes, version: SOURCE_CLASSIFIER_VERSION, dryRun, complete };
}

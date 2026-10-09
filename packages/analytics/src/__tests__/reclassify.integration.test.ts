import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createAnalytics } from "../instance.js";
import { analyticsTables } from "../schema.js";
import { SOURCE_CLASSIFIER_VERSION } from "../sources.js";
import { createTestDb, tenant, type TestDb } from "./pglite.js";

/**
 * reclassifySources, round trip: sessions a 0.1 ingest stored (classifier
 * version null) are brought in line with today's classifier; a second run
 * finds nothing; a dry run writes nothing; the window and `force` do what
 * they say; batching by id reaches every row.
 */

const s = analyticsTables.sessions;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00Z");

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
});
afterAll(async () => {
  await tdb?.close();
});

/** Rows as 0.1 stored them: [referrer host, utm source, the bucket 0.1 gave it, version, days ago]. */
async function seed(tenantId: string, rows: Array<[string | null, string | null, string, number | null, number]>) {
  for (const [i, [referrerHost, utmSource, sourceBucket, classifierVersion, ago]] of rows.entries()) {
    await tdb.db.insert(s).values({
      tenantId,
      visitorKey: `v${i}`,
      landingPath: "/",
      referrerHost,
      utmSource,
      sourceBucket,
      classifierVersion,
      startedAt: new Date(NOW.getTime() - ago * DAY),
      lastSeenAt: new Date(NOW.getTime() - ago * DAY),
      pageViewCount: 1,
    });
  }
}

async function buckets(tenantId: string) {
  return (await tdb.db.select({ host: s.referrerHost, utm: s.utmSource, bucket: s.sourceBucket, version: s.classifierVersion }).from(s).where(eq(s.tenantId, tenantId)).orderBy(asc(s.visitorKey)));
}

describe("reclassifySources", () => {
  it("moves 0.1 rows the new classifier reads differently, records the version on all, and is idempotent", async () => {
    const tenantId = tenant("reclassify");
    await seed(tenantId, [
      ["copilot.cloud.microsoft", null, "referral", null, 40], // Microsoft 365 Copilot: unknown to 0.1
      ["android-app:com.anthropic.claude", null, "referral", null, 20], // the Claude Android app: unknown to 0.1
      [null, "perplexity.ai", "referral", null, 10], // utm_source=perplexity.ai: unknown to 0.1
      ["chatgpt.com", null, "aiAssistant", null, 5], // already right: only the version moves
      ["google.com", null, "organic", SOURCE_CLASSIFIER_VERSION, 1], // already current: not read
    ]);
    const analytics = createAnalytics({ db: tdb.db });

    const dry = await analytics.reclassifySources({ tenantId }, { dryRun: true });
    expect(dry).toEqual({
      scanned: 4,
      changed: 3,
      changes: [{ from: "referral", to: "aiAssistant", sessions: 3 }],
      version: 2,
      dryRun: true,
      complete: true,
    });
    expect((await buckets(tenantId)).map((row) => row.version)).toEqual([null, null, null, null, 2]);

    const before = await analytics.getAiAssistantTraffic({ tenantId, from: new Date(NOW.getTime() - 60 * DAY), to: NOW });
    expect(before.engines.map((row) => row.engine)).toEqual(["chatgpt"]);

    const real = await analytics.reclassifySources({ tenantId }, { batchSize: 2 });
    expect(real).toMatchObject({ scanned: 4, changed: 3, changes: [{ from: "referral", to: "aiAssistant", sessions: 3 }], dryRun: false, complete: true });
    expect(await buckets(tenantId)).toEqual([
      { host: "copilot.cloud.microsoft", utm: null, bucket: "aiAssistant", version: 2 },
      { host: "android-app:com.anthropic.claude", utm: null, bucket: "aiAssistant", version: 2 },
      { host: null, utm: "perplexity.ai", bucket: "aiAssistant", version: 2 },
      { host: "chatgpt.com", utm: null, bucket: "aiAssistant", version: 2 },
      { host: "google.com", utm: null, bucket: "organic", version: 2 },
    ]);

    const after = await analytics.getAiAssistantTraffic({ tenantId, from: new Date(NOW.getTime() - 60 * DAY), to: NOW });
    expect(after.engines.map((row) => row.engine).sort()).toEqual(["chatgpt", "claude", "copilot", "perplexity"]);

    // Idempotent: nothing below the current version is left.
    expect(await analytics.reclassifySources({ tenantId })).toMatchObject({ scanned: 0, changed: 0, changes: [], complete: true });
    // force re-reads every row and finds them all right.
    expect(await analytics.reclassifySources({ tenantId }, { force: true })).toMatchObject({ scanned: 5, changed: 0 });
  });

  it("never touches a session a NEWER classifier stored (a rolling deploy), even with force", async () => {
    const tenantId = tenant("reclassify");
    const NEWER = SOURCE_CLASSIFIER_VERSION + 1;
    await seed(tenantId, [
      ["future-ai.example", null, "aiAssistant", NEWER, 2], // a newer package knows this host; this one does not
      ["chatgpt.com", null, "aiAssistant", SOURCE_CLASSIFIER_VERSION, 2],
    ]);
    const analytics = createAnalytics({ db: tdb.db });
    expect(await analytics.reclassifySources({ tenantId }, { force: true })).toMatchObject({ scanned: 1, changed: 0 });
    expect(await analytics.reclassifySources({ tenantId })).toMatchObject({ scanned: 0, changed: 0 });
    expect(await buckets(tenantId)).toEqual([
      { host: "future-ai.example", utm: null, bucket: "aiAssistant", version: NEWER },
      { host: "chatgpt.com", utm: null, bucket: "aiAssistant", version: SOURCE_CLASSIFIER_VERSION },
    ]);
  });

  it("moves 0.1's over-broad AI hosts back out: an openai.com forum or a DeepSeek developer page was never an assistant", async () => {
    const tenantId = tenant("reclassify");
    await seed(tenantId, [
      ["community.openai.com", null, "aiAssistant", null, 5],
      ["platform.deepseek.com", null, "aiAssistant", null, 4],
      ["chat.openai.com", null, "aiAssistant", null, 3],
    ]);
    const result = await createAnalytics({ db: tdb.db }).reclassifySources({ tenantId });
    expect(result).toMatchObject({ scanned: 3, changed: 2, changes: [{ from: "aiAssistant", to: "referral", sessions: 2 }] });
    expect((await buckets(tenantId)).map((row) => row.bucket)).toEqual(["referral", "referral", "aiAssistant"]);
  });

  it("keeps to its window and its tenant, and can stop early and be re-run", async () => {
    const tenantId = tenant("reclassify");
    const other = tenant("reclassify");
    await seed(tenantId, [
      ["duck.ai", null, "referral", null, 30],
      ["kimi.com", null, "referral", null, 3],
      ["pi.ai", null, "referral", null, 2],
    ]);
    await seed(other, [["duck.ai", null, "referral", null, 3]]);
    const analytics = createAnalytics({ db: tdb.db });

    const recent = await analytics.reclassifySources({ tenantId, from: new Date(NOW.getTime() - 7 * DAY), to: NOW }, { batchSize: 1, maxBatches: 1 });
    expect(recent).toMatchObject({ scanned: 1, changed: 1, complete: false });
    const rest = await analytics.reclassifySources({ tenantId, from: new Date(NOW.getTime() - 7 * DAY), to: NOW }, { batchSize: 1 });
    expect(rest).toMatchObject({ scanned: 1, changed: 1, complete: true });
    expect((await buckets(tenantId)).map((row) => row.bucket)).toEqual(["referral", "aiAssistant", "aiAssistant"]);
    expect((await buckets(other)).map((row) => row.bucket)).toEqual(["referral"]);
  });
});

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { listQueries } from "@adminigloo/aeo";
import { aeoChecks, aeoQueries } from "@adminigloo/aeo/schema";
import { ago, GLANCE_LIMITS, plural, type Glance, type GlanceRow, type GlanceTile } from "../glance.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/aeo: whether AI assistants name this company
 * when asked its customers' questions. Reads only stored check rows — never
 * runs a check, never calls an engine. `cited` (not the narrower `mentioned`)
 * is the "yes" this glance counts, because the schema itself calls `cited`
 * "the yes/no a report counts": named in the words OR the site cited as a
 * source either one means the assistant surfaced this business.
 */
export interface AeoGlanceInput {
  readonly db: DashboardDb;
  readonly tenantId: string;
  readonly now: Date;
  readonly href?: string;
}

function deltaHint(delta: number): string {
  if (delta === 0) return "Same as last time";
  return delta > 0 ? `Up ${delta} from last time` : `Down ${Math.abs(delta)} from last time`;
}

export async function aiMentionsGlance(input: AeoGlanceInput): Promise<Glance> {
  const { db, tenantId, now } = input;
  const href = input.href ?? "/admin/aeo";

  const activeQueries = await listQueries(db, tenantId);
  if (activeQueries.length === 0) {
    return {
      setup: {
        text: "No questions are tracked yet. Add a question a customer might ask to see if AI assistants name your site.",
        href,
        label: "Add a question",
      },
    };
  }
  const activeIds = activeQueries.map((q) => q.id);

  // The latest two DONE checks per question, one windowed query (the
  // row_number-and-rejoin shape already used for per-tenant ranking
  // elsewhere in this monorepo) rather than one query per question.
  const ranked = db
    .select({
      queryId: aeoChecks.queryId,
      cited: aeoChecks.cited,
      rank: sql<number>`row_number() over (partition by ${aeoChecks.queryId} order by ${aeoChecks.checkedAt} desc, ${aeoChecks.id} desc)`.as("rank"),
    })
    .from(aeoChecks)
    .where(and(eq(aeoChecks.tenantId, tenantId), eq(aeoChecks.status, "done"), inArray(aeoChecks.queryId, activeIds)))
    .as("ranked");

  const [rankedRows, recentAnswers] = await Promise.all([
    db
      .select({ queryId: ranked.queryId, cited: ranked.cited, rank: ranked.rank })
      .from(ranked)
      .where(lte(ranked.rank, 2)),
    db
      .select({ query: aeoQueries.query, cited: aeoChecks.cited, checkedAt: aeoChecks.checkedAt })
      .from(aeoChecks)
      .innerJoin(aeoQueries, and(eq(aeoQueries.id, aeoChecks.queryId), eq(aeoQueries.tenantId, tenantId), eq(aeoQueries.isActive, true)))
      .where(and(eq(aeoChecks.tenantId, tenantId), eq(aeoChecks.status, "done")))
      .orderBy(desc(aeoChecks.checkedAt), desc(aeoChecks.id))
      .limit(GLANCE_LIMITS.rows),
  ]);

  const byQuery = new Map<string, { latest?: boolean; previous?: boolean }>();
  for (const row of rankedRows) {
    const entry = byQuery.get(row.queryId) ?? {};
    if (row.rank === 1) entry.latest = row.cited;
    else if (row.rank === 2) entry.previous = row.cited;
    byQuery.set(row.queryId, entry);
  }

  let totalChecked = 0;
  let currentNamed = 0;
  let comparable = 0;
  let previousNamed = 0;
  let currentNamedComparable = 0;
  for (const entry of byQuery.values()) {
    if (entry.latest === undefined) continue;
    totalChecked += 1;
    if (entry.latest) currentNamed += 1;
    if (entry.previous !== undefined) {
      comparable += 1;
      if (entry.previous) previousNamed += 1;
      if (entry.latest) currentNamedComparable += 1;
    }
  }
  const delta = comparable > 0 ? currentNamedComparable - previousNamed : null;

  const tiles: GlanceTile[] = [
    { label: "Questions tracked", value: activeQueries.length, href },
    {
      label: "Named the site",
      value: currentNamed,
      href,
      tone: totalChecked > 0 && currentNamed === 0 ? "warn" : undefined,
      hint: delta === null ? undefined : deltaHint(delta),
    },
    { label: "Not named", value: Math.max(0, totalChecked - currentNamed), href },
  ];

  const rows: GlanceRow[] = recentAnswers.map((answer) => ({
    title: answer.query,
    meta: ago(answer.checkedAt, now),
    badge: answer.cited ? "Named" : "Not named",
    tone: answer.cited ? "good" : "warn",
    href,
  }));

  return {
    status:
      totalChecked === 0
        ? { text: "No answers yet. The next check will run soon.", tone: "neutral" }
        : currentNamed === 0
          ? { text: "AI assistants didn't name your site in the latest answers.", tone: "warn" }
          : { text: `AI assistants named your site in ${plural(currentNamed, "answer")} of ${totalChecked} this run.`, tone: currentNamed === totalChecked ? "good" : "neutral" },
    tiles,
    list: { title: "Recent answers", empty: "No answers yet.", rows },
    link: { href, label: "Open AI mentions" },
  };
}

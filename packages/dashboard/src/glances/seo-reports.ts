import { buildWorklist, getSiteCheck, listSiteChecks, type WorkItemWire } from "@adminigloo/seo-reports";
import { ago, GLANCE_LIMITS, plural, type Glance, type GlanceRow } from "../glance.js";
import type { DashboardDb } from "../handlers.js";

/**
 * The glance over @adminigloo/seo-reports: this company's search check. Read
 * entirely off the package's own store (listSiteChecks, getSiteCheck,
 * buildWorklist) rather than the raw table — the report's worklist logic
 * (what to call a problem, how to rank it) lives there and nowhere else.
 */
export interface SeoReportsGlanceInput {
  readonly db: DashboardDb;
  readonly tenantId: string;
  readonly now: Date;
  /** The check page. */
  readonly href?: string;
}

/** How many recent attempts to look through for the latest FINISHED one. Checks run weekly at most; five is generous. */
const RECENT_ATTEMPTS = 5;

function rowOf(item: WorkItemWire, href: string): GlanceRow {
  const pages = item.evidence.filter((e) => e.page !== null).length;
  return {
    title: item.todo,
    meta: pages > 0 ? plural(pages, "page") : undefined,
    badge: item.status === "fail" ? "Fix" : "Worth a look",
    tone: item.status === "fail" ? "bad" : "warn",
    href,
  };
}

export async function searchCheckGlance(input: SeoReportsGlanceInput): Promise<Glance> {
  const { db, tenantId, now } = input;
  const href = input.href ?? "/admin/seo";

  const recent = await listSiteChecks(db, tenantId, RECENT_ATTEMPTS);
  if (recent.length === 0) {
    return {
      setup: {
        text: "No search check has run yet. Run one to see how search engines and AI assistants read your site.",
        href,
        label: "Run a check",
      },
    };
  }

  const latestDone = recent.find((r) => r.status === "done") ?? null;
  if (!latestDone) {
    // Every recent attempt is still running or broke before it finished —
    // real states, worth saying plainly rather than showing a false "zero
    // problems" from an unfinished row's placeholder counts.
    const latest = recent[0]!;
    return {
      status:
        latest.status === "running"
          ? { text: "A search check is running now.", tone: "neutral" }
          : { text: "The last search check failed to finish.", tone: "bad" },
      link: { href, label: "Open search checks" },
    };
  }

  const record = await getSiteCheck(db, tenantId, latestDone.id);
  const worklist = record ? buildWorklist(record.siteChecks, record.pages).worklist : [];

  const fails = latestDone.failCount;
  const warns = latestDone.warnCount;
  const when = ago(latestDone.finishedAt, now);
  // A newer attempt than the one we're reporting on, already under way.
  const runningNow = recent[0]!.status === "running" && recent[0]!.id !== latestDone.id;

  return {
    status:
      fails > 0
        ? { text: `${plural(fails, "serious problem")} to fix. Last checked ${when}.`, tone: "bad" }
        : warns > 0
          ? { text: `${plural(warns, "thing")} worth a look. Last checked ${when}.`, tone: "warn" }
          : { text: `Nothing to fix. Last checked ${when}.`, tone: "good" },
    attention: fails + warns,
    tiles: [
      { label: "Serious problems", value: fails, href, tone: fails > 0 ? "bad" : "good" },
      { label: "Worth a look", value: warns, href, tone: warns > 0 ? "warn" : undefined },
      { label: "Score", value: latestDone.score, href, hint: "Out of 100" },
    ],
    list: {
      title: "Top problems",
      empty: "Nothing to fix.",
      rows: worklist.slice(0, GLANCE_LIMITS.rows).map((item) => rowOf(item, href)),
    },
    note: runningNow ? "A new check is running now." : undefined,
    link: { href, label: "Open search checks" },
  };
}

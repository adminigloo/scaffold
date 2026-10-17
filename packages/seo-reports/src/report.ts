import type { PageAudit, SeoCheck } from "./audit.js";
import type { SiteCheckRecord, SiteCheckSummary } from "./store.js";
import type { SiteCheckSummaryWire, SiteCheckWire, WorkItemWire } from "./wire.js";
import { wordsFor } from "./words.js";

/**
 * A REPORT AS A WORKLIST (0.2), pure: every check that didn't pass, grouped
 * by what to do — "Give each page a clear title: /prices, /about" — fails
 * first, then the most widespread. What passed everywhere becomes the short
 * "done" list, so an owner sees progress, not only problems.
 */
export function buildWorklist(siteChecks: readonly SeoCheck[], pages: readonly PageAudit[]): { worklist: WorkItemWire[]; done: string[] } {
  const byId = new Map<string, { check: SeoCheck; evidence: { page: string | null; detail: string }[]; failed: boolean }>();
  const passedIds = new Set<string>();
  const seen = new Set<string>();
  const visit = (c: SeoCheck, page: string | null) => {
    seen.add(c.id);
    if (c.status === "pass") {
      passedIds.add(c.id);
      return;
    }
    const entry = byId.get(c.id) ?? { check: c, evidence: [], failed: false };
    entry.evidence.push({ page, detail: c.detail });
    if (c.status === "fail") entry.failed = true;
    byId.set(c.id, entry);
  };
  for (const c of siteChecks) visit(c, null);
  for (const page of pages) for (const c of page.checks) visit(c, page.path);
  const worklist: WorkItemWire[] = [...byId.values()]
    .map(({ check, evidence, failed }) => {
      const words = wordsFor(check.id, check.label);
      return { id: check.id, todo: words.todo, why: words.why, status: failed ? ("fail" as const) : ("warn" as const), kind: check.kind, evidence };
    })
    .sort((a, b) => (a.status === b.status ? b.evidence.length - a.evidence.length : a.status === "fail" ? -1 : 1));
  const done = [...seen]
    .filter((id) => passedIds.has(id) && !byId.has(id))
    .map((id) => wordsFor(id, id).todo)
    .filter((todo, i, all) => todo !== "" && all.indexOf(todo) === i);
  return { worklist, done };
}

export function toSummaryWire(row: SiteCheckSummary): SiteCheckSummaryWire {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    score: row.score,
    seoScore: row.seoScore,
    aeoScore: row.aeoScore,
    pageCount: row.pageCount,
    passCount: row.passCount,
    warnCount: row.warnCount,
    failCount: row.failCount,
    stopped: row.stopped,
    addresses: [...row.addresses],
  };
}

export function toCheckWire(row: SiteCheckRecord): SiteCheckWire {
  const { worklist, done } = buildWorklist(row.siteChecks, row.pages);
  return { ...toSummaryWire(row), worklist, done, siteChecks: row.siteChecks, pages: row.pages };
}

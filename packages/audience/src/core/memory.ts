import { reasonRank } from "./classify.js";
import type { AudienceReason, SubjectKind } from "./labels.js";
import type { AudienceMark } from "./types.js";

/**
 * The read side WITHOUT SQL, for an app that builds its sessions in
 * JavaScript (Road Rally assembles them from events in `_sessionsUtils.ts`,
 * with no visitor-id column to join on). Load the active marks once
 * (`store.listMarks(tenant, { active: true })`), index them, then ask each
 * row for its reason. Same rules as the SQL fragments: a cleared mark never
 * counts, a mark's "only from" date leaves earlier rows counted, and the best
 * reason by precedence wins, so a breakdown built from it adds up.
 */

export type MarkLike = Pick<AudienceMark, "subjectKind" | "subjectId" | "reason" | "appliesFrom" | "clearedAt">;

export interface MarkIndex {
  readonly size: number;
  get(kind: SubjectKind, id: string): readonly MarkLike[];
}

export function indexMarks(marks: Iterable<MarkLike>): MarkIndex {
  const byKey = new Map<string, MarkLike[]>();
  let size = 0;
  for (const mark of marks) {
    if (mark.clearedAt) continue;
    const key = `${mark.subjectKind}|${mark.subjectId}`;
    const list = byKey.get(key) ?? [];
    list.push(mark);
    byKey.set(key, list);
    size += 1;
  }
  return {
    size,
    get: (kind, id) => byKey.get(`${kind}|${id}`) ?? [],
  };
}

/** One row of the app's numbers: when it happened and whatever ids it carries. */
export interface RowSubjects {
  at: Date | string | number;
  visitorId?: string | number | null;
  sessionId?: string | number | null;
  userId?: string | number | null;
  orgId?: string | number | null;
  eventId?: string | number | null;
  orderId?: string | number | null;
}

const ROW_KINDS: ReadonlyArray<[keyof RowSubjects, SubjectKind]> = [
  ["visitorId", "visitor"],
  ["sessionId", "session"],
  ["userId", "user"],
  ["orgId", "org"],
  ["eventId", "event"],
  ["orderId", "order"],
];

/** Why this row does not count (the best reason among its subjects' active marks), or null when it counts. */
export function excludedReasonOf(index: MarkIndex, row: RowSubjects): AudienceReason | null {
  const at = row.at instanceof Date ? row.at.getTime() : new Date(row.at).getTime();
  let best: AudienceReason | null = null;
  for (const [field, kind] of ROW_KINDS) {
    const id = row[field];
    if (id === null || id === undefined || id === "") continue;
    for (const mark of index.get(kind, String(id))) {
      const from = mark.appliesFrom ? new Date(mark.appliesFrom).getTime() : null;
      if (from !== null && !(from <= at)) continue;
      if (best === null || reasonRank(mark.reason) < reasonRank(best)) best = mark.reason;
    }
  }
  return best;
}

import type { AudienceReason, MarkSource, RuleKind, RunAction, SubjectKind } from "./labels.js";

/** A stored rule — one row of `…rules`. Values are stored normalized. */
export interface AudienceRule {
  id: string;
  tenantId: string;
  kind: RuleKind;
  value: string;
  /** Free words for the admin list ("Rachel's consultant"). Never used for matching. */
  reasonLabel: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  /** Set = removed. Rules are never hard-deleted. */
  disabledAt: Date | null;
  disabledBy: string | null;
  /** Rows (sessions) before this instant stay counted. Null = all of history. */
  appliesFrom: Date | null;
}

/** What a caller supplies to create a rule. */
export interface AudienceRuleInput {
  kind: RuleKind;
  value: string;
  reasonLabel?: string | null;
  note?: string | null;
  /** Date, ISO string or YYYY-MM-DD. */
  appliesFrom?: Date | string | null;
}

/** One row of `…marks`: this subject does not count, for this reason. */
export interface AudienceMark {
  id: string;
  tenantId: string;
  subjectKind: SubjectKind;
  subjectId: string;
  reason: AudienceReason;
  ruleId: string | null;
  source: MarkSource;
  markedBy: string | null;
  markedAt: Date;
  clearedAt: Date | null;
  clearedBy: string | null;
  appliesFrom: Date | null;
}

export interface NewAudienceMark {
  tenantId: string;
  subjectKind: SubjectKind;
  subjectId: string;
  reason: AudienceReason;
  ruleId: string | null;
  source: MarkSource;
  markedBy: string | null;
  markedAt: Date;
  appliesFrom: Date | null;
}

/** One row of `…runs`: the audit trail of every apply, remove, backfill and hand mark. */
export interface AudienceRun {
  id: string;
  tenantId: string;
  ruleId: string | null;
  action: RunAction;
  subjectsChanged: number;
  /** Null when the instance has no `sessions` source to count against. */
  sessionsAffected: number | null;
  /** Earliest and latest affected row (session) — "back to <date>". */
  rangeFrom: Date | null;
  rangeTo: Date | null;
  runBy: string | null;
  runAt: Date;
  /** The annotation sentence the run produced. */
  summary: string | null;
}

export type NewAudienceRun = Omit<AudienceRun, "id">;

/**
 * The app's user, as the package needs to see it. Extra fields (a role, a
 * plan) ride along to the app's own `isInternal` callback untouched.
 */
export interface AudienceUser {
  /** A string id, or a number (Road Rally's ids are integers): it is compared and stored as its digits. */
  id: string | number;
  email?: string | null;
  /**
   * Orgs the user belongs to. Read by `org` rules at intake AND in history:
   * return them from `listUsers` too, so an org rule reaches its members' past.
   */
  orgIds?: readonly (string | number)[] | null;
}

/** Header access that accepts a Fetch `Headers` or a plain object. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | string[] | undefined | null>>;

/**
 * Everything known about one request or one actor, all optional. The pure
 * classifier reads only this; nothing in it is stored except through a mark
 * (a visitor/user/org/… id) — never the IP, the user agent or the host.
 */
export interface ActorFacts {
  visitorId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  email?: string | null;
  orgIds?: readonly string[] | null;
  eventId?: string | null;
  orderId?: string | null;
  /** The page's host (or the request's). Port and case are ignored. */
  host?: string | null;
  userAgent?: string | null;
  /** Checked against `network` rules in memory, then dropped. */
  ip?: string | null;
  /** The app's own verdict: `VERCEL_ENV !== "production"` and the like. */
  nonProduction?: boolean | null;
  /** `navigator.webdriver` as the browser reported it. */
  webdriver?: boolean | null;
  /** The secret smoke-test header was present and correct. */
  testHeader?: boolean | null;
  /** What the app's `isInternal(user)` returned: a label means internal. */
  roleLabel?: string | false | null;
}

/** One reason a subject matched. */
export interface AudienceMatch {
  reason: AudienceReason;
  /** The stored rule that matched, or null (a default, the callback, a flag). */
  ruleId: string | null;
  /** Human detail: the callback's label, the default pattern, the rule value. */
  detail: string;
  /** Whether this reason is about the PERSON (so the user is marked too) or only this visit. */
  personal: boolean;
}

/** The winning match plus everything else that matched, best first. */
export interface AudienceClassification extends AudienceMatch {
  all: AudienceMatch[];
}

/** A window over the app's rows. `to` is exclusive. Omitted ends are open. */
export interface AudienceWindow {
  from?: Date | null;
  to?: Date | null;
}

/**
 * Where the app keeps the rows the numbers are made of — usually its
 * sessions table. Identifiers only (`[A-Za-z_][A-Za-z0-9_]*`, dotted for a
 * schema); validated before they reach SQL.
 */
export interface RowsSource {
  /** e.g. "analytics_sessions" or "public.analytics_sessions". */
  table: string;
  /** The column holding the visitor id that `visitor` marks name. */
  visitor: string;
  /** The column the report windows on (session start). */
  time: string;
  /** The row's own id, for `session` marks. Optional. */
  id?: string;
  /**
   * Equality filters on the app's rows — e.g. `{ tenant_id: "site" }` when the
   * sessions table is shared by environments. Column names are validated;
   * values are bound parameters.
   */
  where?: Readonly<Record<string, string | number | boolean>>;
}

export interface ExcludedBreakdown {
  total: number;
  byReason: Partial<Record<AudienceReason, number>>;
  /** What was counted ("sessions"). */
  unit: string;
}

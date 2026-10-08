import type { AudienceReason, RuleKind, RunAction } from "./core/labels.js";

/**
 * The plain shapes the admin components draw. Structural on purpose: what the
 * server functions return (`AudienceRule`, `AudienceRun`, `AudiencePreview`,
 * `ExcludedBreakdown`) already satisfies them, and so does the same data
 * after a server-action or JSON round trip turned its Dates into strings.
 * Type-only — this module is erased from every bundle.
 */

export type DateLike = Date | string;

export interface RuleView {
  id: string;
  kind: RuleKind;
  value: string;
  reasonLabel?: string | null;
  note?: string | null;
  createdBy?: string | null;
  createdAt: DateLike;
  appliesFrom?: DateLike | null;
}

export interface RunView {
  id: string;
  ruleId?: string | null;
  action: RunAction;
  subjectsChanged: number;
  sessionsAffected?: number | null;
  rangeFrom?: DateLike | null;
  rangeTo?: DateLike | null;
  runBy?: string | null;
  runAt: DateLike;
  summary?: string | null;
}

export interface RowCountView {
  sessions: number;
  visitors: number;
}

export interface PreviewWindowView {
  key: string;
  label: string;
  before: RowCountView;
  after: RowCountView;
  excluded: RowCountView;
  earliest?: DateLike | null;
}

export interface PreviewView {
  retroactive: boolean;
  subjects: { users: number; visitors: number; orgs: number; events: number; orders: number };
  alreadyExcluded?: { users: number; visitors: number; orgs: number; events: number; orders: number };
  windows: PreviewWindowView[];
  /** Sentences about what this rule cannot reach. */
  limits: string[];
  /** Set when an active rule already says the same thing. */
  duplicateOf?: string | null;
}

export interface ExcludedView {
  total: number;
  byReason: Partial<Record<AudienceReason | string, number>>;
  unit?: string;
}

/** What the add form hands to `onPreview` and `onAdd`. */
export interface RuleDraft {
  kind: RuleKind;
  value: string;
  reasonLabel?: string | null;
  note?: string | null;
  /** YYYY-MM-DD from a date input, or null. */
  appliesFrom?: string | null;
}

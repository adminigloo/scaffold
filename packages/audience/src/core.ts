/**
 * @adminigloo/audience/core — the part with NO peer dependency: the rule
 * model, the pure classifier, normalisation, masking, the SQL text builders,
 * the `AudienceStore` interface and `createAudience` over any store.
 *
 * Use this entry when the app is not on Drizzle + Postgres (Road Rally:
 * MySQL, SolidJS) — implement `AudienceStore` over your driver and render the
 * counted-SQL fragments with `renderSql(…, { placeholder: "?" })`. Apps on
 * Drizzle + Postgres import the package root instead, which adds the default
 * store, the Drizzle `sql` fragments and the license gate.
 */

export { createAudienceCore as createAudience, isUniqueViolation } from "./core/audience.js";
export type {
  ActorInput,
  ApplyResult,
  AudienceAnnotation,
  AudienceCore,
  AudiencePreview,
  AudienceViewModel,
  BackfillAdapter,
  BackfillCandidate,
  BackfillContext,
  BackfillResult,
  CreateAudienceOptions,
  InternalVerdict,
  LinkMode,
  MaintainResult,
  ObserveInput,
  PreviewWindow,
  RemoveResult,
  SubjectCounts,
  UsersSource,
} from "./core/audience.js";

export {
  RULE_KINDS,
  REASON_ORDER,
  MARK_SOURCES,
  SUBJECT_KINDS,
  RUN_ACTIONS,
  REASON_FOR_KIND,
  RETROACTIVE_KINDS,
  isRetroactiveKind,
  DEFAULT_REASON_LABELS,
  KIND_INFO,
} from "./core/labels.js";
export type { AudienceReason, MarkSource, RuleKind, RunAction, SubjectKind } from "./core/labels.js";

export {
  allMatches,
  bestReason,
  classify,
  compileRules,
  isPersonalReason,
  markScopeOf,
  reasonRank,
  ruleMatchesUser,
} from "./core/classify.js";
export type { ClassifyOptions, CompiledRules, MarkScope } from "./core/classify.js";

export {
  ALL_DEFAULTS,
  DEFAULT_AUTOMATION_AGENTS,
  DEFAULT_EMAIL_DOMAINS,
  DEFAULT_EMAIL_PATTERNS,
  DEFAULT_NON_PRODUCTION_HOSTS,
  DEFAULT_TEST_HEADER,
  DEVICE_LINK_PARAM,
  INCLUDE_INTERNAL_PARAM,
  automationAgentOf,
  clientIpFrom,
  headerValue,
  includeInternalHref,
  isBotAgent,
  isNonProductionEnv,
  isPrivacyOptOut,
  readIncludeInternal,
  resolveDefaults,
} from "./core/defaults.js";
export type { AudienceDefaults } from "./core/defaults.js";

export {
  asciiDomain,
  cleanId,
  domainMatches,
  EMAIL_MAX,
  emailKey,
  emailPatternMatches,
  foldEmail,
  globMatches,
  hostMatches,
  ID_MAX,
  normalizeDomain,
  normalizeEmail,
  normalizeHost,
  normalizeRuleInput,
  normalizeRuleValue,
  RuleValueError,
} from "./core/normalize.js";

export { canonicalCidr, cleanIp, ipInRange, parseCidr, parseIPv4, parseIPv6 } from "./core/cidr.js";
export type { IpRange } from "./core/cidr.js";

export { excludedParts, excludedSentence } from "./core/words.js";
export type { ExcludedCounts } from "./core/words.js";

export { createMasker, maskEmail, maskEmailsIn, maskNetwork, maskRule, maskRun, shortenId } from "./core/mask.js";
export type { Masker } from "./core/mask.js";

export { MIN_SECRET_DISTINCT, MIN_SECRET_LENGTH, signDeviceToken, testHeaderValueFor, userKeyFor, verifyDeviceToken } from "./core/keys.js";
export type { DeviceTokenResult } from "./core/keys.js";

export {
  assertColumnName,
  assertIdentifier,
  breakdownParts,
  countedSubjectClause,
  countedSubjectParts,
  countedVisitorClause,
  countedVisitorParts,
  countRowsParts,
  DEFAULT_MARKS_TABLE,
  renderSql,
} from "./core/sql.js";
export type { ColumnInput, CountedOptions, CountedVisitorOptions, RawSql, RenderOptions, RowQueryBase, SqlDialect, SqlPart } from "./core/sql.js";

export { excludedReasonOf, indexMarks } from "./core/memory.js";
export type { MarkIndex, MarkLike, RowSubjects } from "./core/memory.js";

export { AudienceError, isAudienceError } from "./core/errors.js";
export type { AudienceErrorCode } from "./core/errors.js";

export type {
  AudienceStore,
  ClearedMark,
  ClearMarksWhere,
  ListMarksWhere,
  NewAudienceRuleRow,
  RowCount,
  RowCountQuery,
  RowWindowQuery,
} from "./core/store.js";

export type {
  ActorFacts,
  AudienceClassification,
  AudienceMark,
  AudienceMatch,
  AudienceRule,
  AudienceRuleInput,
  AudienceRun,
  AudienceUser,
  AudienceWindow,
  ExcludedBreakdown,
  HeadersLike,
  NewAudienceMark,
  NewAudienceRun,
  RowsSource,
} from "./core/types.js";

export type {
  DateLike,
  ExcludedView,
  PreviewView,
  PreviewWindowView,
  RowCountView,
  RuleDraft,
  RuleView,
  RunView,
} from "./views.js";

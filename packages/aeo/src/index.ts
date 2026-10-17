/**
 * @adminigloo/aeo — "AI MENTIONS" (0.2): for the questions a company's
 * customers ask an AI assistant, does the answer name the company? Per
 * company, metered, with the quote, the sources and the trend.
 *
 *   const { handle, runScheduled } = createAeoHandlers({ db, resolveTenant, authorize, engine, spend });
 *
 * Modules: detect (code decides what an answer said — pure), engines (the
 * adapter shape), runner (metered, deadline-aware checks), store (per-company
 * rows), handlers + routes + permissions (the HTTP surface). The Anthropic
 * engine is on `@adminigloo/aeo/anthropic`, the screen on `./ui`, the tables
 * on `./schema`.
 */
export { analyzeAnswer, detectCitation, domainIndex, isOwnSource, normalizeDomain, snippetAround } from "./detect.js";
export type { AnswerAnalysis, CitationResult, CitationTarget } from "./detect.js";
export type { AnswerEngine, EngineAnswer, EngineUsage } from "./engines.js";
export { runMentionChecks } from "./runner.js";
export type { MentionSpend, RunMentionChecksInput, RunMentionChecksResult, SpendReservation } from "./runner.js";
export {
  addQuestion,
  AeoError,
  checkCosts,
  createQuery,
  createQuerySchema,
  deactivateQuery,
  getProfile,
  getQuery,
  latestChecks,
  listChecks,
  listQueries,
  MAX_QUESTIONS,
  profileSchema,
  queriesWithLatest,
  questionSchema,
  questionTrends,
  recordCheck,
  recordFailedCheck,
  saveProfile,
  weekStartUtc,
} from "./store.js";
export type { AeoDb, CheckCostSummary, CheckRow, CreateQueryInput, ProfileInput, ProfileRow, QueryRow, QueryWithLatest, RecordCheckInput, TrendWeek } from "./store.js";
export { AEO_SCHEDULE_EVERY_MS, createAeoHandlers } from "./handlers.js";
export type { AeoAuthorizeResult, AeoHandlers, CreateAeoHandlersOptions, ScheduledMentionsOutcome } from "./handlers.js";
export { AEO_ADMIN_ROUTE_PERMISSIONS, AEO_ADMIN_ROUTES } from "./routes.js";
export type { AeoAdminRouteKind, AeoRoute } from "./routes.js";
export { aeoPermissions } from "./permissions.js";
export type { AeoPermission, AeoPermissionDefinition } from "./permissions.js";
export type {
  AeoErrorCodeWire,
  AeoErrorWire,
  MentionCheckWire,
  MentionsOverviewWire,
  ProfileWire,
  QuestionDetailWire,
  QuestionWire,
  RunResultWire,
  TrendWeekWire,
} from "./wire.js";
export { aeoChecks, aeoProfiles, aeoQueries } from "./schema.js";

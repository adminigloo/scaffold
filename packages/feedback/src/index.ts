/**
 * @adminigloo/feedback — a feedback board per company, complete, with epics (0.12.0).
 *
 *   the intake      createFeedbackHandlers: what a reporter's widget calls
 *                   (by a company's website key, or a company's own public
 *                   feedback page via `resolveTenant`), with `admit` for a
 *                   company that is closed to new tickets
 *   the staff side  createFeedbackAdminHandlers: the board (with filters and
 *                   search), New ticket, the ticket panel (editing, the
 *                   activity trail), the company's people, columns,
 *                   categories and website keys, for ONE company per
 *                   request — and the functions under them (board-data.ts),
 *                   every one of which takes the company
 *   the contract    FEEDBACK_ADMIN_ROUTES / FEEDBACK_PUBLIC_ROUTES (the routes
 *                   as data, for an isolation proof), feedbackPermissions (the
 *                   keys and their default roles), feedbackAlertKinds and
 *                   feedbackAlertsFor (alerts), FEEDBACK_EMAIL_TEMPLATES and
 *                   feedbackReporterEmailFor (the reporter's emails)
 *
 * `./schema` holds the tables; `./board` the React board, its toolbar and
 * filters, New ticket, the ticket panel, the connected workspace and the
 * browser client for the staff routes; `./admin` the settings screens
 * (columns, categories, website keys); `./epics` (0.12.0) the epic screens —
 * the list, an epic's page and its create/edit dialog.
 *
 * 0.12.0, epics: a company's bigger pieces of work, each with its tickets and
 * its progress (epics-data.ts, epic-core.ts), on the board's own routes and
 * keys. Included in this package, not sold apart.
 */

export * from "./core.js";
export { FEEDBACK_PLATFORM_BOARD } from "./schema.js";
export type { FeedbackEpicStatus, FeedbackPriority, FeedbackTicketEventKind, FeedbackTicketSource, FeedbackTicketStatus } from "./schema.js";
export * from "./board-data.js";
export * from "./board-filters.js";
export * from "./epics-data.js";
export * from "./epic-core.js";
export {
  createFeedbackHandlers,
  FEEDBACK_CLOSED_MESSAGE,
  type CreateFeedbackHandlersOptions,
  type FeedbackAdmission,
  type FeedbackHandlers,
  type FeedbackRateLimitDecision,
  type FeedbackRateLimitInfo,
} from "./handlers.js";
export {
  createFeedbackAdminHandlers,
  type CreateFeedbackAdminHandlersOptions,
  type FeedbackAdminHandlers,
  type FeedbackAuthorizeResult,
  type FeedbackPerson,
} from "./admin-handlers.js";
export { FEEDBACK_ERROR_STATUS, isCrossSiteRequest, type FeedbackErrorCode } from "./http.js";
export { feedbackPermissions, type FeedbackPermission, type FeedbackPermissionDefinition } from "./permissions.js";
export {
  FEEDBACK_ADMIN_ROUTE_PERMISSIONS,
  FEEDBACK_ADMIN_ROUTES,
  FEEDBACK_PUBLIC_ROUTES,
  type FeedbackAdminRouteKind,
  type FeedbackPublicRouteKind,
  type FeedbackRoute,
} from "./routes.js";
export {
  FEEDBACK_TICKET_NEW_KIND,
  FEEDBACK_TICKET_REPLIED_KIND,
  feedbackAlertKinds,
  feedbackAlertsFor,
  type FeedbackAlertChannel,
  type FeedbackAlertDraft,
  type FeedbackAlertKind,
  type FeedbackAlertKinds,
  type FeedbackAlertRouting,
} from "./alerts.js";
export {
  FEEDBACK_EMAIL_TEMPLATES,
  feedbackReporterEmailFor,
  type FeedbackEmailTemplateKey,
  type FeedbackReporterEmail,
} from "./email.js";
export {
  FEEDBACK_TICKET_RECORD,
  feedbackFileRecords,
  feedbackScreenshotPurpose,
  sniffImage,
  sweepFeedbackUploads,
  UPLOAD_GRACE_MS,
  type FeedbackFileRecordType,
  type FeedbackImageType,
  type FeedbackScreenshotStore,
} from "./uploads.js";
export {
  BUSY_TODAY_MESSAGE,
  createFeedbackRateLimit,
  createMemoryCounter,
  FEEDBACK_INTAKE_LIMITS,
  TOO_MANY_MESSAGE,
  UNKNOWN_CALLER,
  type FeedbackIntakeLimits,
  type FeedbackLimitPolicy,
} from "./limits.js";

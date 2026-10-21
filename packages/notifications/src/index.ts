/**
 * @adminigloo/notifications 0.2: alerts for each company, for each person in
 * it (Tenancy 2b-1, section 4).
 *
 * What the business owner gets: a bell with THEIR company's alerts (a new
 * lead, a quote answered, a visit moved, an invoice paid, an email that
 * didn't go, a teammate who joined), each person's choice of "In the app" or
 * "In the app and by email", ONE place where the owner says who hears about
 * new work, and alert emails under the company's name.
 *
 * Three rules from 0.1 carry over (./instance.ts): fan-out at write time;
 * reads scoped to the company AND the person in the WHERE clause; notifying
 * never breaks the thing it announces.
 *
 * Neither this package nor its schema imports tenancy, auth, permissions,
 * comms or @adminigloo/db (D14): the company, the person and the permission
 * come from the host's seams, and every table name is the host's to choose.
 */

// 4.2 The registry.
export {
  defineAlertKinds,
  defineAlertRegistry,
  DuplicateAlertKindError,
  InvalidAlertKindError,
  type AlertChannel,
  type AlertKindsFragment,
  type AlertKindSpec,
  type AlertRegistry,
  type AlertRoutingSpec,
} from "./registry.js";

// 4.3 The instance.
export { createNotifications } from "./instance.js";
export {
  AlertsInputError,
  AlertsUnavailableError,
  type AlertDraft,
  type AlertEmailDelivery,
  type AlertEmailMessage,
  type AlertEmailOutcome,
  type AlertPerson,
  type AlertReader,
  type AlertRow,
  type CleanupOptions,
  type CreateNotificationsOptions,
  type DeliverPendingEmailsOptions,
  type DeliverPendingEmailsResult,
  type Notifications,
  type NotificationsDb,
  type NotifyReport,
  type RoutingChoice,
} from "./types.js";
export { breakLinks } from "./links.js";

// 4.1, for a host that wires everything from the root (the drizzle schema
// file should still import the tables from "@adminigloo/notifications/schema").
export {
  defineNotificationTables,
  InvalidTableNameError,
  notificationsSql,
  notificationTables,
  type DefineNotificationTablesOptions,
  type NotificationTables,
} from "./schema.js";

// 4.6 Permissions.
export { notificationsPermissions, type NotificationsPermission, type NotificationsPermissionDefinition } from "./permissions.js";

// 4.7 Handlers and the route table.
export {
  createNotificationHandlers,
  type CreateNotificationHandlersOptions,
  type NotificationHandlers,
  type NotificationsAuthorizeResult,
} from "./handlers.js";
export { notificationsAuditedActions, type NotificationsAuditAction, type NotificationsAuditEvent } from "./audit.js";
export {
  NOTIFICATIONS_ADMIN_ROUTE_PERMISSIONS,
  NOTIFICATIONS_ADMIN_ROUTES,
  type NotificationsAdminRouteKind,
  type NotificationsRoute,
} from "./routes.js";

// 4.8 The wire.
export type * from "./wire.js";

// 4.9 The alert email.
export { TEAM_ALERT_EMAIL_TEMPLATE } from "./template.js";
export { renderAlertEmail } from "./render.js";

// 4.10 0.1's API, kept (deprecated).
export {
  listNotifications,
  markAllRead,
  markNotificationRead,
  notify,
  notifySchema,
  unreadCount,
  type NotificationRow,
  type NotifyInput,
} from "./legacy.js";

// Delete a company (create-app 0.37): every row of one company, children first.
export { forgetTenant } from "./forget.js";

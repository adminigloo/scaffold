/**
 * @adminigloo/notifications-widget/admin: the alerts bell, the alerts page,
 * Alert settings and their transport (Tenancy 2b-1, section 5).
 */
export { NOTIFICATIONS_WIRE_VERSION } from "../version.js";
export { AlertsBell } from "./AlertsBell.js";
export type { AlertsBellProps } from "./AlertsBell.js";
export { AlertsInbox } from "./AlertsInbox.js";
export type { AlertsInboxProps } from "./AlertsInbox.js";
export { AlertSettings } from "./AlertSettings.js";
export type { AlertSettingsProps } from "./AlertSettings.js";
export { createAlertsClient } from "../client.js";
export type { AlertsTransport } from "../client.js";
export type { ClientError, Result, TransportOptions } from "../http.js";
export { alertsWidgetCss, injectAlertsStyles } from "../styles.js";
export type {
  AlertChannelWire,
  AlertChoiceWire,
  AlertCountWire,
  AlertListWire,
  AlertWire,
  PreferenceBody,
  PreferencesWire,
  RoutingBody,
  RoutingGroupWire,
  RoutingPersonWire,
  RoutingWire,
} from "../types.js";

/**
 * @adminigloo/notifications-widget, entry `.`: the wire types, the wire
 * version and the transport (Tenancy 2b-1, section 5). The alerts screens
 * themselves are under `./admin`, like every other staff screen, so a page
 * that only needs the types never ships them.
 */
export { NOTIFICATIONS_WIRE_VERSION } from "./version.js";
export { createAlertsClient } from "./client.js";
export type { AlertsTransport } from "./client.js";
export type { ClientError, Result, TransportOptions } from "./http.js";
export type {
  AlertChannelWire,
  AlertChoiceWire,
  AlertCountWire,
  AlertListWire,
  AlertsErrorCode,
  AlertWire,
  Instant,
  PreferenceBody,
  PreferencesWire,
  RoutingBody,
  RoutingGroupWire,
  RoutingPersonWire,
  RoutingWire,
  WireErrorBody,
  WireIssue,
} from "./types.js";

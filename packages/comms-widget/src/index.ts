/**
 * @adminigloo/comms-widget, entry `.`: the wire types, the wire version and
 * the transport. The Messages console itself is under `./admin`, like every
 * other staff screen, so a page that only needs the types never ships it.
 */
export { COMMS_WIRE_VERSION } from "./version.js";
export { createCommsClient } from "./client.js";
export type { CommsTransport } from "./client.js";
export type { ClientError, Result, TransportOptions } from "./http.js";
export type {
  ActiveBody,
  CommsErrorCode,
  CommsStatusWire,
  Instant,
  MessageStatus,
  MessageWire,
  MessagesWire,
  RunDueWire,
  TemplateBody,
  TemplateWire,
  TemplatesWire,
  WireErrorBody,
  WireIssue,
} from "./types.js";

/**
 * @adminigloo/comms-widget/admin: the Messages console (Tenancy 2a, 9.7) and
 * its transport.
 */
export { COMMS_WIRE_VERSION } from "../version.js";
export { MessagesConsole } from "./MessagesConsole.js";
export type { MessagesConsoleProps } from "./MessagesConsole.js";
export { createCommsClient } from "../client.js";
export type { CommsTransport } from "../client.js";
export type { ClientError, Result, TransportOptions } from "../http.js";
export { commsWidgetCss, injectCommsStyles } from "../styles.js";
export { runDueSentence, templateGroup, templateLabel } from "./words.js";
export type {
  ActiveBody,
  CommsErrorCode,
  CommsStatusWire,
  MessageStatus,
  MessageWire,
  MessagesWire,
  RunDueWire,
  TemplateBody,
  TemplateWire,
  TemplatesWire,
} from "../types.js";

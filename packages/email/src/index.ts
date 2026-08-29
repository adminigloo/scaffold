export {
  parseSenderAddress,
  formatSenderAddress,
  InvalidSenderAddressError,
} from "./sender.js";
export type { SenderAddress } from "./sender.js";

export {
  createEmailSender,
  createResendTransport,
  EmailMessageInvalidError,
  EmailTransportError,
} from "./send.js";
export type {
  CreateEmailSenderOptions,
  EmailLogEntry,
  EmailMessage,
  EmailSender,
  EmailTransport,
  OutboundEmail,
  SendOutcome,
  SkipReason,
  TransportResult,
} from "./send.js";

export {
  verifyDeliveryWebhook,
  mapDeliveryStatus,
  deliveryStatusRank,
  shouldApplyDeliveryStatus,
  DeliveryWebhookNotConfiguredError,
  DeliveryWebhookVerificationError,
  MalformedDeliveryEventError,
} from "./webhook.js";
export type {
  DeliveryEvent,
  DeliveryEventType,
  DeliveryStatusOrder,
} from "./webhook.js";

export { emailServer, EMAIL_ENV_GROUP } from "./env.js";

// Types only. The tables themselves are reachable at "@adminigloo/email/schema"
// and nowhere else: re-exporting a pgTable from the barrel drags
// drizzle-orm/pg-core into every client bundle, and because tsup does not
// code-split CJS a require() consumer would hold two distinct objects for one
// physical table, at which point Drizzle's reference equality quietly fails.
// These erase at compile time and cost nothing.
export type {
  EmailEvent,
  EmailMetadata,
  EmailStatus,
  NewEmailEvent,
} from "./schema.js";

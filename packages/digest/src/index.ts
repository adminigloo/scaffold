/**
 * @adminigloo/digest 0.1: each person's own email choices and a daily digest
 * in their own time zone.
 *
 * What a person gets: a preferences page with every email the site sends
 * (each OFF until they say yes), the hour their digests come and their zone;
 * one digest a day at most, at or after that hour; and on every email a link
 * that stops that one email — without signing in — plus the one-click
 * unsubscribe header Gmail and Yahoo show as their own button.
 *
 * What the project writes: its digests' SECTIONS (a server function of the
 * person and the day: a title, plain text and HTML, or null) and its alert
 * kinds, in one `defineEmailKinds`.
 *
 *   ./schema  the three tables (preferences, subscriptions, the ledger)
 *   ./ui      the preferences screen and the sign-up choice (React)
 *
 * Neither this package nor its schema imports the host's users, auth or
 * mailer: who the people are (`people`) and how an email leaves (`send`)
 * are the host's seams.
 */

export { defineEmailKinds, InvalidEmailKindError, KIND_KEY } from "./registry.js";
export type {
  AlertKindSpec,
  DigestPerson,
  DigestRecipient,
  DigestSection,
  DigestSectionContent,
  DigestSpec,
  EmailKind,
  EmailKinds,
} from "./registry.js";

export { html, raw, escapeHtml, isSafeHtml, SAFE_HTML, type SafeHtml } from "./html.js";

export {
  addDays,
  assertTimeZone,
  deliveryWindow,
  digestDay,
  hourLabel,
  InvalidTimeZoneError,
  isDay,
  isTimeZone,
  localDay,
  zonedInstant,
  type DeliveryWindow,
  type DigestDay,
} from "./time.js";

export { readUnsubscribe, signUnsubscribe } from "./tokens.js";

export { paragraphs, renderAlertEmail, renderDigestEmail, type EmailLinks, type EmailTheme, type RenderedEmail } from "./render.js";

export {
  createDigests,
  DigestInputError,
  type AlertSendResult,
  type ChoiceSource,
  type CreateDigestsOptions,
  type DigestDb,
  type DigestOutgoing,
  type DigestPreview,
  type DigestRunResult,
  type DigestRunTally,
  type Digests,
  type DigestSendOutcome,
  type EmailPreferences,
  type SavePreferencesInput,
  type SignUpChoice,
  type UnsubscribeResult,
} from "./instance.js";

export {
  createDigestHandlers,
  DIGEST_ROUTES,
  isCrossSiteRequest,
  type CreateDigestHandlersOptions,
  type DigestHandlers,
  type PreferencesResponse,
} from "./handlers.js";

export {
  encodeSignUpChoice,
  parseSignUpChoice,
  SIGN_UP_CHOICE_COOKIE,
  SIGN_UP_CHOICE_MAX_AGE_SECONDS,
  type SignUpChoiceValue,
} from "./signup.js";

// Types only: the tables are at "@adminigloo/digest/schema" and nowhere else,
// so this entry never drags drizzle's pg-core into a bundle that only sends.
export type { DefineDigestTablesOptions, DigestTables } from "./schema.js";

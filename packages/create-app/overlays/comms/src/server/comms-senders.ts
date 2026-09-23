import { seedDefaultTemplates, type CommsSenders } from "__SCOPE__/comms";
import { db as sharedDb } from "@/db";

/**
 * The app's comms senders, injected into __SCOPE__/comms. A sender is a function
 * that actually delivers a message; the package owns the templates, the queue
 * and the log, and takes the delivery from here so the provider is the app's
 * choice, not the package's.
 *
 * SHIPPED WITH NO PROVIDER WIRED, on purpose (configuration-not-flags). With no
 * sender, comms records each message as "skipped" rather than a fake "sent",
 * and nothing throws. Wire one and it turns on with no other change.
 *
 * EMAIL — generate with `--email`, then:
 *
 *   import { createEmailSender } from "__SCOPE__/email";
 *   import { plainTextToEmailHtml } from "__SCOPE__/comms";
 *   const mailer = createEmailSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? "" });
 *   email: (m) =>
 *     mailer.send({ to: m.to, subject: m.subject, text: m.body, html: plainTextToEmailHtml(m.body) }),
 *
 *   Templates are plain text. plainTextToEmailHtml escapes FIRST and then adds
 *   paragraphs, line breaks and links, so a customer's name can never become
 *   markup — wrap its output in your own branded layout if you have one, but
 *   never interpolate `m.body` into HTML yourself. (`m.html` carries the same
 *   conversion, precomputed.) Returning the provider's result is enough:
 *   comms reads `{ error }`, `{ ok: false }` and `{ status: "failed" }` as a
 *   failure, so a sender need not throw for the log to stay honest.
 *
 *   Calling Resend's SDK directly instead? Forward the key comms hands you —
 *   `resend.emails.send(payload, { idempotencyKey: m.idempotencyKey })` — and
 *   Resend drops a repeat of the same queued message within 24 hours, the last
 *   guard against a double send when a database write fails mid-run.
 *
 * SMS — REQUIRES `smsCompliance` (a type error without it):
 *
 *   import twilio from "twilio";
 *   const twilioClient = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
 *   sms: (m) =>
 *     twilioClient.messages.create({
 *       to: m.to,
 *       body: m.body,
 *       messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
 *     }),
 *   smsCompliance: { senderName: "Your Business Name" },
 *
 *   Every text is then sent as "Your Business Name: …" with "Reply STOP to opt
 *   out." (or your `optOutText`) appended unless the text already contains
 *   that exact line — what US carriers (A2P 10DLC) and the TCPA expect. Other
 *   wording ("text UNSUBSCRIBE") does not count: the check sees the rendered
 *   message, customer-supplied values included. Send through a Twilio MESSAGING
 *   SERVICE registered to your A2P 10DLC campaign (messagingServiceSid), not a
 *   bare `from` number: unregistered traffic from a US long code is filtered
 *   or blocked. Recipients arrive already normalised to E.164.
 *
 * IMMEDIATE vs LATER. A confirmation goes out in the request that caused it:
 * `sendNow(db, { tenantId: COMMS_TENANT, to, templateKey, vars }, commsSenders)`.
 * Only future messages (reminders, follow-ups) belong in `enqueueMessage` —
 * give them `refType`/`refId` so `cancelScheduled` can withdraw them when the
 * booking is cancelled or moved, and a `dedupeKey` if the enqueue can be
 * retried.
 */
export const COMMS_TENANT = "primary";

export const commsSenders: CommsSenders = {
  // email: wire a provider here — see the file header.
  // sms + smsCompliance: wire a provider here — see the file header.
};

let templatesSeeded = false;
export async function ensureCommsTemplates(db = sharedDb): Promise<void> {
  if (templatesSeeded) return;
  await seedDefaultTemplates(db, COMMS_TENANT);
  templatesSeeded = true;
}

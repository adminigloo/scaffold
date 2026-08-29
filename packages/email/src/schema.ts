import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, logIdColumn, updatedAt } from "@adminigloo/db";

/**
 * Where a message got to.
 *
 * `queued`      a row written before dispatch, so a crash mid-send is visible
 * `sent`        the provider accepted it — NOT proof anyone received it
 * `skipped`     no credential, so nothing was dispatched (see below)
 * `delivered`   the receiving server accepted it, per the delivery webhook
 * `bounced`     rejected; the address is bad or the domain refused us
 * `complained`  marked as spam by the recipient
 * `failed`      the provider rejected the request, or the call threw
 *
 * `sent` and `delivered` are separate because a provider's 200 only means the
 * message entered its queue. Collapsing them makes a hard bounce look like a
 * success in every report the row appears in.
 *
 * SKIPPED IS A REAL OUTCOME, NOT AN ERROR. With no API key the send is recorded
 * as skipped and the full intent — recipient, subject, template, tenant — is
 * logged, so a developer can read off exactly which mail WOULD have gone out.
 * The alternative is throwing, and throwing makes every feature that happens to
 * send mail unusable until somebody finds a credential: sign-up cannot finish
 * because the welcome email throws, an invitation cannot be created because the
 * invite email throws. Blocking unrelated work on an unconfigured integration
 * is a bigger outage than the missing mail.
 */
export type EmailStatus =
  | "queued"
  | "sent"
  | "skipped"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed";

/**
 * Whatever the caller wants to correlate the row with later — a plan name, an
 * invitation id, the job that triggered it.
 *
 * jsonb rather than columns because these keys belong to the feature sending
 * the mail, not to the mail. Anything that gets filtered on is promoted to a
 * real column: a jsonb predicate over a high-volume log is a sequential scan.
 */
export type EmailMetadata = Readonly<Record<string, unknown>>;

/**
 * Every message this application decided to send, including the ones it did
 * not actually dispatch.
 *
 * Append-only, so `logIdColumn()` (bigserial) rather than a UUID: nothing
 * references these rows and the volume is the highest of any table here.
 *
 * The log is the only durable record that a send happened. A provider's
 * dashboard shows what the provider received, which by definition excludes the
 * skipped rows and excludes anything that failed before the HTTP call — and
 * those are the two cases somebody is actually debugging when they ask "why
 * didn't the customer get the email".
 */
export const emailEvents = pgTable(
  "email_events",
  {
    id: logIdColumn(),
    /**
     * The provider's own id for the message.
     *
     * Nullable, because it does not exist until the provider has accepted the
     * message: a `queued`, `skipped` or `failed` row has no id and never will.
     * This is the column the delivery webhook joins on, since a bounce
     * notification carries the provider's id and nothing of ours.
     */
    messageId: text("message_id"),
    toAddress: text("to_address").notNull(),
    fromAddress: text("from_address").notNull(),
    subject: text("subject").notNull(),
    /** Which template produced the body, when one did. */
    template: text("template"),
    /**
     * Nullable on purpose. Plenty of mail has no tenant — a password reset for
     * someone who has not joined one yet, an operational alert — and inventing
     * a tenant to satisfy the column would put those rows in somebody's audit
     * trail.
     */
    tenantId: text("tenant_id"),
    /**
     * text, not pgEnum. A value added to a Postgres enum can never be removed,
     * so a status named badly today is permanent; the union type above gives
     * the compile-time check without the one-way door.
     */
    status: text("status").$type<EmailStatus>().notNull(),
    provider: text("provider").notNull().default("resend"),
    /** The provider's rejection message, or the thrown error's message. */
    error: text("error"),
    metadata: jsonb("metadata").$type<EmailMetadata>(),
    createdAt: createdAt(),
    /** Moved by the delivery webhook, which lands minutes after the insert. */
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The per-tenant activity view: "what have we sent this customer". */
    index("email_events_tenant_created_idx").on(t.tenantId, t.createdAt),
    /**
     * The operational query: recent bounces and complaints. Both matter —
     * a bounce rate climbing is how a sending domain gets blocked, and the
     * first sign is always in this table rather than in an alert.
     */
    index("email_events_status_created_idx").on(t.status, t.createdAt),
    /**
     * The delivery webhook's only lookup key. Without it, every bounce
     * notification is a sequential scan of the largest table in the schema,
     * at exactly the moment volume is highest.
     *
     * Not unique: a duplicate provider id must never fail an INSERT into an
     * audit log, because that converts an observability wrinkle into a 500 on
     * the request that was only trying to record what it did.
     */
    index("email_events_message_id_idx").on(t.messageId),
  ],
);

export type EmailEvent = typeof emailEvents.$inferSelect;
export type NewEmailEvent = typeof emailEvents.$inferInsert;

export const emailSchema = { emailEvents };

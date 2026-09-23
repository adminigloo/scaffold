import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { plainTextToEmailHtml } from "./html.js";
import { missingVariables, renderTemplate, type TemplateVars } from "./render.js";
import { commsMessages, commsScheduled, commsTemplates } from "./schema.js";
import { enforceCompliance, normalizePhone, smsComplianceSchema, type SmsCompliance } from "./sms.js";

export * from "./render.js";
export * from "./sms.js";
export * from "./html.js";
export { commsMessages, commsScheduled, commsTemplates } from "./schema.js";

export type CommsDb = PgDatabase<any, any, any>;

export type TemplateRow = typeof commsTemplates.$inferSelect;
export type MessageRow = typeof commsMessages.$inferSelect;
export type ScheduledRow = typeof commsScheduled.$inferSelect;

export type CommsChannel = "email" | "sms";
const channelSchema = z.enum(["email", "sms"]);

export interface OutboundEmail {
  to: string;
  subject: string;
  /** The rendered plain text — send it as the `text` part. */
  body: string;
  /** `body` as escaped HTML (see plainTextToEmailHtml) — send it as the `html` part. */
  html: string;
  /**
   * Stable for one message across every retry and reclaim: the queue row's id
   * for a queued message, the caller's own key for a sendNow that passed one,
   * absent otherwise. Hand it to a provider that deduplicates. Resend takes it
   * as the `Idempotency-Key` header — `resend.emails.send(payload, {
   * idempotencyKey })` — and answers a repeat within 24 hours with the
   * original response instead of sending again. The queue already refuses to
   * re-send a row it has logged as sent; the key covers the last gap, a send
   * whose log write failed as well.
   */
  idempotencyKey?: string;
}
export interface OutboundSms {
  to: string;
  /** Already compliant: starts with the sender name and carries the opt-out line. */
  body: string;
  /**
   * As on OutboundEmail. Twilio's Messages API takes no idempotency key, so for
   * SMS the queue's own already-sent check is the protection; use it for your
   * own dedupe if your provider has one.
   */
  idempotencyKey?: string;
}

/**
 * What a sender may resolve with. Throwing is one way to report a failure but
 * NOT the only one: Resend's SDK resolves `{ data: null, error }` instead of
 * throwing, and @adminigloo/email resolves `{ status: "failed", error }`. A
 * sender that passed either straight through used to be logged `sent` for mail
 * that never left. So a result carrying a truthy `error`, `ok: false` or
 * `status: "failed"` is a failure; `status: "skipped"` is a skip; anything else
 * is a send, with the provider id read from `id`, `messageId`, `sid` or
 * `data.id`.
 */
export type SenderResult =
  | void
  | null
  | undefined
  | {
      id?: string | null;
      messageId?: string | null;
      sid?: string | null;
      data?: { id?: string | null } | null;
      ok?: boolean;
      status?: string;
      error?: unknown;
    };

export type EmailSender = (message: OutboundEmail) => Promise<SenderResult>;
export type SmsSender = (message: OutboundSms) => Promise<SenderResult>;

interface CommsDeliveryConfig {
  email?: EmailSender;
  /**
   * Subject for an email whose template subject renders empty (every
   * placeholder in it was missing). Defaults to DEFAULT_EMAIL_SUBJECT — an
   * email with no subject is the first thing a spam filter drops.
   */
  defaultEmailSubject?: string;
}

/**
 * The senders, injected by the host. Provider-agnostic on purpose: pass a
 * Resend-backed email sender and a Twilio-backed SMS sender, or pass neither.
 * A channel with no sender logs the message as `skipped` rather than throwing —
 * so every feature that sends mail keeps working before the credential exists,
 * the same configuration-not-flags rule @adminigloo/email follows.
 *
 * An `sms` sender REQUIRES `smsCompliance` — a type error without it. Every
 * text then starts with the business name and carries opt-out language (A2P
 * 10DLC / TCPA). Code that gets past the type (plain JS, a cast) is refused at
 * runtime: each SMS is logged `failed` with "sms compliance not configured"
 * and nothing is sent.
 */
export type CommsSenders = CommsDeliveryConfig &
  (
    | { sms?: undefined; smsCompliance?: SmsCompliance }
    | { sms: SmsSender; smsCompliance: SmsCompliance }
  );

export const DEFAULT_EMAIL_SUBJECT = "A message for you";

// --- Templates -------------------------------------------------------------

export const upsertTemplateSchema = z.object({
  tenantId: z.string().min(1).max(200),
  key: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, "lowercase, digits, underscores"),
  channel: channelSchema.default("email"),
  subject: z.string().max(300).nullish(),
  body: z.string().min(1).max(20000),
});
export type UpsertTemplateInput = z.input<typeof upsertTemplateSchema>;

/**
 * An email template needs a subject. A refinement rather than a field rule
 * because it depends on the channel — and exported (the base schema stays a
 * plain object) so a host deriving its own input with
 * `upsertTemplateSchema.omit({ tenantId: true })` applies the same rule via
 * `.superRefine(requireEmailSubject)`.
 */
export function requireEmailSubject(
  value: { channel?: string | undefined; subject?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if ((value.channel ?? "email") === "email" && !value.subject?.trim()) {
    ctx.addIssue({ code: "custom", path: ["subject"], message: "An email template needs a subject" });
  }
}

const upsertTemplateInputSchema = upsertTemplateSchema.superRefine(requireEmailSubject);

export async function upsertTemplate(db: CommsDb, input: UpsertTemplateInput): Promise<TemplateRow> {
  const values = upsertTemplateInputSchema.parse(input);
  const [row] = await db
    .insert(commsTemplates)
    .values({ ...values, subject: values.subject ?? null })
    .onConflictDoUpdate({
      target: [commsTemplates.tenantId, commsTemplates.key],
      // isActive is deliberately NOT here. It used to be forced back to true,
      // so fixing a typo in a template someone had switched off silently
      // switched it back on — and its queued messages started sending again.
      // The switch moves only through setTemplateActive.
      set: {
        channel: values.channel,
        subject: values.subject ?? null,
        body: values.body,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as TemplateRow;
}

const setTemplateActiveSchema = z.object({
  tenantId: z.string().min(1).max(200),
  key: z.string().min(1).max(80),
  active: z.boolean(),
});

/**
 * The kill switch: an inactive template sends nothing — its queued messages
 * end `skipped` and a sendNow logs a skip. Returns false when the tenant has
 * no such template.
 */
export async function setTemplateActive(
  db: CommsDb,
  tenantId: string,
  key: string,
  active: boolean,
): Promise<boolean> {
  const parsed = setTemplateActiveSchema.parse({ tenantId, key, active });
  const rows = (await db
    .update(commsTemplates)
    .set({ isActive: parsed.active, updatedAt: new Date() })
    .where(and(eq(commsTemplates.tenantId, parsed.tenantId), eq(commsTemplates.key, parsed.key)))
    .returning({ id: commsTemplates.id })) as { id: string }[];
  return rows.length > 0;
}

export async function listTemplates(db: CommsDb, tenantId: string): Promise<TemplateRow[]> {
  return (await db
    .select()
    .from(commsTemplates)
    .where(eq(commsTemplates.tenantId, tenantId))
    .orderBy(asc(commsTemplates.key))) as TemplateRow[];
}

export async function getTemplate(db: CommsDb, tenantId: string, key: string): Promise<TemplateRow | null> {
  const [row] = await db
    .select()
    .from(commsTemplates)
    .where(and(eq(commsTemplates.tenantId, tenantId), eq(commsTemplates.key, key)))
    .limit(1);
  return (row as TemplateRow) ?? null;
}

/** Sensible starting templates a business edits, seeded once per tenant. */
export const DEFAULT_TEMPLATES: ReadonlyArray<{ key: string; channel: "email" | "sms"; subject?: string; body: string }> = [
  {
    key: "booking_confirmation",
    channel: "email",
    subject: "Your visit is booked — {{date}}",
    body: "Hi {{name}},\n\nYou're on the calendar for {{date}} at {{time}}. We'll see you at {{address}}.\n\nReply to this email if anything changes.",
  },
  {
    key: "booking_reminder",
    channel: "email",
    subject: "Reminder: your visit is {{date}}",
    body: "Hi {{name}},\n\nJust a reminder that we're scheduled for {{date}} at {{time}}. See you soon!",
  },
  {
    key: "review_request",
    channel: "email",
    subject: "How did we do?",
    body: "Hi {{name}},\n\nThanks for choosing us. If you have a moment, we'd love a quick review: {{reviewUrl}}",
  },
];

export async function seedDefaultTemplates(db: CommsDb, tenantId: string): Promise<number> {
  // Insert-if-absent per (tenant, key) rather than a batch gated on "is the
  // table empty". Two concurrent first-requests on a cold start both saw an
  // empty table and the loser's batch insert threw on the unique key — which,
  // because requestBooking awaits this AFTER creating the booking, rejected the
  // mutation and dropped the customer's confirmation. onConflictDoNothing makes
  // the race a no-op and also backfills a single missing template.
  const inserted = await db
    .insert(commsTemplates)
    .values(
      DEFAULT_TEMPLATES.map((t) => ({
        tenantId,
        key: t.key,
        channel: t.channel,
        subject: t.subject ?? null,
        body: t.body,
      })),
    )
    .onConflictDoNothing({ target: [commsTemplates.tenantId, commsTemplates.key] })
    .returning({ id: commsTemplates.id });
  return (inserted as { id: string }[]).length;
}

// --- Recipients ------------------------------------------------------------

/**
 * The recipient rule per channel. SMS normalises to E.164 (what Twilio
 * requires) and refuses what cannot be a phone number; email must be an
 * address. Applied at enqueue time, so a typo'd number is refused while the
 * customer is still on the form — not discovered by the cron the night before
 * the visit.
 */
export function recipientSchema(channel: CommsChannel) {
  if (channel === "sms") {
    return z.string().transform((to, ctx) => {
      const phone = normalizePhone(to);
      if (!phone) {
        ctx.addIssue({
          code: "custom",
          message: "not a phone number — use E.164 (+18015551234) or a 10-digit US number",
        });
        return z.NEVER;
      }
      return phone;
    });
  }
  return z.string().trim().max(320).email("not an email address");
}

/** A validation failure raised by hand, shaped like the ones zod raises. */
function refuse(path: string, message: string): never {
  throw new z.ZodError([{ code: "custom", path: [path], message, input: undefined }]);
}

// --- Sending ---------------------------------------------------------------

async function logMessage(
  db: CommsDb,
  row: {
    tenantId: string;
    channel: string;
    toAddress: string;
    templateKey: string | null;
    subject: string | null;
    body: string;
    status: string;
    error: string | null;
    providerId: string | null;
    missingVars?: string[] | null;
    /** The queue row this entry is about — how a reclaimed row learns it was already sent. */
    scheduledId?: string | null;
  },
): Promise<MessageRow> {
  const [inserted] = await db
    .insert(commsMessages)
    .values({
      ...row,
      toAddress: row.toAddress.slice(0, 320),
      error: row.error === null ? null : row.error.slice(0, 1000),
      missingVars: row.missingVars && row.missingVars.length > 0 ? row.missingVars : null,
    })
    .returning();
  return inserted as MessageRow;
}

export interface SendInput {
  tenantId: string;
  to: string;
  templateKey: string;
  vars?: TemplateVars;
  /**
   * The channel the caller expects. The queue passes the channel a message was
   * enqueued under: if the template has since been switched (email → SMS), the
   * recipient on the row is the wrong KIND of address, so the send fails as
   * "channel changed" instead of texting an email address.
   */
  channel?: CommsChannel;
  /** Skip (logged) if this template reached this recipient within the window. */
  minIntervalMs?: number;
  /**
   * Handed to the sender as `idempotencyKey` (see OutboundEmail) — e.g.
   * `booking:${id}:confirmation`, so a retried request is not a second email.
   * At most 256 characters, Resend's limit.
   */
  idempotencyKey?: string;
}

/** 400 days — a longer "don't repeat" window than any business message needs. */
const MAX_INTERVAL_MS = 400 * 24 * 60 * 60 * 1000;

const sendInputSchema = z.object({
  tenantId: z.string().min(1).max(200),
  // The recipient's FORMAT is judged per channel once the template is known,
  // and a bad one is logged as a failure, not thrown — see deliver().
  to: z.string(),
  templateKey: z.string().min(1).max(80),
  channel: channelSchema.optional(),
  minIntervalMs: z.number().int().min(0).max(MAX_INTERVAL_MS).optional(),
  idempotencyKey: z.string().trim().min(1).max(256).optional(),
});

/**
 * The provider accepted the message but writing the delivery log then failed.
 * Kept distinct so the queue records the row `sent` instead of retrying it —
 * a retry here would text the customer twice.
 */
class SentButUnloggedError extends Error {
  constructor(cause: unknown) {
    super(`sent, but writing the delivery log failed: ${describeError(cause)}`, { cause });
    this.name = "SentButUnloggedError";
  }
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

type SenderVerdict =
  | { outcome: "sent"; providerId: string | null }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

function interpretSenderResult(result: SenderResult): SenderVerdict {
  const value = result as unknown;
  if (typeof value !== "object" || value === null) return { outcome: "sent", providerId: null };
  const r = value as Exclude<SenderResult, void | null | undefined>;
  if (r.error !== undefined && r.error !== null && r.error !== false) {
    return { outcome: "failed", error: describeError(r.error) };
  }
  if (r.ok === false) return { outcome: "failed", error: "the sender reported the message was not sent" };
  if (r.status === "failed") return { outcome: "failed", error: "the sender reported status failed" };
  if (r.status === "skipped") {
    return { outcome: "skipped", reason: "the sender skipped it (its provider is not configured)" };
  }
  return { outcome: "sent", providerId: r.id ?? r.messageId ?? r.sid ?? r.data?.id ?? null };
}

/**
 * One send decision. `permanent` says whether trying again could ever change
 * the outcome — the queue retries only the failures where it could.
 */
interface Delivery {
  message: MessageRow;
  permanent: boolean;
}

function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

async function deliver(
  db: CommsDb,
  input: SendInput,
  senders: CommsSenders,
  now: Date,
  scheduledId: string | null = null,
): Promise<Delivery> {
  const parsed = sendInputSchema.parse(input);
  const vars = input.vars ?? {};
  const template = await getTemplate(db, parsed.tenantId, parsed.templateKey);

  type LogFields = { toAddress?: string; subject?: string | null; body?: string; providerId?: string | null; missingVars?: string[] };
  const settle = async (status: string, error: string | null, permanent: boolean, fields: LogFields = {}): Promise<Delivery> => ({
    message: await logMessage(db, {
      tenantId: parsed.tenantId,
      channel: template?.channel ?? parsed.channel ?? "email",
      toAddress: parsed.to,
      templateKey: parsed.templateKey,
      subject: null,
      body: "",
      providerId: null,
      ...fields,
      status,
      error,
      scheduledId,
    }),
    permanent,
  });

  if (!template) {
    return settle("failed", `no template "${parsed.templateKey}"`, true);
  }
  if (!template.isActive) {
    return settle("skipped", `template "${parsed.templateKey}" is switched off`, true);
  }
  const channel = template.channel as CommsChannel;
  if (parsed.channel && parsed.channel !== channel) {
    return settle(
      "failed",
      `channel changed: queued as ${parsed.channel}, template "${parsed.templateKey}" is now ${channel}`,
      true,
    );
  }
  const recipient = recipientSchema(channel).safeParse(parsed.to);
  if (!recipient.success) {
    return settle(
      "failed",
      `invalid recipient for ${channel}: ${recipient.error.issues[0]?.message ?? "rejected"}`,
      true,
    );
  }
  const to = recipient.data;

  const missingVars = missingVariables([template.subject, template.body], vars);
  let body = renderTemplate(template.body, vars);
  let subject: string | null = null;
  if (channel === "email") {
    const rendered = template.subject ? renderTemplate(template.subject, vars).trim() : "";
    subject = rendered || senders.defaultEmailSubject?.trim() || DEFAULT_EMAIL_SUBJECT;
  }

  if (channel === "sms") {
    const compliance = smsComplianceSchema.safeParse(senders.smsCompliance);
    if (compliance.success) {
      // Applied even when no sender is wired, so a skipped row shows exactly
      // what WOULD have gone out.
      body = enforceCompliance(body, compliance.data.senderName, compliance.data.optOutText);
    } else if (senders.sms) {
      return settle(
        "failed",
        `sms compliance not configured: ${compliance.error.issues[0]?.message ?? "smsCompliance.senderName is required"}`,
        true,
        { toAddress: to, body, missingVars },
      );
    }
  }

  const rendered: LogFields = { toAddress: to, subject, body, missingVars };

  if (parsed.minIntervalMs) {
    const since = new Date(now.getTime() - parsed.minIntervalMs);
    const [recent] = (await db
      .select({ id: commsMessages.id })
      .from(commsMessages)
      .where(
        and(
          eq(commsMessages.tenantId, parsed.tenantId),
          eq(commsMessages.toAddress, to),
          eq(commsMessages.templateKey, parsed.templateKey),
          eq(commsMessages.status, "sent"),
          gte(commsMessages.createdAt, since),
        ),
      )
      .limit(1)) as { id: string }[];
    if (recent) {
      return settle(
        "skipped",
        `"${parsed.templateKey}" already reached ${to} within the last ${formatInterval(parsed.minIntervalMs)}`,
        true,
        rendered,
      );
    }
  }

  const sender = channel === "sms" ? senders.sms : senders.email;
  if (!sender) {
    return settle("skipped", `no ${channel} provider configured`, true, rendered);
  }

  const key = parsed.idempotencyKey ? { idempotencyKey: parsed.idempotencyKey } : {};
  let verdict: SenderVerdict;
  try {
    verdict = interpretSenderResult(
      channel === "sms"
        ? await senders.sms!({ to, body, ...key })
        : await senders.email!({
            to,
            subject: subject ?? DEFAULT_EMAIL_SUBJECT,
            body,
            html: plainTextToEmailHtml(body),
            ...key,
          }),
    );
  } catch (cause) {
    verdict = { outcome: "failed", error: describeError(cause) };
  }

  if (verdict.outcome === "failed") return settle("failed", verdict.error, false, rendered);
  if (verdict.outcome === "skipped") return settle("skipped", verdict.reason, true, rendered);
  try {
    return await settle("sent", null, true, { ...rendered, providerId: verdict.providerId });
  } catch (cause) {
    throw new SentButUnloggedError(cause);
  }
}

/**
 * Render a template and send it on its channel, logging the outcome. No sender
 * for the channel → logged `skipped`; the sender throws or reports an error →
 * logged `failed`; it returns → logged `sent`. A missing template, an invalid
 * recipient or an SMS sender with no compliance config → logged `failed`; a
 * template that is switched off, or a recipient already reached within
 * `minIntervalMs` → logged `skipped`. Always returns the log row; never throws
 * on a send failure (the caller's flow must not break because a message didn't
 * go out).
 *
 * This is the call for IMMEDIATE messages (a booking confirmation): send it in
 * the request, not via enqueueMessage with sendAt = now — the queue only moves
 * when the cron runs.
 */
export async function sendNow(db: CommsDb, input: SendInput, senders: CommsSenders): Promise<MessageRow> {
  return (await deliver(db, input, senders, new Date())).message;
}

export async function listMessages(db: CommsDb, tenantId: string, limit = 100): Promise<MessageRow[]> {
  return (await db
    .select()
    .from(commsMessages)
    .where(eq(commsMessages.tenantId, tenantId))
    .orderBy(desc(commsMessages.createdAt), desc(commsMessages.id))
    .limit(limit)) as MessageRow[];
}

// --- Scheduling a message for later ----------------------------------------

/**
 * How far in the past a sendAt may be and still be queued. Covers a caller
 * that computed "now" a moment before calling — not a reminder whose moment
 * has genuinely passed.
 */
export const ENQUEUE_PAST_GRACE_MS = 5 * 60 * 1000;

export const enqueueSchema = z.object({
  tenantId: z.string().min(1).max(200),
  to: z.string().trim().min(1).max(320),
  templateKey: z.string().min(1).max(80),
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
  sendAt: z.coerce.date(),
  /** Expected channel: refused if the template's differs; used as-is while the template does not exist yet. */
  channel: channelSchema.optional(),
  /** What the message is about, for cancelScheduled — ("booking", booking.id). Both or neither. */
  refType: z.string().trim().min(1).max(80).optional(),
  refId: z.string().trim().min(1).max(200).optional(),
  /**
   * Idempotency key, unique per tenant. Enqueueing a key that already exists
   * returns the existing row's id and queues nothing. The key is permanent —
   * cancelling does not free it — so the key for something that can move
   * should carry its version: `booking:${id}:reminder:${startsAt}`.
   */
  dedupeKey: z.string().trim().min(1).max(200).optional(),
  /** At send time, skip if this template reached this recipient within the window. */
  minIntervalMs: z.number().int().min(1).max(MAX_INTERVAL_MS).optional(),
  /** Past this, expire instead of sending late. Must be after sendAt. */
  expiresAt: z.coerce.date().optional(),
  /**
   * Default true: a sendAt already in the past (beyond a small grace) queues
   * nothing and returns null — a "24h before" reminder for a visit booked 3h
   * out must not fire the moment the cron next runs.
   */
  skipIfPast: z.boolean().default(true),
});
export type EnqueueInput = z.input<typeof enqueueSchema>;

const enqueueInputSchema = enqueueSchema.superRefine((value, ctx) => {
  if ((value.refType === undefined) !== (value.refId === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: [value.refType === undefined ? "refType" : "refId"],
      message: "refType and refId go together",
    });
  }
  if (value.expiresAt && value.expiresAt.getTime() <= value.sendAt.getTime()) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "expiresAt must be after sendAt" });
  }
});

/**
 * Queue a message. Returns the row id — the EXISTING row's id when `dedupeKey`
 * was already used — or null when nothing was queued because the message
 * could no longer be on time (sendAt past with skipIfPast, or expiresAt
 * already past). Throws a ZodError for invalid input, including a recipient
 * that is not a valid address for the template's channel.
 */
export async function enqueueMessage(db: CommsDb, input: EnqueueInput): Promise<string | null> {
  const parsed = enqueueInputSchema.parse(input);
  const now = Date.now();
  if (parsed.skipIfPast && parsed.sendAt.getTime() < now - ENQUEUE_PAST_GRACE_MS) return null;
  if (parsed.expiresAt && parsed.expiresAt.getTime() <= now) return null;

  const template = await getTemplate(db, parsed.tenantId, parsed.templateKey);
  if (template && parsed.channel && template.channel !== parsed.channel) {
    refuse("channel", `template "${parsed.templateKey}" is ${template.channel}, not ${parsed.channel}`);
  }
  const channel = (template?.channel as CommsChannel | undefined) ?? parsed.channel ?? "email";
  const { to } = z.object({ to: recipientSchema(channel) }).parse({ to: parsed.to });

  const values = {
    tenantId: parsed.tenantId,
    channel,
    toAddress: to,
    templateKey: parsed.templateKey,
    vars: parsed.vars,
    sendAt: parsed.sendAt,
    refType: parsed.refType ?? null,
    refId: parsed.refId ?? null,
    dedupeKey: parsed.dedupeKey ?? null,
    minIntervalMs: parsed.minIntervalMs ?? null,
    expiresAt: parsed.expiresAt ?? null,
  };

  if (!parsed.dedupeKey) {
    const [row] = await db.insert(commsScheduled).values(values).returning({ id: commsScheduled.id });
    return (row as { id: string }).id;
  }

  // The conflict target is the PARTIAL unique index, so its predicate is
  // repeated for Postgres to infer it — unqualified, as an index predicate
  // names bare columns. A conflict inserts nothing and returns nothing; the
  // existing row's id is then read back, which is what makes a retried
  // request idempotent rather than an error.
  const [row] = (await db
    .insert(commsScheduled)
    .values(values)
    .onConflictDoNothing({
      target: [commsScheduled.tenantId, commsScheduled.dedupeKey],
      where: sql`${sql.identifier(commsScheduled.dedupeKey.name)} is not null`,
    })
    .returning({ id: commsScheduled.id })) as { id: string }[];
  if (row) return row.id;
  const [existing] = (await db
    .select({ id: commsScheduled.id })
    .from(commsScheduled)
    .where(and(eq(commsScheduled.tenantId, parsed.tenantId), eq(commsScheduled.dedupeKey, parsed.dedupeKey)))
    .limit(1)) as { id: string }[];
  return existing?.id ?? null;
}

export const cancelScheduledSchema = z.union([
  z.object({ tenantId: z.string().min(1).max(200), id: z.string().min(1).max(200) }).strict(),
  z
    .object({
      tenantId: z.string().min(1).max(200),
      refType: z.string().trim().min(1).max(80),
      refId: z.string().trim().min(1).max(200),
      /** Narrow to one template: cancel the review request, keep the invoice reminder. */
      templateKey: z.string().min(1).max(80).optional(),
    })
    .strict(),
]);
export type CancelScheduledInput = z.input<typeof cancelScheduledSchema>;

/**
 * Cancel queued messages — one by id, or every one about a thing:
 * `{ tenantId, refType: "booking", refId }` when a booking is cancelled or
 * moved. `pending` AND `sending` rows change; a message already sent, failed
 * or expired is history, not a plan. Tenant-scoped, so a guessed id from
 * another tenant cancels nothing. Returns how many were cancelled; the rows
 * stay, marked `cancelled`.
 *
 * Why `sending` too: a claimed row is not necessarily on its way out. A
 * transient failure puts it back to pending and a dead worker's claim is
 * reclaimed — so cancelling only `pending` rows missed exactly those, and the
 * reminder for a cancelled booking went out on the next tick. The worker's
 * outcome write and the reclaim both match only `sending`, so the cancel
 * sticks. A send already in the provider's hands still completes; the delivery
 * log then says so.
 */
export async function cancelScheduled(db: CommsDb, input: CancelScheduledInput): Promise<number> {
  const parsed = cancelScheduledSchema.parse(input);
  const target =
    "id" in parsed
      ? eq(commsScheduled.id, parsed.id)
      : and(
          eq(commsScheduled.refType, parsed.refType),
          eq(commsScheduled.refId, parsed.refId),
          parsed.templateKey ? eq(commsScheduled.templateKey, parsed.templateKey) : undefined,
        );
  const rows = (await db
    .update(commsScheduled)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(commsScheduled.tenantId, parsed.tenantId),
        target,
        inArray(commsScheduled.status, ["pending", "sending"]),
      ),
    )
    .returning({ id: commsScheduled.id })) as { id: string }[];
  return rows.length;
}

/**
 * What a beforeSend hook decides for a claimed row, at send time:
 * - "send": send it as queued.
 * - "skip" / { skip: true, reason }: don't — the row ends `cancelled` and the
 *   log says why ("invoice already paid").
 * - { to?, vars? }: send with fresh values — `to` replaces the recipient and
 *   `vars` are merged over the queued ones (the visit moved, the customer
 *   changed their number since it was queued).
 */
export type BeforeSendResult =
  | "send"
  | "skip"
  | { skip: true; reason?: string }
  | { to?: string; vars?: TemplateVars };

export interface RunDueOptions {
  /** The run's clock. Default: now. */
  now?: Date;
  /** Most rows one run claims. Default 200. */
  limit?: number;
  /** Claims before a transiently-failing row is given up as `failed`. Default 5. */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt (5, 10, 20, 40 min). Default 5 minutes. */
  retryBaseMs?: number;
  /** A `sending` claim older than this belongs to a dead worker and is reclaimed. Default 10 minutes. */
  staleClaimMs?: number;
  /**
   * Stop claiming new rows after this many ms of wall time and leave the rest
   * for the next tick. Set it under the platform's function timeout (Vercel:
   * `maxDuration`) so a big backlog ends the run cleanly instead of the run
   * being killed mid-send.
   */
  timeBudgetMs?: number;
  /**
   * How late a row without an `expiresAt` may still go out, measured from its
   * sendAt. Later than this it ends `expired`, with the reason on the row and
   * in the log. Default 48 hours (DEFAULT_MAX_LATENESS_MS): long enough for a
   * once-a-day cron (Vercel Hobby) to miss a run, short enough that a queue
   * nobody drained for months — a cron never registered, an upgrade from 0.1.x
   * — does not flush every stale "see you tomorrow" at once. A row's own
   * `expiresAt` overrides it.
   */
  maxLatenessMs?: number;
  /**
   * Re-check each claimed row against live data just before it sends. A hook
   * that returns nothing (null/undefined) means "send".
   */
  beforeSend?: (row: ScheduledRow) => BeforeSendResult | Promise<BeforeSendResult>;
}

export interface RunDueResult {
  /** Rows claimed and handled this run. */
  processed: number;
  sent: number;
  skipped: number;
  /**
   * Terminal failures: permanent errors, out of attempts, or a `sending` row
   * left by 0.1.x (state unknown, so failed rather than risk a duplicate).
   */
  failed: number;
  /** Transient failures put back with a later sendAt. */
  retrying: number;
  cancelled: number;
  expired: number;
  /** Stale `sending` rows put back to `pending` before this run claimed anything. */
  reclaimed: number;
  /** True when the limit or the time budget ended the run — due rows may remain. */
  stoppedEarly: boolean;
}

/** See RunDueOptions.maxLatenessMs. */
export const DEFAULT_MAX_LATENESS_MS = 48 * 60 * 60 * 1000;

const runDueOptionsSchema = z.object({
  now: z.date().optional(),
  limit: z.number().int().min(1).max(10_000).default(200),
  maxAttempts: z.number().int().min(1).max(50).default(5),
  retryBaseMs: z.number().int().min(0).max(24 * 60 * 60 * 1000).default(5 * 60 * 1000),
  staleClaimMs: z.number().int().min(60 * 1000).default(10 * 60 * 1000),
  timeBudgetMs: z.number().int().min(0).optional(),
  maxLatenessMs: z.number().int().min(60 * 1000).max(MAX_INTERVAL_MS).default(DEFAULT_MAX_LATENESS_MS),
});

/**
 * Tries for a row's outcome write before it is left in `sending` for the
 * stale-claim reclaim. The reclaim no longer re-sends a row whose send was
 * logged, but a write that lands in-run spares the ten-minute wait and the
 * extra claim.
 */
const OUTCOME_WRITE_TRIES = 3;

type RowOutcome =
  | { status: "sent" | "skipped" | "failed" | "cancelled" | "expired"; lastError: string | null }
  | { status: "retry"; lastError: string };

/**
 * Drain the queue: send every pending message whose time has come.
 *
 * Built so no row can block the rows behind it:
 * - each row is claimed atomically (pending → sending) so overlapping ticks
 *   never send it twice, and its attempt is counted AT the claim;
 * - each row is handled inside its own try/catch, so one that throws cannot
 *   abort the batch or be stranded in `sending`;
 * - a transient failure goes back to `pending` with exponential backoff and,
 *   after `maxAttempts`, ends `failed` — it no longer sits at the head of the
 *   queue being retried every tick while the rows behind it starve;
 * - a permanent failure (no template, bad recipient, SMS compliance not
 *   configured, channel changed) ends `failed` at once;
 * - a `sending` row whose claim is older than `staleClaimMs` (its worker was
 *   killed) is reclaimed at the start of the next run — and before a claimed
 *   row is sent, the delivery log is checked for a `sent` entry from an
 *   earlier claim, so a row whose send landed but whose outcome write did not
 *   is recorded sent, never sent twice;
 * - a row more than `maxLatenessMs` past its sendAt (and no expiresAt of its
 *   own) ends `expired` instead of going out days late.
 *
 * The original positional form `runDueMessages(db, senders, now?, limit?)`
 * still works.
 */
export async function runDueMessages(
  db: CommsDb,
  senders: CommsSenders,
  nowOrOptions: Date | RunDueOptions = {},
  legacyLimit?: number,
): Promise<RunDueResult> {
  const raw: RunDueOptions = nowOrOptions instanceof Date ? { now: nowOrOptions } : nowOrOptions;
  const options = runDueOptionsSchema.parse({
    ...raw,
    ...(legacyLimit !== undefined ? { limit: legacyLimit } : {}),
  });
  const beforeSend = raw.beforeSend;
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  // The run's clock advanced by real elapsed time: claim stamps and retry
  // times stay honest across a long run, and a test pinning `now` stays exact.
  const clock = () => new Date(now.getTime() + elapsed());

  const result: RunDueResult = {
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retrying: 0,
    cancelled: 0,
    expired: 0,
    reclaimed: 0,
    stoppedEarly: false,
  };

  // 1. Rows 0.1.x left in `sending` (claimedAt is NULL: the column did not
  // exist). 0.1.x stranded a row there whenever anything after the claim
  // threw — including the log write AFTER the provider had accepted the
  // message — and its log has no link back to the row to check. Reviving them
  // would re-send reminders, months old, that the customer may already have.
  // Their state is unknown, so they end `failed` saying so, and a person
  // decides.
  const legacy = (await db
    .update(commsScheduled)
    .set({
      status: "failed",
      lastError:
        "state unknown from 0.1.x: left in `sending` before claim times were recorded, possibly already delivered — not re-sent",
    })
    .where(and(eq(commsScheduled.status, "sending"), isNull(commsScheduled.claimedAt)))
    .returning({ id: commsScheduled.id })) as { id: string }[];
  result.failed += legacy.length;

  // 2. Reclaim claims abandoned by a worker that died mid-send (a platform
  // timeout, a crash). Without this a row left in `sending` stays there
  // forever and the message is silently never sent. A reclaimed row that had
  // in fact been sent is caught by the already-sent check in handleClaimed.
  const abandoned = and(
    eq(commsScheduled.status, "sending"),
    lt(commsScheduled.claimedAt, new Date(now.getTime() - options.staleClaimMs)),
  );
  const exhausted = (await db
    .update(commsScheduled)
    .set({ status: "failed", lastError: `abandoned mid-send, out of attempts (${options.maxAttempts})` })
    .where(and(abandoned, gte(commsScheduled.attempts, options.maxAttempts)))
    .returning({ id: commsScheduled.id })) as { id: string }[];
  result.failed += exhausted.length;
  const revived = (await db
    .update(commsScheduled)
    .set({
      status: "pending",
      claimedAt: null,
      lastError: "reclaimed: the worker that claimed it stopped before recording an outcome",
    })
    .where(abandoned)
    .returning({ id: commsScheduled.id })) as { id: string }[];
  result.reclaimed = revived.length;

  // 3. Claim and handle due rows until none are left, the limit is reached or
  // the time budget is spent. Handled rows leave the due set (terminal, or
  // rescheduled into the future), so each select sees new rows; `seen` is the
  // belt-and-braces guard against re-reading one within a run.
  const seen = new Set<string>();
  drain: while (result.processed < options.limit) {
    const due = (await db
      .select()
      .from(commsScheduled)
      .where(and(eq(commsScheduled.status, "pending"), lte(commsScheduled.sendAt, now)))
      .orderBy(asc(commsScheduled.sendAt))
      .limit(options.limit - result.processed)) as ScheduledRow[];
    const fresh = due.filter((row) => !seen.has(row.id));
    if (fresh.length === 0) break;

    for (const row of fresh) {
      seen.add(row.id);
      if (options.timeBudgetMs !== undefined && elapsed() >= options.timeBudgetMs) {
        result.stoppedEarly = true;
        break drain;
      }
      // Claim the row atomically: only the worker that flips pending→sending owns
      // it, so an overlapping cron tick or the admin "Send due now" button can't
      // both grab the same reminder and send it twice. Guarded on `attempts` too,
      // so a row another worker touched since our select is left for next tick
      // rather than claimed with a stale attempt count.
      const attempts = row.attempts + 1;
      const claimed = (await db
        .update(commsScheduled)
        .set({ status: "sending", claimedAt: clock(), attempts })
        .where(
          and(
            eq(commsScheduled.id, row.id),
            eq(commsScheduled.status, "pending"),
            eq(commsScheduled.attempts, row.attempts),
          ),
        )
        .returning({ id: commsScheduled.id })) as { id: string }[];
      if (claimed.length === 0) continue;
      result.processed += 1;

      const outcome = await handleClaimed(
        db,
        { ...row, status: "sending", attempts },
        senders,
        { beforeSend, maxLatenessMs: options.maxLatenessMs },
        clock,
      );
      let patch: Partial<ScheduledRow>;
      if (outcome.status === "retry") {
        if (attempts >= options.maxAttempts) {
          patch = { status: "failed", lastError: `${outcome.lastError} (gave up after ${attempts} attempts)` };
          result.failed += 1;
        } else {
          patch = {
            status: "pending",
            claimedAt: null,
            lastError: outcome.lastError,
            sendAt: new Date(clock().getTime() + options.retryBaseMs * 2 ** (attempts - 1)),
          };
          result.retrying += 1;
        }
      } else {
        patch = { status: outcome.status, lastError: outcome.lastError };
        result[outcome.status] += 1;
      }
      // Guarded on `sending` AND on the attempt count this run claimed with.
      // `sending` alone was not ownership: a run that stalled past
      // staleClaimMs came back to a row another worker had reclaimed, claimed
      // again (attempts + 1) and was mid-send on — and overwrote it, putting
      // it back to pending to be sent yet again. A cancel is left standing too.
      await writeOutcome(
        db,
        patch,
        and(eq(commsScheduled.id, row.id), eq(commsScheduled.status, "sending"), eq(commsScheduled.attempts, attempts)),
      );
    }
  }
  if (result.processed >= options.limit) result.stoppedEarly = true;
  return result;
}

/**
 * Write a row's outcome, retrying a failed write a couple of times in-run. A
 * write that never lands leaves the row `sending` for the stale-claim reclaim —
 * safe now (the already-sent check) but slow. Never throws: one failed write
 * must not abort the rows behind it.
 */
async function writeOutcome(db: CommsDb, patch: Partial<ScheduledRow>, owned: SQL | undefined): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await db.update(commsScheduled).set(patch).where(owned);
      return;
    } catch {
      if (tries >= OUTCOME_WRITE_TRIES) return;
      await new Promise((resolve) => setTimeout(resolve, 50 * tries));
    }
  }
}

/** Everything that happens to one claimed row. Never throws. */
async function handleClaimed(
  db: CommsDb,
  row: ScheduledRow,
  senders: CommsSenders,
  options: { beforeSend: RunDueOptions["beforeSend"]; maxLatenessMs: number },
  clock: () => Date,
): Promise<RowOutcome> {
  const note = (status: string, error: string) =>
    logMessage(db, {
      tenantId: row.tenantId,
      channel: row.channel,
      toAddress: row.toAddress,
      templateKey: row.templateKey,
      subject: null,
      body: "",
      status,
      error,
      providerId: null,
      scheduledId: row.id,
    });
  try {
    // An earlier claim may have sent this row and then failed to record it —
    // the outcome write threw, the row sat in `sending`, the reclaim put it
    // back. The delivery log is the evidence; sending again is a duplicate.
    const [already] = (await db
      .select({ id: commsMessages.id })
      .from(commsMessages)
      .where(and(eq(commsMessages.scheduledId, row.id), eq(commsMessages.status, "sent")))
      .limit(1)) as { id: string }[];
    if (already) {
      return {
        status: "sent",
        lastError: `already sent (delivery log ${already.id}) on an earlier claim whose outcome was not recorded — not sent again`,
      };
    }

    const at = clock().getTime();
    if (row.expiresAt && row.expiresAt.getTime() <= at) {
      const reason = `expired at ${row.expiresAt.toISOString()} before it could send`;
      await note("expired", reason);
      return { status: "expired", lastError: reason };
    }
    if (!row.expiresAt && row.sendAt.getTime() < at - options.maxLatenessMs) {
      const reason = `more than ${formatInterval(options.maxLatenessMs)} late (due ${row.sendAt.toISOString()}) — not sent`;
      await note("expired", reason);
      return { status: "expired", lastError: reason };
    }

    let to = row.toAddress;
    let vars: TemplateVars = row.vars ?? {};
    if (options.beforeSend) {
      // `?? "send"`: a hook returning null (plain JS, a cast, a forgotten
      // return) made `"skip" in decision` throw a TypeError — retried to
      // `failed` for a row the hook meant to send.
      const decision: BeforeSendResult = (await options.beforeSend(row)) ?? "send";
      if (decision === "skip" || (typeof decision === "object" && "skip" in decision && decision.skip)) {
        const reason =
          typeof decision === "object" && "skip" in decision && decision.reason
            ? `cancelled at send time: ${decision.reason}`
            : "cancelled at send time by beforeSend";
        await note("cancelled", reason);
        return { status: "cancelled", lastError: reason };
      }
      if (typeof decision === "object" && !("skip" in decision)) {
        if (decision.to !== undefined) to = decision.to;
        if (decision.vars) vars = { ...vars, ...decision.vars };
      }
    }

    const { message, permanent } = await deliver(
      db,
      {
        tenantId: row.tenantId,
        to,
        templateKey: row.templateKey,
        vars,
        channel: row.channel as CommsChannel,
        ...(row.minIntervalMs ? { minIntervalMs: row.minIntervalMs } : {}),
        // The same key on every retry and reclaim of this row, so a provider
        // that deduplicates (Resend) drops a repeat the queue could not see.
        idempotencyKey: row.id,
      },
      senders,
      clock(),
      row.id,
    );
    if (message.status === "sent") return { status: "sent", lastError: null };
    if (message.status === "skipped") return { status: "skipped", lastError: message.error };
    const error = message.error ?? "send failed";
    return permanent ? { status: "failed", lastError: error } : { status: "retry", lastError: error };
  } catch (error) {
    if (error instanceof SentButUnloggedError) return { status: "sent", lastError: error.message };
    // A validation error fails the same way every time; anything else (a
    // database hiccup, a throwing hook) might not.
    const message = describeError(error).slice(0, 1000);
    return error instanceof z.ZodError
      ? { status: "failed", lastError: message }
      : { status: "retry", lastError: message };
  }
}

import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { z } from "zod";
import { renderTemplate, type TemplateVars } from "./render.js";
import { commsMessages, commsScheduled, commsTemplates } from "./schema.js";

export * from "./render.js";
export { commsMessages, commsScheduled, commsTemplates } from "./schema.js";

export type CommsDb = PgDatabase<any, any, any>;

export type TemplateRow = typeof commsTemplates.$inferSelect;
export type MessageRow = typeof commsMessages.$inferSelect;
export type ScheduledRow = typeof commsScheduled.$inferSelect;

export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
}
export interface OutboundSms {
  to: string;
  body: string;
}

/**
 * The senders, injected by the host. Provider-agnostic on purpose: pass a
 * Resend-backed email sender and a Twilio-backed SMS sender, or pass neither.
 * A channel with no sender logs the message as `skipped` rather than throwing —
 * so every feature that sends mail keeps working before the credential exists,
 * the same configuration-not-flags rule @adminigloo/email follows.
 */
export interface CommsSenders {
  email?: (message: OutboundEmail) => Promise<{ id?: string } | void>;
  sms?: (message: OutboundSms) => Promise<{ id?: string } | void>;
}

// --- Templates -------------------------------------------------------------

export const upsertTemplateSchema = z.object({
  tenantId: z.string().min(1).max(200),
  key: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, "lowercase, digits, underscores"),
  channel: z.enum(["email", "sms"]).default("email"),
  subject: z.string().max(300).nullish(),
  body: z.string().min(1).max(20000),
});
export type UpsertTemplateInput = z.input<typeof upsertTemplateSchema>;

export async function upsertTemplate(db: CommsDb, input: UpsertTemplateInput): Promise<TemplateRow> {
  const values = upsertTemplateSchema.parse(input);
  const [row] = await db
    .insert(commsTemplates)
    .values({ ...values, subject: values.subject ?? null })
    .onConflictDoUpdate({
      target: [commsTemplates.tenantId, commsTemplates.key],
      set: {
        channel: values.channel,
        subject: values.subject ?? null,
        body: values.body,
        isActive: true,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row as TemplateRow;
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
  },
): Promise<MessageRow> {
  const [inserted] = await db.insert(commsMessages).values(row).returning();
  return inserted as MessageRow;
}

export interface SendInput {
  tenantId: string;
  to: string;
  templateKey: string;
  vars?: TemplateVars;
}

/**
 * Render a template and send it on its channel, logging the outcome. No sender
 * for the channel → logged `skipped`; the sender throws → logged `failed`; it
 * returns → logged `sent`. Always returns the log row; never throws on a send
 * failure (the caller's flow must not break because a message didn't go out).
 */
export async function sendNow(
  db: CommsDb,
  input: SendInput,
  senders: CommsSenders,
): Promise<MessageRow> {
  const template = await getTemplate(db, input.tenantId, input.templateKey);
  if (!template || !template.isActive) {
    return logMessage(db, {
      tenantId: input.tenantId,
      channel: "email",
      toAddress: input.to,
      templateKey: input.templateKey,
      subject: null,
      body: "",
      status: "failed",
      error: `no active template "${input.templateKey}"`,
      providerId: null,
    });
  }

  const vars = input.vars ?? {};
  const subject = template.subject ? renderTemplate(template.subject, vars) : null;
  const body = renderTemplate(template.body, vars);
  const channel = template.channel;

  const base = {
    tenantId: input.tenantId,
    channel,
    toAddress: input.to,
    templateKey: input.templateKey,
    subject,
    body,
  };

  const sender = channel === "sms" ? senders.sms : senders.email;
  if (!sender) {
    return logMessage(db, { ...base, status: "skipped", error: null, providerId: null });
  }

  try {
    const result =
      channel === "sms"
        ? await senders.sms!({ to: input.to, body })
        : await senders.email!({ to: input.to, subject: subject ?? "", body });
    return logMessage(db, {
      ...base,
      status: "sent",
      error: null,
      providerId: (result && "id" in result ? result.id : undefined) ?? null,
    });
  } catch (cause) {
    return logMessage(db, {
      ...base,
      status: "failed",
      error: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000),
      providerId: null,
    });
  }
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

export const enqueueSchema = z.object({
  tenantId: z.string().min(1),
  to: z.string().min(1).max(320),
  templateKey: z.string().min(1).max(80),
  vars: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
  sendAt: z.coerce.date(),
});

export async function enqueueMessage(db: CommsDb, input: z.input<typeof enqueueSchema>): Promise<string> {
  const parsed = enqueueSchema.parse(input);
  const template = await getTemplate(db, parsed.tenantId, parsed.templateKey);
  const [row] = await db
    .insert(commsScheduled)
    .values({
      tenantId: parsed.tenantId,
      channel: template?.channel ?? "email",
      toAddress: parsed.to,
      templateKey: parsed.templateKey,
      vars: parsed.vars,
      sendAt: parsed.sendAt,
    })
    .returning({ id: commsScheduled.id });
  return (row as { id: string }).id;
}

/**
 * Drain the queue: send every pending message whose time has come. Idempotent
 * enough for a cron — each row flips to `sent` as it goes, so a re-run only
 * catches what's newly due. Returns how many it sent.
 */
export async function runDueMessages(
  db: CommsDb,
  senders: CommsSenders,
  now: Date = new Date(),
  limit = 200,
): Promise<{ processed: number }> {
  const due = (await db
    .select()
    .from(commsScheduled)
    .where(and(eq(commsScheduled.status, "pending"), lte(commsScheduled.sendAt, now)))
    .orderBy(asc(commsScheduled.sendAt))
    .limit(limit)) as ScheduledRow[];

  let processed = 0;
  for (const row of due) {
    // Claim the row atomically: only the worker that flips pending→sending owns
    // it, so an overlapping cron tick or the admin "Send due now" button can't
    // both grab the same reminder and send it twice.
    const claimed = await db
      .update(commsScheduled)
      .set({ status: "sending" })
      .where(and(eq(commsScheduled.id, row.id), eq(commsScheduled.status, "pending")))
      .returning({ id: commsScheduled.id });
    if ((claimed as { id: string }[]).length === 0) continue;

    const sent = await sendNow(
      db,
      { tenantId: row.tenantId, to: row.toAddress, templateKey: row.templateKey, vars: row.vars },
      senders,
    );
    // Reflect the REAL outcome instead of always claiming "sent": a provider
    // failure returns to "pending" so the next tick retries it (a reminder must
    // not be silently lost); "sent"/"skipped" are terminal.
    await db
      .update(commsScheduled)
      .set({ status: sent.status === "failed" ? "pending" : "sent" })
      .where(eq(commsScheduled.id, row.id));
    processed += 1;
  }
  return { processed };
}

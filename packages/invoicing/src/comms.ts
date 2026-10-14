import { commsMessages, commsTemplates, sendNow, type CommsDb, type CommsSenders } from "@adminigloo/comms";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { formatDueDate, formatMoney, resolveInvoicingBusiness, type InvoicingBusiness, type ResolvedInvoicingBusiness } from "./business.js";
import { getInvoice, type InvoicingDb } from "./index.js";

/**
 * `@adminigloo/invoicing/comms` — the invoice email (Tenancy 2a, 10.6).
 *
 * The only module in this package that imports @adminigloo/comms (an
 * OPTIONAL peer), so an app that never emails invoices needs no comms.
 *
 *   const invoicingComms = createInvoicingComms({ db, senders, invoiceUrl, business });
 *   createInvoicingAdminHandlers({ …, sendInvoiceEmail: invoicingComms.sendInvoice });
 *
 * The email goes out through comms' `sendNow`, so it carries the company's
 * name and reply-to (comms' `identity` seam, D8), lands in the company's
 * delivery log, and can be reworded in Messages like every other email.
 *
 * THE LINK IS A KEY. An invoice's `view_token` never changes, so the link in
 * the email is replaced with ":token" in the delivery log right after the
 * send, the way scheduling scrubs manage links: the log is readable by
 * everyone with Messages access, and a working key to every invoice must not
 * sit there.
 */

export const INVOICING_COMMS_REF_TYPE = "invoice";

export type InvoiceTemplateKey = "invoice_sent";

/**
 * The default email, plain text with `{{variables}}`. Inserted once per
 * tenant if absent (`ensureTemplates`), never over an owner's edit. A line
 * that is only a variable (`{{paymentInstructions}}`) may render empty; the
 * HTML part folds the blank paragraph away.
 */
export const INVOICE_EMAIL_TEMPLATES: ReadonlyArray<{ key: InvoiceTemplateKey; subject: string; body: string }> = Object.freeze([
  {
    key: "invoice_sent",
    subject: "Invoice {{invoiceNumber}} from {{businessName}}",
    body: [
      "Hi {{customerName}},",
      "",
      "Here's invoice {{invoiceNumber}} for {{total}}{{dueLine}}.",
      "",
      "See it here: {{invoiceUrl}}",
      "",
      "{{paymentInstructions}}",
      "",
      "Questions? Just reply to this email{{phoneLine}}.",
      "",
      "{{businessName}}",
    ].join("\n"),
  },
]);

export type InvoiceEmailStatus = "sent" | "skipped" | "failed" | "no-email";

export interface InvoicingCommsOptions {
  /** The comms tables live in the same database. */
  db: InvoicingDb;
  senders: CommsSenders;
  /** The customer's page for a token (absolute). */
  invoiceUrl: (token: string, tenantId: string) => string | Promise<string>;
  business?: (tenantId: string) => InvoicingBusiness | null | Promise<InvoicingBusiness | null>;
  /** How long a send may hold the request; default 10000, as scheduling's. A late send finishes in the background. */
  sendTimeoutMs?: number;
  onError?: (error: unknown, context: { invoiceId: string; step: string }) => void;
}

export interface InvoicingComms {
  /** For the admin handlers' sendInvoiceEmail. Never throws. */
  sendInvoice(input: { readonly tenantId: string; readonly invoiceId: string; readonly userId: string | null }): Promise<{
    readonly status: InvoiceEmailStatus;
    readonly message: string;
  }>;
  /** Insert the template for a tenant if absent; how many were added. */
  ensureTemplates(tenantId: string): Promise<number>;
  /** After a drain, and right after each send: replace invoice tokens in the delivery log with ":token". */
  redactSent(): Promise<number>;
}

/**
 * An invoice token as it appears in a link: "inv_" and 36 hex characters,
 * alone. CONTRACT: 10.6 describes the sweep's shape as "43+ characters", which
 * is scheduling's manage-token shape; invoicing's own tokens are this one
 * (src/index.ts randomToken), so the sweep matches what invoicing mints.
 */
const TOKEN_IN_TEXT = "(?<![A-Za-z0-9_-])inv_[0-9a-f]{36}(?![A-Za-z0-9_-])";
/** How far back `redactSent` sweeps the log for a link a crashed send left behind. */
const SWEEP_DAYS = 14;

const MESSAGES: Readonly<Record<InvoiceEmailStatus, (email: string | null) => string>> = {
  sent: (email) => (email ? `Emailed to ${email}.` : "Emailed to the customer."),
  "no-email": () => "This invoice has no customer email. Copy the link and send it yourself.",
  skipped: () => "This site doesn't send email yet. Copy the link and send it yourself.",
  failed: () => "The email didn't go. Copy the link and send it yourself, or try again.",
};

/** What the owner reads when the site's per-company sending allowance held the email back. */
export const HELD_MESSAGE =
  "Your company has sent as many emails as this site allows for now, so this one didn't go. Copy the link and send it yourself, or try again later.";

/** Postgres regex for "this invoice number, not a longer one that starts with it". */
function numberPattern(invoiceNumber: string): string {
  return `${invoiceNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`;
}

export function createInvoicingComms(options: InvoicingCommsOptions): InvoicingComms {
  const db = options.db as unknown as CommsDb;
  const timeoutMs = options.sendTimeoutMs ?? 10_000;
  const report = (error: unknown, context: { invoiceId: string; step: string }) => {
    try {
      if (options.onError) options.onError(error, context);
      else console.error("[@adminigloo/invoicing/comms] an invoice email step failed", context, error);
    } catch {
      /* a broken reporter must not break the send */
    }
  };
  /** A send that may take no longer than `timeoutMs`; a late one finishes in the background. */
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    if (!(timeoutMs > 0)) return work;
    work.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the invoice email took longer than ${timeoutMs} ms; left to finish in the background`)), timeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  async function ensureTemplates(tenantId: string): Promise<number> {
    const added = (await db
      .insert(commsTemplates)
      .values(INVOICE_EMAIL_TEMPLATES.map((t) => ({ tenantId, key: t.key, channel: "email", subject: t.subject, body: t.body })))
      .onConflictDoNothing({ target: [commsTemplates.tenantId, commsTemplates.key] })
      .returning({ id: commsTemplates.id })) as Array<{ id: string }>;
    return added.length;
  }

  async function businessFor(tenantId: string, invoiceId: string): Promise<ResolvedInvoicingBusiness> {
    try {
      return resolveInvoicingBusiness(options.business ? await options.business(tenantId) : null);
    } catch (error) {
      report(error, { invoiceId, step: "business" });
      return resolveInvoicingBusiness(null);
    }
  }

  async function redactToken(tenantId: string, messageId: string, token: string): Promise<void> {
    await db
      .update(commsMessages)
      .set({
        subject: sql`replace(${commsMessages.subject}, ${token}, ':token')`,
        body: sql`replace(${commsMessages.body}, ${token}, ':token')`,
      })
      .where(and(eq(commsMessages.tenantId, tenantId), eq(commsMessages.id, messageId)));
  }

  async function sendInvoice(input: { readonly tenantId: string; readonly invoiceId: string; readonly userId: string | null }) {
    const { tenantId, invoiceId } = input;
    try {
      const detail = await getInvoice(options.db, tenantId, invoiceId);
      if (!detail) return { status: "failed" as const, message: "That invoice isn't here." };
      const inv = detail.invoice;
      // No address, nothing to send and nothing to log.
      if (!inv.customerEmail || inv.customerEmail.trim() === "") return { status: "no-email" as const, message: MESSAGES["no-email"](null) };
      await ensureTemplates(tenantId);
      const business = await businessFor(tenantId, invoiceId);

      let url: string | null = null;
      try {
        url = await options.invoiceUrl(inv.viewToken, tenantId);
      } catch (error) {
        report(error, { invoiceId, step: "links" });
      }
      const vars = invoiceEmailVars(inv, business, url);

      // How many invoice_sent emails this invoice already has in the log: the
      // idempotency key's last part. A double click asks before either send
      // is logged, so both carry the same key and the provider drops the
      // second; a deliberate resend later counts one more, and goes.
      // CONTRACT: the delivery log has no reference to an invoice, so its rows
      // are counted by the invoice number in their subject or body (the
      // template carries it in both; a number is unique per company).
      const pattern = numberPattern(inv.invoiceNumber);
      const [counted] = (await db
        .select({ n: count() })
        .from(commsMessages)
        .where(
          and(
            eq(commsMessages.tenantId, tenantId),
            eq(commsMessages.templateKey, "invoice_sent"),
            eq(commsMessages.status, "sent"),
            sql`(${commsMessages.body} ~ ${pattern} or coalesce(${commsMessages.subject}, '') ~ ${pattern})`,
          ),
        )) as Array<{ n: number }>;
      const sentCount = Number(counted?.n ?? 0);

      const message = await bounded(
        sendNow(
          db,
          {
            tenantId,
            to: inv.customerEmail,
            templateKey: "invoice_sent",
            vars,
            idempotencyKey: `invoice:${inv.id}:sent:${sentCount}`,
          },
          options.senders,
        ),
      );
      try {
        await redactToken(tenantId, message.id, inv.viewToken);
      } catch (error) {
        // The sweep in redactSent() catches it later.
        report(error, { invoiceId, step: "redact" });
      }
      const status: InvoiceEmailStatus = message.status === "sent" ? "sent" : message.status === "skipped" ? "skipped" : "failed";
      // Held by the company's sending allowance (comms 0.3, review
      // SEC-2A-03): not a broken email — say so, so the owner waits rather
      // than pressing Send again and again.
      if (status === "failed" && typeof message.error === "string" && message.error.startsWith("held:")) {
        return { status, message: HELD_MESSAGE };
      }
      if (status === "failed") report(new Error(message.error ?? "the invoice email failed"), { invoiceId, step: "send" });
      return { status, message: MESSAGES[status](message.toAddress) };
    } catch (error) {
      report(error, { invoiceId, step: "send" });
      return { status: "failed" as const, message: MESSAGES.failed(null) };
    }
  }

  /**
   * Sweep the last two weeks of invoice emails for anything shaped like an
   * invoice token and replace it with ":token". `sendInvoice` already scrubs
   * its own row right after sending; this catches a send that finished after
   * the request stopped waiting, or a process that died in between.
   */
  async function redactSent(): Promise<number> {
    try {
      const swept = (await db
        .update(commsMessages)
        .set({
          subject: sql`regexp_replace(${commsMessages.subject}, ${TOKEN_IN_TEXT}, ':token', 'g')`,
          body: sql`regexp_replace(${commsMessages.body}, ${TOKEN_IN_TEXT}, ':token', 'g')`,
        })
        .where(
          and(
            eq(commsMessages.templateKey, "invoice_sent"),
            gt(commsMessages.createdAt, sql`now() - make_interval(days => ${SWEEP_DAYS}::int)`),
            sql`(${commsMessages.body} ~ ${TOKEN_IN_TEXT} or coalesce(${commsMessages.subject}, '') ~ ${TOKEN_IN_TEXT})`,
          ),
        )
        .returning({ id: commsMessages.id })) as Array<{ id: string }>;
      return swept.length;
    } catch (error) {
      report(error, { invoiceId: "", step: "redact-sweep" });
      return 0;
    }
  }

  return { sendInvoice, ensureTemplates, redactSent };
}

/**
 * The email's variables, worked out by code (the AI rule: code does the
 * maths): the total in the business's currency and locale, the due date in
 * its zone, and the optional pieces as whole phrases that are empty when
 * there's nothing to say.
 */
export function invoiceEmailVars(
  inv: { invoiceNumber: string; customerName: string | null; total: number; dueDate: Date | null },
  business: ResolvedInvoicingBusiness,
  invoiceUrl: string | null,
): Record<string, string> {
  const name = inv.customerName?.trim();
  return {
    invoiceNumber: inv.invoiceNumber,
    businessName: business.name,
    customerName: name ? name : "there",
    total: formatMoney(inv.total, business),
    dueLine: inv.dueDate ? `, due ${formatDueDate(inv.dueDate, business)}` : "",
    invoiceUrl: invoiceUrl ?? "",
    paymentInstructions: business.paymentInstructions ?? "",
    phoneLine: business.contactPhone ? ` or call ${business.contactPhone}` : "",
  };
}

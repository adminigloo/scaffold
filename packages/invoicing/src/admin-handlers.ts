import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  invoiceDueInstant,
  isCalendarDate,
  moneyFormatOf,
  resolveInvoicingBusiness,
  type InvoicingBusiness,
  type ResolvedInvoicingBusiness,
} from "./business.js";
import { emitInvoicingEvent, type InvoicingEventOptions } from "./events.js";
import {
  CROSS_SITE_MESSAGE,
  FORBIDDEN_MESSAGE,
  INVOICE_NOT_HERE,
  InvoicingHttpError,
  failure,
  isCrossSiteRequest,
  isExpected,
  json,
  readJsonBody,
  segmentsAfter,
} from "./http.js";
import {
  addInvoiceItem,
  createInvoice,
  getInvoice,
  invoiceCursor,
  isInvoiceEditable,
  isOverdue,
  listInvoices,
  nextInvoiceStatuses,
  outstandingBalance,
  recordPayment,
  removeInvoiceItem,
  reversePayment,
  setInvoiceStatus,
  updateInvoiceItem,
  type InvoiceDetail,
  type InvoiceRow,
  type InvoicingDb,
} from "./index.js";
import { INVOICE_LIST_STATUSES, PAYMENT_METHODS } from "./constants.js";
import {
  depositRuleOf,
  expireOpenCheckouts,
  invoiceDeposit,
  listCardAlerts,
  resolveCardAlert,
  setInvoiceDeposit,
  stripePaymentUrl,
  type CardAlertRow,
  type InvoiceCardPayments,
} from "./online.js";
import type { InvoiceStatus } from "./money.js";
import type { InvoicingPermission } from "./permissions.js";
import { INVOICING_ADMIN_ROUTE_PERMISSIONS, type InvoicingAdminRouteKind } from "./routes.js";
import { invoiceItems, invoicePayments, invoices } from "./schema.js";
import type {
  CardAlertWire,
  CardAlertsWire,
  InvoiceDetailWire,
  InvoiceLinkWire,
  InvoiceListWire,
  InvoicePaymentWire,
  InvoiceResponse,
  InvoiceStatusWire,
  InvoiceSummaryWire,
  InvoicingStatusWire,
  PaymentFlagWire,
  PaymentMethodWire,
  SendResponse,
  SettableInvoiceStatusWire,
  StoredInvoiceStatusWire,
} from "./wire.js";

/**
 * The staff HTTP surface (Tenancy 2a, D3, 10.5): what `<InvoicesLedger>` and
 * `<InvoiceEditor>` speak, every route under `{base}/v1/admin/`.
 *
 *   // app/api/app/[tenantId]/invoices/[...path]/route.ts
 *   const { handle } = createInvoicingAdminHandlers({ db, resolveTenant, authorize, invoiceUrl, business });
 *   export { handle as GET, handle as POST };
 *
 * Before 2a the ledger was a tRPC router and a page copied into each project,
 * pinned to one fixed business. Now it is package code in both modes: a fix
 * reaches every project by `npm update`, and the company it serves is the
 * one the request names.
 *
 * EVERY ROUTE ASKS `authorize(req, permission, tenantId)` for exactly one key
 * (INVOICING_ADMIN_ROUTE_PERMISSIONS): a `Response` is returned as it is,
 * `false` is 403, `true` or `{ userId }` passes (and `userId` is who
 * recorded a payment or raised an invoice). NEVER CROSS-ORIGIN.
 *
 * Totals are always the package's: the widget sends lines, a tax rate and a
 * discount, never a figure it worked out, and every answer is re-read from
 * the database after the write.
 */

export type InvoicingAuthorizeResult = boolean | { userId?: string | number | null } | Response;

/** Is email really leaving, and if not, why. */
export interface InvoicingDelivery {
  readonly emails: boolean;
  readonly emailsOffReason: string | null;
}

export type InvoiceEmailDelivery = "sent" | "skipped" | "failed" | "no-email";

export interface CreateInvoicingAdminHandlersOptions extends InvoicingEventOptions {
  db: InvoicingDb;
  /** A fixed tenant (a single business). Pass this or `resolveTenant`. */
  tenantId?: string;
  resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  authorize: (req: Request, permission: InvoicingPermission, tenantId: string) => InvoicingAuthorizeResult | Promise<InvoicingAuthorizeResult>;
  /** The business on the invoice (10.4). A throw is reported and treated as null for that request. */
  business?: (tenantId: string) => InvoicingBusiness | null | Promise<InvoicingBusiness | null>;
  /** The customer's page for a token (absolute). Required: the ledger's "Copy link" and the email both use it. */
  invoiceUrl: (token: string, tenantId: string) => string | Promise<string>;
  /** Emails the invoice (the ./comms sender, 10.6). Absent → "Send" marks it sent and says to copy the link. */
  sendInvoiceEmail?: (input: { readonly tenantId: string; readonly invoiceId: string; readonly userId: string | null }) => Promise<{
    readonly status: InvoiceEmailDelivery;
    readonly message: string;
  }>;
  delivery?: (tenantId: string) => InvoicingDelivery | Promise<InvoicingDelivery>;
  /** Where the owner fills in invoice details (the checklist and the status notice link here). */
  detailsHref?: string | null;
  /** invoicing 0.5: card payments. Voiding an invoice expires its open Stripe Checkout Sessions through it. */
  payments?: InvoiceCardPayments;
  onError?: (error: unknown, context: { tenantId: string | null; route: string }) => void;
  now?: () => Date;
}

export interface InvoicingAdminHandlers {
  handle: (req: Request) => Promise<Response>;
}

interface Matched {
  kind: InvoicingAdminRouteKind;
  id?: string;
}

/** The routes a path names, by method; null for an unknown path. */
function route(pathname: string): Partial<Record<"GET" | "POST", Matched>> | null {
  const parts = segmentsAfter(pathname, "/v1/admin/");
  if (!parts) return null;
  const [head, id, action] = parts;
  const one = (method: "GET" | "POST", kind: InvoicingAdminRouteKind, withId = false) => ({
    [method]: withId ? { kind, id: id as string } : { kind },
  });
  switch (head) {
    case "status":
      return parts.length === 1 ? one("GET", "status") : null;
    case "invoices":
      if (parts.length === 1) return { GET: { kind: "list" }, POST: { kind: "create" } };
      if (parts.length === 2) return one("GET", "get", true);
      if (parts.length === 3) {
        if (action === "items") return one("POST", "item-add", true);
        if (action === "status") return one("POST", "status-set", true);
        if (action === "send") return one("POST", "send", true);
        if (action === "link") return one("GET", "link", true);
        if (action === "payments") return one("POST", "payment-record", true);
        if (action === "deposit") return one("POST", "deposit", true);
      }
      return null;
    case "items":
      if (parts.length === 2) return one("POST", "item-update", true);
      if (parts.length === 3 && action === "remove") return one("POST", "item-remove", true);
      return null;
    case "payments":
      return parts.length === 3 && action === "reverse" ? one("POST", "payment-reverse", true) : null;
    case "attention":
      if (parts.length === 1) return one("GET", "attention");
      return parts.length === 3 && action === "resolve" ? one("POST", "attention-resolve", true) : null;
    default:
      return null;
  }
}

// --- Bodies (wire names, so issue paths are the widget's field names) ---------

const blankToNull = (value: unknown) => (typeof value === "string" && value.trim() === "" ? null : value);
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());
const cents = z.number().int("Use whole cents.").min(0, "Can't be negative.").max(1_000_000_000_00, "That's too much for one invoice.");

const lineSchema = z.object({
  description: z.string().trim().min(1, "Describe the work.").max(500, "Keep it under 500 characters."),
  quantity: z.number().int("Use a whole number.").min(1, "At least 1.").max(100_000, "That's too many."),
  unitPrice: cents,
});

const createBodySchema = z.object({
  customerName: z.string().trim().min(1, "Who is this invoice for?").max(200, "Keep the name under 200 characters."),
  customerEmail: z.preprocess(blankToNull, z.string().trim().max(320).email("Enter an email address.").nullable().optional()),
  customerPhone: optionalText(60),
  billingAddress: optionalText(500),
  taxRateBp: z.number().int("Use a whole number of basis points.").min(0, "Can't be negative.").max(1_000_000).optional(),
  discount: cents.optional(),
  dueDate: z.preprocess(
    blankToNull,
    z.string().refine(isCalendarDate, "Use a date like 2026-11-02.").nullable().optional(),
  ),
  notes: optionalText(2000),
  items: z.array(lineSchema).min(1, "Add at least one line.").max(200, "Up to 200 lines."),
});
const itemPatchSchema = z
  .object({
    description: lineSchema.shape.description.optional(),
    quantity: lineSchema.shape.quantity.optional(),
    unitPrice: cents.optional(),
  })
  .refine((v) => v.description !== undefined || v.quantity !== undefined || v.unitPrice !== undefined, {
    message: "Change at least one thing.",
    path: ["description"],
  });
const statusBodySchema = z.object({ status: z.enum(["draft", "sent", "viewed", "void"]) });
const paymentBodySchema = z.object({
  amount: z.number().int("Use whole cents.").min(1, "Enter an amount.").max(1_000_000_000_00),
  method: z.enum(PAYMENT_METHODS),
  reference: optionalText(200),
});
const depositBodySchema = z.discriminatedUnion("rule", [
  z.object({ rule: z.literal("default") }),
  z.object({ rule: z.literal("none") }),
  z.object({ rule: z.literal("percent"), percentBp: z.number().int("Use a whole number.").min(1, "At least 0.01%.").max(10_000, "At most 100%.") }),
  z.object({ rule: z.literal("amount"), amount: z.number().int("Use whole cents.").min(1, "Enter an amount.").max(1_000_000_000_00) }),
]);
const reverseBodySchema = z.object({
  reason: z.string().trim().min(1, "Say why this payment is being reversed.").max(500, "Keep it under 500 characters."),
});
const listQuerySchema = z.object({
  status: z.enum(INVOICE_LIST_STATUSES).optional(),
  cursor: z.string().max(300).optional(),
});

/** 50 a page (10.5). */
const PAGE_SIZE = 50;

const SEND_MESSAGES: Readonly<Record<InvoiceEmailDelivery, (email: string | null) => string>> = {
  sent: (email) => (email ? `Emailed to ${email}.` : "Emailed to the customer."),
  "no-email": () => "This invoice has no customer email. Copy the link and send it yourself.",
  skipped: () => "This site doesn't send email yet. Copy the link and send it yourself.",
  failed: () => "The email didn't go. Copy the link and send it yourself, or try again.",
};

function displayStatus(row: Pick<InvoiceRow, "status" | "dueDate">, now: Date): InvoiceStatusWire {
  return isOverdue(row.status as InvoiceStatus, row.dueDate, now) ? "overdue" : (row.status as InvoiceStatusWire);
}

function summaryWire(row: InvoiceRow, now: Date): InvoiceSummaryWire {
  return {
    id: row.id,
    number: row.invoiceNumber,
    status: displayStatus(row, now),
    customerName: row.customerName ?? null,
    total: row.total,
    amountPaid: row.amountPaid,
    balanceDue: outstandingBalance(row),
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

const FLAGS: readonly string[] = ["disputed", "dispute_lost"];

function detailWire(detail: InvoiceDetail, can: InvoiceDetailWire["can"], now: Date, business: Pick<ResolvedInvoicingBusiness, "depositPercent" | "currency">): InvoiceDetailWire {
  const inv = detail.invoice;
  const defaultDepositPercent = business.depositPercent;
  // A payment is "reversed" once its reversals (0.5: a part refund is one) add up to all of it.
  const reversedBy = new Map<string, number>();
  for (const p of detail.payments) if (p.reversesPaymentId) reversedBy.set(p.reversesPaymentId, (reversedBy.get(p.reversesPaymentId) ?? 0) - p.amount);
  // "Reversed" is all of it — a full refund, or a lost dispute; anything less is "Partly refunded $X".
  const reversed = new Set(
    detail.payments.filter((p) => !p.reversesPaymentId && ((reversedBy.get(p.id) ?? 0) >= p.amount || p.flag === "dispute_lost")).map((p) => p.id),
  );
  const payments: InvoicePaymentWire[] = detail.payments.map((p) => ({
    id: p.id,
    amount: p.amount,
    method: (PAYMENT_METHODS as readonly string[]).includes(p.method) ? (p.method as PaymentMethodWire) : "other",
    reference: p.reference ?? null,
    paidAt: p.paidAt.toISOString(),
    reversesPaymentId: p.reversesPaymentId ?? null,
    reversed: reversed.has(p.id),
    reason: p.reason ?? null,
    flag: p.flag && FLAGS.includes(p.flag) ? (p.flag as PaymentFlagWire) : null,
    reversedAmount: p.reversesPaymentId ? 0 : (reversedBy.get(p.id) ?? 0),
  }));
  const rule = depositRuleOf(inv);
  return {
    id: inv.id,
    number: inv.invoiceNumber,
    status: displayStatus(inv, now),
    storedStatus: inv.status as StoredInvoiceStatusWire,
    customerName: inv.customerName ?? null,
    customerEmail: inv.customerEmail ?? null,
    customerPhone: inv.customerPhone ?? null,
    billingAddress: inv.billingAddress ?? null,
    subtotal: inv.subtotal,
    discount: inv.discount,
    taxRateBp: inv.taxRateBp,
    taxAmount: inv.taxAmount,
    total: inv.total,
    amountPaid: inv.amountPaid,
    balanceDue: outstandingBalance(inv),
    overpaid: Math.max(0, inv.amountPaid - inv.total),
    dueDate: inv.dueDate ? inv.dueDate.toISOString() : null,
    notes: inv.notes ?? null,
    fromEstimate: Boolean(inv.estimateId),
    sentAt: inv.sentAt ? inv.sentAt.toISOString() : null,
    viewedAt: inv.viewedAt ? inv.viewedAt.toISOString() : null,
    paidAt: inv.paidAt ? inv.paidAt.toISOString() : null,
    createdAt: inv.createdAt.toISOString(),
    lines: detail.items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: item.total,
    })),
    payments,
    editable: isInvoiceEditable(inv.status),
    nextStatuses: [...nextInvoiceStatuses(inv.status)] as SettableInvoiceStatusWire[],
    can,
    deposit: {
      rule: rule.rule,
      percentBp: rule.rule === "percent" ? rule.percentBp : null,
      fixedAmount: rule.rule === "amount" ? rule.amount : null,
      amount: invoiceDeposit(inv, business),
      defaultPercent: defaultDepositPercent,
      editable: inv.status !== "void" && inv.status !== "paid" && inv.amountPaid === 0,
    },
  };
}

function cardAlertWire(row: CardAlertRow): CardAlertWire {
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    amount: row.amount ?? null,
    currency: row.currency ?? null,
    invoiceId: row.invoiceId ?? null,
    stripeUrl: stripePaymentUrl(row.paymentIntentId ?? null),
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/** `url` plus `preview=1`, keeping any query the host's link already has. */
function previewOf(url: string): string {
  const hash = url.indexOf("#");
  const base = hash >= 0 ? url.slice(0, hash) : url;
  const fragment = hash >= 0 ? url.slice(hash) : "";
  return `${base}${base.includes("?") ? "&" : "?"}preview=1${fragment}`;
}

export function createInvoicingAdminHandlers(options: CreateInvoicingAdminHandlersOptions): InvoicingAdminHandlers {
  if (!options.tenantId && !options.resolveTenant) {
    throw new Error("createInvoicingAdminHandlers: pass tenantId or resolveTenant");
  }
  if (typeof options.authorize !== "function") {
    throw new Error("createInvoicingAdminHandlers: pass authorize (your permission check)");
  }
  if (typeof options.invoiceUrl !== "function") {
    throw new Error("createInvoicingAdminHandlers: pass invoiceUrl (the customer's page for a token)");
  }
  const clock = () => options.now?.() ?? new Date();
  const notFound = () => new InvoicingHttpError("not_found", 404, INVOICE_NOT_HERE);
  const report = (error: unknown, tenantId: string | null, kind: string) => {
    try {
      options.onError?.(error, { tenantId, route: kind });
    } catch {
      /* a broken reporter must not turn an answer into a crash */
    }
  };

  async function businessFor(tenantId: string, kind: string): Promise<ResolvedInvoicingBusiness> {
    if (!options.business) return resolveInvoicingBusiness(null);
    try {
      return resolveInvoicingBusiness(await options.business(tenantId));
    } catch (error) {
      // 3.2: a throwing seam is reported and read as "no business" for this
      // request; the ledger still answers, in UTC and USD.
      report(error, tenantId, kind);
      return resolveInvoicingBusiness(null);
    }
  }

  async function dispatch(
    req: Request,
    matched: Matched,
    tenantId: string,
    userId: string | null,
    may: (permission: InvoicingPermission) => Promise<boolean>,
  ): Promise<Response> {
    const db = options.db;
    const now = clock();
    const id = matched.id ?? "";
    let business: ResolvedInvoicingBusiness | null = null;
    const biz = async () => (business ??= await businessFor(tenantId, matched.kind));
    // The second asks (the estimator's costs-ask pattern): only true/an object
    // counts, and the answers never become the response.
    let canMemo: InvoiceDetailWire["can"] | null = null;
    const can = async (): Promise<InvoiceDetailWire["can"]> =>
      (canMemo ??= {
        manage: await may("invoices.manage"),
        record: await may("invoices.payments.record"),
        reverse: await may("invoices.payments.reverse"),
      });
    // invoicing 0.5 (H1): ANY change to what the invoice asks — a line, the
    // deposit, a void — closes the Stripe pages already open for it, so a
    // customer can't pay the old figure. Reported, never fatal.
    const edited = async (invoiceId: string): Promise<void> => {
      if (!options.payments) return;
      await expireOpenCheckouts(db, options.payments, tenantId, invoiceId, { report: (error) => report(error, tenantId, matched.kind) });
    };
    const respond = async (invoiceId: string, status = 200): Promise<Response> => {
      const detail = await getInvoice(db, tenantId, invoiceId);
      if (!detail) throw notFound();
      const b = await biz();
      const body: InvoiceResponse = { invoice: detailWire(detail, await can(), now, b), format: moneyFormatOf(b) };
      return json(body, status);
    };

    switch (matched.kind) {
      case "status": {
        const b = await biz();
        const delivery: InvoicingDelivery = options.delivery
          ? await options.delivery(tenantId)
          : options.sendInvoiceEmail
            ? { emails: true, emailsOffReason: null }
            : { emails: false, emailsOffReason: "This site doesn't email invoices yet. Send marks an invoice sent; copy its link to the customer." };
        const body: InvoicingStatusWire = {
          emails: delivery.emails,
          emailsOffReason: delivery.emails ? null : (delivery.emailsOffReason ?? null),
          detailsComplete: b.paymentInstructions !== null,
          detailsHref: options.detailsHref ?? null,
          format: moneyFormatOf(b),
        };
        return json(body);
      }
      case "list": {
        const params = new URL(req.url).searchParams;
        const query = listQuerySchema.parse({
          ...(params.get("status") ? { status: params.get("status") } : {}),
          ...(params.get("cursor") ? { cursor: params.get("cursor") } : {}),
        });
        let rows: InvoiceRow[];
        try {
          rows = await listInvoices(db, tenantId, { limit: PAGE_SIZE, status: query.status ?? null, cursor: query.cursor ?? null });
        } catch (error) {
          // A cursor the package can't read is the caller's mistake, not ours.
          if (error instanceof z.ZodError) {
            throw new InvoicingHttpError("invalid", 400, "That page link is out of date. Start from the first page.", [
              { path: ["cursor"], message: "Start from the first page." },
            ]);
          }
          throw error;
        }
        const last = rows[rows.length - 1];
        const body: InvoiceListWire = {
          invoices: rows.map((row) => summaryWire(row, now)),
          nextCursor: rows.length === PAGE_SIZE && last ? invoiceCursor(last) : null,
          format: moneyFormatOf(await biz()),
        };
        return json(body);
      }
      case "create": {
        const body = createBodySchema.parse(await readJsonBody(req));
        const b = await biz();
        const created = await createInvoice(
          db,
          {
            tenantId,
            customerName: body.customerName,
            customerEmail: body.customerEmail ?? null,
            customerPhone: body.customerPhone ?? null,
            billingAddress: body.billingAddress ?? null,
            taxRateBp: body.taxRateBp ?? 0,
            discount: body.discount ?? 0,
            // Code does the maths (10.5): the end of the chosen day in the
            // business's zone, or today there plus its usual days.
            dueDate: invoiceDueInstant(body.dueDate ?? null, b, now),
            notes: body.notes ?? null,
            items: body.items,
          },
          userId ?? undefined,
        );
        return respond(created.id, 201);
      }
      case "get":
        return respond(id);
      case "item-add": {
        const body = lineSchema.parse(await readJsonBody(req));
        const change = await addInvoiceItem(db, { tenantId, invoiceId: id, ...body });
        if (!change) throw notFound();
        await edited(id);
        return respond(id);
      }
      case "item-update": {
        const body = itemPatchSchema.parse(await readJsonBody(req));
        const change = await updateInvoiceItem(db, { tenantId, itemId: id, ...body });
        if (!change) throw notFound();
        await edited(change.item.invoiceId);
        // The whole invoice the line belongs to (its new id on a sent invoice).
        return respond(change.item.invoiceId);
      }
      case "item-remove": {
        await readJsonBody(req);
        // Which invoice, asked inside THIS tenant: another tenant's line
        // finds nothing here and answers 404 before any write.
        const [owner] = (await db
          .select({ invoiceId: invoiceItems.invoiceId })
          .from(invoiceItems)
          .innerJoin(invoices, eq(invoices.id, invoiceItems.invoiceId))
          .where(and(eq(invoiceItems.id, id), eq(invoices.tenantId, tenantId)))
          .limit(1)) as Array<{ invoiceId: string }>;
        if (!owner) throw notFound();
        const totals = await removeInvoiceItem(db, tenantId, id);
        if (!totals) throw notFound();
        await edited(owner.invoiceId);
        return respond(owner.invoiceId);
      }
      case "status-set": {
        const body = statusBodySchema.parse(await readJsonBody(req));
        const moved = await setInvoiceStatus(db, { tenantId, id, status: body.status });
        if (!moved) throw notFound();
        // invoicing 0.5: a voided invoice can't be paid from a checkout the
        // customer already opened. Reported, never fatal: the void stands.
        if (body.status === "void") await edited(id);
        return respond(id);
      }
      case "attention": {
        const { open, handled } = await listCardAlerts(db, tenantId);
        const body: CardAlertsWire = { open: open.map(cardAlertWire), handled: handled.map(cardAlertWire) };
        return json(body);
      }
      case "attention-resolve": {
        await readJsonBody(req);
        const row = await resolveCardAlert(db, tenantId, id, userId);
        if (!row) throw new InvoicingHttpError("not_found", 404, "That item isn't here.");
        return json({ item: cardAlertWire(row) });
      }
      case "deposit": {
        const body = depositBodySchema.parse(await readJsonBody(req));
        const changed = await setInvoiceDeposit(db, tenantId, id, body);
        if (!changed) throw notFound();
        await edited(id);
        return respond(id);
      }
      case "send": {
        await readJsonBody(req);
        const detail = await getInvoice(db, tenantId, id);
        if (!detail) throw notFound();
        const stored = detail.invoice.status;
        if (stored === "paid" || stored === "void") {
          throw new InvoicingHttpError("transition_not_allowed", 409, "A paid or void invoice can't be sent.");
        }
        // A draft moves to sent FIRST, by the package's own rules (no lines →
        // invoice_has_no_lines); a sent, viewed or part-paid one is emailed again.
        if (stored === "draft") await setInvoiceStatus(db, { tenantId, id, status: "sent" });
        let delivery: InvoiceEmailDelivery;
        let message: string | null = null;
        if (!options.sendInvoiceEmail) {
          delivery = detail.invoice.customerEmail ? "skipped" : "no-email";
        } else {
          try {
            const outcome = await options.sendInvoiceEmail({ tenantId, invoiceId: id, userId });
            delivery = outcome.status;
            message = typeof outcome.message === "string" && outcome.message.trim() !== "" ? outcome.message : null;
          } catch (error) {
            // The status move has committed and stays; the email is what failed.
            report(error, tenantId, "send");
            delivery = "failed";
          }
        }
        const after = await getInvoice(db, tenantId, id);
        if (!after) throw notFound();
        const body: SendResponse = {
          invoice: detailWire(after, await can(), now, await biz()),
          format: moneyFormatOf(await biz()),
          delivery,
          message: message ?? SEND_MESSAGES[delivery](after.invoice.customerEmail ?? null),
        };
        return json(body);
      }
      case "link": {
        // The ONLY admin route that carries the customer's token: a link is a
        // key to the invoice, handed out on request, never in a listing.
        const [row] = (await db
          .select({ token: invoices.viewToken })
          .from(invoices)
          .where(and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)))
          .limit(1)) as Array<{ token: string }>;
        if (!row) throw notFound();
        const url = await options.invoiceUrl(row.token, tenantId);
        const body: InvoiceLinkWire = { url, previewUrl: previewOf(url) };
        return json(body);
      }
      case "payment-record": {
        const body = paymentBodySchema.parse(await readJsonBody(req));
        const recorded = await recordPayment(
          db,
          { tenantId, invoiceId: id, amount: body.amount, method: body.method, reference: body.reference ?? null },
          userId ?? undefined,
        );
        if (!recorded) throw notFound();
        // Tenancy 2b-1 (11.1): `invoice.paid` when THIS payment settled it.
        // recordPayment refuses a payment on an invoice already paid, so
        // "paid now" means "not paid before"; a payment whose reference was
        // already recorded (`duplicate`) wrote nothing and tells nobody. After
        // commit (recordPayment's transaction has ended), awaited, contained.
        if (!recorded.duplicate && recorded.status === "paid") {
          await emitInvoicingEvent(
            db,
            {
              type: "invoice.paid",
              tenantId,
              invoiceId: id,
              actor: { type: "staff", id: userId },
              format: async () => moneyFormatOf(await biz()),
              now,
            },
            { onEvent: options.onEvent, onEventError: options.onEventError, report: (error) => report(error, tenantId, matched.kind) },
          );
        }
        return respond(id);
      }
      case "payment-reverse": {
        const body = reverseBodySchema.parse(await readJsonBody(req));
        const reversed = await reversePayment(db, tenantId, id, body.reason, userId ?? undefined);
        if (!reversed) throw notFound();
        const [row] = (await db
          .select({ invoiceId: invoicePayments.invoiceId })
          .from(invoicePayments)
          .where(eq(invoicePayments.id, reversed.reversalId))
          .limit(1)) as Array<{ invoiceId: string }>;
        if (!row) throw notFound();
        return respond(row.invoiceId);
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    // No CORS headers, ever: the staff API is same-origin only.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const routes = route(new URL(req.url).pathname);
    if (!routes) return failure(notFound());
    const matched = routes[req.method as "GET" | "POST"];
    if (!matched) {
      const allow = Object.keys(routes).join(", ");
      return json({ error: { code: "invalid", message: `Use ${allow} for this address.` } }, 405, { allow });
    }
    if (req.method === "POST" && isCrossSiteRequest(req)) {
      return failure(new InvoicingHttpError("cross_site", 403, CROSS_SITE_MESSAGE));
    }
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(notFound());
      const verdict = await options.authorize(req, INVOICING_ADMIN_ROUTE_PERMISSIONS[matched.kind], tenantId);
      if (verdict instanceof Response) return verdict;
      if (verdict === false || verdict === null || verdict === undefined) {
        return failure(new InvoicingHttpError("forbidden", 403, FORBIDDEN_MESSAGE));
      }
      const raw = typeof verdict === "object" ? (verdict.userId ?? null) : null;
      const userId = raw === null ? null : String(raw);
      const scoped = tenantId;
      const may = async (permission: InvoicingPermission): Promise<boolean> => {
        try {
          const answer = await options.authorize(req, permission, scoped);
          return answer === true || (typeof answer === "object" && answer !== null && !(answer instanceof Response));
        } catch {
          return false;
        }
      };
      return await dispatch(req, matched, tenantId, userId, may);
    } catch (error) {
      if (!isExpected(error)) report(error, tenantId, matched.kind);
      return failure(error);
    }
  }

  return { handle };
}

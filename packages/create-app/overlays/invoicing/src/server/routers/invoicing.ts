import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  addInvoiceItem,
  addInvoiceItemSchema,
  createInvoice,
  createInvoiceSchema,
  getInvoice,
  getInvoiceByToken,
  INVOICE_LIST_STATUSES,
  invoiceCursor,
  InvoicingError,
  isInvoiceEditable,
  isOverdue,
  listInvoices,
  markInvoiceViewed,
  nextInvoiceStatuses,
  recordPayment,
  recordPaymentSchema,
  removeInvoiceItem,
  reversePayment,
  setInvoiceStatus,
  setInvoiceStatusSchema,
  updateInvoiceItem,
  updateInvoiceItemSchema,
} from "__SCOPE__/invoicing";
import { db } from "@/db";
import { createTRPCRouter, publicProcedure, requireStaff } from "../trpc";

/**
 * Invoicing, from __SCOPE__/invoicing. Staff create and manage invoices, edit
 * lines until money is against them, and record (or reverse) payments; a
 * customer opens and (later) pays theirs by a capability token, no account.
 * Totals are the package's — a client never sends a figure it made up — and
 * every call carries the tenant, so an id from another tenant is "not found".
 *
 * ESTIMATE → INVOICE IS YOURS TO WIRE. On the dogfood site an approved estimate
 * becomes an invoice in one call. That coupling is left out here so invoicing
 * stands alone: add `--estimator`, then the procedure below. The package owns
 * the parts the source got wrong — `invoiceInputFromEstimate` refuses anything
 * but an approved estimate, folds labor into the unit price with the quoted
 * line total preserved, carries the tax rate AND the discount, and bills a
 * line-less estimate at its PRE-tax subtotal (never its tax-inclusive total,
 * which the invoice would tax again). A unique index allows one invoice per
 * estimate; a second convert throws InvoiceAlreadyExistsForEstimateError, which
 * `refused` turns into a CONFLICT.
 *
 *   createFromEstimate: requireStaff("staff.dashboard.view")
 *     .meta({ scope: "staff" })
 *     .input(z.object({ estimateId: z.string().min(1) }))
 *     .mutation(async ({ input, ctx }) => {
 *       // getEstimate / markEstimateConverted from __SCOPE__/estimator (both
 *       // tenant-scoped from estimator 0.2.0 — on an older one, getEstimate
 *       // takes (db, id): check detail.estimate.tenantId yourself, since an
 *       // unscoped read is an IDOR). ESTIMATOR_TENANT is in @/server/estimator-seed.
 *       const detail = await getEstimate(db, ESTIMATOR_TENANT, input.estimateId);
 *       if (!detail) throw new TRPCError({ code: "NOT_FOUND", message: "Estimate not found." });
 *       return db
 *         .transaction(async (tx) => {
 *           const invoice = await createInvoice(
 *             tx,
 *             { tenantId: INVOICING_TENANT, ...invoiceInputFromEstimate(detail.estimate, detail.items) },
 *             ctx.principal.userId,
 *           );
 *           // Claim the quote in the same transaction; null means it was
 *           // already converted, and throwing rolls the new invoice back.
 *           if (!(await markEstimateConverted(tx, ESTIMATOR_TENANT, detail.estimate.id))) {
 *             throw new TRPCError({ code: "CONFLICT", message: "This estimate was already converted." });
 *           }
 *           return invoice;
 *         })
 *         .catch(refused);
 *     }),
 */
const INVOICING_TENANT = "primary";
const PAGE_SIZE = 50;

/**
 * Derive "overdue" for display — it's a fact about the clock, not a stored
 * state, so it's computed on read rather than flipped by a cron. The stored
 * status stays "sent"/"viewed"/"partial"; setInvoiceStatus never sees "overdue".
 */
function withDisplayStatus<T extends { status: string; dueDate: Date | null }>(invoice: T): T {
  return {
    ...invoice,
    status: isOverdue(invoice.status as Parameters<typeof isOverdue>[0], invoice.dueDate)
      ? "overdue"
      : invoice.status,
  };
}

/**
 * The package's typed refusals (paid invoice, frozen lines, illegal status
 * move, discount over the subtotal, estimate already invoiced) as a 4xx that
 * carries the message to the page. Uncaught, each is a 500 that tells staff
 * nothing about what to do instead.
 */
function refused(error: unknown): never {
  if (error instanceof InvoicingError) {
    throw new TRPCError({
      code: error.code === "estimate_already_invoiced" ? "CONFLICT" : "BAD_REQUEST",
      message: error.message,
      cause: error,
    });
  }
  throw error;
}

export const invoicingRouter = createTRPCRouter({
  /** A page of the ledger, newest first; `nextCursor` fetches the next page. */
  list: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(
      z.object({
        status: z.enum(INVOICE_LIST_STATUSES).nullish(),
        cursor: z.string().max(300).nullish(),
      }),
    )
    .query(async ({ input }) => {
      const rows = await listInvoices(db, INVOICING_TENANT, {
        limit: PAGE_SIZE,
        status: input.status,
        cursor: input.cursor,
      });
      return {
        invoices: rows.map(withDisplayStatus),
        nextCursor: rows.length === PAGE_SIZE ? invoiceCursor(rows[rows.length - 1]!) : null,
      };
    }),

  get: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await getInvoice(db, INVOICING_TENANT, input.id);
      if (!detail) return null;
      return {
        ...detail,
        invoice: withDisplayStatus(detail.invoice),
        // What the page may offer, decided here from the STORED status so the
        // client never imports the package (or re-types its rules).
        editable: isInvoiceEditable(detail.invoice.status),
        nextStatuses: nextInvoiceStatuses(detail.invoice.status),
      };
    }),

  create: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createInvoiceSchema.omit({ tenantId: true }))
    .mutation(({ input, ctx }) =>
      createInvoice(db, { ...input, tenantId: INVOICING_TENANT }, ctx.principal.userId).catch(refused),
    ),

  addItem: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(addInvoiceItemSchema.omit({ tenantId: true }))
    .mutation(({ input }) =>
      addInvoiceItem(db, { ...input, tenantId: INVOICING_TENANT }).catch(refused),
    ),

  updateItem: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(updateInvoiceItemSchema.omit({ tenantId: true }))
    .mutation(({ input }) =>
      updateInvoiceItem(db, { ...input, tenantId: INVOICING_TENANT }).catch(refused),
    ),

  removeItem: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ itemId: z.string().min(1) }))
    .mutation(({ input }) =>
      removeInvoiceItem(db, INVOICING_TENANT, input.itemId).catch(refused),
    ),

  recordPayment: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(recordPaymentSchema.omit({ tenantId: true }))
    .mutation(({ input, ctx }) =>
      recordPayment(db, { ...input, tenantId: INVOICING_TENANT }, ctx.principal.userId).catch(refused),
    ),

  /** Undo a payment by appending a reversal — the ledger is never edited. */
  reversePayment: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ paymentId: z.string().min(1), reason: z.string().min(1).max(500) }))
    .mutation(({ input, ctx }) =>
      reversePayment(db, INVOICING_TENANT, input.paymentId, input.reason, ctx.principal.userId).catch(
        refused,
      ),
    ),

  setStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setInvoiceStatusSchema.omit({ tenantId: true }))
    .mutation(async ({ input }) => ({
      ok: await setInvoiceStatus(db, { ...input, tenantId: INVOICING_TENANT }).catch(refused),
    })),

  /**
   * Public: a customer opens their invoice by its token. The package answers
   * null for a draft and returns a projection — no payment references, staff
   * ids, internal ids or contact details ride along on a forwarded link.
   */
  byToken: publicProcedure
    .meta({ scope: "public" })
    .input(z.object({ token: z.string().min(1).max(200) }))
    .query(({ input }) => getInvoiceByToken(db, input.token)),

  /**
   * Public: the page reports that the customer opened it (sent → viewed). A
   * mutation fired from the page, not a side effect of the query, so an email
   * scanner's or link preview's fetch doesn't count as the customer looking.
   */
  markViewed: publicProcedure
    .meta({ scope: "public" })
    .input(z.object({ token: z.string().min(1).max(200) }))
    .mutation(async ({ input }) => ({ viewed: await markInvoiceViewed(db, input.token) })),
});

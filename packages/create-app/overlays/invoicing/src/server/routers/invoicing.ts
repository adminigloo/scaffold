import { z } from "zod";
import {
  createInvoice,
  createInvoiceSchema,
  getInvoice,
  getInvoiceByToken,
  isOverdue,
  listInvoices,
  recordPayment,
  recordPaymentSchema,
  setInvoiceStatus,
  setInvoiceStatusSchema,
} from "__SCOPE__/invoicing";
import { db } from "@/db";
import { createTRPCRouter, publicProcedure, requireStaff } from "../trpc";

/**
 * Invoicing, from __SCOPE__/invoicing. Staff create and manage invoices and
 * record payments; a customer opens and (later) pays theirs by a capability
 * token, no account. Totals are the package's — a client never sends a figure
 * it made up.
 *
 * ESTIMATE → INVOICE IS YOURS TO WIRE. On the dogfood site an approved estimate
 * becomes an invoice in one call (`createFromEstimate`, reading __SCOPE__/estimator).
 * That coupling is left out here so invoicing stands alone: add `--estimator`,
 * then a `createFromEstimate` procedure that reads `getEstimate(db, id)` and maps
 * its items into `createInvoice`, folding labor into the line price.
 */
const INVOICING_TENANT = "primary";

export const invoicingRouter = createTRPCRouter({
  list: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .query(async () => {
      // Derive "overdue" for display — it's a fact about the clock, not a stored
      // state, so it's computed on read rather than flipped by a cron. The stored
      // status stays "sent"/"viewed"; setInvoiceStatus never sees "overdue".
      const rows = await listInvoices(db, INVOICING_TENANT);
      return rows.map((inv) => ({
        ...inv,
        status: isOverdue(inv.status as Parameters<typeof isOverdue>[0], inv.dueDate)
          ? "overdue"
          : inv.status,
      }));
    }),

  get: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const detail = await getInvoice(db, input.id);
      if (!detail) return null;
      return {
        ...detail,
        invoice: {
          ...detail.invoice,
          status: isOverdue(
            detail.invoice.status as Parameters<typeof isOverdue>[0],
            detail.invoice.dueDate,
          )
            ? "overdue"
            : detail.invoice.status,
        },
      };
    }),

  create: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(createInvoiceSchema.omit({ tenantId: true }))
    .mutation(({ input, ctx }) =>
      createInvoice(db, { ...input, tenantId: INVOICING_TENANT }, ctx.principal.userId),
    ),

  recordPayment: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(recordPaymentSchema)
    .mutation(({ input, ctx }) => recordPayment(db, input, ctx.principal.userId)),

  setStatus: requireStaff("staff.dashboard.view")
    .meta({ scope: "staff" })
    .input(setInvoiceStatusSchema)
    .mutation(async ({ input }) => ({ ok: await setInvoiceStatus(db, input) })),

  /** Public: a customer opens their invoice by its token. */
  byToken: publicProcedure
    .meta({ scope: "public" })
    .input(z.object({ token: z.string().min(1) }))
    .query(({ input }) => getInvoiceByToken(db, input.token)),
});

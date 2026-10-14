import { z } from "zod";

/**
 * What a business's invoices tell its customers about paying (Tenancy 2a,
 * D15): how customers pay, how many days until an invoice is due, and a note
 * at the bottom. FLAT, scalar fields an owner fills in once, so they live in
 * the host's company settings registry (tenancy's `defineSettingsFragment`
 * accepts this fragment as is), not in a table of invoicing's own.
 *
 * Structural: no tenancy import. A host without a registry passes the same
 * three values through the `business` seam.
 */

/** "" and whitespace → null, so a cleared textarea stores "nothing", never "". */
function blankToNull(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? null : value;
}

export const invoicingSettingsFragment = {
  key: "invoicing",
  label: "Invoices",
  description: "What your invoices tell customers about paying you.",
  order: 40,
  viewPermission: "tenant.view",
  editPermission: "tenant.edit",
  schema: z.object({
    paymentInstructions: z.preprocess(blankToNull, z.string().trim().max(1000).nullable()).default(null),
    dueDays: z.number().int().min(0).max(365).default(14),
    footer: z.preprocess(blankToNull, z.string().trim().max(500).nullable()).default(null),
  }),
  fields: [
    {
      key: "paymentInstructions",
      kind: "textarea",
      label: "How customers pay you",
      help: "Shown on every invoice and in the invoice email. For example: Pay by check to Green Acres LLC, or call us to pay by card.",
      width: "full",
    },
    {
      key: "dueDays",
      kind: "number",
      label: "Invoices are due after this many days",
      help: "0 means due as soon as they get it.",
      min: 0,
      max: 365,
      step: 1,
      width: "half",
    },
    { key: "footer", kind: "textarea", label: "A note at the bottom of every invoice (optional)", width: "full" },
  ],
} as const;

export interface InvoicingDetails {
  readonly paymentInstructions: string | null;
  readonly dueDays: number;
  readonly footer: string | null;
}

export const DEFAULT_INVOICING_DETAILS: InvoicingDetails = Object.freeze({ paymentInstructions: null, dueDays: 14, footer: null });

/**
 * The fragment's values from a stored blob (`companyProfile(id).settings.invoicing`).
 * Each field is read on its own: one bad field falls back to its default and
 * keeps the others, so a footer that somehow grew past 500 characters never
 * wipes the payment instructions off every invoice. Anything that isn't an
 * object reads as the defaults.
 */
export function readInvoicingDetails(stored: unknown): InvoicingDetails {
  const raw = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const shape = invoicingSettingsFragment.schema.shape;
  const pick = <K extends keyof InvoicingDetails>(key: K): InvoicingDetails[K] => {
    const parsed = shape[key].safeParse(raw[key]);
    return (parsed.success ? parsed.data : DEFAULT_INVOICING_DETAILS[key]) as InvoicingDetails[K];
  };
  return { paymentInstructions: pick("paymentInstructions"), dueDays: pick("dueDays"), footer: pick("footer") };
}

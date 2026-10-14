import { readInvoicingDetails } from "./settings.js";

/**
 * Invoicing's item on the company setup checklist (Tenancy 2a, 10.7).
 * Structural (D4): the same shape as tenancy's `SetupChecklistItem`, declared
 * here so invoicing never imports tenancy; `defineSetupChecklist` accepts it
 * as is.
 */
export interface InvoicingChecklistItem {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly href: string;
  readonly order: number;
  readonly permission?: string;
  isDone(ctx: { readonly db: unknown; readonly tenantId: string; readonly settings: Readonly<Record<string, unknown>> }): Promise<boolean>;
}

/**
 * "Tell customers how to pay you": done once the company has written payment
 * instructions in its Invoices settings. Its permission is `tenant.edit`
 * because the details live in the company settings, which that key guards.
 */
export function invoicingChecklistItems(hrefs: { readonly details: string }): readonly InvoicingChecklistItem[] {
  return [
    {
      key: "invoices.details",
      order: 80,
      permission: "tenant.edit",
      title: "Tell customers how to pay you",
      description: "Shown on every invoice and in the invoice email.",
      actionLabel: "Add invoice details",
      href: hrefs.details,
      isDone: async (ctx) => readInvoicingDetails(ctx.settings["invoicing"]).paymentInstructions !== null,
    },
  ];
}

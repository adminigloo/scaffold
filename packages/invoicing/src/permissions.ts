/**
 * This package's permission keys (Tenancy 2a, 10.2), for the app to spread
 * into its own `definePermissions("tenant", { ... })` call beside the other
 * packages' fragments.
 *
 * TENANT, because each company keeps its own ledger. Four keys because there
 * are four jobs: reading invoices (anyone in the office answering "did they
 * pay?"), raising and sending them (the office), recording money as it comes
 * in (the office), and undoing a recorded payment (the owner's or an admin's:
 * a reversal changes what the books say was collected, so it belongs with
 * the people who answer for the books).
 *
 * A single-business site maps the same keys onto its STAFF catalog
 * (`staff.invoices.view`, `staff.invoices.manage`); the keys are the
 * contract, the defaults a starting point.
 *
 * Typed structurally, not against @adminigloo/permissions' `PermissionMap`, so
 * invoicing stays installable on its own; `definePermissions` accepts the
 * shape as is.
 */

export interface InvoicingPermissionDefinition {
  readonly label: string;
  readonly description?: string;
  readonly category?: string;
  readonly sealed?: boolean;
  readonly defaultFor?: readonly string[];
}

export const invoicingPermissions = {
  "invoices.view": {
    label: "See invoices",
    description: "Invoices, their lines and payments.",
    category: "Invoices",
    defaultFor: ["owner", "admin", "member", "viewer"],
  },
  "invoices.manage": {
    label: "Raise and send invoices",
    description:
      "Create invoices, edit their lines until money is against them, move them along, copy a customer's link and email it to them.",
    category: "Invoices",
    defaultFor: ["owner", "admin", "member"],
  },
  "invoices.payments.record": {
    label: "Record payments",
    description: "Record a payment against an invoice: cash, check, card or other. The status follows the money.",
    category: "Invoices",
    defaultFor: ["owner", "admin", "member"],
  },
  "invoices.payments.reverse": {
    label: "Reverse payments",
    description: "Undo a recorded payment by adding a reversal. The record of both stays.",
    category: "Invoices",
    defaultFor: ["owner", "admin"],
  },
} as const satisfies Record<string, InvoicingPermissionDefinition>;

export type InvoicingPermission = keyof typeof invoicingPermissions;

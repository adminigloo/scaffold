/**
 * @adminigloo/invoicing-widget, entry `.`: the customer's own invoice page
 * (`<InvoiceView>`), its transport and the public wire types. The staff
 * screens are under `./admin`, so a public page never ships the ledger.
 */
export { INVOICING_WIRE_VERSION } from "./version.js";
export { InvoiceView, statusLine } from "./InvoiceView.js";
export type { InvoiceViewProps } from "./InvoiceView.js";
export { createInvoicePublicClient } from "./client.js";
export type { InvoicePublicTransport } from "./client.js";
export type { ClientError, Result, TransportOptions } from "./http.js";
export { formatMoney, formatDate, paymentWords } from "./money.js";
export { invoicingWidgetCss, injectInvoicingStyles } from "./styles.js";
export type {
  BusinessWire,
  CardAlertsWire,
  CardAlertWire,
  Instant,
  InvoiceStatusWire,
  InvoicingErrorCodeWire,
  MoneyFormatWire,
  PaymentMethodWire,
  PublicInvoiceResponse,
  PublicInvoiceWire,
  WireErrorBody,
  WireIssue,
} from "./types.js";

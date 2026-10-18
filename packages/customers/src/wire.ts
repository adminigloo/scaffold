/**
 * What the customer routes answer (customers 0.1): plain JSON, dates as ISO
 * strings. Shared by the handlers and the screens.
 */

/** What a link points at: one record of one feature. */
export type CustomerLinkKind = "estimate" | "visit" | "invoice" | "booking" | "order" | "message";

export const CUSTOMER_LINK_KINDS: readonly CustomerLinkKind[] = ["estimate", "visit", "invoice", "booking", "order", "message"];

export interface CustomerAddressWire {
  readonly id: string;
  readonly label: string | null;
  readonly text: string;
}

export interface CustomerSummaryWire {
  readonly id: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly tags: readonly string[];
  readonly lastActivityAt: string | null;
  readonly createdAt: string;
}

/** Something on a customer's record for staff to decide (see customer_notices). */
export interface CustomerNoticeWire {
  readonly id: string;
  readonly kind: "new-details" | "possible-duplicate" | "shared-key";
  /** The whole thing in plain words: "New details from a form (Quote Q-0012): phone +12125550199, 666 Evil St". */
  readonly message: string;
  /** The other customer (a possible duplicate, or who also has the detail). */
  readonly other: { readonly id: string; readonly name: string } | null;
  readonly createdAt: string;
}

export interface CustomerWire extends CustomerSummaryWire {
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly notes: string | null;
  readonly createdFrom: string;
  readonly addresses: readonly CustomerAddressWire[];
  /** What waits for staff: details a form brought, a possible duplicate, a detail another customer has. */
  readonly notices: readonly CustomerNoticeWire[];
  readonly updatedAt: string;
}

export interface CustomerListResponse {
  readonly customers: readonly CustomerSummaryWire[];
  readonly nextCursor: string | null;
}

export interface CustomerResponse {
  readonly customer: CustomerWire;
  /** Set when the id asked for was merged into this customer: open this one instead. */
  readonly mergedFrom?: string;
}

export interface TimelineEntryWire {
  readonly id: string;
  readonly kind: CustomerLinkKind;
  readonly refId: string;
  /** What happened to the record: "submitted", "booked", "raised", "paid", "sent", … */
  readonly action: string;
  readonly occurredAt: string;
  readonly summary: string;
}

export interface TimelineResponse {
  readonly entries: readonly TimelineEntryWire[];
  readonly nextCursor: string | null;
}

export type ImportRowAction = "create" | "update" | "same-as-row" | "error";

export interface ImportRowWire {
  /** The row's number as a spreadsheet shows it (the heading is row 1). */
  readonly row: number;
  readonly action: ImportRowAction;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  /** In plain words: what will happen, or what to fix. */
  readonly message: string;
  /** The emails and phones this row adds to the customer: "phone +14155550123". */
  readonly adds: readonly string[];
  /** Details another customer already has, which aren't added: "phone +14155550123 is already Mr Kim's". */
  readonly conflicts: readonly string[];
}

export interface ImportPreviewResponse {
  readonly rows: readonly ImportRowWire[];
  readonly counts: Readonly<Record<ImportRowAction, number>>;
  /** Headings the import doesn't read (they're left out). */
  readonly ignoredColumns: readonly string[];
}

export interface ImportApplyResponse {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  readonly errors: readonly ImportRowWire[];
  /** Rows of the file (after the heading) worked through so far, and how many there are. */
  readonly done: number;
  readonly total: number;
  /** Where to carry on (send it back as `fromRow`), or null when the file is finished. */
  readonly nextRow: number | null;
  /** When part of this call couldn't be saved: which rows were, in plain words. The rest can be tried again from `nextRow`. */
  readonly problem: string | null;
}

export interface MergeResponse {
  readonly customer: CustomerWire;
  readonly linksMoved: number;
}

import { and, eq, inArray } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { invoices } from "./schema.js";

/**
 * Photos and files on an invoice (Tenancy 2b-1, 11.4): invoicing's RECORD
 * TYPE for @adminigloo/storage. A file attached to an invoice belongs to it,
 * and the invoice's own permissions decide who sees it (2b-1 D12): anyone who
 * can see invoices sees its files, anyone who can manage invoices adds and
 * removes them, and nobody else learns it exists (storage answers 404).
 *
 * STRUCTURAL (2a D4): storage never imports invoicing and invoicing never
 * imports storage. The shape below is declared again in each package that
 * contributes a record type, field for field (2b-1 3.5), prefixed
 * `Invoicing…` so a generated file importing two packages never sees two
 * `FileRecordType`s.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PgDatabase<any, any, any>;

/** A record type files can belong to (2b-1 section 3.5), structurally identical to storage's own. */
export interface InvoicingFileRecordType {
  /** "invoicing.invoice": /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/. Permanent (stored on file rows). */
  readonly type: string;
  /** "Invoice" */
  readonly label: string;
  /** "Invoices": the Files screen's filter (review BO-22). */
  readonly pluralLabel: string;
  /** Any one of these lets someone see this record's files. */
  readonly view: readonly string[];
  /** Any one of these lets someone add and remove them. */
  readonly manage: readonly string[];
  /** Someone holding this may see and ADD files on records they are assigned to (crew), and remove their own within 24 h (D12). */
  readonly assigned?: { readonly permission: string };
  /**
   * The records of THIS company among `ids`: a label (the Files screen's
   * "Attached to" and the record's heading), where it opens, and who is
   * assigned. An id that isn't this company's is simply absent. One query,
   * never one per id.
   */
  find(input: { readonly tenantId: string; readonly ids: readonly string[] }): Promise<
    ReadonlyMap<string, { readonly label: string; readonly href: string | null; readonly assignedUserIds: readonly string[] }>
  >;
}

/** The record type's permanent key (stored on storage's file rows). */
export const INVOICING_INVOICE_RECORD = "invoicing.invoice";

/** 3.3's href rule (D18), for the record's own page. */
const HREF_PATTERN = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;
/** At most this many ids in one `find` (one query either way): the Files screen asks a page at a time. */
const MAX_FIND_IDS = 500;

/** One line of plain text, at most `max` characters: a customer typed this name. */
function oneLine(value: string, max: number): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    out += control ? " " : char;
  }
  const cleaned = out.replace(/\s+/g, " ").trim();
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * Invoicing's record types for `createStorage({ records })` (11.4): one, the
 * invoice. `invoiceHref` is a pattern (`{id}` is the invoice, URL-encoded), so
 * the same package serves `/app/invoices/{id}` and `/admin/invoices/{id}`.
 *
 *   records: [...invoicingFileRecords(db, { invoiceHref: "/app/invoices/{id}" })]
 *
 * The label is "Invoice {number} · {customer}" ("Invoice INV-2026-0042 · Pat
 * Rivera"), or "Invoice {number}" with no customer. No one is ASSIGNED to an
 * invoice (no crew), so `assigned` is absent and `assignedUserIds` empty.
 */
export function invoicingFileRecords(db: Db, options: { readonly invoiceHref: string }): readonly InvoicingFileRecordType[] {
  const pattern = options.invoiceHref;
  const hrefOf = (id: string): string | null => {
    const href = pattern.replace(/\{id\}/g, encodeURIComponent(id));
    return HREF_PATTERN.test(href) ? href : null;
  };
  const invoice: InvoicingFileRecordType = {
    type: INVOICING_INVOICE_RECORD,
    label: "Invoice",
    pluralLabel: "Invoices",
    view: Object.freeze(["invoices.view"]),
    manage: Object.freeze(["invoices.manage"]),
    async find(input) {
      const found = new Map<string, { label: string; href: string | null; assignedUserIds: readonly string[] }>();
      if (typeof input.tenantId !== "string" || input.tenantId.length === 0) return found;
      const ids = [...new Set(input.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(
        0,
        MAX_FIND_IDS,
      );
      if (ids.length === 0) return found;
      // ONE query, scoped to the company: another company's invoice id is
      // simply absent, so its files read "Attached to something that was
      // removed" to someone who manages files, and nobody else sees them.
      const rows = (await db
        .select({ id: invoices.id, number: invoices.invoiceNumber, customerName: invoices.customerName })
        .from(invoices)
        .where(and(eq(invoices.tenantId, input.tenantId), inArray(invoices.id, ids)))) as Array<{
        id: string;
        number: string;
        customerName: string | null;
      }>;
      for (const row of rows) {
        const customer = row.customerName ? oneLine(row.customerName, 80) : "";
        const number = oneLine(row.number, 40);
        found.set(row.id, {
          label: customer ? `Invoice ${number} · ${customer}` : `Invoice ${number}`,
          href: hrefOf(row.id),
          assignedUserIds: [],
        });
      }
      return found;
    },
  };
  return Object.freeze([Object.freeze(invoice)]);
}

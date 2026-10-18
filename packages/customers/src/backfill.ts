import { refActionKey } from "./customers.js";
import { recordCustomerActivity, type CustomerActivity, type CustomerDirectory } from "./directory.js";
import type { CustomerLinkKind } from "./wire.js";

/**
 * THE BACKFILL (customers 0.1): a company that had estimates, visits,
 * invoices, calls, orders or messages before the customer list existed gets
 * them on its customers' timelines.
 *
 * The app reads its own feature rows (this package knows none of their
 * tables) and hands them in as records, in any order, as an array or a
 * stream. They are worked through in chunks; for each chunk the records
 * whose ACTION is already on a timeline (the invoice raised, the invoice
 * paid — each on its own) are skipped in ONE question, so running it again
 * is quick and changes nothing (idempotent). An invoice the live glue linked
 * as paid after the list was installed still gets its earlier "raised". The
 * records are public by default (`source: "public"`: a form's details never
 * change a customer they match); pass `source: "staff"` on a record staff
 * made (a staff-made invoice). A record with no name,
 * email or phone has nobody to belong to and is counted as skipped.
 */
export type BackfillRecord = Omit<CustomerActivity, "tenantId"> & { readonly kind: CustomerLinkKind };

export interface BackfillResult {
  readonly seen: number;
  readonly linked: number;
  readonly alreadyLinked: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface BackfillOptions {
  /** Records per chunk. Default 200. */
  readonly chunkSize?: number;
  /** After every chunk: how far it has got. */
  readonly onProgress?: (progress: BackfillResult) => void;
  /** A record that couldn't be linked (the run goes on). */
  readonly onError?: (error: unknown, record: BackfillRecord) => void;
}

export async function backfillCustomers(
  directory: CustomerDirectory,
  tenantId: string,
  records: Iterable<BackfillRecord> | AsyncIterable<BackfillRecord>,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const size = Math.min(Math.max(options.chunkSize ?? 200, 1), 2_000);
  const totals = { seen: 0, linked: 0, alreadyLinked: 0, skipped: 0, failed: 0 };
  let chunk: BackfillRecord[] = [];

  const flush = async () => {
    if (chunk.length === 0) return;
    // One question per kind: which of these records' actions are on a timeline already?
    const groups = new Map<CustomerLinkKind, BackfillRecord[]>();
    for (const record of chunk) groups.set(record.kind, [...(groups.get(record.kind) ?? []), record]);
    for (const [kind, group] of groups) {
      const done = await directory.linkedRefs(tenantId, kind, [...new Set(group.map((record) => record.refId))]);
      for (const record of group) {
        if (done.has(refActionKey(record.refId, record.action))) {
          totals.alreadyLinked += 1;
          continue;
        }
        try {
          const customer = await recordCustomerActivity(directory, { ...record, tenantId });
          if (customer) totals.linked += 1;
          else totals.skipped += 1;
        } catch (error) {
          totals.failed += 1;
          options.onError?.(error, record);
        }
      }
    }
    chunk = [];
    options.onProgress?.({ ...totals });
  };

  for await (const record of records as AsyncIterable<BackfillRecord>) {
    totals.seen += 1;
    chunk.push(record);
    if (chunk.length >= size) await flush();
  }
  await flush();
  return { ...totals };
}

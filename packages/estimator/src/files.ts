import { and, eq, inArray } from "drizzle-orm";
import { ESTIMATOR_ESTIMATE_SUBJECT, fillEstimateHref } from "./alerts.js";
import { estimatorEstimates } from "./schema.js";
import type { EstimatorDb } from "./types.js";

/**
 * Files (Tenancy 2b-1, contract 3.5, 10.4 and 10.5): an estimate is something
 * a company keeps photos and files against, and THE ESTIMATE'S OWN
 * PERMISSIONS DECIDE who sees them (D12). And a customer's estimate photo is
 * kept privately with its estimate.
 *
 * STRUCTURAL, NO STORAGE IMPORT (2a D4): `EstimatorFileRecordType` is the
 * contract's `<Pkg>FileRecordType` and `estimatorPhotoPurpose` a
 * `StoragePurpose`, declared here, so a host passes them to `createStorage`
 * and the estimator never loads @adminigloo/storage.
 */

export interface EstimatorFileRecordType {
  /** "estimator.estimate": permanent (stored on file rows). */
  readonly type: string;
  /** "Estimate" */
  readonly label: string;
  /** "Estimates": the Files screen's filter (review BO-22). */
  readonly pluralLabel: string;
  /** Any one of these lets someone see this record's files. */
  readonly view: readonly string[];
  /** Any one of these lets someone add and remove them. */
  readonly manage: readonly string[];
  /** Someone holding this may see and ADD files on records they are assigned to. The estimator has nobody assigned. */
  readonly assigned?: { readonly permission: string };
  /**
   * The records of THIS company among `ids`: a label, where it opens, and who
   * is assigned. An id that isn't this company's is simply absent. One
   * query, never one per id.
   */
  find(input: { readonly tenantId: string; readonly ids: readonly string[] }): Promise<
    ReadonlyMap<string, { readonly label: string; readonly href: string | null; readonly assignedUserIds: readonly string[] }>
  >;
}

export interface EstimatorFileRecordsOptions {
  /** Where an estimate opens: a pattern with {id}, e.g. "/app/estimates/{id}". */
  readonly estimateHref: string;
}

/** The most ids one `find` looks up; storage pages its lists well under this. */
const MAX_FIND_IDS = 500;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const line = (value: string | null | undefined) => (value ?? "").replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim();

/**
 * The estimator's one record type, `estimator.estimate` (contract 10.4):
 * `estimator.view` sees an estimate's files, `estimator.estimates.manage`
 * adds and removes them; nobody is "assigned" to an estimate. `find` is ONE
 * query in the tenant; its label ("Estimate 1042 · Pat Rivera") is the Files
 * screen's "Attached to" and the record's heading.
 */
export function estimatorFileRecords(db: EstimatorDb, options: EstimatorFileRecordsOptions): readonly EstimatorFileRecordType[] {
  const estimates: EstimatorFileRecordType = {
    type: ESTIMATOR_ESTIMATE_SUBJECT,
    label: "Estimate",
    pluralLabel: "Estimates",
    view: Object.freeze(["estimator.view"]),
    manage: Object.freeze(["estimator.estimates.manage"]),
    async find(input) {
      const out = new Map<string, { label: string; href: string | null; assignedUserIds: readonly string[] }>();
      const ids = [...new Set(input.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(
        0,
        MAX_FIND_IDS,
      );
      if (ids.length === 0 || typeof input.tenantId !== "string" || input.tenantId === "") return out;
      const rows = (await db
        .select({ id: estimatorEstimates.id, number: estimatorEstimates.estimateNumber, customerName: estimatorEstimates.customerName })
        .from(estimatorEstimates)
        .where(and(eq(estimatorEstimates.tenantId, input.tenantId), inArray(estimatorEstimates.id, ids)))) as Array<{
        id: string;
        number: string;
        customerName: string | null;
      }>;
      for (const row of rows) {
        const who = line(row.customerName);
        // CONTRACT: "Estimate {number} · {customer}"; an estimate with no
        // customer name yet (a draft staff started) reads "Estimate 1042".
        out.set(row.id, {
          label: who ? `Estimate ${line(row.number)} · ${who}` : `Estimate ${line(row.number)}`,
          href: fillEstimateHref(options.estimateHref, row.id),
          assignedUserIds: [],
        });
      }
      return out;
    },
  };
  return Object.freeze([estimates]);
}

/**
 * The purpose a customer's estimate photo is stored under (contract 10.5),
 * structurally storage's `StoragePurpose`: the host passes it to
 * `createStorage({ purposes: [...STORAGE_BUILT_IN_PURPOSES, estimatorPhotoPurpose] })`
 * and uses `storage.purposeStore("estimator.photo")` as the estimator's
 * photo store.
 */
export const estimatorPhotoPurpose = Object.freeze({
  key: "estimator.photo",
  label: "Estimate photo",
  // Kept privately with the estimate: a customer's house is not a public page.
  access: "private",
  types: Object.freeze(["jpeg", "png", "webp"] as const),
  maxBytes: 4 * 1024 * 1024,
  // Counted, never refused for a full company: a customer's photo is a lead
  // (review BO-06), and the estimator's own daily caps
  // (DEFAULT_PUBLIC_PHOTO_LIMITS) bound how many arrive.
  exemptFromAllowance: true,
  // But never more than a fifth of the room: 500 anonymous photos a day at up
  // to 4 MB could otherwise fill a company's storage and refuse the crew's job
  // photos (review G6).
  maxShareOfAllowance: 0.2,
  view: Object.freeze(["estimator.view"] as const),
  // Removed where it is used (the estimate's Photos panel), never from the
  // Files screen, where removing it would leave the estimate pointing at nothing.
  removableFromFiles: false,
  // A customer's photo before the lead is sent is purged after 48 h; it isn't
  // listed on the Files screen until it is on its estimate (review BO-13).
  hiddenUntilAttached: true,
} as const);

/**
 * The purpose STAFF's own estimate photos are stored under (Tenancy 2b-1
 * review SEC-02), apart from customers' photos: the host registers it next
 * to `estimatorPhotoPurpose` and passes
 * `storage.purposeStore("estimator.staff-photo")` as the admin handlers'
 * `staffPhotoStore`.
 *
 * WHY APART. The customers' share (a fifth of the room) is room strangers can
 * fill: anyone may send a lead with photos. When staff photos were kept under
 * the same purpose, a full share refused the business's own photos of its
 * own estimates too. A staff photo is the business's work, like the crew's
 * job photos, so it is counted and refused like them: no exemption, no share.
 */
export const estimatorStaffPhotoPurpose = Object.freeze({
  key: "estimator.staff-photo",
  label: "Estimate photo added by staff",
  access: "private",
  types: Object.freeze(["jpeg", "png", "webp"] as const),
  maxBytes: 4 * 1024 * 1024,
  view: Object.freeze(["estimator.view"] as const),
  // Removed where it is used (the estimate's Photos panel), like a customer's.
  removableFromFiles: false,
  // Put on its estimate the moment it is added; never listed on no record.
  hiddenUntilAttached: true,
} as const);

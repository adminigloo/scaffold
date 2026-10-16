import { StorageConfigError } from "./types.js";

/**
 * Record types (D12, sections 3.5 and 6.5): a file can belong to a visit, an
 * estimate or an invoice, and THAT record's permissions decide who sees it.
 * Each 2a package exports its own (`schedulingFileRecords`,
 * `estimatorFileRecords`, `invoicingFileRecords`) structurally, in exactly
 * this shape, with no storage import (2a D4).
 */
export interface StorageRecordType {
  /** "scheduling.visit": /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/. Permanent (stored on file rows). */
  readonly type: string;
  /** "Visit" */
  readonly label: string;
  /** "Visits": the Files screen's filter (review BO-22). */
  readonly pluralLabel: string;
  /** Any one of these lets someone see this record's files. */
  readonly view: readonly string[];
  /** Any one of these lets someone add and remove them. */
  readonly manage: readonly string[];
  /** Someone holding this may see and ADD files on records they are assigned to (crew), and remove their own within 24 h (D12). */
  readonly assigned?: { readonly permission: string };
  /**
   * The records of THIS company among `ids`: a label (the Files screen's
   * "Attached to" and the record's heading, e.g. "Visit · Pat Rivera ·
   * Tue, Nov 3, 9:00 AM"), where it opens, and who is assigned. An id that
   * isn't this company's is simply absent. One query, never one per id.
   */
  find(input: { readonly tenantId: string; readonly ids: readonly string[] }): Promise<
    ReadonlyMap<string, { readonly label: string; readonly href: string | null; readonly assignedUserIds: readonly string[] }>
  >;
}

/** One record as `find` answers it. */
export type StorageRecordInfo = { readonly label: string; readonly href: string | null; readonly assignedUserIds: readonly string[] };

const RECORD_TYPE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/;

function permissionList(value: unknown): boolean {
  return Array.isArray(value) && value.every((p) => typeof p === "string" && p !== "");
}

/** Refused at construction (a programming error, said once). */
export function checkRecordType(record: StorageRecordType): void {
  const where = `record type ${JSON.stringify((record as { type?: unknown })?.type)}`;
  if (!record || typeof record !== "object") throw new StorageConfigError("A record type must be an object.");
  if (typeof record.type !== "string" || record.type.length > 64 || !RECORD_TYPE.test(record.type)) {
    throw new StorageConfigError(`${where}: the type must match /^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*){1,3}$/.`);
  }
  for (const field of ["label", "pluralLabel"] as const) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "" || value.length > 80) throw new StorageConfigError(`${where}: ${field} must be 1–80 characters.`);
  }
  if (!permissionList(record.view) || !permissionList(record.manage)) throw new StorageConfigError(`${where}: view and manage must be lists of permission keys.`);
  if (record.assigned !== undefined && (typeof record.assigned?.permission !== "string" || record.assigned.permission === "")) {
    throw new StorageConfigError(`${where}: assigned.permission must be a permission key.`);
  }
  if (typeof record.find !== "function") throw new StorageConfigError(`${where}: find must be a function.`);
}

/** The record types by type; a duplicate type throws (6.5). */
export function recordMap(records: readonly StorageRecordType[]): ReadonlyMap<string, StorageRecordType> {
  const map = new Map<string, StorageRecordType>();
  for (const record of records) {
    checkRecordType(record);
    if (map.has(record.type)) throw new StorageConfigError(`Two record types are both ${JSON.stringify(record.type)}.`);
    map.set(record.type, record);
  }
  return map;
}

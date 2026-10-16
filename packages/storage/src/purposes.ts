import { FILE_TYPE_KEYS, type FileTypeKey } from "./file-types.js";
import { StorageConfigError } from "./types.js";

/**
 * Purposes (D11, section 6.4): what a file is FOR decides where it goes
 * (private or public), what it may be, how big, and whether a full company
 * may still keep it. A purpose's key is stored in the row's `kind` column
 * (0.1's name), so it is permanent.
 *
 * Packages contribute their own (the estimator's `estimator.photo`, 2b-2's
 * `feedback.screenshot`) structurally: a plain object of this shape, no
 * storage import.
 */
export interface StoragePurpose {
  /** /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){0,3}$/. Permanent (stored in `kind`). */
  readonly key: string;
  /** "Photo or file" */
  readonly label: string;
  readonly access: "private" | "public";
  readonly types: readonly FileTypeKey[];
  /** The most one file of this purpose may be. */
  readonly maxBytes: number;
  /** Counted in the usage, never refused for the allowance (D11). With a share, for uploads from the public only (see below). */
  readonly exemptFromAllowance?: boolean;
  /**
   * 0–1 (review G6). This purpose's live bytes plus a new file must stay
   * within this share of the allowance, checked under the same lock as the
   * allowance (6.6 steps 5 and 8), whether or not it is exempt. Absent: no
   * share. No allowance (null): no share either.
   *
   * A SHARE IS FOR UPLOADS FROM THE PUBLIC (review SEC-02): it, and the
   * exemption with it, hold for files stored with no `addedBy` (a customer's),
   * and only those count toward it. A file a signed-in person adds to this
   * purpose (`addedBy` set: staff adding a photo to an estimate) is an
   * ordinary file: never refused by the share, and refused like any file
   * when the company is full. A share refusal reaches `onUsage` as
   * `share_full`.
   */
  readonly maxShareOfAllowance?: number;
  /** On top of `files.view` (D12, review G5): one of these is also needed to open a file of this purpose while it is on no record. Default ["files.view"]. */
  readonly view?: readonly string[];
  /** Offer Remove on the Files screen. Default true. false: it is removed where it is used. */
  readonly removableFromFiles?: boolean;
  /** Left off the Files screen until it is attached to a record (a customer's photo with no estimate yet, purged after 48 h by its feature; review BO-13). Default false. Still counted. */
  readonly hiddenUntilAttached?: boolean;
}

const MiB = 1024 * 1024;
const ALL_TYPES: readonly FileTypeKey[] = ["jpeg", "png", "webp", "gif", "heic", "pdf"];

/**
 * The built-in purposes (6.4):
 * - `attachment`: a photo or file on a visit, an estimate or an invoice. Its
 *   record's permissions decide who sees it (D12).
 * - `library`: the Files screen's own uploads, on no record.
 * - `company.logo`: the only PUBLIC purpose in 2b-1 (an email and a customer
 *   page show it to strangers). Exempt from the allowance, so a full company
 *   can still fix its logo; removed where it is set, never from Files. Seen
 *   on the Files screen with `files.view` alone (review FH-11): it named the
 *   template's `tenant.view`, a permission a host's own roles don't have, so
 *   an office role was listed every file but the logo while the usage still
 *   counted it.
 */
export const STORAGE_BUILT_IN_PURPOSES: readonly StoragePurpose[] = Object.freeze([
  Object.freeze({ key: "attachment", label: "Photo or file", access: "private", types: ALL_TYPES, maxBytes: 4 * MiB }),
  Object.freeze({ key: "library", label: "Company file", access: "private", types: ALL_TYPES, maxBytes: 4 * MiB }),
  Object.freeze({
    key: "company.logo",
    label: "Company logo",
    access: "public",
    types: ["png", "jpeg", "webp"] as readonly FileTypeKey[],
    maxBytes: 1 * MiB,
    exemptFromAllowance: true,
    removableFromFiles: false,
  }),
] satisfies StoragePurpose[]);

const PURPOSE_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){0,3}$/;

/** Refuses a malformed purpose at construction, never per request (a programming error, said once). */
export function checkPurpose(purpose: StoragePurpose): void {
  const where = `storage purpose ${JSON.stringify((purpose as { key?: unknown })?.key)}`;
  if (!purpose || typeof purpose !== "object") throw new StorageConfigError("A storage purpose must be an object.");
  if (typeof purpose.key !== "string" || purpose.key.length > 64 || !PURPOSE_KEY.test(purpose.key)) {
    throw new StorageConfigError(`${where}: the key must match /^[a-z][a-z0-9]*(\\.[a-z][a-z0-9-]*){0,3}$/ (at most 64 characters).`);
  }
  if (typeof purpose.label !== "string" || purpose.label.trim().length < 1 || purpose.label.length > 80) {
    throw new StorageConfigError(`${where}: the label must be 1–80 characters.`);
  }
  if (purpose.access !== "private" && purpose.access !== "public") throw new StorageConfigError(`${where}: access must be "private" or "public".`);
  if (!Array.isArray(purpose.types) || purpose.types.length === 0 || purpose.types.some((t) => !FILE_TYPE_KEYS.includes(t))) {
    throw new StorageConfigError(`${where}: types must list one or more of ${FILE_TYPE_KEYS.join(", ")}.`);
  }
  if (!Number.isInteger(purpose.maxBytes) || purpose.maxBytes < 1) throw new StorageConfigError(`${where}: maxBytes must be a positive whole number.`);
  if (
    purpose.maxShareOfAllowance !== undefined &&
    (typeof purpose.maxShareOfAllowance !== "number" || !(purpose.maxShareOfAllowance >= 0 && purpose.maxShareOfAllowance <= 1))
  ) {
    throw new StorageConfigError(`${where}: maxShareOfAllowance must be between 0 and 1.`);
  }
  if (purpose.view !== undefined && (!Array.isArray(purpose.view) || purpose.view.length === 0 || purpose.view.some((p) => typeof p !== "string" || p === ""))) {
    throw new StorageConfigError(`${where}: view must list one or more permission keys.`);
  }
}

/** The purposes by key; a duplicate key throws (6.6). */
export function purposeMap(purposes: readonly StoragePurpose[]): ReadonlyMap<string, StoragePurpose> {
  const map = new Map<string, StoragePurpose>();
  for (const purpose of purposes) {
    checkPurpose(purpose);
    if (map.has(purpose.key)) throw new StorageConfigError(`Two storage purposes have the key ${JSON.stringify(purpose.key)}.`);
    map.set(purpose.key, purpose);
  }
  return map;
}

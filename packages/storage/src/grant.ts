import type { StoragePurpose } from "./purposes.js";
import type { StorageRecordInfo, StorageRecordType } from "./records.js";
import type { StoredFile } from "./types.js";

/**
 * D12's rules for one file and one reader (review G5), in one place: the
 * signed-in handlers ask them for the person making the request, and a
 * signed link's `stillValid` can ask them again for the person who MADE the
 * link (review SEC-03), so a member demoted to crew, or taken off the visit,
 * stops opening the file through the link they copied too. In order,
 * stopping at the first that decides:
 *
 *   1. `files.manage`: view and remove any file of the company, orphans
 *      included (a file whose record type was uninstalled, or whose record
 *      was deleted), so an orphan can always be removed and stops counting;
 *   2. one of the record's `manage` permissions: view, add, remove;
 *   3. one of the record's `view` permissions: view;
 *   4. the record's `assigned` permission AND being assigned to it (a crew
 *      member on their own visit): view, and remove a file THEY added there
 *      within 24 hours;
 *   5. anyone else: nothing.
 *
 * A file on no record needs `files.view` and, when its purpose names its own
 * `view` list, one of those too.
 */

/** What one reader may do with one file. */
export interface FileGrant {
  readonly view: boolean;
  readonly remove: boolean;
  /** What the file is attached to, as the reader may see it. */
  readonly record: { type: string; label: string; href: string | null } | null;
}

export const NO_GRANT: FileGrant = { view: false, remove: false, record: null };

/** A crew member may take back their own photo for this long. */
export const RECENT_REMOVE_MS = 24 * 60 * 60 * 1000;

/** What a file on a record that is gone (or uninstalled) is shown as, to files.manage only. */
export const ORPHAN_LABEL = "Attached to something that was removed";

/** The reader: which permissions they hold (asked lazily, in order), and who they are (null: nobody named). */
export interface GrantReader {
  holds(permission: string): Promise<boolean>;
  any(permissions: readonly string[]): Promise<boolean>;
  readonly userId: string | null;
}

export interface GrantContext {
  readonly purposes: ReadonlyMap<string, StoragePurpose>;
  readonly records: ReadonlyMap<string, StorageRecordType>;
  readonly now: () => Date;
}

/** One record type's records among `ids`, in one `find`. */
export async function findRecords(tenantId: string, type: StorageRecordType, ids: readonly string[]): Promise<ReadonlyMap<string, StorageRecordInfo>> {
  if (ids.length === 0) return new Map();
  return type.find({ tenantId, ids: [...new Set(ids)] });
}

/**
 * D12 for one file. `found` is the record's lookup when the caller already
 * has it (a page of the list: one `find` per record type), or undefined to
 * look it up here.
 */
export async function grantFor(ctx: GrantContext, reader: GrantReader, file: StoredFile, found?: StorageRecordInfo | null): Promise<FileGrant> {
  const purpose = ctx.purposes.get(file.purpose);
  const recordType = file.record ? ctx.records.get(file.record.type) : undefined;
  let info: StorageRecordInfo | null = null;
  if (file.record && recordType) {
    info = found !== undefined ? found : ((await findRecords(file.tenantId, recordType, [file.record.id])).get(file.record.id) ?? null);
  }
  const display = file.record
    ? info && recordType
      ? { type: recordType.type, label: info.label, href: info.href }
      : { type: file.record.type, label: ORPHAN_LABEL, href: null }
    : null;
  // 1. files.manage: any file of the company, orphans included.
  if (await reader.holds("files.manage")) return { view: true, remove: true, record: display };
  if (file.record) {
    // A record type no longer installed, or a record `find` no longer
    // returns: only files.manage (above) may see it.
    if (!recordType || !info) return NO_GRANT;
    // 2. the record's manage permissions.
    if (await reader.any(recordType.manage)) return { view: true, remove: true, record: display };
    const views = await reader.any(recordType.view);
    // 4. assigned: their own record, and their own recent files.
    let assigned = false;
    if (recordType.assigned && (await reader.holds(recordType.assigned.permission))) {
      assigned = reader.userId !== null && info.assignedUserIds.includes(reader.userId);
    }
    if (!views && !assigned) return NO_GRANT;
    const own =
      assigned && file.addedBy !== null && file.addedBy === reader.userId && file.createdAt.getTime() > ctx.now().getTime() - RECENT_REMOVE_MS;
    return { view: true, remove: own, record: display };
  }
  // A file on no record: files.view and the purpose's own view list.
  if (!(await reader.holds("files.view"))) return NO_GRANT;
  if (!(await reader.any(purpose?.view ?? ["files.view"]))) return NO_GRANT;
  return { view: true, remove: false, record: null };
}

/** A reader over a plain "does this person hold this permission" answer, each permission asked once. */
export function readerFor(userId: string, holds: (permission: string) => boolean | Promise<boolean>): GrantReader {
  const answers = new Map<string, Promise<boolean>>();
  const reader: GrantReader = {
    userId,
    holds(permission) {
      let answer = answers.get(permission);
      if (!answer) {
        answer = Promise.resolve(holds(permission)).then((value) => value === true);
        answers.set(permission, answer);
      }
      return answer;
    },
    async any(permissions) {
      for (const permission of permissions) if (await reader.holds(permission)) return true;
      return false;
    },
  };
  return reader;
}

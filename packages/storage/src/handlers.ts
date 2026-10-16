import { z } from "zod";
import { readSingleFileUpload } from "./body.js";
import { contentDisposition } from "./filenames.js";
import { FILE_TYPES, fileTypeOfContentType, PREVIEWABLE_TYPES, uploadRuleInWords } from "./file-types.js";
import {
  CROSS_SITE_MESSAGE,
  failure,
  FILE_NOT_FOUND_MESSAGE,
  FilesHttpError,
  isCrossSiteRequest,
  json,
  NOT_FOUND_MESSAGE,
  readJsonBody,
  safeDecode,
} from "./http.js";
import { findRecords, grantFor as grantOf, ORPHAN_LABEL, RECENT_REMOVE_MS, type FileGrant, type GrantContext } from "./grant.js";
import { SHARE_FULL_SENTENCE, type Storage } from "./instance.js";
import type { StorageRecordInfo, StorageRecordType } from "./records.js";
import type { StorageAdminRouteKind } from "./routes.js";
import { StorageError, type StoredFile, type StorageUsage } from "./types.js";
import type { AttachmentsWire, FileLinkWire, FileListWire, FileResponse, FileWire, RemoveResponse, UploadRulesWire, UsageWire } from "./wire.js";

/**
 * The company's signed-in file routes (section 6.7): what
 * `@adminigloo/storage-widget/admin`'s `<RecordFiles>`, `<FilesManager>` and
 * `<UsageMeter>` speak. One `handle(req)`, routed by the path after
 * `/v1/admin/`:
 *
 *   // app/api/app/[tenantId]/files/[...path]/route.ts
 *   const { handle } = createStorageHandlers({ storage, resolveTenant, authorize });
 *   export { handle as GET, handle as POST };
 *
 * THE ROW DECIDES (D12, review G5). `usage`, `files` and `upload` ask one
 * permission each. Every route that reads ONE file, or a record's files,
 * asks what that row needs (grant.ts, shared with a signed link's re-check),
 * in order, stopping at the first that decides:
 *
 *   1. `files.manage`: view and remove any file of the company, orphans
 *      included (a file whose record type was uninstalled, or whose record
 *      was deleted), so an orphan can always be removed and stops counting;
 *   2. one of the record's `manage` permissions: view, add, remove;
 *   3. one of the record's `view` permissions: view;
 *   4. the record's `assigned` permission AND being assigned to it (a crew
 *      member on their own visit): view and add, and remove a file THEY added
 *      there within 24 hours (a blurry photo, the wrong house);
 *   5. anyone else: 404, never 403, so an id from another company, another
 *      crew, or a record the reader can't see reveals nothing.
 *
 * `files.view` alone opens NO record's files: a member who can't see
 * invoices can't see an invoice's attachments by way of the Files screen.
 * A file on no record needs `files.view` and, when its purpose names its own
 * `view` list, one of those too.
 *
 * NEVER CROSS-ORIGIN: no CORS headers, ever, and every POST (the uploads
 * included) must pass the same-site check. A PRIVATE object's key never
 * appears in any answer (D10): the wire has no field for it, and every
 * private file is streamed by this handler (never a redirect to the store;
 * review BO-24).
 */

export type StorageAuthorizeResult = boolean | { userId?: string | number | null } | Response;

export interface CreateStorageHandlersOptions {
  readonly storage: Storage;
  /** A fixed company (a single business). Pass this or `resolveTenant`. */
  readonly tenantId?: string;
  /** The company a request is for (a company id in the path). null → 404. */
  readonly resolveTenant?: (req: Request) => string | null | Promise<string | null>;
  /** Asked for each permission a route or a record needs (D12), in order; the host memoises per request (2a's seams do). */
  readonly authorize: (req: Request, permission: string, tenantId: string) => StorageAuthorizeResult | Promise<StorageAuthorizeResult>;
  /** Names for "Added by". Absent: not shown. */
  readonly names?: (tenantId: string, userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  /**
   * false → 429 rate_limited "Too many uploads for now. Try again in a few
   * minutes." `userId` is the person `authorize` named (null when it named
   * nobody), so a host can limit uploads per person (review BO-09).
   */
  readonly rateLimit?: (req: Request, bucket: "upload" | "link", tenantId: string, userId: string | null) => boolean | Promise<boolean>;
  /** The company's name, for the sentence a member sees when storage is full (review BO-07). Absent: "The company". */
  readonly companyName?: (tenantId: string) => Promise<string | null>;
  /**
   * Where the company's logo is changed, in a few words ("company settings"),
   * for the sentence Remove is answered with on the logo: "This is removed
   * where it's used: in company settings." Absent (review FH-11: a host may
   * have no page by that name): "This is your logo: change it where you set
   * it, not here."
   */
  readonly logoSettings?: string;
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly route: string }) => void;
  readonly now?: () => Date;
}

export interface StorageHandlers {
  handle(req: Request): Promise<Response>;
}

/** A host's `Response` from `authorize`, answered as it is (2a 3.5). */
class Respond extends Error {
  readonly name = "Respond";
  constructor(readonly response: Response) {
    super("respond");
  }
}

const PAGE_SIZE = 30;
const RATE_LIMITED = "Too many uploads for now. Try again in a few minutes.";
const LINK_RATE_LIMITED = "Too many links for now. Try again in a few minutes.";
/** The logo's Remove, on a host that didn't say where its logo is set (review FH-11). */
const LOGO_NOT_HERE = "This is your logo: change it where you set it, not here.";

/** The route a path names, by method. */
function route(pathname: string): { byMethod: Partial<Record<"GET" | "POST", StorageAdminRouteKind>>; fileId?: string } | null {
  const path = pathname.replace(/\/+$/, "");
  const at = path.lastIndexOf("/v1/admin/");
  if (at < 0) return null;
  const parts = path.slice(at + "/v1/admin/".length).split("/").map(safeDecode);
  if (parts.some((part) => part === "")) return null;
  const [head, id, action] = parts;
  if (head === "usage" && parts.length === 1) return { byMethod: { GET: "usage" } };
  if (head === "attachments" && parts.length === 1) return { byMethod: { GET: "attachments", POST: "attach" } };
  if (head !== "files") return null;
  if (parts.length === 1) return { byMethod: { GET: "files", POST: "upload" } };
  if (parts.length === 2) return { byMethod: { GET: "file-get" }, fileId: id as string };
  if (parts.length === 3 && action === "content") return { byMethod: { GET: "file-content" }, fileId: id as string };
  if (parts.length === 3 && action === "link") return { byMethod: { POST: "file-link" }, fileId: id as string };
  if (parts.length === 3 && action === "remove") return { byMethod: { POST: "file-remove" }, fileId: id as string };
  return null;
}

const ROUTE_PERMISSION: Partial<Record<StorageAdminRouteKind, { permission: string; refusal: string }>> = {
  usage: { permission: "files.view", refusal: "You don't have permission to see files." },
  files: { permission: "files.view", refusal: "You don't have permission to see files." },
  upload: { permission: "files.manage", refusal: "You don't have permission to add files." },
};

const listQuerySchema = z.object({
  purpose: z.string().min(1).max(64).optional(),
  record: z.string().min(1).max(64).optional(),
  sort: z.enum(["newest", "size"], { message: "Sort by newest or size." }).optional(),
  cursor: z.string().min(1).max(600).optional(),
});

const recordQuerySchema = z.object({
  record: z.string({ message: "Say which kind of record." }).min(1, "Say which kind of record.").max(64),
  id: z.string({ message: "Say which record." }).min(1, "Say which record.").max(200),
});

/** One request's permission asks, memoised: each permission is asked once, in the order the rules need them. */
class Asker {
  private readonly answers = new Map<string, Promise<boolean>>();
  userId: string | null = null;
  constructor(
    private readonly req: Request,
    private readonly tenantId: string,
    private readonly authorize: CreateStorageHandlersOptions["authorize"],
  ) {}

  holds(permission: string): Promise<boolean> {
    let answer = this.answers.get(permission);
    if (!answer) {
      answer = (async () => {
        const verdict = await this.authorize(this.req, permission, this.tenantId);
        if (verdict instanceof Response) throw new Respond(verdict);
        if (verdict && typeof verdict === "object") {
          const id = verdict.userId;
          if (this.userId === null && id !== null && id !== undefined && String(id) !== "") this.userId = String(id);
          return true;
        }
        return verdict === true;
      })();
      this.answers.set(permission, answer);
    }
    return answer;
  }

  async any(permissions: readonly string[]): Promise<boolean> {
    for (const permission of permissions) if (await this.holds(permission)) return true;
    return false;
  }
}

function usageWire(usage: StorageUsage): UsageWire {
  return { usedBytes: usage.usedBytes, fileCount: usage.fileCount, allowanceBytes: usage.allowanceBytes };
}

export function createStorageHandlers(options: CreateStorageHandlersOptions): StorageHandlers {
  if (!options?.storage) throw new Error("createStorageHandlers: pass storage (createStorage(…))");
  if (!options.tenantId && !options.resolveTenant) throw new Error("createStorageHandlers: pass tenantId or resolveTenant");
  if (typeof options.authorize !== "function") throw new Error("createStorageHandlers: pass authorize (your permission check)");
  const storage = options.storage;
  const clock = () => options.now?.() ?? new Date();
  const report = (error: unknown, tenantId: string | null, kind: string) => {
    try {
      options.onError?.(error, { tenantId, route: kind });
    } catch {
      /* a broken reporter must not turn a handled answer into a crash */
    }
  };
  const fileNotFound = () => new FilesHttpError("not_found", FILE_NOT_FOUND_MESSAGE);
  const recordNotFound = () => new FilesHttpError("not_found", NOT_FOUND_MESSAGE);

  function uploadRules(purposeKey: string): UploadRulesWire {
    const purpose = storage.purposes.get(purposeKey);
    const state = storage.available(purposeKey);
    const types = purpose?.types ?? [];
    const maxBytes = Math.min(purpose?.maxBytes ?? storage.maxUploadBytes, storage.maxUploadBytes);
    const accept = types.map((t) => FILE_TYPES[t].contentType);
    // iPhones offer HEIC by extension as often as by type.
    if (types.includes("heic")) accept.push(".heic", ".heif");
    return {
      available: state.available,
      offReason: state.available ? null : state.reason,
      maxBytes,
      accept,
      rule: uploadRuleInWords(types, maxBytes),
    };
  }

  // D12 (grant.ts): the same rules a signed link's re-check asks for its maker.
  const grantCtx: GrantContext = { purposes: storage.purposes, records: storage.records, now: clock };
  const grantFor = (a: Asker, file: StoredFile, found?: StorageRecordInfo | null): Promise<FileGrant> => grantOf(grantCtx, a, file, found);

  async function addedByNames(tenantId: string, files: readonly StoredFile[]): Promise<ReadonlyMap<string, string>> {
    if (!options.names) return new Map();
    const ids = [...new Set(files.map((file) => file.addedBy).filter((id): id is string => typeof id === "string" && id !== ""))];
    if (ids.length === 0) return new Map();
    try {
      return await options.names(tenantId, ids);
    } catch (error) {
      // "Added by" is a convenience: a broken lookup is reported and the
      // names are left off, never the whole list.
      report(error, tenantId, "names");
      return new Map();
    }
  }

  function toWire(file: StoredFile, grant: FileGrant, names: ReadonlyMap<string, string>, a: Asker): FileWire {
    const type = fileTypeOfContentType(file.contentType);
    const purpose = storage.purposes.get(file.purpose);
    // A public purpose's file opens at its public address; everything else
    // (a 0.1 or 2a file still in the public store included) through the
    // signed-in route, which reads from the store the row is in.
    const url = purpose?.access === "public" && file.access === "public" && file.publicUrl ? file.publicUrl : storage.contentUrl(file.tenantId, file.id);
    const removable = purpose?.removableFromFiles !== false;
    return {
      id: file.id,
      name: file.filename,
      contentType: file.contentType,
      kind: type && PREVIEWABLE_TYPES.has(type) ? "photo" : "document",
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
      purpose: file.purpose,
      purposeLabel: purpose?.label ?? "File",
      record: grant.record,
      addedBy: file.addedBy ? (names.get(file.addedBy) ?? null) : null,
      at: file.createdAt.toISOString(),
      url,
      canRemove: grant.remove && removable,
      canLink: storage.linksEnabled && grant.view && file.access === "private" && a.userId !== null,
    };
  }

  async function usageFor(a: Asker, tenantId: string): Promise<UsageWire | null> {
    // A crew member (no files.view) never learns the company's usage.
    return (await a.holds("files.view")) ? usageWire(await storage.usage(tenantId)) : null;
  }

  async function limited(req: Request, bucket: "upload" | "link", tenantId: string, a: Asker): Promise<void> {
    if (!options.rateLimit) return;
    if (!(await options.rateLimit(req, bucket, tenantId, a.userId))) {
      throw new FilesHttpError("rate_limited", bucket === "upload" ? RATE_LIMITED : LINK_RATE_LIMITED);
    }
  }

  /** A StorageError as the wire's answer, worded for THIS caller (review BO-07). */
  async function wireStorageError(error: StorageError, a: Asker, tenantId: string): Promise<FilesHttpError> {
    switch (error.code) {
      case "storage_full": {
        if (error.share) return new FilesHttpError("storage_full", SHARE_FULL_SENTENCE);
        let manages = false;
        try {
          manages = await a.holds("files.manage");
        } catch {
          manages = false;
        }
        if (manages) return new FilesHttpError("storage_full", error.message);
        let company: string | null = null;
        try {
          company = (await options.companyName?.(tenantId)) ?? null;
        } catch (lookup) {
          report(lookup, tenantId, "company-name");
        }
        const who = company && company.trim() !== "" ? `${company.trim()}'s` : "The company's";
        return new FilesHttpError("storage_full", `${who} storage is full, so this wasn't added. Ask the owner to make room.`);
      }
      case "unknown_record":
        return recordNotFound();
      case "unknown_purpose":
        throw error;
      default:
        return new FilesHttpError(error.code, error.message);
    }
  }

  async function oneFile(a: Asker, tenantId: string, fileId: string): Promise<{ file: StoredFile; grant: FileGrant }> {
    // files.manage is asked BEFORE the lookup (6.7): the host's gate answers
    // a non-member or a signed-out caller with its own Response whether or
    // not the id exists, so the answer never says which ids are real.
    await a.holds("files.manage");
    const file = await storage.get({ tenantId, fileId });
    if (!file) throw fileNotFound();
    const grant = await grantFor(a, file);
    if (!grant.view) throw fileNotFound();
    return { file, grant };
  }

  async function recordAccess(a: Asker, tenantId: string, req: Request) {
    // The gate first, before any lookup (see oneFile).
    await a.holds("files.manage");
    const params = new URL(req.url).searchParams;
    const parsed = recordQuerySchema.safeParse({ record: params.get("record") ?? undefined, id: params.get("id") ?? undefined });
    if (!parsed.success) {
      throw new FilesHttpError("invalid", "Say which record.", parsed.error.issues.map((i) => ({ path: i.path.filter((p): p is string | number => typeof p !== "symbol"), message: i.message })));
    }
    const recordType = storage.records.get(parsed.data.record);
    if (!recordType) throw recordNotFound();
    const info = (await findRecords(tenantId, recordType, [parsed.data.id])).get(parsed.data.id);
    if (!info) throw recordNotFound();
    const record = { type: recordType.type, id: parsed.data.id };
    // CONTRACT: 6.7 says files.manage "decides at once"; it grants viewing
    // AND adding on a record that exists in this company (the owner and
    // admins hold it, and they hold every record's manage list by default).
    if (await a.holds("files.manage")) return { recordType, info, record, view: true, add: true, manageAll: true, assigned: false };
    if (await a.any(recordType.manage)) return { recordType, info, record, view: true, add: true, manageAll: true, assigned: false };
    const views = await a.any(recordType.view);
    let assigned = false;
    if (recordType.assigned && (await a.holds(recordType.assigned.permission))) {
      assigned = a.userId !== null && info.assignedUserIds.includes(a.userId);
    }
    return { recordType, info, record, view: views || assigned, add: assigned, manageAll: false, assigned };
  }

  async function dispatch(req: Request, kind: StorageAdminRouteKind, fileId: string | undefined, tenantId: string, a: Asker): Promise<Response> {
    const fixed = ROUTE_PERMISSION[kind];
    if (fixed && !(await a.holds(fixed.permission))) throw new FilesHttpError("forbidden", fixed.refusal);

    switch (kind) {
      case "usage":
        return json(usageWire(await storage.usage(tenantId)));

      case "files": {
        const params = new URL(req.url).searchParams;
        const query = listQuerySchema.safeParse(Object.fromEntries(params.entries()));
        if (!query.success) throw query.error;
        const { purpose, record, sort, cursor } = query.data;
        if (purpose !== undefined && !storage.purposes.has(purpose)) {
          throw new FilesHttpError("invalid", "Pick a kind of file from the list.", [{ path: ["purpose"], message: "Pick a kind of file from the list." }]);
        }
        if (record !== undefined && record !== "none" && !storage.records.has(record)) {
          throw new FilesHttpError("invalid", "Pick what the files are attached to from the list.", [{ path: ["record"], message: "Pick what the files are attached to from the list." }]);
        }
        const page = await storage.list({
          tenantId,
          ...(purpose !== undefined ? { purpose } : {}),
          ...(record === "none" ? { recordType: null } : record !== undefined ? { recordType: record } : {}),
          sort: sort === "size" ? "largest" : "newest",
          cursor: cursor ?? null,
          limit: PAGE_SIZE,
        });
        // One `find` per record type per page, never one per file.
        const byType = new Map<string, string[]>();
        for (const file of page.files) {
          if (!file.record || !storage.records.has(file.record.type)) continue;
          const ids = byType.get(file.record.type) ?? [];
          ids.push(file.record.id);
          byType.set(file.record.type, ids);
        }
        const found = new Map<string, ReadonlyMap<string, StorageRecordInfo>>();
        for (const [type, ids] of byType) found.set(type, await findRecords(tenantId, storage.records.get(type) as StorageRecordType, ids));
        // A RUNTIME PERMISSION FILTER over the page (D12, review G5): rows the
        // reader can't open under the record's own rules are dropped, so a
        // member holding files.view but not invoices.view never sees an
        // invoice attachment listed. The usage stays the company's whole usage.
        const visible: { file: StoredFile; grant: FileGrant }[] = [];
        for (const file of page.files) {
          const info = file.record ? (found.get(file.record.type)?.get(file.record.id) ?? null) : undefined;
          const grant = await grantFor(a, file, info);
          if (grant.view) visible.push({ file, grant });
        }
        const names = await addedByNames(tenantId, visible.map((v) => v.file));
        const manages = await a.holds("files.manage");
        const recordTypes: FileListWire["recordTypes"] = [];
        for (const type of storage.records.values()) {
          const sees =
            manages ||
            (await a.any(type.manage)) ||
            (await a.any(type.view)) ||
            (type.assigned ? await a.holds(type.assigned.permission) : false);
          if (sees) recordTypes.push({ type: type.type, label: type.pluralLabel });
        }
        const present = await storage.purposesPresent(tenantId);
        const body: FileListWire = {
          files: visible.map((v) => toWire(v.file, v.grant, names, a)),
          nextCursor: page.nextCursor,
          usage: usageWire(await storage.usage(tenantId)),
          uploads: uploadRules("library"),
          canUpload: manages && storage.available("library").available,
          purposes: present.flatMap((key) => {
            const known = storage.purposes.get(key);
            return known ? [{ key, label: known.label }] : [];
          }),
          recordTypes,
        };
        return json(body);
      }

      case "upload": {
        await limited(req, "upload", tenantId, a);
        const state = storage.available("library");
        if (!state.available) throw new FilesHttpError("storage_off", state.reason);
        const upload = await readSingleFileUpload(req, storage.maxUploadBytes);
        const file = await storage.store({
          tenantId,
          purpose: "library",
          bytes: upload.bytes,
          declaredType: upload.type,
          filename: upload.name ? upload.name.slice(-200) : null,
          addedBy: a.userId,
        });
        const grant: FileGrant = { view: true, remove: true, record: null };
        const body: FileResponse = { file: toWire(file, grant, await addedByNames(tenantId, [file]), a), usage: await usageFor(a, tenantId) };
        return json(body, 201);
      }

      case "file-get": {
        const { file, grant } = await oneFile(a, tenantId, fileId ?? "");
        const body: FileResponse = { file: toWire(file, grant, await addedByNames(tenantId, [file]), a), usage: await usageFor(a, tenantId) };
        return json(body);
      }

      case "file-content": {
        const { file } = await oneFile(a, tenantId, fileId ?? "");
        const etag = file.sha256 ? `"${file.sha256}"` : null;
        const type = fileTypeOfContentType(file.contentType);
        const image = type !== null && FILE_TYPES[type].image;
        const headers = contentHeaders(file, {
          "cache-control": image ? "private, max-age=300" : "private, no-cache",
        });
        // Review BO-19: a thumbnail asked for again is answered from the ROW,
        // before the store is read.
        if (etag && ifNoneMatch(req, etag)) return new Response(null, { status: 304, headers: notModifiedHeaders(headers) });
        const opened = await storage.open({ tenantId, fileId: file.id });
        if (!opened) throw fileNotFound();
        return new Response(opened.object.body as BodyInit, { status: 200, headers: withLength(headers, opened.object, file) });
      }

      case "file-link": {
        const { file } = await oneFile(a, tenantId, fileId ?? "");
        if (!storage.linksEnabled) throw new FilesHttpError("storage_off", "Links to files aren't switched on.");
        if (file.access !== "private") throw new FilesHttpError("invalid", "This file already has its own address.");
        if (a.userId === null) throw new FilesHttpError("forbidden", "Sign in again to make a link.");
        await limited(req, "link", tenantId, a);
        await readJsonBody(req);
        const link = await storage.signedLink({ tenantId, fileId: file.id, userId: a.userId });
        if (!link) throw fileNotFound();
        const body: FileLinkWire = { url: link.url, expiresAt: link.expiresAt.toISOString() };
        return json(body);
      }

      case "file-remove": {
        const { file, grant } = await oneFile(a, tenantId, fileId ?? "");
        // Nothing granted beyond viewing: the same 404 as a stranger.
        if (!grant.remove) throw fileNotFound();
        const purpose = storage.purposes.get(file.purpose);
        if (purpose?.removableFromFiles === false) {
          // CONTRACT: a purpose that is "removed where it is used" (the logo,
          // an estimate's own photos) is refused here for everyone: removing
          // it from Files would leave its feature pointing at nothing.
          if (purpose.key === "company.logo") {
            const settings = options.logoSettings?.trim();
            throw new FilesHttpError("not_removable", settings ? `This is removed where it's used: in ${settings}.` : LOGO_NOT_HERE);
          }
          const where = grant.record && grant.record.label !== ORPHAN_LABEL ? `on ${grant.record.label}` : null;
          throw new FilesHttpError("not_removable", where ? `This is removed where it's used: ${where}.` : "This is removed where it's used.");
        }
        await readJsonBody(req);
        const result = await storage.remove({ tenantId, fileId: file.id });
        if (!result.removed) throw fileNotFound();
        const body: RemoveResponse = { removed: true, usage: await usageFor(a, tenantId) };
        return json(body);
      }

      case "attachments": {
        const access = await recordAccess(a, tenantId, req);
        if (!access.view) throw recordNotFound();
        // The record's files of purpose `attachment` only (D12, review
        // BO-13): a feature's own photos show in the feature's own panel.
        const files: StoredFile[] = [];
        let cursor: string | null = null;
        do {
          const page: { readonly files: readonly StoredFile[]; readonly nextCursor: string | null } = await storage.list({
            tenantId,
            purpose: "attachment",
            record: access.record,
            includeHidden: true,
            cursor,
            limit: 100,
          });
          files.push(...page.files);
          cursor = page.nextCursor;
        } while (cursor && files.length < 500);
        const names = await addedByNames(tenantId, files);
        const display = { type: access.recordType.type, label: access.info.label, href: access.info.href };
        const now = clock().getTime();
        const body: AttachmentsWire = {
          record: display,
          files: files.map((file) =>
            toWire(
              file,
              {
                view: true,
                remove:
                  access.manageAll ||
                  (access.assigned && file.addedBy !== null && file.addedBy === a.userId && file.createdAt.getTime() > now - RECENT_REMOVE_MS),
                record: display,
              },
              names,
              a,
            ),
          ),
          canAdd: access.add && storage.available("attachment").available,
          uploads: uploadRules("attachment"),
        };
        return json(body);
      }

      case "attach": {
        const access = await recordAccess(a, tenantId, req);
        if (!access.add) throw recordNotFound();
        await limited(req, "upload", tenantId, a);
        const state = storage.available("attachment");
        if (!state.available) throw new FilesHttpError("storage_off", state.reason);
        const upload = await readSingleFileUpload(req, storage.maxUploadBytes);
        const file = await storage.store({
          tenantId,
          purpose: "attachment",
          bytes: upload.bytes,
          declaredType: upload.type,
          filename: upload.name ? upload.name.slice(-200) : null,
          addedBy: a.userId,
          record: access.record,
        });
        const display = { type: access.recordType.type, label: access.info.label, href: access.info.href };
        const body: FileResponse = {
          file: toWire(file, { view: true, remove: true, record: display }, await addedByNames(tenantId, [file]), a),
          usage: await usageFor(a, tenantId),
        };
        return json(body, 201);
      }
    }
  }

  async function handle(req: Request): Promise<Response> {
    // No CORS headers, ever: the files API is same-origin only.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const found = route(new URL(req.url).pathname);
    if (!found) return failure(fileNotFoundOrPath());
    const kind = found.byMethod[req.method as "GET" | "POST"];
    if (!kind) {
      const allow = Object.keys(found.byMethod).join(", ");
      return json({ error: { code: "invalid", message: `Use ${allow} for this address.` } }, 405, { allow });
    }
    if (req.method === "POST" && isCrossSiteRequest(req)) return failure(new FilesHttpError("cross_site", CROSS_SITE_MESSAGE));
    let tenantId: string | null = null;
    try {
      tenantId = options.resolveTenant ? await options.resolveTenant(req) : (options.tenantId ?? null);
      if (!tenantId) return failure(new FilesHttpError("not_found", NOT_FOUND_MESSAGE));
      const a = new Asker(req, tenantId, options.authorize);
      try {
        return await dispatch(req, kind, found.fileId, tenantId, a);
      } catch (error) {
        if (error instanceof StorageError) throw await wireStorageError(error, a, tenantId);
        throw error;
      }
    } catch (error) {
      if (error instanceof Respond) return error.response;
      if (!(error instanceof FilesHttpError) && !(error instanceof z.ZodError)) report(error, tenantId, kind);
      return failure(error);
    }
  }

  return { handle };
}

function fileNotFoundOrPath(): FilesHttpError {
  return new FilesHttpError("not_found", NOT_FOUND_MESSAGE);
}

/** Does If-None-Match name this ETag (or `*`)? Weak validators compare equal. */
export function ifNoneMatch(req: Request, etag: string): boolean {
  const header = req.headers.get("if-none-match");
  if (!header) return false;
  return header
    .split(",")
    .map((part) => part.trim().replace(/^W\//, ""))
    .some((part) => part === "*" || part === etag);
}

/**
 * The headers every private file is served with (6.7), here and on a signed
 * link (6.8): its stored type (a 0.1 row of a type 0.2 doesn't keep goes as
 * `application/octet-stream`, a download), the disposition with the stored,
 * extension-corrected name, the ETag, and the three that keep a file from
 * ever running as a page: nosniff, a CSP that allows nothing and sandboxes
 * it, and no referrer.
 */
export function contentHeaders(file: StoredFile, extra: Record<string, string>): Headers {
  const type = fileTypeOfContentType(file.contentType);
  const headers = new Headers({
    "content-type": type ? FILE_TYPES[type].contentType : "application/octet-stream",
    "content-disposition": contentDisposition(type && FILE_TYPES[type].image ? "inline" : "attachment", file.filename),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    ...extra,
  });
  if (file.sha256) headers.set("etag", `"${file.sha256}"`);
  return headers;
}

export function notModifiedHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete("content-type");
  out.delete("content-disposition");
  out.delete("content-length");
  return out;
}

export function withLength(headers: Headers, object: { readonly size: number | null; readonly body: unknown }, file: StoredFile): Headers {
  const out = new Headers(headers);
  const size = object.body instanceof Uint8Array ? object.body.byteLength : (object.size ?? file.sizeBytes);
  if (Number.isFinite(size) && size >= 0) out.set("content-length", String(size));
  return out;
}

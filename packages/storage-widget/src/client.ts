import { createRequester, isObject, listOf, num, numOrNull, str, strOrNull, stringList, type Result, type TransportOptions } from "./http.js";
import type {
  AttachmentsWire,
  FileLinkWire,
  FileListWire,
  FileResponse,
  FileWire,
  RemoveResponse,
  UploadRulesWire,
  UsageWire,
} from "./types.js";

/**
 * The files screens' transport: one method per route of
 * @adminigloo/storage's `createStorageHandlers` (contract 6.7). A host that
 * backs the screens with something else passes its own object of this shape
 * as `transport`.
 */
export interface FilesTransport {
  usage(): Promise<Result<UsageWire>>;
  files(q?: { purpose?: string; record?: string; sort?: "newest" | "size"; cursor?: string }): Promise<Result<FileListWire>>;
  upload(file: Blob, name: string): Promise<Result<FileResponse>>;
  file(id: string): Promise<Result<FileResponse>>;
  link(id: string): Promise<Result<FileLinkWire>>;
  remove(id: string): Promise<Result<RemoveResponse>>;
  attachments(record: { type: string; id: string }): Promise<Result<AttachmentsWire>>;
  attach(record: { type: string; id: string }, file: Blob, name: string, onProgress?: (fraction: number) => void): Promise<Result<FileResponse>>;
  /** The content route for a file id (what an <img> uses). */
  contentUrl(id: string): string;
}

export function parseUsage(raw: unknown): UsageWire | null {
  if (!isObject(raw) || typeof raw.usedBytes !== "number") return null;
  return { usedBytes: num(raw.usedBytes), fileCount: num(raw.fileCount), allowanceBytes: numOrNull(raw.allowanceBytes) };
}

function parseRules(raw: unknown): UploadRulesWire {
  const r = isObject(raw) ? raw : {};
  return {
    available: r.available === true,
    offReason: strOrNull(r.offReason),
    maxBytes: num(r.maxBytes),
    accept: stringList(r.accept),
    rule: str(r.rule),
  };
}

function parseRecordRef(raw: unknown): { type: string; label: string; href: string | null } | null {
  if (!isObject(raw) || typeof raw.type !== "string" || typeof raw.label !== "string") return null;
  return { type: raw.type, label: raw.label, href: strOrNull(raw.href) };
}

export function parseFile(raw: unknown): FileWire | null {
  if (!isObject(raw) || typeof raw.id !== "string" || typeof raw.url !== "string") return null;
  return {
    id: raw.id,
    name: str(raw.name, "File"),
    contentType: str(raw.contentType, "application/octet-stream"),
    kind: raw.kind === "photo" ? "photo" : "document",
    sizeBytes: num(raw.sizeBytes),
    width: numOrNull(raw.width),
    height: numOrNull(raw.height),
    purpose: str(raw.purpose),
    purposeLabel: str(raw.purposeLabel, "File"),
    record: parseRecordRef(raw.record),
    addedBy: strOrNull(raw.addedBy),
    at: str(raw.at),
    url: raw.url,
    canRemove: raw.canRemove === true,
    canLink: raw.canLink === true,
  };
}

function parseList(raw: unknown): FileListWire | null {
  if (!isObject(raw) || !Array.isArray(raw.files)) return null;
  return {
    files: listOf(raw.files, parseFile),
    nextCursor: strOrNull(raw.nextCursor),
    usage: parseUsage(raw.usage) ?? { usedBytes: 0, fileCount: 0, allowanceBytes: null },
    uploads: parseRules(raw.uploads),
    canUpload: raw.canUpload === true,
    purposes: listOf(raw.purposes, (p) => (isObject(p) && typeof p.key === "string" ? { key: p.key, label: str(p.label, p.key) } : null)),
    recordTypes: listOf(raw.recordTypes, (r) => (isObject(r) && typeof r.type === "string" ? { type: r.type, label: str(r.label, r.type) } : null)),
  };
}

function parseAttachments(raw: unknown): AttachmentsWire | null {
  if (!isObject(raw) || !Array.isArray(raw.files)) return null;
  const record = parseRecordRef(raw.record);
  if (!record) return null;
  return { record, files: listOf(raw.files, parseFile), canAdd: raw.canAdd === true, uploads: parseRules(raw.uploads) };
}

function parseFileResponse(raw: unknown): FileResponse | null {
  const file = isObject(raw) ? parseFile(raw.file) : null;
  return file ? { file, usage: isObject(raw) ? parseUsage(raw.usage) : null } : null;
}

function parseLink(raw: unknown): FileLinkWire | null {
  return isObject(raw) && typeof raw.url === "string" ? { url: raw.url, expiresAt: str(raw.expiresAt) } : null;
}

function parseRemove(raw: unknown): RemoveResponse | null {
  return isObject(raw) && raw.removed === true ? { removed: true, usage: parseUsage(raw.usage) } : null;
}

const segment = (value: string) => encodeURIComponent(value);

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") search.set(key, value);
  const text = search.toString();
  return text ? `?${text}` : "";
}

function form(file: Blob, name: string): FormData {
  const data = new FormData();
  // A File carrying the name (a shrunk photo is a bare Blob): every runtime
  // then sends the same filename, whatever its FormData does with a Blob.
  const named = typeof File === "function" && !(file instanceof File && file.name === name) ? new File([file], name, { type: file.type }) : file;
  // Exactly one part, a file named `file` (6.7): anything else is refused.
  data.append("file", named, name);
  return data;
}

/** The transport over HTTP, at `baseUrl` (the handler's mount). Never throws. */
export function createFilesClient(options: TransportOptions): FilesTransport {
  const http = createRequester(options);
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    usage: () => http.get("/v1/admin/usage", parseUsage),
    files: (q = {}) => http.get(`/v1/admin/files${query({ purpose: q.purpose, record: q.record, sort: q.sort, cursor: q.cursor })}`, parseList),
    upload: (file, name) => http.upload("/v1/admin/files", form(file, name), parseFileResponse),
    file: (id) => http.get(`/v1/admin/files/${segment(id)}`, parseFileResponse),
    link: (id) => http.post(`/v1/admin/files/${segment(id)}/link`, {}, parseLink),
    remove: (id) => http.post(`/v1/admin/files/${segment(id)}/remove`, {}, parseRemove),
    attachments: (record) => http.get(`/v1/admin/attachments${query({ record: record.type, id: record.id })}`, parseAttachments),
    attach: (record, file, name, onProgress) =>
      http.upload(`/v1/admin/attachments${query({ record: record.type, id: record.id })}`, form(file, name), parseFileResponse, onProgress),
    contentUrl: (id) => `${base}/v1/admin/files/${segment(id)}/content`,
  };
}

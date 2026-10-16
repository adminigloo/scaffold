/**
 * @adminigloo/storage-widget, entry `.`: the wire types, the wire version and
 * the transport (Tenancy 2b-1, section 7). The photos and files screens
 * themselves are under `./admin`, like every other staff screen, so a page
 * that only needs the types never ships them.
 */
export { STORAGE_WIRE_VERSION } from "./version.js";
export { createFilesClient } from "./client.js";
export type { FilesTransport } from "./client.js";
export type { ClientError, Result, TransportOptions } from "./http.js";
export type {
  AttachmentsWire,
  FileLinkWire,
  FileListWire,
  FileResponse,
  FilesErrorCode,
  FileWire,
  Instant,
  RemoveResponse,
  UploadRulesWire,
  UsageWire,
  WireErrorBody,
  WireIssue,
} from "./types.js";

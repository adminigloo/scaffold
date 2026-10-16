/**
 * @adminigloo/storage-widget/admin: the photos and files of one record, the
 * company Files screen, the usage meter and their transport (Tenancy 2b-1,
 * section 7).
 */
export { STORAGE_WIRE_VERSION } from "../version.js";
export { RecordFiles } from "./RecordFiles.js";
export type { RecordFilesProps } from "./RecordFiles.js";
export { FilesManager } from "./FilesManager.js";
export type { FilesManagerProps } from "./FilesManager.js";
export { UsageMeter } from "./UsageMeter.js";
export type { UsageMeterProps } from "./UsageMeter.js";
export { shrinkPhoto } from "../shrink.js";
export type { PhotoEncoder, ShrinkOptions } from "../shrink.js";
export { createFilesClient } from "../client.js";
export type { FilesTransport } from "../client.js";
export type { ClientError, Result, TransportOptions } from "../http.js";
export { filesWidgetCss, injectFilesStyles } from "../styles.js";
export { formatBytes } from "./words.js";
export type {
  AttachmentsWire,
  FileLinkWire,
  FileListWire,
  FileResponse,
  FilesErrorCode,
  FileWire,
  RemoveResponse,
  UploadRulesWire,
  UsageWire,
} from "../types.js";

/**
 * @adminigloo/storage 0.2: a company's photos and files, private by default.
 *
 * Rows in your database, bytes behind a store you choose (./vercel-blob,
 * ./s3, ./local, or ./testing's memory store). Every read, list and delete
 * names the company; the record a file belongs to decides who sees it; an
 * upload is checked for its type (from its bytes) and size and against the
 * company's allowance under a lock; deleting removes the stored object from
 * the store it is in; private files are served only through the company's
 * signed-in route or a short-lived signed link that stops working when its
 * maker leaves. See README.md and docs/tenancy-2b1-contract.md section 6.
 *
 * This entry is server code (no React). The screens are
 * @adminigloo/storage-widget.
 */

export { createStorage, DEFAULT_MAX_UPLOAD_BYTES, MAX_PURGE_ATTEMPTS, SHARE_FULL_SENTENCE, STORAGE_OFF_SENTENCE, storageFullSentence } from "./instance.js";
export type {
  CreateStorageOptions,
  Storage,
  StorageDb,
  StorageListInput,
  StorageLogoStore,
  StorageLinkCheck,
  StoragePurposeStore,
  StorageSigningOptions,
} from "./instance.js";

export { InvalidKeyError, InvalidStoreError, StorageConfigError, StorageError } from "./types.js";
export type {
  BlobBody,
  BlobObject,
  BlobStore,
  BlobStoreV1,
  StorageErrorCode,
  StorageUsage,
  StorageUsageEvent,
  StoredFile,
  StoreInput,
} from "./types.js";

export { isLegacyKey, STORAGE_KEY_PATTERN } from "./keys.js";
export { FILE_TYPES, formatBytes, imageSize, sniffFileType } from "./file-types.js";
export type { FileTypeInfo, FileTypeKey } from "./file-types.js";
export { STORAGE_BUILT_IN_PURPOSES } from "./purposes.js";
export type { StoragePurpose } from "./purposes.js";
export type { StorageRecordType } from "./records.js";

export { defineStorageTables, InvalidTableNameError, storageTables, storedFiles } from "./schema.js";
export type { DefineStorageTablesOptions, StorageTables, StoredFilesTable } from "./schema.js";
export { storageSql, storageUpgradeSql } from "./sql.js";

export { storagePermissions } from "./permissions.js";
export type { StoragePermission, StoragePermissionDefinition } from "./permissions.js";

export { createStorageHandlers } from "./handlers.js";
export type { CreateStorageHandlersOptions, StorageAuthorizeResult, StorageHandlers } from "./handlers.js";
export { createStorageLinkHandlers } from "./link-handlers.js";
export type { CreateStorageLinkHandlersOptions } from "./link-handlers.js";
export { STORAGE_ADMIN_ROUTES, STORAGE_PUBLIC_ROUTES } from "./routes.js";
export type { StorageAdminRouteKind, StoragePublicRouteKind, StorageRoute } from "./routes.js";
export type * from "./wire.js";

export { askForRoom, STORAGE_ALMOST_FULL_KIND, STORAGE_FULL_KIND, STORAGE_SHARE_FULL_KIND, storageAlertKinds, storageUsageAlert } from "./alerts.js";
export type { StorageAlertChannel, StorageAlertDraft, StorageAlertKind, StorageAlertKinds, StorageAlertRouting } from "./alerts.js";

// 0.1's API, kept (6.11). All but sanitizeFilename are @deprecated.
export { sanitizeFilename } from "./filenames.js";
export { DEFAULT_MAX_SIZE_BYTES, deleteFile, getFile, listFiles, storeFile, storeFileSchema } from "./legacy.js";
export type { StoredFileRow, StoreFileInput } from "./legacy.js";

/**
 * THE WIRE TYPES — what @adminigloo/storage's `createStorageHandlers` sends
 * and accepts, as JSON (Tenancy 2b-1 contract, 6.10).
 *
 * SHARED WITH @adminigloo/storage (its src/wire.ts declares the same region);
 * change both or neither. The widget never imports the server package at
 * runtime, so the wire-parity test reads BOTH files from disk and fails the
 * build if the region between the WIRE markers differs by a single byte.
 *
 * There is no field for a key, a pathname or a store (D10).
 */

// WIRE:BEGIN
export type Instant = string;
export type FilesErrorCode =
  | "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "internal"
  | "storage_off" | "file_type" | "file_too_big" | "storage_full" | "not_removable";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: FilesErrorCode; message: string; issues?: WireIssue[] } }

export interface UsageWire { usedBytes: number; fileCount: number; /** null = no allowance. */ allowanceBytes: number | null }
export interface UploadRulesWire {
  /** False with `offReason`: nothing can be added right now. */
  available: boolean;
  offReason: string | null;
  maxBytes: number;
  /** For the file input's accept attribute. */
  accept: string[];
  /** In words: "Photos (JPEG, PNG, WebP, HEIC) or PDFs, up to 4 MB". */
  rule: string;
}
export interface FileWire {
  id: string;
  name: string;
  contentType: string;
  /** For the icon, the preview and the filter. */
  kind: "photo" | "document";
  sizeBytes: number;
  width: number | null;
  height: number | null;
  purpose: string;
  purposeLabel: string;
  /** What it's attached to; label "Attached to something that was removed" (href null) for an orphan, shown to files.manage only (D12). */
  record: { type: string; label: string; href: string | null } | null;
  addedBy: string | null;
  at: Instant;
  /** Where it opens: the signed-in content route, or a public file's address. */
  url: string;
  canRemove: boolean;
  canLink: boolean;
}
export interface FileListWire {
  files: FileWire[];
  nextCursor: string | null;
  usage: UsageWire;
  uploads: UploadRulesWire;
  canUpload: boolean;
  /** The purposes present, for the filter: { key, label }. */
  purposes: { key: string; label: string }[];
  /** The installed record types the reader can see files of, for the filter (review BO-22): { type: "scheduling.visit", label: "Visits" } (the type's `pluralLabel`). */
  recordTypes: { type: string; label: string }[];
}
export interface AttachmentsWire {
  record: { type: string; label: string; href: string | null };
  files: FileWire[];
  canAdd: boolean;
  uploads: UploadRulesWire;
}
export interface FileResponse { file: FileWire; /** null for someone without files.view (a crew member). */ usage: UsageWire | null }
export interface RemoveResponse { removed: true; usage: UsageWire | null }
export interface FileLinkWire { url: string; expiresAt: Instant }
// WIRE:END

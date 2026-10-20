import type { FileWire, UsageWire } from "../types.js";

/**
 * The screens' plain words. A business owner never reads a key, a store or
 * a byte count: "412 KB", "iPhone photo (HEIC)", "Using 120 MB of 5 GB".
 */

/**
 * Bytes in words: "412 KB", "3.1 MB", "1 GB". COPIED from @adminigloo/storage's
 * file-types.ts (`formatBytes`), never imported; change both or neither, so
 * a screen and the server's sentences say the same size the same way.
 */
export function formatBytes(bytes: number, locale = "en-US"): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  const format = (n: number, digits: number) => {
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
    } catch {
      return String(Math.round(n * 10 ** digits) / 10 ** digits);
    }
  };
  if (value < 1024) return value === 1 ? "1 byte" : `${format(value, 0)} bytes`;
  const kb = value / 1024;
  if (kb < 1024) return `${format(kb < 10 ? Math.round(kb * 10) / 10 : Math.round(kb), kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${format(mb < 100 ? Math.round(mb * 10) / 10 : Math.round(mb), mb < 100 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${format(Math.round(gb * 10) / 10, 1)} GB`;
}

/** "Oct 13, 2:05 PM", in the viewer's own clock. Bad input → the raw text. */
export function formatWhen(instant: string, locale = "en-US"): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
  } catch {
    return date.toISOString();
  }
}

/** An iPhone photo: shown as a row, never as an <img> a desktop browser can't draw (review BO-21). */
export function isHeicFile(file: Pick<FileWire, "contentType" | "name">): boolean {
  return /^image\/hei[cf]/i.test(file.contentType) || /\.(heic|heif)$/i.test(file.name);
}

/** What kind of file it is, in words, for a document row. */
export function kindLabel(file: Pick<FileWire, "contentType" | "name">): string {
  if (isHeicFile(file)) return "iPhone photo (HEIC)";
  if (file.contentType === "application/pdf") return "PDF";
  if (file.contentType.startsWith("image/")) return "Photo";
  return "File";
}

export type UsageTone = "ok" | "warn" | "full" | "none";

/**
 * 90 % or more is "almost full"; at or over the allowance is "full"; no
 * allowance has no tone. `refusedFull` (review BO-10): a file was just
 * refused because storage is full, so it is full for that file, whatever the
 * last few bytes say.
 */
export function usageTone(usage: UsageWire, refusedFull = false): UsageTone {
  if (usage.allowanceBytes === null || !(usage.allowanceBytes > 0)) return "none";
  if (refusedFull || usage.usedBytes >= usage.allowanceBytes) return "full";
  if (usage.usedBytes >= 0.9 * usage.allowanceBytes) return "warn";
  return "ok";
}

/** "Using 120 MB of 5 GB", or "Using 120 MB" with no allowance. */
export function usageSentence(usage: UsageWire, locale?: string): string {
  if (usage.allowanceBytes === null) return `Using ${formatBytes(usage.usedBytes, locale)}`;
  return `Using ${formatBytes(usage.usedBytes, locale)} of ${formatBytes(usage.allowanceBytes, locale)}`;
}

export interface UsageNoteOptions {
  /** The address people write to for more room (review BO-6): "…or write to Igloo Back Office at help@igloo.test for more room." */
  supportEmail?: string | undefined;
  /** Can the reader remove files (`canUpload`, files.manage)? Default true. false (review BO-9, D11): told to ask the owner, never to delete. */
  canMakeRoom?: boolean | undefined;
  /** A file was just refused because storage is full (review BO-10). */
  refusedFull?: boolean | undefined;
}

/**
 * Who to ask for more room: "ask Igloo Back Office", or with an address
 * (review BO-6) "write to Igloo Back Office at help@igloo.test". COPIED from
 * @adminigloo/storage's alerts.ts (`askForRoom`), so the meter and the alert
 * email say it the same way.
 */
export function askForRoom(platformName: string | undefined, supportEmail?: string): string | null {
  const who = platformName?.trim();
  const email = supportEmail?.trim();
  if (email) return `write to ${who || "us"} at ${email}`;
  return who ? `ask ${who}` : null;
}

/** The line under the meter, by tone (review BO-07: the full one names who to ask for more room). */
export function usageNote(usage: UsageWire, platformName?: string, options: UsageNoteOptions = {}): string | null {
  const tone = usageTone(usage, options.refusedFull === true);
  const canMakeRoom = options.canMakeRoom !== false;
  if (tone === "warn") return canMakeRoom ? "Almost full: delete files you no longer need." : "Almost full. The owner can make room.";
  if (tone === "full") {
    if (!canMakeRoom) return "Full: ask the owner to make room.";
    const ask = askForRoom(platformName, options.supportEmail);
    return ask ? `Full: new files can't be added until you delete some, or ${ask} for more room.` : "Full: new files can't be added until you delete some.";
  }
  return null;
}

/**
 * Where the logo is changed, for a person who manages files (review FH-11):
 * the host's own page when it says ("company settings"), else a sentence
 * that names no page.
 */
export function logoHint(logoSettings?: string): string {
  const where = logoSettings?.trim();
  return where ? `Change it in ${where}.` : "Change it where you set your logo.";
}

export const WORDS = {
  photosAndFiles: "Photos and files",
  takePhoto: "Take a photo",
  addPhotosOrFiles: "Add photos or files",
  addFiles: "Add photos or files",
  uploadFile: "Upload a file",
  dropHere: "Or drop photos and files here.",
  copyLink: "Copy a link (works for 1 hour)",
  linkCopied: "Link copied. It works for 1 hour.",
  linkReady: "Here's the link. It works for 1 hour:",
  remove: "Remove",
  tryAgain: "Try again",
  saveToPhone: "Save to phone",
  retry: "Retry",
  open: "Open",
  back: "Back",
  loading: "Loading photos and files…",
  loadingFiles: "Loading files…",
  loadMore: "Load more",
  notAvailable: "These files aren't available to you.",
  empty: "Nothing here yet.",
  filesEmpty: "No files yet. Photos and files added to visits, estimates and invoices show up here.",
  filesEmptyTitle: "No photos or files yet",
  filesEmptyText:
    "Once you're using it, every photo and file your team adds to a visit, an estimate or an invoice lands here, so the before-and-after shots and the signed paperwork are never in someone's camera roll.",
  notYetAdded: "A photo hasn't been added yet.",
  uploading: "Sending…",
  making: "Making it smaller…",
  all: "All",
  notAttached: "Not attached",
  newest: "Newest first",
  largest: "Largest first",
} as const;

export function removeQuestion(name: string): string {
  return `Remove ${name}? It's deleted for good.`;
}

/** A filter chip's word for a purpose that is on no record by nature ("Company logo" → "Logo"). */
export function purposeFilterLabel(purpose: { key: string; label: string }): string {
  return purpose.key === "company.logo" ? "Logo" : purpose.label;
}

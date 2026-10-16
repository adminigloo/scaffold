import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { isTenantId, type FeedbackDb } from "./core.js";
import { feedbackTickets, feedbackUploads } from "./schema.js";

/**
 * Screenshots (0.10.0): what the bytes really are, where they are kept, which
 * report may use which, and the sweep of the ones nobody sent.
 */

// ---------------------------------------------------------------------------
// The bytes
// ---------------------------------------------------------------------------

export type FeedbackImageType = "image/png" | "image/jpeg" | "image/webp";

/**
 * What an upload REALLY is, from its first bytes — never what the browser
 * said (0.9 trusted the declared type, so an HTML page sent as "image/png"
 * was stored as one). PNG, JPEG and WebP only: what the widget's screenshot
 * is, and nothing that can carry a script. null: not one of them.
 */
export function sniffImage(bytes: Uint8Array): FeedbackImageType | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export const IMAGE_EXTENSION: Readonly<Record<FeedbackImageType, string>> = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
});

// ---------------------------------------------------------------------------
// Where they are kept
// ---------------------------------------------------------------------------

/**
 * Where a board's screenshots are kept (0.10.0), structurally — this package
 * imports no file storage:
 *
 *   put     keep the bytes; answer the address the board shows (a public
 *           file's address, or a private file's signed-in route) and, for a
 *           private one, its file id
 *   attach  the report that uses it arrived: put the file on its ticket, so
 *           the ticket's permissions decide who opens it
 *   remove  nobody sent a report with it: delete it
 *
 * With @adminigloo/storage: `storage.purposeStore("feedback.screenshot")`
 * (feedbackScreenshotPurpose) does all three, keeping the picture private.
 */
export interface FeedbackScreenshotStore {
  put(input: {
    readonly tenantId: string;
    readonly bytes: Uint8Array;
    readonly contentType: FeedbackImageType;
    readonly filename: string;
  }): Promise<{ readonly url: string; readonly fileId?: string | null }>;
  attach?(input: { readonly tenantId: string; readonly fileId: string; readonly ticketId: string }): Promise<void>;
  remove?(input: { readonly tenantId: string; readonly url: string; readonly fileId: string | null }): Promise<void>;
}

/** The record a screenshot is put on (structurally storage's record reference). */
export const FEEDBACK_TICKET_RECORD = "feedback.ticket";

/**
 * The purpose a screenshot is kept under in @adminigloo/storage, structurally
 * its `StoragePurpose`: register it in `createStorage({ purposes })` and use
 * `storage.purposeStore("feedback.screenshot")`.
 *
 * PRIVATE: a customer's screenshot shows their account, their address, their
 * order — never a public page. Hidden until the report arrives (then it is on
 * its ticket, and the ticket's permissions decide), swept after a day
 * otherwise. Counted in the company's room but never refused for it, and
 * never more than a tenth of it: strangers send these.
 */
export const feedbackScreenshotPurpose = Object.freeze({
  key: "feedback.screenshot",
  label: "Feedback screenshot",
  access: "private",
  types: Object.freeze(["jpeg", "png", "webp"] as const),
  maxBytes: 4 * 1024 * 1024,
  exemptFromAllowance: true,
  maxShareOfAllowance: 0.1,
  view: Object.freeze(["feedback.view"] as const),
  removableFromFiles: false,
  hiddenUntilAttached: true,
} as const);

/** A ticket as a file record type (Tenancy 2b-1, 3.5), structurally storage's `StorageRecordType`. */
export interface FeedbackFileRecordType {
  readonly type: string;
  readonly label: string;
  readonly pluralLabel: string;
  readonly view: readonly string[];
  readonly manage: readonly string[];
  readonly assigned?: { readonly permission: string };
  find(input: { readonly tenantId: string; readonly ids: readonly string[] }): Promise<
    ReadonlyMap<string, { readonly label: string; readonly href: string | null; readonly assignedUserIds: readonly string[] }>
  >;
}

const HREF_PATTERN = /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * `feedback.ticket`: who may see the board sees a ticket's screenshots
 * (`feedback.view`); who works it manages them (`feedback.manage`). `find` is
 * one query inside the company; its label ("Feedback FB-00012 · The gate code
 * doesn't work") is what the Files screen says it's attached to.
 */
export function feedbackFileRecords(db: FeedbackDb, options: { readonly ticketHref: string }): readonly FeedbackFileRecordType[] {
  const tickets: FeedbackFileRecordType = {
    type: FEEDBACK_TICKET_RECORD,
    label: "Feedback",
    pluralLabel: "Feedback",
    view: Object.freeze(["feedback.view"]),
    manage: Object.freeze(["feedback.manage"]),
    async find(input) {
      const out = new Map<string, { label: string; href: string | null; assignedUserIds: readonly string[] }>();
      const ids = [...new Set(input.ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 500);
      if (ids.length === 0 || !isTenantId(input.tenantId)) return out;
      const rows = (await db
        .select({ id: feedbackTickets.id, number: feedbackTickets.ticketNumber, title: feedbackTickets.title })
        .from(feedbackTickets)
        .where(and(eq(feedbackTickets.tenantId, input.tenantId), inArray(feedbackTickets.id, ids)))) as Array<{ id: string; number: string; title: string }>;
      for (const row of rows) {
        const title = row.title.replace(CONTROL, " ").replace(/\s{2,}/g, " ").trim().slice(0, 80);
        const href = options.ticketHref.replace(/\{id\}/g, encodeURIComponent(row.id));
        out.set(row.id, {
          label: title ? `Feedback ${row.number} · ${title}` : `Feedback ${row.number}`,
          href: HREF_PATTERN.test(href) ? href : null,
          assignedUserIds: [],
        });
      }
      return out;
    },
  };
  return Object.freeze([tickets]);
}

// ---------------------------------------------------------------------------
// Which report may use which
// ---------------------------------------------------------------------------

/** How long an upload waits for its report before the sweep may delete it. */
export const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

export async function recordUpload(
  db: FeedbackDb,
  input: {
    readonly tenantId: string;
    readonly url: string;
    readonly fileId: string | null;
    readonly kind: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  },
): Promise<void> {
  await db.insert(feedbackUploads).values({ ...input }).onConflictDoNothing();
}

/**
 * The screenshots a report may carry: only addresses this board's upload
 * route stored, not yet used by another report, still inside their grace
 * period. Anything else is dropped (the report still arrives, without it).
 */
export async function claimableUploads(
  db: FeedbackDb,
  tenantId: string,
  urls: readonly string[],
  now: Date = new Date(),
): Promise<ReadonlyMap<string, { readonly id: string; readonly fileId: string | null }>> {
  const wanted = [...new Set(urls.filter((url) => url.length > 0))];
  if (!isTenantId(tenantId) || wanted.length === 0) return new Map();
  const rows = (await db
    .select({ id: feedbackUploads.id, url: feedbackUploads.url, fileId: feedbackUploads.fileId, createdAt: feedbackUploads.createdAt })
    .from(feedbackUploads)
    .where(and(eq(feedbackUploads.tenantId, tenantId), inArray(feedbackUploads.url, wanted), isNull(feedbackUploads.ticketId)))) as Array<{
    id: string;
    url: string;
    fileId: string | null;
    createdAt: Date;
  }>;
  return new Map(
    rows
      .filter((row) => now.getTime() - new Date(row.createdAt).getTime() < UPLOAD_GRACE_MS)
      .map((row) => [row.url, { id: row.id, fileId: row.fileId }] as const),
  );
}

/** The report arrived: these uploads are its (and nobody else's). */
export async function markUploadsUsed(db: FeedbackDb, tenantId: string, uploadIds: readonly string[], ticketId: string): Promise<void> {
  if (uploadIds.length === 0) return;
  await db
    .update(feedbackUploads)
    .set({ ticketId })
    .where(and(eq(feedbackUploads.tenantId, tenantId), inArray(feedbackUploads.id, [...uploadIds]), isNull(feedbackUploads.ticketId)));
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Delete the screenshots nobody sent a report with (0.10.0): an upload with no
 * ticket after `UPLOAD_GRACE_MS` — the person closed the form, or a script
 * uploaded without reporting. For the whole site in one pass (every company's
 * leftovers), oldest first, within a time budget. The stored file goes first
 * (`store.remove`), then the row; a file the store couldn't delete keeps its
 * row, so the next run tries again. Without a `remove` (a 0.9 `storeFile`
 * only puts), the rows are dropped and the files stay where they were.
 */
export async function sweepFeedbackUploads(
  db: FeedbackDb,
  options: {
    readonly store?: Pick<FeedbackScreenshotStore, "remove"> | ((tenantId: string) => Pick<FeedbackScreenshotStore, "remove"> | undefined);
    readonly now?: Date;
    readonly limit?: number;
    readonly timeBudgetMs?: number;
    readonly onError?: (error: unknown, context: { tenantId: string; uploadId: string }) => void;
  } = {},
): Promise<{ readonly removed: number; readonly failed: number }> {
  const now = options.now ?? new Date();
  const started = Date.now();
  const budget = options.timeBudgetMs ?? 15_000;
  const before = new Date(now.getTime() - UPLOAD_GRACE_MS);
  const rows = (await db
    .select({ id: feedbackUploads.id, tenantId: feedbackUploads.tenantId, url: feedbackUploads.url, fileId: feedbackUploads.fileId })
    .from(feedbackUploads)
    .where(and(isNull(feedbackUploads.ticketId), lt(feedbackUploads.createdAt, before)))
    .orderBy(feedbackUploads.createdAt)
    .limit(Math.min(Math.max(options.limit ?? 200, 1), 1000))) as Array<{ id: string; tenantId: string; url: string; fileId: string | null }>;
  let removed = 0;
  let failed = 0;
  for (const row of rows) {
    if (Date.now() - started > budget) break;
    const store = typeof options.store === "function" ? options.store(row.tenantId) : options.store;
    try {
      await store?.remove?.({ tenantId: row.tenantId, url: row.url, fileId: row.fileId });
      await db.delete(feedbackUploads).where(and(eq(feedbackUploads.id, row.id), isNull(feedbackUploads.ticketId)));
      removed += 1;
    } catch (error) {
      failed += 1;
      try {
        options.onError?.(error, { tenantId: row.tenantId, uploadId: row.id });
      } catch {
        /* a broken reporter must not stop the sweep */
      }
    }
  }
  return { removed, failed };
}

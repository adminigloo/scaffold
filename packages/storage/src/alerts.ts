import { formatBytes } from "./file-types.js";

/**
 * Storage's own alert kinds (section 6.15, review BO-07): somebody hears when
 * the company's files fill up. Declared STRUCTURALLY in 3.2's shape: no
 * notifications import (2a D4). The host composes the fragment into its
 * registry (`defineAlertRegistry([..., storageAlertKinds])`) and turns each
 * `onUsage` event into a draft with `storageUsageAlert`.
 *
 * The dedupe keys make "once a month" (almost full) and "once a day" (a
 * refusal) true by construction (D7): a second draft with the same key for
 * the same person is a no-op in notifications' unique index.
 */

export type StorageAlertChannel = "in_app" | "email";

export interface StorageAlertKind {
  /** Permanent. /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){1,3}$/, at most 64 characters. */
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly category: string;
  readonly audience: {
    readonly permission: string;
    readonly routing?: string;
    readonly assigned?: { readonly permission: string };
  };
  readonly defaultChannel: StorageAlertChannel;
  readonly email?: boolean;
  readonly emailBy?: "notifications" | "producer";
  readonly order?: number;
}

export interface StorageAlertRouting {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly permission: string;
  readonly order?: number;
}

export interface StorageAlertKinds {
  readonly kinds: readonly StorageAlertKind[];
  readonly routings: readonly StorageAlertRouting[];
}

/** 3.3's draft, storage's copy. */
export interface StorageAlertDraft {
  readonly tenantId: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly assignedHref?: string | null;
  readonly dedupeKey: string;
  readonly subject: { readonly type: string; readonly id: string } | null;
  readonly actorUserId: string | null;
  readonly assignedUserIds?: readonly string[];
  readonly replyTo?: string | null;
}

export const STORAGE_ALMOST_FULL_KIND = "storage.files.almost-full";
export const STORAGE_FULL_KIND = "storage.files.full";
/** Review SEC-02: a purpose's share is used up (customers' estimate photos are being turned away). */
export const STORAGE_SHARE_FULL_KIND = "storage.files.share-full";

/** The share of the allowance at which "almost full" is said. */
export const ALMOST_FULL_AT = 0.9;

export const storageAlertKinds: StorageAlertKinds = Object.freeze({
  kinds: Object.freeze([
    Object.freeze({
      key: STORAGE_ALMOST_FULL_KIND,
      label: "Your files are almost full",
      description: "When the company has used 90% of its storage. At most once a month.",
      category: "Files",
      // The people who can make room: an alert to someone who can't delete a
      // file would only tell them to ask the owner.
      audience: Object.freeze({ permission: "files.manage" }),
      defaultChannel: "email",
      email: true,
      order: 10,
    }),
    Object.freeze({
      key: STORAGE_FULL_KIND,
      label: "A file couldn't be added because storage is full",
      description: "When someone tries to add a photo or file and there's no room. At most once a day.",
      category: "Files",
      audience: Object.freeze({ permission: "files.manage" }),
      defaultChannel: "email",
      email: true,
      order: 20,
    }),
    Object.freeze({
      key: STORAGE_SHARE_FULL_KIND,
      label: "Customers' photos couldn't be added: their part of storage is used up",
      description: "When the photos customers send have used all the room they may take (a fifth of your storage). At most once a day.",
      category: "Files",
      audience: Object.freeze({ permission: "files.manage" }),
      defaultChannel: "email",
      email: true,
      order: 30,
    }),
  ] satisfies StorageAlertKind[]),
  routings: Object.freeze([] as StorageAlertRouting[]),
});

/** "Estimate photo" → "Estimate photos". */
function plural(label: string): string {
  const trimmed = label.trim();
  return /s$/i.test(trimmed) ? trimmed : `${trimmed}s`;
}

/**
 * Who to ask for more room, as the end of a sentence (review BO-6): "ask
 * Igloo Back Office", or, with an address, "write to Igloo Back Office at
 * help@igloo.test", so the reader has a way to ask, not only a name.
 */
export function askForRoom(platformName: string | null | undefined, supportEmail?: string | null): string {
  const platform = platformName?.trim() || "us";
  const email = supportEmail?.trim();
  return email ? `write to ${platform} at ${email}` : `ask ${platform}`;
}

/**
 * The draft for one `onUsage` event, or null when it isn't worth an alert.
 * Pure: the host passes the Files page's path, the clock, its own name and
 * (review BO-6) the address people write to for more room.
 *
 *   stored, at 90 % or more of an allowance → "almost full", keyed by month (UTC)
 *   refused                                 → "full", keyed by day (UTC)
 *   share_full (review SEC-02)              → "their part is used up", keyed by purpose and day (UTC)
 *   anything else                           → null
 */
export function storageUsageAlert(
  event: {
    readonly tenantId: string;
    readonly usage: { readonly usedBytes: number; readonly allowanceBytes: number | null };
    readonly outcome: "stored" | "refused" | "share_full";
    readonly purpose?: string;
    readonly share?: { readonly purposeLabel: string; readonly usedBytes: number; readonly limitBytes: number };
  },
  options: { readonly href: string; readonly now: Date; readonly platformName: string; readonly supportEmail?: string | null; readonly locale?: string },
): StorageAlertDraft | null {
  const ask = askForRoom(options.platformName, options.supportEmail);
  const body = `Delete files you no longer need in Files, or ${ask} for more room.`;
  const iso = options.now.toISOString();
  if (event.outcome === "share_full") {
    if (!event.share) return null;
    const what = plural(event.share.purposeLabel);
    return {
      tenantId: event.tenantId,
      kind: STORAGE_SHARE_FULL_KIND,
      title: `${what} can't be added: they've used their part of your storage`,
      body: `${what} may use up to ${formatBytes(event.share.limitBytes, options.locale)} of your storage (${formatBytes(event.share.usedBytes, options.locale)} used), so they can't crowd out your other files. Remove the ones you no longer need where they're used, or ${ask} for more room.`,
      href: options.href,
      dedupeKey: `${STORAGE_SHARE_FULL_KIND}:${event.purpose ?? "share"}:${iso.slice(0, 10)}`,
      subject: null,
      actorUserId: null,
    };
  }
  if (event.outcome === "refused") {
    return {
      tenantId: event.tenantId,
      kind: STORAGE_FULL_KIND,
      title: "A file couldn't be added: your storage is full",
      body,
      href: options.href,
      dedupeKey: `${STORAGE_FULL_KIND}:${iso.slice(0, 10)}`,
      subject: null,
      actorUserId: null,
    };
  }
  const allowance = event.usage.allowanceBytes;
  if (event.outcome !== "stored" || allowance === null || !(allowance > 0)) return null;
  if (event.usage.usedBytes < ALMOST_FULL_AT * allowance) return null;
  return {
    tenantId: event.tenantId,
    kind: STORAGE_ALMOST_FULL_KIND,
    title: `Your files are almost full: ${formatBytes(event.usage.usedBytes, options.locale)} of ${formatBytes(allowance, options.locale)} used`,
    body,
    href: options.href,
    dedupeKey: `${STORAGE_ALMOST_FULL_KIND}:${iso.slice(0, 7)}`,
    subject: null,
    actorUserId: null,
  };
}

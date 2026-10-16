import type { PgDatabase } from "drizzle-orm/pg-core";
import type { AlertChannel, AlertRegistry } from "./registry.js";
import type { NotificationTables } from "./schema.js";

/**
 * The instance's public shapes (Tenancy 2b-1, 4.3). Declared once here so the
 * instance, the email engine, the handlers and the testing entry share them.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type NotificationsDb = PgDatabase<any, any, any>; // 0.1's name, kept

export interface AlertPerson {
  readonly userId: string;
  readonly name: string | null;
  /** Where their email copies go; null: in the app only. */
  readonly email: string | null;
  /**
   * Gets a routing group's alerts while the company chose nobody (the owner;
   * single mode: every staff admin). Mark at least one person per company;
   * otherwise routed alerts go to everyone who holds the group's permission
   * (D4, review G13).
   */
  readonly isOwner: boolean;
}

export interface AlertEmailMessage {
  readonly tenantId: string;
  readonly alertId: string;
  readonly kind: string;
  readonly to: string;
  readonly recipientName: string | null;
  /** true for an email-only address the owner added (it has no sign-in): no "change which alerts you get" line (4.9). */
  readonly addressOnly: boolean;
  /** Plain text, one line, `breakLinks` applied (D18). */
  readonly title: string;
  readonly body: string | null;
  /** The alert's path on this site; the host makes it absolute (companies: through the switch route). */
  readonly href: string | null;
  readonly replyTo: string | null;
  /** "alert:{alertId}", the same on every retry (D7). */
  readonly idempotencyKey: string;
}

export type AlertEmailOutcome =
  | { readonly status: "sent" }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "failed"; readonly error: string; readonly retryable: boolean };

export interface AlertEmailDelivery {
  readonly available: boolean;
  readonly offReason: string | null;
  /**
   * Kinds whose email the host has switched off where it keeps its message
   * wording (comms' Messages), each with the name of that message as the
   * owner sees it: { "estimator.lead": "New lead (to your office)" }.
   * Those kinds get no email copy, and Alert settings says where to turn them
   * back on (D6, review BO-11). Default {}.
   */
  readonly offKinds?: Readonly<Record<string, string>>;
}

export interface CreateNotificationsOptions {
  readonly db: NotificationsDb;
  /** REQUIRED (D14, review G1): `notificationTables` for the 0.1 names, or `defineNotificationTables({ prefix, schema })`. */
  readonly tables: NotificationTables;
  readonly registry: AlertRegistry;
  /**
   * The company's ACTIVE members holding `permission` right now, with their
   * sign-in address. A suspended, deleted or unknown company → []. Asked at
   * write time, per alert (D2, D9). A throw: that draft alerts nobody and is
   * reported (step "people").
   */
  readonly people: (tenantId: string, permission: string) => Promise<readonly AlertPerson[]>;
  /**
   * Where the owner's email copies of a ROUTED kind go while its group is on
   * "The owner" (no row, mode `owner`, or the empty-list fallback; D4, review
   * BO-01). null or absent: the owner's own address. A throw: the owner's own
   * address, reported (step "owner-email").
   */
  readonly ownerEmail?: (tenantId: string) => string | null | Promise<string | null>;
  /** Sends one email copy (D5). Absent: alerts are in the app only, and no email choice is offered. */
  readonly email?: (message: AlertEmailMessage) => Promise<AlertEmailOutcome>;
  /**
   * Does the `email` seam's provider drop a repeat of the same
   * `idempotencyKey` (Resend does; SMTP doesn't)? Default false. false: a copy
   * left `sending` by a send that was cut off, or whose seam THREW (the
   * message may have gone before the connection dropped; review FH-9), is
   * never sent again; it ends `failed` with "It may not have gone, and it
   * isn't sent again so nobody gets two." Only a seam that ANSWERS `{ status:
   * "failed", retryable: true }` is tried again. true: those are retried too
   * (D7, review G12).
   */
  readonly emailIdempotent?: boolean;
  /** Is email really leaving for this company, and if not, why (shown in Alert settings). Default: available exactly when `email` is given. */
  readonly emailDelivery?: (tenantId: string) => AlertEmailDelivery | Promise<AlertEmailDelivery>;
  /** Longest one email may hold up the request that caused the alert. Default 8000; 0 waits. */
  readonly sendTimeoutMs?: number;
  readonly now?: () => Date;
  /** Told about every step that failed. The instance never throws from notify; claimEmails throws only AlertsUnavailableError (4.5). Default console.error. */
  readonly onError?: (error: unknown, context: { readonly tenantId: string | null; readonly kind?: string; readonly step: string }) => void;
}

/** 3.3's `<Pkg>AlertDraft`, exactly. */
export interface AlertDraft {
  readonly tenantId: string;
  /** A registered kind key. */
  readonly kind: string;
  /** One line, 1–200 characters, plain text: no CR, LF, U+2028 or U+2029 (it becomes an email Subject; D18). */
  readonly title: string;
  /** At most 2000 characters, plain text, may have line breaks; null = none. */
  readonly body: string | null;
  /**
   * Where it opens: a path on this site ("/app/estimates/…") matching
   * /^\/(?![\/\\])[^\\\s\u0000-\u001f]{0,499}$/ (D18: no "//", no "/\", no
   * backslash, whitespace or control character anywhere); null = nothing to open.
   */
  readonly href: string | null;
  /** Where it opens for someone reached ONLY through `assigned` (crew). Default `href`. The same pattern as `href`. */
  readonly assignedHref?: string | null;
  /** D7: from the durable fact; 1–200 characters. */
  readonly dedupeKey: string;
  /** What it is about, e.g. { type: "scheduling.visit", id }. */
  readonly subject: { readonly type: string; readonly id: string } | null;
  /** Who caused it; never alerted about it. null for a customer or the system. */
  readonly actorUserId: string | null;
  /** For kinds with `audience.assigned`: who is on the record (as text). */
  readonly assignedUserIds?: readonly string[];
  /** Where a reply to the email copy goes (the customer, on a lead). */
  readonly replyTo?: string | null;
}

export interface AlertRow {
  readonly id: string;
  readonly tenantId: string;
  readonly recipientId: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly href: string | null;
  readonly subject: { readonly type: string; readonly id: string } | null;
  readonly readAt: Date | null;
  readonly createdAt: Date;
}

export interface NotifyReport {
  /** Rows written for people (extra addresses not counted). */
  readonly alerted: number;
  /** Rows the dedupe key already had (D7). */
  readonly duplicates: number;
  readonly emailed: number;
  readonly emailsFailed: number;
  /** Left for the cron: timed out, or failed in a way a retry could fix. */
  readonly emailsLater: number;
  /** Each draft refused or skipped, in words ("unknown alert kind estimator.leed"). For tests and logs. */
  readonly problems: readonly string[];
}

export interface RoutingChoice {
  readonly mode: "owner" | "chosen";
  readonly userIds: readonly string[];
  readonly extraEmails: readonly string[];
  readonly updatedAt: Date | null;
}

/**
 * Who is reading, and what they may get NOW (D2, review G4): the entries of
 * `registry.permissions` they hold. The handlers fill it from `authorize`; a
 * host calling the instance directly passes the person's permissions.
 */
export interface AlertReader {
  readonly tenantId: string;
  readonly userId: string;
  readonly permissions: readonly string[];
}

export interface DeliverPendingEmailsOptions {
  /** REQUIRED (D9, review G3): the companies whose emails may go now (the active ones). [] claims nothing. */
  readonly tenantIds: readonly string[];
  readonly limit?: number;
  readonly timeBudgetMs?: number;
  readonly maxAttempts?: number;
  readonly maxAgeMs?: number;
}

export interface DeliverPendingEmailsResult {
  readonly sent: number;
  readonly skipped: number;
  readonly failed: number;
  readonly retrying: number;
  readonly expired: number;
  readonly reclaimed: number;
  readonly stoppedEarly: boolean;
}

export interface CleanupOptions {
  readonly readOlderThanDays?: number;
  readonly anyOlderThanDays?: number;
  readonly limit?: number;
  readonly timeBudgetMs?: number;
}

export interface Notifications {
  readonly registry: AlertRegistry;
  readonly tables: NotificationTables;
  /** Write each draft's alerts and send their email copies (4.5). Never throws. */
  notify(drafts: AlertDraft | readonly AlertDraft[]): Promise<NotifyReport>;
  /**
   * A producer's office email (D6): the addresses still owed this alert's
   * email, claimed in the same statement. Throws `AlertsUnavailableError`
   * ONLY when its database statement fails (reported first), so the
   * listener falls back to `staffEmails` and the office still hears (3.4).
   * Every other problem is [] + onError.
   */
  claimEmails(input: {
    readonly tenantId: string;
    readonly kind: string;
    readonly dedupeKey: string;
    readonly assignedUserIds?: readonly string[];
    readonly actorUserId?: string | null;
  }): Promise<readonly string[]>;
  /**
   * The office email to `to` failed and a retry could help (D6, review
   * BO-02): that claimed row goes back to `pending`, due in 5 minutes, so the
   * alerts cron sends it as a `team_alert` copy. Answers how many rows moved
   * (0 or 1). Never throws (0 + onError).
   */
  releaseClaim(input: { readonly tenantId: string; readonly kind: string; readonly dedupeKey: string; readonly to: string }): Promise<number>;
  list(
    input: AlertReader & { readonly unreadOnly?: boolean; readonly cursor?: string | null; readonly limit?: number },
  ): Promise<{ readonly alerts: readonly AlertRow[]; readonly nextCursor: string | null }>;
  unreadCount(input: AlertReader): Promise<number>;
  /** "already" for an alert of theirs already read (two tabs); "not_found" for anyone else's id, or one of theirs they may no longer see (D2). */
  markRead(input: AlertReader & { readonly alertId: string }): Promise<"marked" | "already" | "not_found">;
  markAllRead(input: AlertReader): Promise<number>;
  /** The person's STORED choices only (D5). */
  choices(input: { readonly tenantId: string; readonly userId: string }): Promise<ReadonlyMap<string, AlertChannel>>;
  /** Throws AlertsInputError (unknown kind; email on a kind that is never emailed). */
  setChoice(input: { readonly tenantId: string; readonly userId: string; readonly kind: string; readonly channel: AlertChannel }): Promise<void>;
  routing(tenantId: string): Promise<ReadonlyMap<string, RoutingChoice>>;
  /** Throws AlertsInputError: unknown group; a person who isn't a member holding the group's permission ("Pick people from your company."); more than 20 people; more than 5 addresses or a bad one. */
  setRouting(input: {
    readonly tenantId: string;
    readonly routing: string;
    readonly mode: "owner" | "chosen";
    readonly userIds: readonly string[];
    readonly extraEmails: readonly string[];
    readonly by: string;
  }): Promise<RoutingChoice>;
  /** D9: a member removed or gone. */
  forget(input: { readonly tenantId: string; readonly userId: string }): Promise<{ readonly alerts: number; readonly choices: number; readonly routings: number }>;
  /**
   * D9, review G4: a member's role changed. `permissions` is the person's
   * set NOW (at least the entries of `registry.permissions` they hold).
   * Deletes their rows they may no longer see (the read filter's rule, by
   * `reached_via`) and takes them off routing lists whose permission they
   * lost. Never throws (zeros + onError).
   */
  prune(input: { readonly tenantId: string; readonly userId: string; readonly permissions: readonly string[] }): Promise<{
    readonly alerts: number;
    readonly routings: number;
  }>;
  /** The alerts cron (D8). */
  deliverPendingEmails(options: DeliverPendingEmailsOptions): Promise<DeliverPendingEmailsResult>;
  /** The alerts cron (D9). */
  cleanup(options?: CleanupOptions): Promise<{ readonly deleted: number; readonly stoppedEarly: boolean }>;
}

export class AlertsInputError extends Error {
  readonly name = "AlertsInputError";
  constructor(
    message: string,
    readonly issues: readonly { readonly path: (string | number)[]; readonly message: string }[] = [],
  ) {
    super(message);
  }
}

/** claimEmails' one throw: its database statement failed (the office falls back to the business address, 3.4). */
export class AlertsUnavailableError extends Error {
  readonly name = "AlertsUnavailableError";
  constructor(message = "Alerts couldn't be read just now.", options?: { cause?: unknown }) {
    super(message, options);
  }
}

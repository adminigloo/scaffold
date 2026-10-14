/**
 * THE WIRE TYPES — what @adminigloo/comms's `createCommsAdminHandlers`
 * sends and accepts, as JSON (Tenancy 2a contract, 9.6).
 *
 * SHARED WITH @adminigloo/comms (its src/wire.ts declares the same region);
 * change both or neither. The widget never imports the server package at
 * runtime, so the wire-parity test reads BOTH files from disk and fails the
 * build if the region between the WIRE markers differs by a single byte.
 */

// WIRE:BEGIN
export type Instant = string;
export type CommsErrorCode = "invalid" | "not_found" | "forbidden" | "cross_site" | "rate_limited" | "internal";
export interface WireIssue { path: (string | number)[]; message: string }
export interface WireErrorBody { error: { code: CommsErrorCode; message: string; issues?: WireIssue[] } }

export interface TemplateWire {
  key: string;
  channel: "email" | "sms";
  subject: string | null;
  body: string;
  active: boolean;
  updatedAt: Instant;
  /** The {{placeholders}} its subject and body use, in first-seen order. */
  variables: string[];
}
export interface TemplatesWire { templates: TemplateWire[] }
export interface TemplateBody { subject: string | null; body: string }   // subject ≤ 300, body 1..20000
export interface ActiveBody { active: boolean }

export type MessageStatus = "sent" | "skipped" | "failed" | "cancelled" | "expired";
export interface MessageWire {
  id: string;
  at: Instant;
  channel: "email" | "sms";
  to: string;
  templateKey: string | null;
  subject: string | null;
  status: MessageStatus;
  /** Why it was skipped, cancelled, expired or failed, in the log's words; null when sent. */
  note: string | null;
  /** Placeholders that rendered blank. */
  blanks: string[];
  fromName: string | null;
  replyTo: string | null;
}
export interface MessagesWire { messages: MessageWire[] }

export interface RunDueWire {
  sent: number; skipped: number; failed: number; retrying: number; cancelled: number; expired: number;
  stoppedEarly: boolean;
}
export interface CommsStatusWire {
  emails: boolean;
  emailsOffReason: string | null;
  fromName: string | null;
  replyTo: string | null;
  /**
   * pending: queued for later. behind: due over an hour ago and still waiting:
   * it missed a run (the job couldn't keep up, or isn't running). late: over
   * 26 hours past due: the daily job hasn't run at all.
   */
  scheduled: { pending: number; behind: number; late: number };
}
// WIRE:END

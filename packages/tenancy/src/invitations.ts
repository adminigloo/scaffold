import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface InvitationToken {
  /** Goes into the email link. Never stored, never logged. */
  readonly token: string;
  /** Goes into `tenant_invitations.token_hash`. */
  readonly tokenHash: string;
}

/**
 * Mint an invitation token and the hash to store beside it.
 *
 * 32 bytes from the CSPRNG — an invite link is a bearer credential, so it has
 * to be unguessable at the same strength as a session token, not merely long.
 * base64url because the value is pasted into a URL: base64 proper would arrive
 * with `+` and `/` percent-encoded by some clients and raw from others, and the
 * two forms hash differently, which shows up as invites that work in one mail
 * client and not another.
 */
export function generateInvitationToken(): InvitationToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

/** SHA-256, lowercase hex. */
export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time check of a presented token against the stored hash.
 *
 * Compared as the ASCII hex text, NOT as decoded bytes. `Buffer.from(x, "hex")`
 * discards everything from the first invalid character onward, so a truncated
 * or garbled `storedHash` would decode to a short — possibly empty — buffer,
 * and an empty buffer compares equal to another empty buffer. That failure mode
 * accepts an arbitrary token against a corrupt row.
 *
 * The length is checked first because `timingSafeEqual` throws on mismatched
 * lengths, which would turn a corrupt row into a 500 instead of a rejection.
 * Leaking length costs nothing here: a SHA-256 hex digest is always 64
 * characters, so the comparison that matters is always the constant-time one.
 */
export function verifyInvitationToken(token: string, storedHash: string): boolean {
  const computed = Buffer.from(hashInvitationToken(token), "utf8");
  const stored = Buffer.from(storedHash, "utf8");
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

export type InvitationState = "pending" | "expired" | "revoked" | "accepted";

export interface InvitationLifecycle {
  /** NULL means the invite never expires. */
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly acceptedAt: Date | null;
}

/**
 * The one place that decides what an invitation row means.
 *
 * Precedence is revoked > accepted > expired > pending, and the order is load
 * bearing:
 *
 *   - Revoked beats accepted. Revocation is an explicit act taken with the row
 *     in view, usually *because* it was accepted by the wrong person; if
 *     accepted won, the undo would silently do nothing.
 *   - Accepted beats expired. Acceptance is a completed fact about the past.
 *     An accepted invite whose `expires_at` later slid by must not resurface as
 *     "expired", or an admin re-issues it and the invitee joins twice.
 *
 * Columns are stamps rather than a status column so the timeline survives: a
 * single mutable status cannot say when it was revoked, nor that it had been
 * accepted first.
 */
export function invitationState(
  invitation: InvitationLifecycle,
  now: Date = new Date(),
): InvitationState {
  if (invitation.revokedAt !== null) return "revoked";
  if (invitation.acceptedAt !== null) return "accepted";
  // Closed boundary: an invite is expired at the instant it expires. The open
  // form would leave a token valid for the one millisecond it is stamped dead.
  if (invitation.expiresAt !== null && invitation.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "pending";
}

/**
 * Canonical form of an invited address.
 *
 * Applied at the boundary, before both the insert and the lookup — the partial
 * unique index on (tenant_id, email) compares bytes, so `Ada@Example.com` and
 * `ada@example.com` would otherwise be two open invites to the same person, and
 * accepting one would leave the other dangling.
 *
 * Only trim and case: the local part of an address is case-sensitive per RFC
 * 5321 and providers ignore that in practice, but stripping dots or `+tags`
 * would rewrite addresses that genuinely differ at some providers.
 */
export function normaliseInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

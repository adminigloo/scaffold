import { and, eq } from "drizzle-orm";
import { getBookingRow } from "./internal.js";
import { schedulingBookings, schedulingVisitTokens } from "./schema.js";
import { generateToken, hashToken, looksLikeToken } from "./tokens.js";
import type { BookingRow, SchedulingDb } from "./types.js";

/**
 * Manage tokens in the database: minting one for a visit, and opening the
 * visit a token names. Only SHA-256 hashes are stored (see tokens.ts and the
 * `scheduling_visit_tokens` table for why there are several per visit).
 */

/** Store a fresh token's hash for a visit (on whatever handle — a writer's transaction, say) and return the plaintext. */
export async function insertManageToken(db: SchedulingDb, tenantId: string, visitId: string): Promise<string> {
  const token = generateToken();
  await db.insert(schedulingVisitTokens).values({ tenantId, visitId, tokenHash: await hashToken(token) });
  return token;
}

/**
 * A fresh manage token for one of this tenant's visits, for ONE message: an
 * accept, a move or a reminder each mint their own, and every token stays
 * valid for the visit. Null when the visit isn't this tenant's.
 */
export async function issueManageToken(db: SchedulingDb, tenantId: string, visitId: string): Promise<string | null> {
  const [visit] = (await db
    .select({ id: schedulingBookings.id })
    .from(schedulingBookings)
    .where(and(eq(schedulingBookings.tenantId, tenantId), eq(schedulingBookings.id, visitId)))
    .limit(1)) as Array<{ id: string }>;
  if (!visit) return null;
  return insertManageToken(db, tenantId, visit.id);
}

/**
 * The row id of the token minted for ONE message, from the message's own key
 * (`visit:{visitId}:{eventId}:customer`): the first 16 bytes of its SHA-256,
 * shaped as a UUID (version 8, RFC 9562's "custom"), so a host whose
 * `scheduling_visit_tokens.id` is a `uuid` column takes it as readily as one
 * of `newId()`'s.
 */
export async function messageTokenId(messageKey: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(messageKey))).slice(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A manage token for ONE message, minted AT MOST ONCE (Tenancy 2b-1: the
 * same event handed to the comms listener again sent the customer the same
 * email again, with a new link each time). The row's id comes from
 * `messageKey` (`messageTokenId`), so a second call for the same message
 * inserts nothing and answers "already": the listener then knows this
 * message was handled. Null when the visit isn't this tenant's.
 */
export async function issueMessageToken(
  db: SchedulingDb,
  tenantId: string,
  visitId: string,
  messageKey: string,
): Promise<{ readonly token: string; readonly id: string } | "already" | null> {
  const [visit] = (await db
    .select({ id: schedulingBookings.id })
    .from(schedulingBookings)
    .where(and(eq(schedulingBookings.tenantId, tenantId), eq(schedulingBookings.id, visitId)))
    .limit(1)) as Array<{ id: string }>;
  if (!visit) return null;
  const token = generateToken();
  const id = await messageTokenId(messageKey);
  const inserted = (await db
    .insert(schedulingVisitTokens)
    .values({ id, tenantId, visitId: visit.id, tokenHash: await hashToken(token) })
    .onConflictDoNothing({ target: schedulingVisitTokens.id })
    .returning({ id: schedulingVisitTokens.id })) as Array<{ id: string }>;
  return inserted.length > 0 ? { token, id } : "already";
}

/** Forget a message's token whose message never went (its link reached nobody), so the next delivery of the event may try again. */
export async function releaseMessageToken(db: SchedulingDb, tenantId: string, id: string): Promise<void> {
  await db.delete(schedulingVisitTokens).where(and(eq(schedulingVisitTokens.tenantId, tenantId), eq(schedulingVisitTokens.id, id)));
}

/**
 * The visit a token opens, for this tenant, or null. Shape first (anything
 * that isn't base64url of a sane length costs nothing), then the hash, then
 * `(tenant, hash)`, then the visit by `(tenant, id)`. Every miss — malformed,
 * unknown, another tenant's token, a deleted visit — is the same null, so
 * nothing a caller sees says which.
 */
export async function openVisitByToken(db: SchedulingDb, tenantId: string, token: unknown): Promise<BookingRow | null> {
  if (!looksLikeToken(token)) return null;
  const tokenHash = await hashToken(token);
  const [found] = (await db
    .select({ visitId: schedulingVisitTokens.visitId })
    .from(schedulingVisitTokens)
    .where(and(eq(schedulingVisitTokens.tenantId, tenantId), eq(schedulingVisitTokens.tokenHash, tokenHash)))
    .limit(1)) as Array<{ visitId: string }>;
  if (!found) return null;
  return getBookingRow(db, tenantId, found.visitId);
}

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

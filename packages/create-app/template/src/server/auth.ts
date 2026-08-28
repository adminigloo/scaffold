import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import type { Principal } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import { db } from "@/db";

/**
 * Who is making this request, as a Principal.
 *
 * Clerk gives us a verified external id and nothing else that authorization
 * reads. Roles are NEVER taken from Clerk metadata or a JWT claim: a claim is
 * stale the moment you revoke, and the session token outlives the revocation.
 */
export async function currentPrincipal(): Promise<Principal | null> {
  const { userId: externalId } = await auth();
  if (!externalId) return null;

  const row = await db.query.users.findFirst({
    where: eq(users.externalId, externalId),
  });

  // No local row yet means the Clerk webhook has not landed. Returning null is
  // correct: a signed-in user with no mirror row has no memberships and no
  // grants, so inventing a Principal would push the failure one layer in.
  if (!row || row.deletedAt !== null) return null;

  return { userId: row.id, externalId: row.externalId, email: row.email };
}

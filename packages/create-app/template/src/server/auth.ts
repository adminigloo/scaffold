import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import type { Principal } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import { personalWorkspaceId, personalWorkspaceSlug } from "__SCOPE__/tenancy";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
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

  const existing = await db.query.users.findFirst({
    where: eq(users.externalId, externalId),
  });

  // Deliberately deleted. Do NOT resurrect: a soft-deleted row is a decision,
  // and re-creating it on the next request would silently undo it.
  if (existing?.deletedAt) return null;

  const row = existing ?? (await mirrorUser(externalId));
  if (!row) return null;

  return { userId: row.id, externalId: row.externalId, email: row.email };
}

/**
 * Create the local row for a user Clerk has already authenticated.
 *
 * WITHOUT THIS, LOCAL DEVELOPMENT DOES NOT WORK. The row is normally created by
 * the Clerk webhook, and a webhook needs a public URL — which localhost is not.
 * So on a laptop you sign in successfully, no row is ever written, every
 * `currentPrincipal()` returns null, and the app treats you as a stranger while
 * Clerk's UI cheerfully shows you as signed in. There is no error to search for.
 *
 * It is not a dev-only shim, and gating it on NODE_ENV would be worse. Webhook
 * delivery is best-effort everywhere: a delivery dropped in production leaves a
 * paying customer permanently unable to use the product, and the support ticket
 * says only "it says I'm not logged in". Reading the identity we already hold a
 * verified session for is strictly more reliable than waiting to be told about
 * it.
 *
 * The webhook is still what keeps the row FRESH — renames, email changes,
 * deletions. This only guarantees the row EXISTS. The unique index on
 * (identity_provider, external_id) makes the two safe to race.
 */
async function mirrorUser(externalId: string) {
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email =
    clerkUser.primaryEmailAddress?.emailAddress?.toLowerCase() ??
    clerkUser.emailAddresses[0]?.emailAddress?.toLowerCase() ??
    null;

  const displayName =
    [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(" ") || null;

  const [created] = await db
    .insert(users)
    .values({
      externalId,
      email,
      displayName,
      imageUrl: clerkUser.imageUrl ?? null,
      // NOT stamped. `provider_updated_at` records the last webhook APPLIED,
      // and stamping it here would make a genuinely newer webhook look stale
      // and be discarded.
      providerUpdatedAt: null,
    })
    // The webhook may have won the race between our SELECT and this INSERT.
    .onConflictDoNothing({ target: [users.identityProvider, users.externalId] })
    .returning();

  const row =
    created ??
    (await db.query.users.findFirst({ where: eq(users.externalId, externalId) }));

  if (row) await ensurePersonalWorkspace(row.id);
  return row ?? null;
}

/**
 * Give a brand-new user somewhere to be.
 *
 * Tenancy is always on, so a user with no membership can reach no tenant-scoped
 * route at all — `tenantProcedure` denies non-members by design. A consumer-shaped
 * project would otherwise sign someone up into a dead end.
 *
 * Idempotent: both writes conflict-do-nothing, so a concurrent request or a
 * later re-run changes nothing.
 */
async function ensurePersonalWorkspace(userId: string): Promise<void> {
  const tenantId = personalWorkspaceId(userId);

  await db
    .insert(tenants)
    .values({
      id: tenantId,
      kind: "personal",
      slug: personalWorkspaceSlug(userId),
      name: "Personal",
      ownerUserId: userId,
    })
    .onConflictDoNothing();

  await db
    .insert(tenantMembers)
    .values({ tenantId, userId, status: "active" })
    .onConflictDoNothing();
}

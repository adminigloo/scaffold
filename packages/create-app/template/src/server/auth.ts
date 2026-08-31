import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import type { Principal } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import {
  grantTenantOwnerRole,
  personalWorkspaceId,
  personalWorkspaceSlug,
} from "__SCOPE__/tenancy";
import { tenantMembers, tenants } from "__SCOPE__/tenancy/schema";
import { db } from "@/db";
import { env } from "@/env";
import { grantBootstrapAdminIfFirst } from "./bootstrap";

/**
 * Can anybody sign in to this deployment at all?
 *
 * BOTH KEYS, because either alone is a deployment that cannot authenticate:
 * the publishable key draws the sign-in card and the secret key is what
 * verifies the session behind it. The condition was written inline in
 * `currentPrincipal` and nowhere else, so every other caller that needed to
 * know re-derived it — and the two that got it wrong tested only the
 * publishable half, which is the one a browser can see.
 *
 * IT IS A REAL PRODUCT STATE, not a diagnostic. A project generated an hour ago
 * has no Clerk keys, and the honest thing for a page to do about that is not
 * always "redirect to /sign-in": the simulated checkout books a GUEST order on
 * such a deployment, because `orders.user_id` is nullable precisely so that a
 * purchase nobody can be attributed to is still a purchase. Every page that
 * behaves differently when nobody can sign in asks this one function.
 */
export function isSignInConfigured(): boolean {
  return Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY);
}

/**
 * Who is making this request, as a Principal.
 *
 * Clerk gives us a verified external id and nothing else that authorization
 * reads. Roles are NEVER taken from Clerk metadata or a JWT claim: a claim is
 * stale the moment you revoke, and the session token outlives the revocation.
 */
export async function currentPrincipal(): Promise<Principal | null> {
  // No Clerk yet. `auth()` throws rather than returning an empty session when
  // the keys are absent, so without this guard every page that asks who the
  // caller is 500s on a laptop that has not signed up for Clerk — including
  // /setup, which exists to tell you that Clerk is what is missing.
  if (!isSignInConfigured()) return null;

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

  if (row) {
    await ensurePersonalWorkspace(row.id);
    // Only ever succeeds for the very first staff user; a no-op forever after.
    await grantBootstrapAdminIfFirst(row.id, row.email);
  }
  return row ?? null;
}

/**
 * Give a brand-new user somewhere to be, and something to be there.
 *
 * Tenancy is always on, so a user with no membership can reach no tenant-scoped
 * route at all — `tenantProcedure` denies non-members by design. A consumer-shaped
 * project would otherwise sign someone up into a dead end.
 *
 * THREE WRITES, AND THE THIRD IS NOT OPTIONAL. This used to write the tenant
 * and the membership and stop, which put the customer inside a workspace they
 * owned and could do nothing in: permissions are deny-by-default and neither
 * @__SCOPE_NAME__/permissions nor @__SCOPE_NAME__/tenancy grants an owner
 * anything implicitly, so `owner_user_id` pointing at you conferred exactly
 * zero. The visible symptoms were `/account/billing` explaining that the
 * renewal amount is shown to whoever holds `subscriptions.view` — "normally its
 * owner" — to the owner, `account.billingPortal` answering FORBIDDEN, and
 * inviting anybody refused for want of a rank to compare the invitation
 * against. None of it raised an error; the product behaved as though the
 * customer were a stranger in their own account.
 *
 * `grantTenantOwnerRole` writes a real `principal_role` row rather than
 * teaching the resolver to imply one, so what the owner can do stays a thing
 * you can read out of a table — see the block comment on that function for why
 * that trade is worth a backfill script.
 *
 * Idempotent: all three writes conflict-do-nothing, so a concurrent request or
 * a later re-run changes nothing. The role grant also inserts nothing when the
 * templates have not been seeded yet, rather than throwing — a fresh database
 * with no `pnpm db:seed` behind it must not turn a first sign-in into a 500.
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

  // AFTER the membership, deliberately. A role row for somebody who is not a
  // member resolves to nothing — `loadTenantPermissions` checks membership
  // first and returns null — so writing it earlier would be a row that means
  // nothing until the next statement succeeds.
  await grantTenantOwnerRole(db, { tenantId, userId });
}

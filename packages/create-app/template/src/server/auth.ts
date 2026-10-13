import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import type { Principal } from "__SCOPE__/auth";
import { users } from "__SCOPE__/auth/schema";
import { db } from "@/db";
import { env } from "@/env";
import { tenancy } from "./tenancy";

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
 * Who is making this request, as a Principal — and, the first time, setting
 * them up.
 *
 * Clerk gives us a verified external id and nothing else that authorization
 * reads. Roles are NEVER taken from Clerk metadata or a JWT claim: a claim is
 * stale the moment you revoke, and the session token outlives the revocation.
 *
 * PROVISIONING IS A STATE MACHINE WITH ONE STAMP (Tenancy 1). A person is set
 * up exactly once — a personal workspace in a single-business project, the
 * first-administrator check in every project — and `users.provisioned_at`
 * records that it finished. TWO PATHS finish it, and either may arrive first:
 *
 *   - the Clerk webhook (app/api/webhooks/clerk/route.ts), on user.created;
 *   - this function, on the person's first page request.
 *
 * Whichever gets there first does it; the other finds the stamp and does
 * nothing. Every step of `tenancy.provisionUser` is idempotent (each write is
 * "insert … on conflict do nothing"), so the two can race safely, and a crash
 * halfway leaves the stamp unset so the NEXT request finishes the job.
 *
 * This replaced "the webhook only keeps the row fresh", which was the bug: on
 * a deployed site the webhook usually won the race,
 * wrote the row, and the page then found the row and skipped setting the
 * person up — most new sign-ups got no workspace, no role and no first
 * administrator (PC-01). People that bug left with nothing are repaired here,
 * on their next visit, because their stamp was never set.
 *
 * Every signed-in page view reaches this (the header's company switcher asks
 * for the principal), which is what makes "the first page provisions" true.
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

  // Null means "not set up yet" — a brand-new person, one whose webhook
  // arrived first, or a 0.21 account the race left with nothing.
  if (row.provisionedAt === null) {
    await tenancy.provisionUser({ userId: row.id, email: row.email });
  }

  return { userId: row.id, externalId: row.externalId, email: row.email };
}

/** The slice of a Clerk user this file reads. Structural, so a test can pass a plain object. */
interface ClerkIdentityLike {
  readonly primaryEmailAddressId: string | null;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
    readonly verification: { readonly status?: string | null } | null;
  }[];
}

/**
 * The addresses Clerk has VERIFIED, lowercased — and the one to mirror.
 *
 * ONLY VERIFIED ADDRESSES, EVER (review T1-02, TB-DEPLOY-09). `users.email` is
 * what decides who becomes the first administrator and whom an invitation is
 * for, and an address somebody merely typed into their profile can be the
 * founder's. The mirrored one is the primary address when it is verified,
 * otherwise the first verified one, otherwise none — the same rule
 * @__SCOPE_NAME__/auth's webhook applies, so the two paths can't disagree.
 */
export function verifiedAddressesOf(user: ClerkIdentityLike): {
  readonly primary: string | null;
  readonly all: readonly string[];
} {
  const verified = user.emailAddresses.filter(
    (address) => address.verification?.status === "verified",
  );
  const all = verified.map((address) => address.emailAddress.trim().toLowerCase());
  const primary =
    verified.find((address) => address.id === user.primaryEmailAddressId) ?? verified[0];
  return {
    primary: primary ? primary.emailAddress.trim().toLowerCase() : null,
    all: [...new Set(all)],
  };
}

/**
 * Every address the signed-in person has verified with Clerk, lowercased.
 *
 * What "join with a verified address" (an invitation waiting for this person's
 * address shows up in onboarding) is decided against. Empty when Clerk isn't
 * configured or nobody is signed in.
 */
export async function verifiedEmails(): Promise<readonly string[]> {
  if (!isSignInConfigured()) return [];
  const clerkUser = await currentUser();
  if (!clerkUser) return [];
  return verifiedAddressesOf(clerkUser).all;
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
 * It only writes the ROW. Setting the person up is `currentPrincipal`'s next
 * step (provisioning), so the webhook-first and page-first orders end in the
 * same place. The unique index on (identity_provider, external_id) makes the
 * two safe to race.
 */
async function mirrorUser(externalId: string) {
  const clerkUser = await currentUser();
  if (!clerkUser) return null;

  const email = verifiedAddressesOf(clerkUser).primary;

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

  // A row the webhook soft-deleted in the gap between our SELECT and INSERT.
  if (row?.deletedAt) return null;
  return row ?? null;
}

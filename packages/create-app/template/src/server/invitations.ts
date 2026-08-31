import { createInvitationService } from "__SCOPE__/tenancy";
import { db } from "@/db";
import { env } from "@/env";
import { invitePath } from "@/invitations";

/**
 * The invitation service, wired to this project's database, and the one place
 * an invitation link becomes an absolute URL.
 *
 * @__SCOPE_NAME__/tenancy owns the rules — hash the token and store only the
 * hash, refuse an expired or revoked or already-used one, notice that the
 * invited address is already a member — and it owns them because they are the
 * kind of rule that must not have a second implementation. What it cannot own
 * is the database handle or the deployment's origin, so those are supplied
 * here, once, and every caller reaches the service through this module.
 *
 * WHY THIS FILE EXISTS AT ALL RATHER THAN A CALL PER ROUTER: the service is
 * stateful in exactly one respect that matters — it holds the connection — and
 * two constructions would be two connection pools' worth of prepared
 * statements for no benefit. It is also the single import site to change if the
 * package's dependency shape moves, which for a published package is the
 * difference between a version bump and a hunt.
 *
 * The absolute URL is built from NEXT_PUBLIC_APP_URL because a mail client has
 * no origin to resolve a relative path against — a link written as
 * `/invite/abc` in an email is not a link, it is text. On a preview deployment
 * that variable falls back to the URL Vercel assigned the build, so an
 * invitation sent from a preview points back at that preview rather than at
 * production, which is the behaviour you want the first time somebody tests
 * this on a branch.
 */
export const invitations = createInvitationService({ db });

/**
 * How long a new invitation is good for.
 *
 * Seven days, and it is a named constant rather than a literal at the call site
 * because it is the number somebody will want to change and the number a test
 * has to agree with. Long enough to survive a holiday; short enough that a link
 * forwarded into a group chat two months ago no longer opens a door.
 */
export const INVITATION_EXPIRY_HOURS = 24 * 7;

/** The full URL that goes in the mail. Relative paths do not work in an inbox. */
export function invitationUrl(token: string): string {
  return new URL(invitePath(token), env.NEXT_PUBLIC_APP_URL).toString();
}

import { cache } from "react";
import { isDbConfigured } from "__SCOPE__/db";
import { db } from "@/db";
import { env } from "@/env";
import { currentPrincipal } from "@/server/auth";
import { loadStaffPermissions } from "@/server/permissions";

/**
 * MAY THIS REQUEST READ THE OPERATOR'S DETAIL — the name of a setting, a file
 * path, a link to /setup? (create-app 0.36, the showroom.)
 *
 * A business owner, their staff and their customers never should: "Email
 * isn't switched on for this site yet" is the whole of what they can act on,
 * and an environment variable on their screen reads as "broken". So:
 *
 *   - STAFF of the site (staff permissions, resolved from this project's own
 *     tables): yes, always.
 *   - Anyone else: no — with one exception. In development (`next dev`) on a
 *     machine where sign-in or the database isn't set up yet, there is nobody
 *     to be staff and the only reader is the developer running it, so the
 *     detail shows. Never in production.
 *
 * Asked once per request (React's `cache`). A failure answers no.
 */
export const operatorView = cache(async (): Promise<boolean> => {
  const unconfigured = !isDbConfigured(db) || !env.CLERK_SECRET_KEY || !env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (unconfigured) return process.env.NODE_ENV !== "production";
  try {
    const principal = await currentPrincipal();
    if (!principal) return false;
    return (await loadStaffPermissions({ principal })) !== null;
  } catch {
    return false;
  }
});

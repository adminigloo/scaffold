import { clerkMiddleware } from "@clerk/nextjs/server";

/**
 * Root proxy — Next 16's rename of `middleware.ts`. The old filename still
 * works and warns on every build, which is noise you would learn to ignore.
 *
 * This hydrates the Clerk session so downstream `auth()` calls resolve, and
 * does NOT gate routes. Route gating lives in the pages and procedures that
 * consume protected data: a matcher here is a second place for authorization
 * to live, and the two drift.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Everything except static assets. Webhook routes stay INCLUDED on purpose:
    // clerkMiddleware attaches auth state, it does not require a session, and
    // excluding them is how a route ends up unable to read its own headers.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};

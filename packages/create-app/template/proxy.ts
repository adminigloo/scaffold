import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Root proxy — Next 16's rename of `middleware.ts`. The old filename still
 * works and warns on every build, which is noise you learn to scroll past.
 *
 * This hydrates the Clerk session so downstream `auth()` calls resolve, and
 * does NOT gate routes. Route gating lives in the pages and procedures that
 * consume protected data: a matcher here is a second place for authorization to
 * live, and the two drift.
 *
 * THE ONE PLACE OUTSIDE `src/env.ts` THAT READS process.env, and it is worth
 * saying why. This file runs on the edge runtime, before any page. Importing
 * `@/env` would pull in the database fragment, which pulls in the Neon driver
 * and `ws` — neither of which exists on the edge. `NEXT_PUBLIC_*` values are
 * inlined at build time, so the line below is a compile-time constant rather
 * than a runtime lookup, and the rule it bends is about runtime configuration
 * drift, which cannot happen here.
 *
 * Without the check, a project with no Clerk account yet 500s on EVERY request
 * — clerkMiddleware throws on a missing publishable key at the edge, before
 * layout, before the page, before /setup can tell you Clerk is what is missing.
 * The first thing you would see after generating a project is a stack trace.
 */
const clerkConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export default clerkConfigured ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // Everything except static assets. Webhook routes stay INCLUDED on purpose:
    // clerkMiddleware attaches auth state, it does not require a session, and
    // excluding them is how a route ends up unable to read its own headers.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};

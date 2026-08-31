import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "__SCOPE__/observability/request";

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

/**
 * Stamp one id onto the request, and echo it back on the response.
 *
 * THE ONLY PLACE THIS IS MINTED. Everything downstream reads the header —
 * `createScaffoldContext` puts it on `ctx.requestId`, `requestLog` puts it on
 * every log line, `reportError` puts it in the `error_log` row — so a page
 * render, the tRPC call that page makes and the error either of them reports
 * all carry the same value. Minting per handler instead would give every hop a
 * different id, and an error row whose id appears nowhere else joins to
 * nothing.
 *
 * FROM THE PACKAGE, over an edge-safe subpath, and not from a copy kept here.
 * `@__SCOPE_NAME__/observability/request` imports nothing at all — no pino, no
 * `node:crypto` — precisely so this file can use it; the barrel would drag the
 * logger in behind it and the edge build would fail. This project used to keep
 * its own dependency-free copy for that reason, and the copy drifted exactly
 * where it mattered: it never validated the inbound header, so a newline in
 * `x-request-id` became two records in a line-delimited log and the second one
 * said whatever the caller wanted. `resolveRequestId` bounds the length,
 * restricts the characters and replaces anything that fails rather than
 * refusing the request.
 *
 * An incoming id is kept rather than replaced. A load balancer, a client SDK or
 * an internal caller that already assigned one is describing a trace that
 * started before us, and overwriting it severs this app from the front of it.
 * `x-vercel-id` is promoted into the header when nothing else set one, because
 * Vercel stamps it on every inbound request and a real id from the platform
 * beats a fresh one that joins to nothing outside this process.
 *
 * On the response as well as the request, because that header is what a person
 * reporting a problem can actually copy out of their browser's network tab.
 */
function withRequestId(req: NextRequest): NextResponse {
  const forwarded = new Headers(req.headers);
  const platform = forwarded.get("x-vercel-id");
  if (!forwarded.get(REQUEST_ID_HEADER) && platform) {
    forwarded.set(REQUEST_ID_HEADER, platform);
  }
  const requestId = resolveRequestId(forwarded);
  forwarded.set(REQUEST_ID_HEADER, requestId);

  // `NextResponse.next({ request })` is the only way to change what the route
  // below sees. Setting the header on the response alone would echo an id that
  // no handler could read, which is the version of this that looks like it
  // works.
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export default clerkConfigured
  ? clerkMiddleware((_auth, req) => withRequestId(req))
  : withRequestId;

export const config = {
  matcher: [
    // Everything except static assets. Webhook routes stay INCLUDED on purpose:
    // clerkMiddleware attaches auth state, it does not require a session, and
    // excluding them is how a route ends up unable to read its own headers.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico)).*)",
    "/(api|trpc)(.*)",
  ],
};

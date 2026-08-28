import { clerkMiddleware } from "@clerk/nextjs/server";

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

import { createFeedbackHandlers } from "__SCOPE__/feedback";
import { put } from "@vercel/blob";
import { db } from "@/db";
import { env } from "@/env";

/**
 * The feedback intake surface: /api/igloo/v1/{config,upload,submit}.
 *
 * AUTHENTICATED BY THE WIDGET'S CLIENT KEY, NOT CLERK — deliberately, and the
 * distinction is the product. Reporters are end users of whichever app mounts
 * the widget; they have no account here and must not need one, or the only
 * people who can report a sign-in problem are the people who got past it. The
 * key is verified against its stored hash and scopes every ticket to the
 * tenant it was issued for.
 *
 * Storage is INJECTED, because the package refuses to choose a vendor. This
 * route is the caller that chose Vercel Blob, which is why `@vercel/blob` is a
 * dependency of this app and not of __SCOPE__/feedback. Without
 * BLOB_READ_WRITE_TOKEN the upload endpoint answers 503 {skipped} and the
 * widget submits the report without images — a degraded behaviour the widget
 * knows how to say, not a failure.
 */
const handlers = createFeedbackHandlers({
  db,
  storeFile: env.BLOB_READ_WRITE_TOKEN
    ? async (path, file, contentType) => {
        const blob = await put(path, file, {
          access: "public",
          contentType,
          // Passed explicitly rather than left to the SDK's own process.env
          // lookup, so the one place this app reads its environment stays
          // src/env.ts — and so the branch above and the credential the SDK
          // uses can never be two different answers.
          token: env.BLOB_READ_WRITE_TOKEN,
        });
        return { url: blob.url };
      }
    : undefined,
});

export const GET = handlers.handle;
export const POST = handlers.handle;
export const OPTIONS = handlers.handle;

import { del, put } from "@vercel/blob";
import type { BlobStore } from "__SCOPE__/storage";
import { env } from "@/env";

/**
 * This app's blob store: Vercel Blob behind @__SCOPE_NAME__/storage's two-method
 * adapter. The package never sees the vendor; swapping to S3 later means
 * rewriting this file and nothing else.
 *
 * Null when BLOB_READ_WRITE_TOKEN is absent — configuration, not a feature
 * flag, same contract as the feedback widget without a client key: the
 * feature stays off and /admin/files names the variable to paste.
 */
export function getBlobStore(): BlobStore | null {
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return {
    put: async (pathname, body, options) => {
      // The adapter's BlobBody admits a bare Uint8Array; Vercel's PutBody
      // does not. One normalisation here keeps the package vendor-neutral.
      const bytes = body instanceof Uint8Array && !Buffer.isBuffer(body) ? Buffer.from(body) : body;
      const blob = await put(pathname, bytes, {
        access: "public",
        contentType: options.contentType,
        // The package already salts the pathname with a random segment; a
        // second suffix here would make the stored name unrecognisable.
        addRandomSuffix: false,
        token,
      });
      return { url: blob.url, pathname: blob.pathname };
    },
    delete: async (pathname) => {
      await del(pathname, { token });
    },
  };
}

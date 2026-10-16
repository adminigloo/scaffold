import type { VercelBlobSdk } from "../../vercel-blob.js";
import type * as vercelBlob from "./vercel-blob-2.8.js";

/**
 * Review FH-7: the README's own line, `sdk: vercelBlob` with
 * `import * as vercelBlob from "@vercel/blob"`, must type-check against
 * today's @vercel/blob (2.8.2, declared in ./vercel-blob-2.8.d.ts). Checked
 * by `tsc --noEmit` (the package's typecheck) and by vercel-blob-sdk.test.ts.
 * Never run.
 */
export function asSdk(namespace: typeof vercelBlob): VercelBlobSdk {
  return namespace;
}

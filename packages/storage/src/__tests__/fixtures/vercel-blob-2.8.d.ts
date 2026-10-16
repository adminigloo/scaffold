/**
 * The four calls the Vercel Blob adapter takes, exactly as @vercel/blob 2.8.2
 * declares them (dist/index.d.ts and its create-folder chunk), so the
 * package's type test (vercel-blob-sdk.test.ts) checks `VercelBlobSdk`
 * against the real signatures without depending on @vercel/blob (review
 * FH-7). Only two things differ from the original: undici's `Headers` and
 * `File` are the global ones, and the unrelated exports are left out.
 *
 * When a newer @vercel/blob changes these, paste its declarations here.
 */
import type { Readable } from "node:stream";

interface BlobCommandOptions {
  token?: string;
  oidcToken?: string;
  storeId?: string;
  abortSignal?: AbortSignal;
}
type BlobAccessType = "public" | "private";
interface CommonCreateBlobOptions extends BlobCommandOptions {
  access: BlobAccessType;
  addRandomSuffix?: boolean;
  allowOverwrite?: boolean;
  contentType?: string;
  cacheControlMaxAge?: number;
  ifMatch?: string;
  maximumSizeInBytes?: number;
}
interface UploadProgressEvent {
  loaded: number;
  total: number;
  percentage: number;
}
type OnUploadProgressCallback = (progressEvent: UploadProgressEvent) => void;
interface WithUploadProgress {
  onUploadProgress?: OnUploadProgressCallback;
}
interface OptimizeImageOptions {
  width: number;
  quality?: number;
  format?: "jpeg" | "png" | "webp" | "avif";
}
interface PutBlobResult {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  contentDisposition: string;
  etag: string;
}
type PutBody = string | Readable | Buffer | Blob | ArrayBuffer | ReadableStream | File;

export interface PutCommandOptions extends CommonCreateBlobOptions, WithUploadProgress {
  multipart?: boolean;
  optimizeImage?: OptimizeImageOptions;
}

export interface DeleteCommandOptions extends BlobCommandOptions {
  ifMatch?: string;
}
export declare function del(urlOrPathname: string[] | string, options?: DeleteCommandOptions): Promise<void>;

export interface HeadBlobResult {
  size: number;
  uploadedAt: Date;
  pathname: string;
  contentType: string;
  contentDisposition: string;
  url: string;
  downloadUrl: string;
  cacheControl: string;
  etag: string;
}
export declare function head(urlOrPathname: string, options?: BlobCommandOptions): Promise<HeadBlobResult>;

export interface GetCommandOptions extends BlobCommandOptions {
  access: BlobAccessType;
  useCache?: boolean;
  ifNoneMatch?: string;
  headers?: HeadersInit;
}
interface GetBlobResultBlobBase {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentDisposition: string;
  cacheControl: string;
  uploadedAt: Date;
  etag: string;
}
export type GetBlobResult =
  | {
      statusCode: 200;
      stream: ReadableStream<Uint8Array>;
      headers: Headers;
      blob: GetBlobResultBlobBase & {
        contentType: string;
        size: number;
      };
    }
  | {
      statusCode: 304;
      stream: null;
      headers: Headers;
      blob: GetBlobResultBlobBase & {
        contentType: null;
        size: null;
      };
    };
export declare function get(urlOrPathname: string, options: GetCommandOptions): Promise<GetBlobResult | null>;

export declare const put: (pathname: string, body: PutBody, optionsInput: PutCommandOptions) => Promise<PutBlobResult>;

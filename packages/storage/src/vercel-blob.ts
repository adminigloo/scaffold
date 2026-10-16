import { assertStorageKey, probeKey } from "./keys.js";
import { StorageError, type BlobObject, type BlobStore } from "./types.js";

/**
 * `@adminigloo/storage/vercel-blob`: a Vercel Blob store, through the SDK's
 * own functions handed in by the host (`import * as sdk from "@vercel/blob"`),
 * so this package never depends on it.
 *
 * TWO STORES (D10, open question 1, resolved by review BO-19). A Vercel Blob
 * store is public or private as a WHOLE: the photos and files go to a
 * private store (its own token), the logo to the public one. Ask Lou's
 * `privateBlob.ts` runs exactly this pair.
 *
 * A "PRIVATE" STORE THAT ISN'T (review G9). A token is just a string; pasting
 * the public store's token where the private one belongs would publish every
 * photo. Vercel answers every put with the object's URL, and a public
 * store's URLs are on `*.public.blob.vercel-storage.com`, so a private
 * store's `put` that gets one back deletes the object at once and refuses:
 * the file is never kept where anyone can open it. `checkPrivate` makes the
 * same check on a probe, for /setup and the files cron.
 */

/**
 * The four @vercel/blob functions the adapter uses, passed in by the host
 * (`import * as sdk from "@vercel/blob"`), so this package never depends on
 * it.
 *
 * EACH OPTIONS ARGUMENT NAMES EXACTLY WHAT THE ADAPTER SENDS (review FH-7).
 * Typed loosely (`Record<string, unknown>`), the SDK's own namespace didn't
 * type-check against @vercel/blob 2.8, whose `put` requires `access`, so a
 * host's `next build` stopped on the README's own line. Named precisely,
 * these are what 2.x's functions accept (a test compiles 2.8.2's
 * declarations against this interface), and `get` may answer a 304 with no
 * stream (never asked for: the adapter sends no `ifNoneMatch`).
 */
export interface VercelBlobSdk {
  put(
    pathname: string,
    body: Buffer,
    options: {
      access: "private" | "public";
      token?: string;
      contentType?: string;
      addRandomSuffix?: boolean;
      allowOverwrite?: boolean;
      cacheControlMaxAge?: number;
    },
  ): Promise<{ url: string; pathname: string }>;
  get(
    pathname: string,
    options: { access: "private"; token?: string },
  ): Promise<{ stream: ReadableStream<Uint8Array> | null; blob?: { contentType?: string | null; size?: number | null } } | null>;
  head(pathname: string, options: { token?: string }): Promise<{ url: string; contentType?: string; size?: number }>;
  del(pathname: string, options: { token?: string }): Promise<void>;
}

export interface VercelBlobStoreOptions {
  readonly sdk: VercelBlobSdk;
  readonly token: string;
  readonly access: "private" | "public";
  /** Public stores only: seconds. Default one year (keys are never reused). */
  readonly cacheControlMaxAge?: number;
  /** How a public store's object is read after `head` (tests). Default the global fetch. */
  readonly fetch?: typeof fetch;
}

const PUBLIC_HOST_SUFFIX = ".public.blob.vercel-storage.com";
const NOT_PRIVATE = "The private file store's token belongs to a public store. Connect a private Blob store for photos and files.";

function isPublicBlobUrl(url: string): boolean {
  try {
    return new URL(url).host.toLowerCase().endsWith(PUBLIC_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/** The SDK says "not found" by throwing (BlobNotFoundError) or by answering null; both are null here. */
function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const named = error as { name?: unknown; message?: unknown; status?: unknown };
  return named.name === "BlobNotFoundError" || named.status === 404 || (typeof named.message === "string" && /not\s*found/i.test(named.message));
}

export function createVercelBlobStore(options: VercelBlobStoreOptions): BlobStore {
  if (!options?.sdk || typeof options.sdk.put !== "function") throw new Error('createVercelBlobStore: pass sdk (import * as sdk from "@vercel/blob").');
  if (typeof options.token !== "string" || options.token === "") throw new Error("createVercelBlobStore: pass the store's token.");
  if (options.access !== "private" && options.access !== "public") throw new Error('createVercelBlobStore: access must be "private" or "public".');
  const { sdk, token, access } = options;
  const maxAge = options.cacheControlMaxAge ?? 365 * 24 * 60 * 60;

  const store: BlobStore = {
    access,
    async put(key, bytes, putOptions) {
      assertStorageKey(key, "put");
      const blob = await sdk.put(key, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access,
        token,
        contentType: putOptions.contentType,
        // The key is already random (D10): a second suffix would only make
        // the stored name unrecognisable, and an overwrite is never wanted.
        addRandomSuffix: false,
        allowOverwrite: false,
        ...(access === "public" ? { cacheControlMaxAge: maxAge } : {}),
      });
      if (access === "private") {
        if (isPublicBlobUrl(blob.url)) {
          await sdk.del(key, { token }).catch(() => undefined);
          throw new StorageError("storage_off", NOT_PRIVATE);
        }
        return { url: null };
      }
      return { url: blob.url };
    },
    async get(key): Promise<BlobObject | null> {
      assertStorageKey(key, "get");
      if (access === "private") {
        let found: Awaited<ReturnType<VercelBlobSdk["get"]>>;
        try {
          found = await sdk.get(key, { access: "private", token });
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
        if (!found) return null;
        // A 304 (no body) is only the type's other case: no `ifNoneMatch` is sent.
        if (!found.stream) throw new Error("The private file store answered without the file's bytes.");
        return { body: found.stream, contentType: found.blob?.contentType ?? null, size: found.blob?.size ?? null };
      }
      let head: Awaited<ReturnType<VercelBlobSdk["head"]>>;
      try {
        head = await sdk.head(key, { token });
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
      const res = await (options.fetch ?? globalThis.fetch)(head.url, { cache: "no-store" });
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`The public file store couldn't read a file (it answered ${res.status}).`);
      return { body: res.body, contentType: head.contentType ?? res.headers.get("content-type"), size: head.size ?? null };
    },
    async delete(key) {
      assertStorageKey(key, "delete");
      try {
        await sdk.del(key, { token });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
  if (access === "private") {
    store.checkPrivate = async () => {
      const key = probeKey(new Date());
      try {
        const blob = await sdk.put(key, Buffer.from("adminigloo private check"), {
          access: "private",
          token,
          contentType: "text/plain",
          addRandomSuffix: false,
          allowOverwrite: false,
        });
        await sdk.del(key, { token }).catch(() => undefined);
        return isPublicBlobUrl(blob.url) ? { ok: false, reason: NOT_PRIVATE } : { ok: true, reason: null };
      } catch {
        return { ok: false, reason: "Couldn't write to the private file store to check it. Check its token." };
      }
    };
  }
  return store;
}

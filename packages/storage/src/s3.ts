import { assertStorageKey, probeKey } from "./keys.js";
import { EMPTY_SHA256, rfc3986, sha256Hex, signS3Request } from "./sigv4.js";
import type { BlobObject, BlobStore } from "./types.js";

export { presignS3Url, signS3Request } from "./sigv4.js";

/**
 * `@adminigloo/storage/s3`: any S3-compatible store (Cloudflare R2, MinIO,
 * AWS S3) with no SDK: `fetch` and SigV4 by hand (./sigv4.ts).
 *
 * TWO BUCKETS (D10, review G9): a PRIVATE one with NO anonymous access
 * policy, and a public one for the logo. One bucket with "some files public"
 * is one policy edit away from every photo being public; two buckets make
 * the difference structural. `checkPrivate` proves the private bucket really
 * is: it puts a probe, asks for it WITHOUT a signature, and expects a refusal
 * (403 or 404; 401; or R2's 400 InvalidArgument). MinIO's `mc anonymous set
 * public` also allows listing, so a bucket made public by mistake answers 200
 * here and the files cron says so.
 *
 * CLOUDFLARE R2 (reviews FH-8, SEC-05). R2's S3 endpoint refuses every
 * unsigned request, public bucket or not: a bucket is readable by anyone only
 * at its r2.dev address or a custom domain. So the probe also asks
 * `publicUrlToCheck` (that address) when the host gives it, and expects a
 * refusal there too; on R2 without it, the check passes with a `note`
 * saying in plain words what it couldn't check, for /setup to show.
 *
 * Every request is signed with the Authorization header and the body's real
 * hash (never `UNSIGNED-PAYLOAD`). The URL is built by joining
 * `{endpoint}/{bucket}/` with the key's segments, each RFC 3986-encoded,
 * never by passing a path through `new URL()` normalisation (review G7), and
 * only after the key has passed STORAGE_KEY_PATTERN (or, for get and delete,
 * the legacy check). Nothing is sent for a key that fails.
 */

export interface S3CompatibleStoreOptions {
  /** "https://<account>.r2.cloudflarestorage.com", "http://localhost:9000", "https://s3.us-east-1.amazonaws.com". */
  readonly endpoint: string;
  /** Default "auto" (R2); MinIO's default is "us-east-1". */
  readonly region?: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly access: "private" | "public";
  /** A public bucket's own address ("https://files.example.com"). Required for access "public": `put` answers `${publicBaseUrl}/${key}`. */
  readonly publicBaseUrl?: string;
  /**
   * Private stores (reviews FH-8, SEC-05): an address this bucket could ALSO
   * be read at without a signature, which `checkPrivate` asks for the probe
   * and expects refused. On R2: the bucket's r2.dev address
   * ("https://pub-….r2.dev") or its custom domain.
   */
  readonly publicUrlToCheck?: string;
  /** {endpoint}/{bucket}/{key}. Default true (R2 and MinIO need it). */
  readonly pathStyle?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** R2's S3 endpoints: `<account>.r2.cloudflarestorage.com` (and its jurisdiction variants). */
const R2_ENDPOINT = /\.r2\.cloudflarestorage\.com$/i;

/** What checkPrivate says about R2 when it wasn't given the bucket's public address to ask (review SEC-05). */
export const R2_PUBLIC_ACCESS_UNCHECKED =
  "This is a Cloudflare R2 bucket: anyone can also read it at its r2.dev address, or at a custom domain, if either is switched on, and that can't be checked from here. In Cloudflare, open the bucket's settings and make sure both are off.";

/**
 * Was an unsigned GET refused? 403 and 404 (S3, MinIO), 401, and R2's
 * `400 InvalidArgument` ("Authorization"): what R2's S3 endpoint answers
 * every request without a signature (review FH-8).
 */
function refusedAnonymous(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  return status === 400 && /<Code>\s*InvalidArgument\s*<\/Code>/i.test(body);
}

export function createS3CompatibleStore(options: S3CompatibleStoreOptions): BlobStore {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw new Error("createS3CompatibleStore: endpoint must be a URL, e.g. https://<account>.r2.cloudflarestorage.com");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("createS3CompatibleStore: endpoint must be http(s).");
  if (typeof options.bucket !== "string" || !BUCKET.test(options.bucket)) throw new Error("createS3CompatibleStore: bucket must be a bucket name.");
  if (!options.accessKeyId || !options.secretAccessKey) throw new Error("createS3CompatibleStore: pass accessKeyId and secretAccessKey.");
  if (options.access !== "private" && options.access !== "public") throw new Error('createS3CompatibleStore: access must be "private" or "public".');
  if (options.access === "public" && !options.publicBaseUrl) {
    throw new Error("createS3CompatibleStore: a public store needs publicBaseUrl (the bucket's own public address).");
  }
  const region = options.region ?? "auto";
  const pathStyle = options.pathStyle ?? true;
  const base = `${endpoint.protocol}//${endpoint.host}${endpoint.pathname.replace(/\/+$/, "")}`;
  const virtualBase = `${endpoint.protocol}//${options.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, "")}`;
  const publicBase = options.publicBaseUrl?.replace(/\/+$/, "") ?? null;
  let alsoReadableAt: string | null = null;
  if (options.publicUrlToCheck !== undefined) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(options.publicUrlToCheck);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new Error("createS3CompatibleStore: publicUrlToCheck must be an http(s) address, e.g. https://pub-<id>.r2.dev");
    }
    alsoReadableAt = parsed.href.replace(/\/+$/, "");
  }
  const isR2 = R2_ENDPOINT.test(endpoint.hostname);
  const clock = () => options.now?.() ?? new Date();
  const doFetch = (url: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(url, init);

  /** The object's URL: each key segment encoded once, joined by hand. */
  const objectUrl = (key: string) => {
    const path = key.split("/").map(rfc3986).join("/");
    return pathStyle ? `${base}/${rfc3986(options.bucket)}/${path}` : `${virtualBase}/${path}`;
  };

  async function send(method: "GET" | "PUT" | "DELETE", key: string, body: Uint8Array | null, headers: Record<string, string> = {}): Promise<Response> {
    const url = objectUrl(key);
    const signed = signS3Request({
      method,
      url,
      region,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      now: clock(),
      headers,
      payloadHash: body ? sha256Hex(body) : EMPTY_SHA256,
    });
    return doFetch(url, { method, headers: { ...signed }, ...(body ? { body: body as BodyInit } : {}), cache: "no-store", redirect: "manual" });
  }

  const store: BlobStore = {
    access: options.access,
    async put(key, bytes, putOptions) {
      assertStorageKey(key, "put");
      const headers: Record<string, string> = { "content-type": putOptions.contentType };
      if (putOptions.cacheControl) headers["cache-control"] = putOptions.cacheControl;
      const res = await send("PUT", key, bytes, headers);
      if (!res.ok) throw new Error(`The file store refused the upload (it answered ${res.status}).`);
      await res.arrayBuffer().catch(() => undefined);
      return { url: options.access === "public" && publicBase ? `${publicBase}/${key}` : null };
    },
    async get(key): Promise<BlobObject | null> {
      assertStorageKey(key, "get");
      const res = await send("GET", key, null);
      if (res.status === 404) {
        await res.arrayBuffer().catch(() => undefined);
        return null;
      }
      if (!res.ok) throw new Error(`The file store couldn't read a file (it answered ${res.status}).`);
      const length = Number(res.headers.get("content-length"));
      return {
        body: res.body ?? new Uint8Array(await res.arrayBuffer()),
        contentType: res.headers.get("content-type"),
        size: Number.isFinite(length) && res.headers.has("content-length") ? length : null,
      };
    },
    async delete(key) {
      assertStorageKey(key, "delete");
      const res = await send("DELETE", key, null);
      await res.arrayBuffer().catch(() => undefined);
      // A delete of a missing object resolves: "gone" is what was asked for.
      if (!res.ok && res.status !== 404) throw new Error(`The file store couldn't delete a file (it answered ${res.status}).`);
    },
  };
  if (options.access === "private") {
    store.checkPrivate = async () => {
      const key = probeKey(clock());
      try {
        await store.put(key, new TextEncoder().encode("adminigloo private check"), { contentType: "text/plain" });
      } catch {
        return { ok: false, reason: "Couldn't write to the private bucket to check it. Check its keys and its name." };
      }
      try {
        // UNSIGNED, on purpose: this is what anyone on the internet can do.
        let res: Response;
        try {
          res = await doFetch(objectUrl(key), { method: "GET", cache: "no-store", redirect: "manual" });
        } catch {
          return { ok: false, reason: "Couldn't reach the private bucket to check it." };
        }
        const body = await res.text().catch(() => "");
        if (res.ok) return { ok: false, reason: "The private bucket lets anyone read its files. Remove its public access policy." };
        if (!refusedAnonymous(res.status, body)) return { ok: false, reason: `Couldn't check the private bucket (it answered ${res.status}).` };
        if (alsoReadableAt) {
          let open: Response;
          try {
            open = await doFetch(`${alsoReadableAt}/${key.split("/").map(rfc3986).join("/")}`, { method: "GET", cache: "no-store", redirect: "manual" });
          } catch {
            // Nothing answers there (the r2.dev address is off, the domain
            // isn't connected): nobody can read the bucket at that address.
            return { ok: true, reason: null };
          }
          await open.arrayBuffer().catch(() => undefined);
          if (open.ok) {
            return {
              ok: false,
              reason: `Anyone can read the private bucket's files at ${alsoReadableAt}. In Cloudflare, switch off the bucket's r2.dev address and remove any custom domain from it.`,
            };
          }
          if (open.status === 401 || open.status === 403 || open.status === 404) return { ok: true, reason: null };
          return { ok: false, reason: `Couldn't check the private bucket's public address (it answered ${open.status}).` };
        }
        return isR2 ? { ok: true, reason: null, note: R2_PUBLIC_ACCESS_UNCHECKED } : { ok: true, reason: null };
      } finally {
        await store.delete(key).catch(() => undefined);
      }
    };
  }
  return store;
}

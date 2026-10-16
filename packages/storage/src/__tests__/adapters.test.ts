import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newPrivateKey, newPublicKey } from "../keys.js";
import { createLocalDiskStore } from "../local.js";
import { createMemoryBlobStore } from "../memory.js";
import { createStorage } from "../instance.js";
import { storageTables } from "../schema.js";
import { createS3CompatibleStore, presignS3Url, signS3Request } from "../s3.js";
import { EMPTY_SHA256 } from "../sigv4.js";
import { InvalidKeyError, StorageError, type BlobStore } from "../types.js";
import { createVercelBlobStore, type VercelBlobSdk } from "../vercel-blob.js";
import { startFakeS3, type FakeS3 } from "./fake-s3.js";
import { PNG } from "./pglite.js";

/**
 * The four adapters (6.2): every one refuses a key this package didn't make
 * before any I/O (review G7); S3's signer is proven by AWS's two documented
 * vectors (review BO-16) and its round trip against a fake server that
 * checks shape and encoding only; Vercel Blob's against a fake SDK, with a
 * "private" token that turns out public refused (review G9); local disk in a
 * temp folder.
 */

const NOW = new Date("2026-10-15T12:00:00Z");
const BAD_KEYS = ["t/../x.png", "t/abc/%2e%2e/x.png", "/etc/passwd", "t\\0000000000000000\\2026\\10\\x.png", "C:\\Windows\\x.png"];
const LEGACY_KEYS = ["t/acme/0b0e1a2f-0000-4000-8000-000000000001-Q3_report.pdf", "tenancy/logos/acme/01890a5d-ac96-774b-bcce-b302099a8057.png"];

async function refusesBadKeys(store: BlobStore, noIo: () => void) {
  for (const key of BAD_KEYS) {
    await expect(store.put(key, PNG, { contentType: "image/png" }), key).rejects.toThrow(InvalidKeyError);
    await expect(store.get(key), key).rejects.toThrow(InvalidKeyError);
    await expect(store.delete(key), key).rejects.toThrow(InvalidKeyError);
  }
  // A legacy shape is never PUT, only read and deleted.
  for (const key of LEGACY_KEYS) await expect(store.put(key, PNG, { contentType: "image/png" }), key).rejects.toThrow(InvalidKeyError);
  noIo();
}

describe("S3: AWS's documented signature examples (review BO-16)", () => {
  const keys = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const when = new Date("2013-05-24T00:00:00Z");

  it("1. the presigned GET of examplebucket/test.txt", () => {
    const url = presignS3Url({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1", ...keys, expiresInSeconds: 86400, now: when });
    expect(url).toContain("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request");
    expect(url.endsWith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")).toBe(true);
  });

  it("2. the header-signed GET Object with Range: bytes=0-9", () => {
    const headers = signS3Request({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      region: "us-east-1",
      ...keys,
      now: when,
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY_SHA256,
    });
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers.host).toBeUndefined();
  });
});

describe("S3-compatible store against a fake server", () => {
  let s3: FakeS3;
  beforeAll(async () => {
    s3 = await startFakeS3({ region: "auto" });
  });
  afterAll(async () => {
    await s3.close();
  });
  const make = (access: "private" | "public" = "private") =>
    createS3CompatibleStore({
      endpoint: s3.endpoint,
      bucket: "photos-private",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      access,
      ...(access === "public" ? { publicBaseUrl: "https://files.example.com" } : {}),
      now: () => NOW,
    });

  it("put, get, delete: signed with the body's real hash, the path encoded segment by segment", async () => {
    const store = make();
    const key = await newPrivateKey("acme", "png", NOW);
    s3.seen.length = 0;
    expect(await store.put(key, PNG, { contentType: "image/png", cacheControl: "private, no-store" })).toEqual({ url: null });
    const got = await store.get(key);
    expect(got?.contentType).toBe("image/png");
    expect(new Uint8Array(await new Response(got?.body as BodyInit).arrayBuffer())).toEqual(PNG);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.delete(key); // missing: resolves
    expect(s3.seen.map((r) => r.method)).toEqual(["PUT", "GET", "DELETE", "GET", "DELETE"]);
    for (const r of s3.seen) {
      expect(r.problems, `${r.method} ${r.rawPath}`).toEqual([]);
      expect(r.rawPath).toBe(`/photos-private/${key}`);
    }
    expect(s3.seen[0]?.headers["x-amz-content-sha256"]).toBe(createHash("sha256").update(PNG).digest("hex"));
    expect(s3.seen[0]?.headers["content-type"]).toBe("image/png");
    expect(s3.seen[1]?.headers["x-amz-content-sha256"]).toBe(EMPTY_SHA256);
  });

  it("encodes a legacy key's segments (spaces, unicode) once, never normalising the path", async () => {
    const store = make();
    const key = "t/acme co/0b0e1a2f-0000-4000-8000-000000000001-Résumé (1).pdf";
    s3.seen.length = 0;
    expect(await store.get(key)).toBeNull();
    expect(s3.seen[0]?.rawPath).toBe("/photos-private/t/acme%20co/0b0e1a2f-0000-4000-8000-000000000001-R%C3%A9sum%C3%A9%20%281%29.pdf");
  });

  it("a public store answers its own public address", async () => {
    const key = newPublicKey("png");
    expect(await make("public").put(key, PNG, { contentType: "image/png" })).toEqual({ url: `https://files.example.com/${key}` });
  });

  it("checkPrivate: an unsigned GET answered 403 → ok; answered 200 → not ok, and says why; the probe is deleted", async () => {
    const store = make();
    s3.anonymousStatus = 403;
    expect(await store.checkPrivate?.()).toEqual({ ok: true, reason: null });
    s3.anonymousStatus = 200;
    expect(await store.checkPrivate?.()).toEqual({ ok: false, reason: "The private bucket lets anyone read its files. Remove its public access policy." });
    s3.anonymousStatus = 403;
    expect([...s3.objects.keys()].filter((k) => k.includes("/t/0000000000000000/"))).toEqual([]);
  });

  it("refuses a bad key before sending anything", async () => {
    const store = make();
    s3.seen.length = 0;
    await refusesBadKeys(store, () => expect(s3.seen).toEqual([]));
  });

  it("refuses to start without what it needs", () => {
    expect(() => createS3CompatibleStore({ endpoint: "not a url", bucket: "b1b", accessKeyId: "a", secretAccessKey: "b", access: "private" })).toThrow();
    expect(() => createS3CompatibleStore({ endpoint: s3.endpoint, bucket: "b1b", accessKeyId: "a", secretAccessKey: "b", access: "public" })).toThrow(/publicBaseUrl/);
  });
});

describe("Vercel Blob with a fake SDK", () => {
  function fakeSdk(host = "abc.private.blob.vercel-storage.com") {
    const calls: { fn: string; pathname: string; options: Record<string, unknown> }[] = [];
    const blobs = new Map<string, { bytes: Uint8Array; contentType: string }>();
    const sdk: VercelBlobSdk = {
      async put(pathname, body, options) {
        calls.push({ fn: "put", pathname, options });
        blobs.set(pathname, { bytes: new Uint8Array(body), contentType: String(options.contentType) });
        return { url: `https://${host}/${pathname}`, pathname };
      },
      async get(pathname, options) {
        calls.push({ fn: "get", pathname, options });
        const found = blobs.get(pathname);
        return found ? { stream: new Response(found.bytes as BodyInit).body as ReadableStream<Uint8Array>, blob: { contentType: found.contentType, size: found.bytes.length } } : null;
      },
      async head(pathname, options) {
        calls.push({ fn: "head", pathname, options });
        const found = blobs.get(pathname);
        if (!found) throw Object.assign(new Error("The requested blob does not exist"), { name: "BlobNotFoundError" });
        return { url: `https://${host}/${pathname}`, contentType: found.contentType, size: found.bytes.length };
      },
      async del(pathname, options) {
        calls.push({ fn: "del", pathname, options });
        blobs.delete(pathname);
      },
    };
    return { sdk, calls, blobs };
  }

  it("a private store: put with the key as given, no URL back; get through the SDK's private get; del", async () => {
    const fake = fakeSdk();
    const store = createVercelBlobStore({ sdk: fake.sdk, token: "vercel_blob_rw_private", access: "private" });
    const key = await newPrivateKey("acme", "png", NOW);
    expect(await store.put(key, PNG, { contentType: "image/png" })).toEqual({ url: null });
    expect(fake.calls[0]?.options).toEqual({ access: "private", token: "vercel_blob_rw_private", contentType: "image/png", addRandomSuffix: false, allowOverwrite: false });
    const got = await store.get(key);
    expect(fake.calls[1]).toEqual({ fn: "get", pathname: key, options: { access: "private", token: "vercel_blob_rw_private" } });
    expect(new Uint8Array(await new Response(got?.body as BodyInit).arrayBuffer())).toEqual(PNG);
    expect(await store.get(await newPrivateKey("acme", "png", NOW))).toBeNull();
    await store.delete(key);
    expect(fake.calls.at(-1)).toEqual({ fn: "del", pathname: key, options: { token: "vercel_blob_rw_private" } });
    expect(await store.checkPrivate?.()).toEqual({ ok: true, reason: null });
  });

  it("a public store: put answers blob.url; get is head then fetch; not found is null", async () => {
    const fake = fakeSdk("abc.public.blob.vercel-storage.com");
    const fetched: string[] = [];
    const store = createVercelBlobStore({
      sdk: fake.sdk,
      token: "vercel_blob_rw_public",
      access: "public",
      fetch: (async (url: string) => {
        fetched.push(url);
        const key = url.split(".com/")[1] ?? "";
        const found = fake.blobs.get(key);
        return found ? new Response(found.bytes as BodyInit, { headers: { "content-type": found.contentType } }) : new Response("", { status: 404 });
      }) as unknown as typeof fetch,
    });
    const key = newPublicKey("png");
    expect(await store.put(key, PNG, { contentType: "image/png" })).toEqual({ url: `https://abc.public.blob.vercel-storage.com/${key}` });
    expect(fake.calls[0]?.options).toMatchObject({ access: "public", addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 31536000 });
    const got = await store.get(key);
    expect(fake.calls.map((c) => c.fn)).toEqual(["put", "head"]);
    expect(fetched).toEqual([`https://abc.public.blob.vercel-storage.com/${key}`]);
    expect(new Uint8Array(await new Response(got?.body as BodyInit).arrayBuffer())).toEqual(PNG);
    expect(await store.get(newPublicKey("png"))).toBeNull();
  });

  it("a 'private' store whose token belongs to a PUBLIC store: the object is deleted and storage_off thrown (review G9)", async () => {
    const fake = fakeSdk("abc.public.blob.vercel-storage.com");
    const store = createVercelBlobStore({ sdk: fake.sdk, token: "the_public_token", access: "private" });
    const key = await newPrivateKey("acme", "png", NOW);
    const error = await store.put(key, PNG, { contentType: "image/png" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect((error as StorageError).code).toBe("storage_off");
    expect((error as StorageError).message).toBe("The private file store's token belongs to a public store. Connect a private Blob store for photos and files.");
    expect(fake.blobs.has(key)).toBe(false);
    expect(await store.checkPrivate?.()).toEqual({
      ok: false,
      reason: "The private file store's token belongs to a public store. Connect a private Blob store for photos and files.",
    });
  });

  it("refuses a bad key before calling the SDK", async () => {
    const fake = fakeSdk();
    await refusesBadKeys(createVercelBlobStore({ sdk: fake.sdk, token: "t", access: "private" }), () => expect(fake.calls).toEqual([]));
  });
});

describe("local disk (development only)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "aig-storage-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round trip in a temp folder, its type beside it", async () => {
    const store = createLocalDiskStore({ dir: join(dir, "files"), access: "private" });
    const key = await newPrivateKey("acme", "png", NOW);
    expect(await store.put(key, PNG, { contentType: "image/png" })).toEqual({ url: null });
    expect(await store.get(key)).toEqual({ body: PNG, contentType: "image/png", size: PNG.length });
    await expect(store.put(key, PNG, { contentType: "image/png" })).rejects.toThrow(); // never over an existing object
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.delete(key);
  });

  it("refuses ../, an absolute path and a backslash before touching the disk", async () => {
    const root = join(dir, "untouched");
    const store = createLocalDiskStore({ dir: root, access: "public" });
    await refusesBadKeys(store, () => expect(existsSync(root)).toBe(false));
    expect(readdirSync(dir)).not.toContain("untouched");
  });
});

describe("the memory store", () => {
  it("checks keys like every adapter", async () => {
    const store = createMemoryBlobStore({ access: "private" });
    await refusesBadKeys(store, () => expect(store.objects.size).toBe(0));
    const pub = createMemoryBlobStore({ access: "public", publicBaseUrl: "https://e2e.test/blobs/" });
    const key = newPublicKey("png");
    expect(await pub.put(key, PNG, { contentType: "image/png" })).toEqual({ url: `https://e2e.test/blobs/${key}` });
    for (const legacy of LEGACY_KEYS) {
      expect(await store.get(legacy)).toBeNull();
      await store.delete(legacy);
    }
  });
});

describe("storage.checkPrivateStore (review G9)", () => {
  const base = { db: {} as never, tables: storageTables, urls: { content: () => "/", publicBase: "https://app.test/api/files" } };
  it("off without a private store; the store's own check otherwise; never throws", async () => {
    expect(await createStorage({ ...base, stores: {} }).checkPrivateStore()).toEqual({ ok: false, reason: "File storage isn't switched on yet." });
    expect(await createStorage({ ...base, stores: { private: createMemoryBlobStore({ access: "private" }) } }).checkPrivateStore()).toEqual({ ok: true, reason: null });
    const leaky: BlobStore = {
      access: "private",
      put: async () => ({ url: null }),
      get: async () => null,
      delete: async () => undefined,
      checkPrivate: async () => ({ ok: false, reason: "The private bucket lets anyone read its files. Remove its public access policy." }),
    };
    expect(await createStorage({ ...base, stores: { private: leaky } }).checkPrivateStore()).toEqual({
      ok: false,
      reason: "The private bucket lets anyone read its files. Remove its public access policy.",
    });
    const throwing: BlobStore = { ...leaky, checkPrivate: async () => { throw new Error("down"); } };
    expect((await createStorage({ ...base, stores: { private: throwing }, onError: () => undefined }).checkPrivateStore()).ok).toBe(false);
  });
});

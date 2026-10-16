import { assertStorageKey } from "./keys.js";
import type { BlobObject, BlobStore } from "./types.js";

/**
 * An in-memory store for tests and the e2e fixture (`./testing`). It checks
 * keys exactly like every other adapter (review G7), so the package's own
 * tests exercise the refusal; `plant` is the one way around it, for a test
 * that needs a 0.1 or 2a object already in a store.
 */
export interface MemoryBlobStore extends BlobStore {
  readonly objects: ReadonlyMap<string, { readonly bytes: Uint8Array; readonly contentType: string }>;
  /** The next call of that kind rejects once (a store that fails). */
  failNext(op: "put" | "get" | "delete"): void;
  /** How many times each operation was called (a test that must prove the store was NOT read). */
  readonly calls: { readonly put: number; readonly get: number; readonly delete: number };
  /** Puts an object under ANY key, legacy shapes included, with no key check: a test's way to stand up 0.1/2a data. */
  plant(key: string, bytes: Uint8Array, contentType: string): void;
}

export function createMemoryBlobStore(options: { readonly access: "private" | "public"; readonly publicBaseUrl?: string }): MemoryBlobStore {
  const objects = new Map<string, { readonly bytes: Uint8Array; readonly contentType: string }>();
  const failing = new Set<"put" | "get" | "delete">();
  const calls = { put: 0, get: 0, delete: 0 };
  const base = options.publicBaseUrl?.replace(/\/+$/, "") ?? null;
  const maybeFail = (op: "put" | "get" | "delete") => {
    if (failing.delete(op)) throw new Error(`The memory store was told to fail this ${op}.`);
  };
  return {
    access: options.access,
    objects,
    calls,
    failNext(op) {
      failing.add(op);
    },
    plant(key, bytes, contentType) {
      objects.set(key, { bytes: bytes.slice(), contentType });
    },
    async put(key, bytes, putOptions) {
      calls.put += 1;
      assertStorageKey(key, "put");
      maybeFail("put");
      objects.set(key, { bytes: bytes.slice(), contentType: putOptions.contentType });
      return { url: options.access === "public" && base ? `${base}/${key}` : null };
    },
    async get(key): Promise<BlobObject | null> {
      calls.get += 1;
      assertStorageKey(key, "get");
      maybeFail("get");
      const found = objects.get(key);
      return found ? { body: found.bytes.slice(), contentType: found.contentType, size: found.bytes.byteLength } : null;
    },
    async delete(key) {
      calls.delete += 1;
      assertStorageKey(key, "delete");
      maybeFail("delete");
      objects.delete(key);
    },
    async checkPrivate() {
      return { ok: true, reason: null };
    },
  };
}

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { assertStorageKey } from "./keys.js";
import { InvalidKeyError, type BlobObject, type BlobStore } from "./types.js";

/**
 * `@adminigloo/storage/local`: files on this machine's disk. FOR DEVELOPMENT
 * ONLY (review BO-08): `pnpm dev` and a client-style install get working logo
 * uploads and job photos with no cloud account. A serverless host's disk is
 * thrown away between requests, so production uses ./vercel-blob or ./s3.
 *
 * A key must pass STORAGE_KEY_PATTERN (or, for get and delete, the legacy
 * check), else InvalidKeyError before the disk is touched. The object is
 * `{dir}/{key}`, RESOLVED and checked to stay inside `dir` (belt and braces
 * over the key check: a `..` can't climb out, nor a drive letter on Windows).
 * Its type sits beside it in `{key}.type`. `put` answers url null: public
 * files are then served by the package's public route (6.8).
 */
export function createLocalDiskStore(options: { readonly dir: string; readonly access: "private" | "public" }): BlobStore {
  if (typeof options?.dir !== "string" || options.dir === "") throw new Error("createLocalDiskStore: pass dir (a folder for the files).");
  if (options.access !== "private" && options.access !== "public") throw new Error('createLocalDiskStore: access must be "private" or "public".');
  const root = resolve(options.dir);

  function pathFor(key: string, op: "put" | "get" | "delete"): string {
    assertStorageKey(key, op);
    const target = resolve(root, ...key.split("/"));
    if (!target.startsWith(root + sep)) throw new InvalidKeyError();
    return target;
  }

  const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "ENOENT";

  return {
    access: options.access,
    async put(key, bytes, putOptions) {
      const target = pathFor(key, "put");
      await mkdir(dirname(target), { recursive: true });
      // `wx`: never over an existing object (keys are random; a clash is a bug).
      await writeFile(target, bytes, { flag: "wx" });
      await writeFile(`${target}.type`, putOptions.contentType, "utf8");
      return { url: null };
    },
    async get(key): Promise<BlobObject | null> {
      const target = pathFor(key, "get");
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(target));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      let contentType: string | null = null;
      try {
        contentType = (await readFile(`${target}.type`, "utf8")).trim() || null;
      } catch {
        contentType = null;
      }
      return { body: bytes, contentType, size: bytes.byteLength };
    },
    async delete(key) {
      const target = pathFor(key, "delete");
      await rm(target, { force: true });
      await rm(`${target}.type`, { force: true });
    },
    async checkPrivate() {
      // A folder on this machine is served by nobody but the package.
      return { ok: true, reason: null };
    },
  };
}

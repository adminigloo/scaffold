import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_SIZE_BYTES,
  deleteFile,
  listFiles,
  sanitizeFilename,
  storeFile,
  type BlobStore,
  type StoredFileRow,
} from "../index.js";

/** The narrowest fake for the chains this module runs — the house pattern. */
function fakeDb(state: {
  insertedRow?: Partial<StoredFileRow>;
  insertThrows?: boolean;
  deletedPathnames?: string[];
  rows?: Array<Record<string, unknown>>;
}) {
  const inserted: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return {
          returning: async () => {
            if (state.insertThrows) throw new Error("connection reset");
            return [{ ...row, id: "row_1", createdAt: new Date(), ...state.insertedRow }];
          },
        };
      },
    }),
    delete: () => ({
      where: () => ({
        returning: async () => (state.deletedPathnames ?? []).map((pathname) => ({ pathname })),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => state.rows ?? [] }),
          limit: async () => state.rows ?? [],
        }),
      }),
    }),
  };
  return { db: db as never, inserted };
}

/** A store that remembers its puts and deletes, and can be told to fail. */
function fakeStore(options: { deleteRejects?: boolean } = {}) {
  const puts: Array<{ pathname: string; contentType: string }> = [];
  const deletes: string[] = [];
  const store: BlobStore = {
    put: async (pathname, _body, opts) => {
      puts.push({ pathname, contentType: opts.contentType });
      return { url: `https://blobs.example/${pathname}`, pathname };
    },
    delete: async (pathname) => {
      deletes.push(pathname);
      if (options.deleteRejects) throw new Error("store unavailable");
    },
  };
  return { store, puts, deletes };
}

const INPUT = {
  tenantId: "acme",
  ownerId: "user_1",
  kind: "library.file",
  filename: "Q3 report.pdf",
  contentType: "application/pdf",
  sizeBytes: 1024,
  body: "bytes",
};

describe("sanitizeFilename", () => {
  it("keeps ordinary names and their extension dots", () => {
    expect(sanitizeFilename("invoice-2026.final.pdf")).toBe("invoice-2026.final.pdf");
  });

  it("underscores separators, spaces and specials", () => {
    const backslash = String.fromCharCode(92);
    const cleaned = sanitizeFilename(`a/b${backslash}c: d*e?.png`);
    expect(cleaned).not.toContain("/");
    expect(cleaned).not.toContain(backslash);
    expect(cleaned).not.toContain(" ");
    expect(cleaned.endsWith(".png")).toBe(true);
  });

  it("refuses to produce a dotfile or an empty name", () => {
    expect(sanitizeFilename("..htaccess").startsWith(".")).toBe(false);
    expect(sanitizeFilename("   ")).toBe("file");
  });
});

describe("storeFile", () => {
  it("puts the blob under the tenant's prefix, then writes the receipt", async () => {
    const { db, inserted } = fakeDb({});
    const { store, puts } = fakeStore();

    const row = await storeFile(db, store, INPUT);

    expect(puts).toHaveLength(1);
    expect(puts[0]?.pathname.startsWith("t/acme/")).toBe(true);
    expect(puts[0]?.pathname.endsWith("Q3_report.pdf")).toBe(true);
    expect(puts[0]?.contentType).toBe("application/pdf");
    expect(inserted[0]?.tenantId).toBe("acme");
    expect(inserted[0]?.filename).toBe("Q3_report.pdf");
    expect(row.url).toContain("t/acme/");
  });

  it("rejects a file over the size cap before touching the store", async () => {
    const { db } = fakeDb({});
    const { store, puts } = fakeStore();

    await expect(
      storeFile(db, store, { ...INPUT, sizeBytes: DEFAULT_MAX_SIZE_BYTES + 1 }),
    ).rejects.toThrow(/limit/);
    expect(puts).toHaveLength(0);
  });

  it("rejects a content type that is not a media type", async () => {
    const { db } = fakeDb({});
    const { store, puts } = fakeStore();

    await expect(
      storeFile(db, store, { ...INPUT, contentType: "not a type" }),
    ).rejects.toThrow();
    expect(puts).toHaveLength(0);
  });

  it("takes the blob back out when the receipt cannot be written", async () => {
    const { db } = fakeDb({ insertThrows: true });
    const { store, puts, deletes } = fakeStore();

    await expect(storeFile(db, store, INPUT)).rejects.toThrow("connection reset");
    expect(puts).toHaveLength(1);
    expect(deletes).toEqual([puts[0]?.pathname]);
  });
});

describe("deleteFile", () => {
  it("never touches the store when the row was not this tenant's", async () => {
    const { db } = fakeDb({ deletedPathnames: [] });
    const { store, deletes } = fakeStore();

    const result = await deleteFile(db, store, { id: "row_1", tenantId: "acme" });

    expect(result).toEqual({ deleted: false, blobRemoved: false });
    expect(deletes).toHaveLength(0);
  });

  it("deletes the blob the row named", async () => {
    const { db } = fakeDb({ deletedPathnames: ["t/acme/abc-file.png"] });
    const { store, deletes } = fakeStore();

    const result = await deleteFile(db, store, { id: "row_1", tenantId: "acme" });

    expect(result).toEqual({ deleted: true, blobRemoved: true });
    expect(deletes).toEqual(["t/acme/abc-file.png"]);
  });

  it("reports a store failure instead of throwing — the receipt is already gone", async () => {
    const { db } = fakeDb({ deletedPathnames: ["t/acme/abc-file.png"] });
    const { store } = fakeStore({ deleteRejects: true });

    const result = await deleteFile(db, store, { id: "row_1", tenantId: "acme" });

    expect(result).toEqual({ deleted: true, blobRemoved: false });
  });
});

describe("listFiles", () => {
  it("returns what the tenant-scoped query returns", async () => {
    const rows = [{ id: "row_1", filename: "a.png" }];
    const { db } = fakeDb({ rows });
    expect(await listFiles(db, { tenantId: "acme" })).toEqual(rows);
  });
});

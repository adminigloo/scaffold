import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deleteFile, getFile, listFiles, storeFile } from "../legacy.js";
import { createMemoryBlobStore } from "../memory.js";
import { storageTables } from "../schema.js";
import { storageSql, storageUpgradeSql } from "../sql.js";
import type { BlobStoreV1 } from "../types.js";
import { createTestDb, PNG, pdf, tenant, type TestDb } from "./pglite.js";
import { buildWorld, ESTIMATE_PHOTO } from "./world.js";

/**
 * The shipped SQL (6.1, D14): the files equal the functions, the SQL runs
 * twice, the package's service suite runs on tables built from it under a
 * Postgres schema and a prefix (with a host's OWN `stored_files` in public,
 * untouched), and a 0.1 table upgrades in place with its rows kept public and
 * 0.1's functions still working.
 */

const here = dirname(fileURLToPath(import.meta.url));
const file = (name: string) => readFileSync(resolve(here, "../../sql", name), "utf8").replace(/\r\n/g, "\n");

describe("the shipped files", () => {
  it("sql/storage-0.2.0.sql is storageSql()", () => {
    expect(file("storage-0.2.0.sql")).toBe(storageSql());
  });
  it("sql/upgrade-0.1-to-0.2.sql is storageUpgradeSql()", () => {
    expect(file("upgrade-0.1-to-0.2.sql")).toBe(storageUpgradeSql());
  });
  it("opens with its guard, before anything is created", () => {
    const text = storageSql({ schema: "adminigloo" });
    expect(text.indexOf("raise exception")).toBeLessThan(text.indexOf("create schema"));
    expect(text.indexOf("raise exception")).toBeLessThan(text.indexOf("create table"));
    expect(storageUpgradeSql().indexOf("raise exception")).toBeLessThan(storageUpgradeSql().indexOf("alter table"));
  });
});

describe("the service suite on tables built from storageSql({ schema: 'adminigloo', prefix: 'aig_' })", () => {
  let t: TestDb;
  const HOST_TABLE = `
    create table public.stored_files (id text primary key, tenant_id text, pathname text, note text);
    insert into public.stored_files values ('h1', 'acme', 'invoices/2026/a.pdf', 'the host''s own'), ('h2', 'acme', 'invoices/2026/b.pdf', 'also the host''s');`;
  const hostRows = async () => (await t.client.query("select * from public.stored_files order by id")).rows;
  let before: unknown[];

  beforeAll(async () => {
    t = await createTestDb({ schema: "adminigloo", prefix: "aig_", before: HOST_TABLE });
    before = await hostRows();
  });
  afterAll(async () => {
    await t.close();
  });

  it("runs twice without complaint", async () => {
    await t.client.exec(storageSql({ schema: "adminigloo", prefix: "aig_" }));
  });

  it("stores, lists, opens, links, attaches, removes and purges, and the host's stored_files is untouched", async () => {
    const w = buildWorld(t, { purposes: [{ key: "library", label: "Company file", access: "private", types: ["png", "pdf"], maxBytes: 1 << 20 }, ESTIMATE_PHOTO] });
    const a = tenant();
    w.records.add("estimator.estimate", a, "e1", { label: "Estimate 1042 · Pat Rivera" });
    const one = await w.storage.store({ tenantId: a, purpose: "library", bytes: PNG, filename: "yard.png", addedBy: "u1" });
    const two = await w.storage.store({ tenantId: a, purpose: "library", bytes: pdf(), filename: "quote.pdf" });
    expect((await w.storage.list({ tenantId: a })).files.map((f) => f.id)).toEqual([two.id, one.id]);
    const opened = await w.storage.open({ tenantId: a, fileId: one.id });
    expect(opened?.object.contentType).toBe("image/png");
    w.valid.add(`${a}|u1`);
    const link = await w.storage.signedLink({ tenantId: a, fileId: one.id, userId: "u1" });
    expect((await w.storage.resolveLink(link?.url.split("/v1/f/")[1] ?? ""))?.id).toBe(one.id);
    const photo = await w.storage.store({ tenantId: a, purpose: "estimator.photo", bytes: PNG });
    expect(await w.storage.attach({ tenantId: a, fileId: photo.id, record: { type: "estimator.estimate", id: "e1" } })).toBe(true);
    expect((await w.storage.usage(a)).fileCount).toBe(3);
    w.priv.failNext("delete");
    expect(await w.storage.remove({ tenantId: a, fileId: two.id })).toEqual({ removed: true, objectRemoved: false });
    expect(await w.storage.purgeDeleted()).toEqual({ purged: 1, failed: 0, gaveUp: 0 });
    expect((await w.storage.usage(a)).fileCount).toBe(2);
    expect(await hostRows()).toEqual(before);
    // Every statement named the package's own table, never the host's.
    expect(t.queries.some((q) => /"aig_stored_files"/.test(q.sql))).toBe(true);
    expect(t.queries.some((q) => /(^|[^_])"stored_files"/.test(q.sql))).toBe(false);
  });
});

describe("upgrading a 0.1 table (sql/upgrade-0.1-to-0.2.sql)", () => {
  let t: TestDb;
  const V01 = `
    create table stored_files (
      id text primary key, tenant_id text not null, owner_id text not null, kind text not null,
      filename text not null, content_type text not null, size_bytes integer not null,
      pathname text not null, url text not null, created_at timestamp with time zone not null default now()
    );
    create index stored_files_tenant_created_idx on stored_files (tenant_id, created_at);
    create index stored_files_tenant_kind_idx on stored_files (tenant_id, kind);
    insert into stored_files values
      ('f1', '*', 'staff_1', 'library.file', 'Q3_report.pdf', 'application/pdf', 10, 't/*/0b0e1a2f-0000-4000-8000-000000000001-Q3_report.pdf', 'https://blob.example/t/*/a', now() - interval '2 days'),
      ('f2', 'acme', 'estimator', 'estimator.photo', 'estimate-photo.jpg', 'image/jpeg', 20, 't/acme/0b0e1a2f-0000-4000-8000-000000000002-estimate-photo.jpg', 'https://blob.example/t/acme/b', now() - interval '1 day');`;

  beforeAll(async () => {
    // Built by hand as 0.1 shipped it, NOT from storageSql (which would refuse it: that's the point).
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = new PGlite();
    await client.exec(V01);
    t = { client, db: drizzle(client) as never, tables: storageTables, queries: [], close: () => client.close() };
  });
  afterAll(async () => {
    await t.close();
  });

  it("the 0.2 create refuses to run over it, pointing at the upgrade", async () => {
    await expect(t.client.exec(storageSql())).rejects.toThrow(/already exists and isn't AdminIgloo's.*Pass a prefix or a schema.*upgrade-0\.1-to-0\.2\.sql/);
  });

  it("upgrades in place: every row kept, every 0.1 row public, the new columns and indexes there", async () => {
    await t.client.exec(storageUpgradeSql());
    const rows = (await t.client.query<{ id: string; access: string; purge_attempts: number; deleted_at: unknown; tenant_id: string }>(
      "select id, access, purge_attempts, deleted_at, tenant_id from stored_files order by id",
    )).rows;
    expect(rows).toEqual([
      { id: "f1", access: "public", purge_attempts: 0, deleted_at: null, tenant_id: "*" },
      { id: "f2", access: "public", purge_attempts: 0, deleted_at: null, tenant_id: "acme" },
    ]);
    const indexes = (await t.client.query<{ indexname: string }>("select indexname from pg_indexes where tablename = 'stored_files' order by indexname")).rows.map((r) => r.indexname);
    expect(indexes).toEqual([
      "stored_files_live_idx",
      "stored_files_pathname_uidx",
      "stored_files_pkey",
      "stored_files_purge_idx",
      "stored_files_record_idx",
      "stored_files_tenant_created_idx",
      "stored_files_tenant_kind_idx",
    ]);
  });

  it("running it again is a no-op (the table is exactly 0.2's now)", async () => {
    await t.client.exec(storageUpgradeSql());
    await t.client.exec(storageSql());
  });

  it("0.1's functions keep working on the upgraded table", async () => {
    const puts: string[] = [];
    const store: BlobStoreV1 = {
      put: async (pathname) => {
        puts.push(pathname);
        return { url: `https://blob.example/${pathname}`, pathname };
      },
      delete: async () => undefined,
    };
    const row = await storeFile(t.db, store, { tenantId: "acme", ownerId: "u1", kind: "library.file", filename: "a b.pdf", contentType: "application/pdf", sizeBytes: 5, body: "bytes" });
    expect(row.url).toContain("t/acme/");
    expect((await listFiles(t.db, { tenantId: "acme" })).map((r) => r.id)).toEqual([row.id, "f2"]);
    expect((await getFile(t.db, { id: "f2", tenantId: "acme" }))?.ownerId).toBe("estimator");
    expect(await deleteFile(t.db, store, { id: row.id, tenantId: "acme" })).toEqual({ deleted: true, blobRemoved: true });
  });

  it("a 0.2 instance reads the upgraded rows from the PUBLIC store they are in (D13)", async () => {
    const pub = createMemoryBlobStore({ access: "public" });
    pub.plant("t/acme/0b0e1a2f-0000-4000-8000-000000000002-estimate-photo.jpg", new Uint8Array([0xff, 0xd8, 0xff, 1]), "image/jpeg");
    const { createStorage } = await import("../instance.js");
    const storage = createStorage({
      db: t.db,
      tables: storageTables,
      stores: { private: createMemoryBlobStore({ access: "private" }), public: pub },
      purposes: [ESTIMATE_PHOTO],
      urls: { content: (x, id) => `/c/${x}/${id}`, publicBase: "https://app.test/api/files" },
    });
    const opened = await storage.open({ tenantId: "acme", fileId: "f2" });
    expect(opened?.file.access).toBe("public");
    expect(opened?.file.sha256).toBe("");
    expect(await storage.remove({ tenantId: "acme", fileId: "f2" })).toEqual({ removed: true, objectRemoved: true });
    expect(pub.objects.size).toBe(0);
  });
});

describe("the upgrade refuses a table that isn't AdminIgloo's 0.1 table", () => {
  it("raises, and alters nothing", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite();
    await client.exec("create table stored_files (id text, tenant_id text, pathname text); insert into stored_files values ('h1', 'acme', 'x');");
    await expect(client.exec(storageUpgradeSql())).rejects.toThrow(/isn't AdminIgloo's storage 0\.1 table\. Pass a prefix or a schema/);
    const columns = (await client.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'stored_files' order by ordinal_position")).rows;
    expect(columns.map((c) => c.column_name)).toEqual(["id", "tenant_id", "pathname"]);
    await client.close();
  });

  it("and says so when there is no table at all", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite();
    await expect(client.exec(storageUpgradeSql())).rejects.toThrow(/no table named stored_files to upgrade/);
    await client.close();
  });
});

describe("a 2a file with a % in its stored name, after the upgrade (review BUY-04)", () => {
  // 0.1's sanitizeFilename kept "%": these keys are real 2a keys. Before the
  // fix every get, delete and purge of one was refused before any I/O: the
  // file answered 500, "removed" left its public bytes, and the purge gave up.
  const KEYS = {
    invoice: "t/acme/0b0e1a2f-0000-4000-8000-000000000003-May%20invoice.pdf",
    done: "t/acme/0b0e1a2f-0000-4000-8000-000000000004-100%_done.pdf",
  };
  const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n%a 2a pdf\n");

  async function upgradedWithPercentRows() {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = new PGlite();
    await client.exec(`
      create table stored_files (
        id text primary key, tenant_id text not null, owner_id text not null, kind text not null,
        filename text not null, content_type text not null, size_bytes integer not null,
        pathname text not null, url text not null, created_at timestamp with time zone not null default now()
      );
      create index stored_files_tenant_created_idx on stored_files (tenant_id, created_at);
      insert into stored_files values
        ('p1', 'acme', 'staff_1', 'library.file', 'May%20invoice.pdf', 'application/pdf', ${PDF_BYTES.length}, '${KEYS.invoice}', 'https://blob.example/a', now()),
        ('p2', 'acme', 'staff_1', 'library.file', '100%_done.pdf', 'application/pdf', ${PDF_BYTES.length}, '${KEYS.done}', 'https://blob.example/b', now());`);
    await client.exec(storageUpgradeSql());
    const pub = createMemoryBlobStore({ access: "public" });
    pub.plant(KEYS.invoice, PDF_BYTES, "application/pdf");
    pub.plant(KEYS.done, PDF_BYTES, "application/pdf");
    const errors: string[] = [];
    const { createStorage } = await import("../instance.js");
    const storage = createStorage({
      db: drizzle(client) as never,
      tables: storageTables,
      stores: { private: createMemoryBlobStore({ access: "private" }), public: pub },
      purposes: [{ key: "library.file", label: "Company file", access: "public", types: ["pdf"], maxBytes: 1 << 20 }],
      urls: { content: (x, id) => `/c/${x}/${id}`, publicBase: "https://app.test/api/files" },
      onError: (error, context) => errors.push(`${context.step}: ${String(error)}`),
    });
    return { client, pub, storage, errors };
  }

  it("opens, and removing it deletes its bytes from the public store", async () => {
    const { client, pub, storage, errors } = await upgradedWithPercentRows();
    const opened = await storage.open({ tenantId: "acme", fileId: "p1" });
    expect(opened?.file.filename).toBe("May%20invoice.pdf");
    expect(await storage.remove({ tenantId: "acme", fileId: "p1" })).toEqual({ removed: true, objectRemoved: true });
    expect(pub.objects.has(KEYS.invoice)).toBe(false);
    expect(errors).toEqual([]);
    await client.close();
  });

  it("a removal whose store failed is finished by the purge, not given up on", async () => {
    const { client, pub, storage } = await upgradedWithPercentRows();
    pub.failNext("delete");
    expect(await storage.remove({ tenantId: "acme", fileId: "p2" })).toEqual({ removed: true, objectRemoved: false });
    expect(await storage.purgeDeleted()).toEqual({ purged: 1, failed: 0, gaveUp: 0 });
    expect(pub.objects.has(KEYS.done)).toBe(false);
    expect((await client.query("select id from stored_files where id = 'p2'")).rows).toEqual([]);
    await client.close();
  });
});

describe("run the way psql runs a file by default (review FH-1)", () => {
  // `psql -f` runs statement by statement with autocommit on and
  // ON_ERROR_STOP off: after the guard's RAISE it carries on. Each shipped
  // file must stop at its guard anyway, whatever runs it.
  function statements(text: string): string[] {
    const out: string[] = [];
    let buffer = "";
    let inDollar = false;
    for (const line of text.split("\n")) {
      buffer += `${line}\n`;
      if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inDollar = !inDollar;
      if (!inDollar && /;\s*$/.test(line)) {
        out.push(buffer.trim());
        buffer = "";
      }
    }
    if (buffer.trim()) out.push(buffer.trim());
    return out.filter((s) => s.replace(/--.*$/gm, "").trim() !== "");
  }

  async function psqlDefaults(client: { query: (sql: string) => Promise<unknown> }, text: string): Promise<string[]> {
    const errors: string[] = [];
    for (const statement of statements(text)) {
      try {
        await client.query(statement);
      } catch (error) {
        errors.push(String((error as Error).message));
      }
    }
    return errors;
  }

  const HOST = `
    create table stored_files (id serial primary key, tenant_id text, kind text, filename text, pathname text, url text, created_at timestamptz default now(), deleted_at timestamptz);
    insert into stored_files (tenant_id, kind, filename, pathname) select '1', 'invoice.pdf', 'inv.pdf', 'invoices/' || g || '.pdf' from generate_series(1, 3) g;`;

  async function hostShape(client: { query: <T>(sql: string) => Promise<{ rows: T[] }> }) {
    const indexes = (await client.query<{ indexname: string }>("select indexname from pg_indexes where tablename = 'stored_files' order by indexname")).rows.map((r) => r.indexname);
    const columns = (await client.query<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_name = 'stored_files' order by ordinal_position",
    )).rows;
    return { indexes, columns };
  }

  it("sql/storage-0.2.0.sql over a host's own stored_files: the guard refuses, and not one index lands on the host's table", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite();
    await client.exec(HOST);
    const before = await hostShape(client);
    const errors = await psqlDefaults(client, file("storage-0.2.0.sql"));
    expect(errors[0]).toMatch(/A table named stored_files already exists and isn't AdminIgloo's/);
    expect(await hostShape(client)).toEqual(before);
    // The host's own inserts still work (a UNIQUE pathname index would refuse this one).
    await client.query("insert into stored_files (tenant_id, kind, filename, pathname) values ('1', 'invoice.pdf', 'dup.pdf', 'invoices/1.pdf')");
    await client.close();
  });

  it("sql/upgrade-0.1-to-0.2.sql over a host's own stored_files: the guard refuses, and nothing is altered", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite();
    await client.exec(HOST);
    const before = await hostShape(client);
    const errors = await psqlDefaults(client, file("upgrade-0.1-to-0.2.sql"));
    expect(errors[0]).toMatch(/isn't AdminIgloo's storage 0\.1 table/);
    expect(await hostShape(client)).toEqual(before);
    await client.close();
  });

  it("storageSql under a schema still builds the table, run the same way", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite();
    await client.exec(HOST);
    expect(await psqlDefaults(client, storageSql({ schema: "adminigloo" }))).toEqual([]);
    const made = (await client.query<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'adminigloo' order by indexname")).rows.map((r) => r.indexname);
    expect(made).toContain("stored_files_pathname_uidx");
    await client.close();
  });
});

describe("a prefix alone and Prisma (review FH-2)", () => {
  it("storageSql with only a prefix says, in the file, that a Prisma host needs a schema", () => {
    expect(storageSql({ prefix: "aig_" })).toMatch(/-- .*Prisma.*schema/);
    expect(storageSql({ schema: "adminigloo" })).not.toMatch(/Prisma/);
    expect(storageSql({ schema: "adminigloo", prefix: "aig_" })).not.toMatch(/Prisma/);
  });
});

describe("the shipped files can be found by the package's name (review FH-10)", () => {
  it("@adminigloo/storage/sql/storage-0.2.0.sql and /package.json resolve, so a host script needn't hard-code a node_modules path", async () => {
    const { execFileSync } = await import("node:child_process");
    const resolveFromPackage = (specifier: string) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", `process.stdout.write(import.meta.resolve(${JSON.stringify(specifier)}))`], {
        cwd: resolve(here, "../.."),
        encoding: "utf8",
      });
    expect(resolveFromPackage("@adminigloo/storage/sql/storage-0.2.0.sql")).toMatch(/\/packages\/storage\/sql\/storage-0\.2\.0\.sql$/);
    expect(resolveFromPackage("@adminigloo/storage/sql/upgrade-0.1-to-0.2.sql")).toMatch(/\/sql\/upgrade-0\.1-to-0\.2\.sql$/);
    expect(resolveFromPackage("@adminigloo/storage/package.json")).toMatch(/\/packages\/storage\/package\.json$/);
  });
});

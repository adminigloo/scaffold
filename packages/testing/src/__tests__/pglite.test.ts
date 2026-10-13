import { sql } from "drizzle-orm";
import { pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { authSchema } from "@adminigloo/auth/schema";
import { permissionsSchema } from "@adminigloo/permissions/schema";
import { tenancySchema } from "@adminigloo/tenancy/schema";
import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDb, PgliteDdlError, schemaDdl, type PgliteTestDb } from "../pglite.js";

/**
 * @adminigloo/testing/pglite (contract 10.3): the DDL builder over a real
 * project-shaped schema (the permissions enums, tenant_members' composite PK,
 * tenant_invitations' partial unique index, FKs with ON DELETE CASCADE), and
 * the public API.
 */

const schema = {
  ...authSchema,
  ...tenancySchema,
  ...permissionsSchema,
  // A project's schema object also carries things that aren't DDL.
  notATable: { hello: "world" },
  aFunction: () => 1,
};

let db: PgliteTestDb<typeof schema> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("schemaDdl", () => {
  it("emits enums first, then tables, then FKs and indexes; skips non-DDL values", () => {
    const ddl = schemaDdl(schema);
    expect(ddl[0]).toMatch(/^CREATE TYPE "permission_scope" AS ENUM \('staff', 'tenant'\)$/);
    const firstTable = ddl.findIndex((s) => s.startsWith("CREATE TABLE"));
    const firstFk = ddl.findIndex((s) => s.includes("FOREIGN KEY"));
    const firstIndex = ddl.findIndex((s) => s.includes("INDEX"));
    expect(firstTable).toBeGreaterThan(0);
    expect(firstFk).toBeGreaterThan(firstTable);
    expect(firstIndex).toBeGreaterThan(firstTable);
    expect(ddl.some((s) => s.includes("notATable"))).toBe(false);
    expect(ddl.find((s) => s.startsWith('CREATE TABLE "tenant_members"'))).toContain('PRIMARY KEY ("tenant_id", "user_id")');
    expect(ddl.find((s) => s.includes('"tenant_invitations_tenant_email_open_idx"'))).toMatch(/WHERE .*accepted_at.* is null/);
  });

  it("throws a named error for a default it can't write as a literal", () => {
    const odd = pgTable("odd", { id: text("id").primaryKey(), v: text("v").default(Symbol("no") as unknown as string) });
    expect(() => schemaDdl({ odd })).toThrow(PgliteDdlError);
  });

  it("writes unique constraints", () => {
    const t = pgTable("uniq", { a: text("a").notNull(), b: text("b").unique() }, (x) => [uniqueIndex("uniq_a").on(x.a)]);
    const ddl = schemaDdl({ t });
    expect(ddl[0]).toContain("UNIQUE");
  });
});

describe("createPgliteDb", () => {
  it("builds the whole schema; ON CONFLICT on the partial index works; the cascade fires", async () => {
    db = await createPgliteDb({ schema });
    await db.db.execute(sql`insert into tenants (id, slug, name) values ('t1', 'acme', 'Acme')`);
    await db.db.execute(sql`insert into tenant_members (tenant_id, user_id) values ('t1', 'u1')`);
    const upsert = sql`insert into tenant_invitations (id, tenant_id, email, token_hash) values (${"i" + Math.random()}, 't1', 'a@b.test', ${"h" + Math.random()})
      on conflict (tenant_id, email) where accepted_at is null and revoked_at is null do update set token_hash = excluded.token_hash`;
    await db.db.execute(upsert);
    await db.db.execute(sql`insert into tenant_invitations (id, tenant_id, email, token_hash) values ('i2', 't1', 'a@b.test', 'h2')
      on conflict (tenant_id, email) where accepted_at is null and revoked_at is null do update set token_hash = excluded.token_hash`);
    const count = await db.db.execute(sql`select count(*)::int as n from tenant_invitations`);
    expect(count.rows[0]).toEqual({ n: 1 });
    await db.db.execute(sql`delete from tenants where id = 't1'`);
    const after = await db.db.execute(sql`select count(*)::int as n from tenant_members`);
    expect(after.rows[0]).toEqual({ n: 0 });
  });

  it("returns a db whose db.query.<table> works, and logs statements", async () => {
    db = await createPgliteDb({ schema });
    await db.db.execute(sql`insert into users (id, external_id, email) values ('u1', 'user_1', 'a@b.test')`);
    db.queries.length = 0;
    const found = await db.db.query.users.findFirst();
    expect(found?.email).toBe("a@b.test");
    expect(db.queries.length).toBeGreaterThan(0);
    expect(db.queries[0]?.sql).toMatch(/select/i);
  });
});

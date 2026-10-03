import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, schemaDdl, type TestDb } from "./pglite.js";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe("test database", () => {
  it("builds the schema from the drizzle tables", async () => {
    expect(schemaDdl().join("\n")).toContain('CREATE TABLE "booking_bookings"');
    const result = await t.db.execute(sql`select pg_advisory_xact_lock(hashtext('x'))`);
    expect(result).toBeDefined();
  });
});

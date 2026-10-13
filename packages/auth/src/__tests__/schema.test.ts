import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { users } from "../schema.js";

describe("users.provisioned_at (Tenancy 1, decision D8)", () => {
  it("exists, is a timestamptz, and is nullable (null = provision on the next request)", () => {
    const column = getTableConfig(users).columns.find((c) => c.name === "provisioned_at");
    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe("timestamp with time zone");
    expect(column?.notNull).toBe(false);
    // No default: a default would stamp every existing row on upgrade, and the
    // whole point of a null stamp is that the next request repairs the user.
    expect(column?.default).toBeUndefined();
  });
});

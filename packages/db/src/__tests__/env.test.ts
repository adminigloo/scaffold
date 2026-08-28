import { describe, expect, it } from "vitest";
import { dbServer } from "../env.js";

const DIRECT = "postgresql://u:p@ep-cool-name.us-east-2.aws.neon.tech/db";
const POOLED = "postgresql://u:p@ep-cool-name-pooler.us-east-2.aws.neon.tech/db";

describe("dbServer", () => {
  const schema = dbServer();

  it("accepts the pooled endpoint for the app connection", () => {
    expect(schema.DATABASE_URL.safeParse(POOLED).success).toBe(true);
  });

  it("rejects the direct endpoint for the app connection", () => {
    expect(schema.DATABASE_URL.safeParse(DIRECT).success).toBe(false);
  });

  it("accepts the direct endpoint for migrations", () => {
    expect(schema.DATABASE_URL_UNPOOLED.safeParse(DIRECT).success).toBe(true);
  });

  it("rejects the pooled endpoint for migrations", () => {
    expect(schema.DATABASE_URL_UNPOOLED.safeParse(POOLED).success).toBe(false);
  });

  it("rejects a non-postgres url outright", () => {
    expect(schema.DATABASE_URL.safeParse("https://example.com").success).toBe(false);
  });
});

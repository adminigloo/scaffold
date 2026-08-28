import { describe, expect, it } from "vitest";
import {
  assertMigrationAllowed,
  ProductionMigrationBlockedError,
} from "../migrate.js";

const DIRECT = "postgresql://u:p@ep-cool-name.us-east-2.aws.neon.tech/db";
const POOLED = "postgresql://u:p@ep-cool-name-pooler.us-east-2.aws.neon.tech/db";

describe("assertMigrationAllowed", () => {
  it("allows local and staging without ceremony", () => {
    expect(() =>
      assertMigrationAllowed({ appEnv: "local", connectionString: DIRECT }),
    ).not.toThrow();
    expect(() =>
      assertMigrationAllowed({ appEnv: "staging", connectionString: DIRECT }),
    ).not.toThrow();
  });

  it("blocks a hand-run production migration", () => {
    expect(() =>
      assertMigrationAllowed({ appEnv: "production", connectionString: DIRECT }),
    ).toThrow(ProductionMigrationBlockedError);
  });

  it("allows production when the deploy workflow opts in explicitly", () => {
    expect(() =>
      assertMigrationAllowed({
        appEnv: "production",
        connectionString: DIRECT,
        allowProduction: true,
      }),
    ).not.toThrow();
  });

  it("blocks a pooled connection string in every environment", () => {
    for (const appEnv of ["local", "staging", "production"] as const) {
      expect(() =>
        assertMigrationAllowed({ appEnv, connectionString: POOLED, allowProduction: true }),
      ).toThrow(/POOLED/);
    }
  });

  it("explains what to do instead", () => {
    try {
      assertMigrationAllowed({ appEnv: "production", connectionString: DIRECT });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("deploy workflow");
    }
  });
});

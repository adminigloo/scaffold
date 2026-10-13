import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIRM_WIDE as fromRoot, STAFF_ROLE_TEMPLATES } from "../index.js";
import { FIRM_WIDE as fromSchema } from "../schema.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("the package root stays client-safe (contract 4.1)", () => {
  it("never imports ./schema (which drags drizzle-orm/pg-core and the Neon driver)", () => {
    const index = readFileSync(resolve(SRC, "index.ts"), "utf8");
    expect(index).not.toMatch(/from\s+["']\.\/schema(\.js)?["']/);
    for (const file of ["constants.ts", "roles.ts"]) {
      expect(readFileSync(resolve(SRC, file), "utf8")).not.toMatch(/^import\s(?!type)/m);
    }
  });

  it("FIRM_WIDE is one value, from both entries", () => {
    expect(fromRoot).toBe("*");
    expect(fromSchema).toBe(fromRoot);
  });

  it("ships the staff ladder, highest first, spaced by ten", () => {
    expect(STAFF_ROLE_TEMPLATES.map((t) => [t.key, t.rank])).toEqual([
      ["admin", 30],
      ["cs_lead", 20],
      ["cs_agent", 10],
    ]);
  });
});

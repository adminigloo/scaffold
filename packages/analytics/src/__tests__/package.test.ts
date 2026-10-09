import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { createAudience, createDrizzleAudienceStore } from "@adminigloo/audience";
import type { AnalyticsAudience, AnalyticsDb } from "../context.js";

/**
 * The package as a consumer meets it: what `require` and `import` resolve
 * types to, how the audience is declared, and that the audience's own
 * instance is checked against what analytics passes it — strictly.
 */

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(`${PACKAGE_ROOT}/package.json`, "utf8")) as {
  exports: Record<string, { import: { types: string; default: string }; require: { types: string; default: string } }>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  dependencies: Record<string, string>;
};

describe("package.json", () => {
  it("gives `require` the CommonJS types (.d.cts) and `import` the ESM types (.d.ts), for every entry", () => {
    expect(Object.keys(pkg.exports).sort()).toEqual([".", "./client", "./crawlers", "./dashboard", "./schema"]);
    for (const [entry, conditions] of Object.entries(pkg.exports)) {
      const base = entry === "." ? "index" : entry.slice(2);
      expect([entry, conditions]).toEqual([
        entry,
        {
          import: { types: `./dist/${base}.d.ts`, default: `./dist/${base}.js` },
          require: { types: `./dist/${base}.d.cts`, default: `./dist/${base}.cjs` },
        },
      ]);
    }
  });

  it("declares the audience as an OPTIONAL peer (^0.1), never a dependency — vendorable without it", () => {
    expect(pkg.peerDependencies["@adminigloo/audience"]).toBe("^0.1.0");
    expect(pkg.peerDependenciesMeta["@adminigloo/audience"]).toEqual({ optional: true });
    expect(pkg.dependencies["@adminigloo/audience"]).toBeUndefined();
  });
});

describe("the audience's shape", () => {
  it("the real createAudience instance is an AnalyticsAudience", () => {
    const audience = createAudience({ store: createDrizzleAudienceStore({ db: {} as AnalyticsDb }), secret: "test-secret-0123456789-abcdefghijklmnopqrstuvwxyz" });
    const shaped: AnalyticsAudience = audience;
    expect(typeof shaped.countedVisitorSql).toBe("function");
    expect(typeof shaped.mark).toBe("function");
  });

  it("is checked strictly: an audience whose countedVisitorSql cannot take what analytics passes does not compile", () => {
    // A future audience that dropped `null` for "this read has no time column".
    const narrower = {
      countedVisitorSql: (_column: SQLWrapper, _extra: { time: SQLWrapper; session: SQLWrapper }): SQL => sql`true`,
      excludedBreakdown: async () => ({ total: 0, byReason: {}, unit: "sessions" }),
    };
    // @ts-expect-error — parameters are checked contravariantly (property syntax), so this is refused
    const refused: AnalyticsAudience = narrower;
    expect(refused).toBe(narrower);
  });
});

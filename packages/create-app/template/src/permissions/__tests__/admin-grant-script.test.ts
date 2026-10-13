import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `pnpm admin:grant` against a database it can't reach says so in a sentence
 * — "Could not reach the database at <host>/<database>…", as db:seed:deploy
 * does — and nothing else: not drizzle's "Failed query: select … params:
 * you@example.com", not a stack, never the password (review R3 TB2-09).
 *
 * The real script, run the way the package.json script runs it. The database
 * is 127.0.0.1 on a port nothing listens on: refused at once, no network.
 */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

describe("admin:grant against a database it can't reach", () => {
  it("names the database in plain words, without the query, the address asked about or the password", () => {
    const url = "postgres://grant:not-the-real-password@127.0.0.1:9/appdb";
    const run = spawnSync(process.execPath, [TSX, "scripts/admin-grant.ts", "owner@example.com"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      // The environment wins over .env.local, so a laptop's own database is never touched.
      env: { ...process.env, DATABASE_URL_UNPOOLED: url, DATABASE_URL: url },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(run.status, out).toBe(1);
    expect(out).toContain("Could not reach the database at 127.0.0.1:9/appdb.");
    expect(out).not.toContain("Failed query");
    expect(out).not.toContain("params:");
    expect(out).not.toContain("not-the-real-password");
  }, 90_000);
});

import { afterEach, describe, expect, it } from "vitest";
import { companyRowCounts, forgetReport, plantCompanyRows } from "../../../testing/src/forget.js";
import { createPgliteDb } from "../../../testing/src/pglite.js";
import { forgetTenant } from "../index.js";
import * as schema from "../schema.js";

/**
 * DELETE A COMPANY (create-app 0.37): `forgetTenant` takes every row this
 * package keeps for one company — what its assistant knows, its conversations, offered changes and checks —
 * and nothing of another company's. The tables are read from the database
 * itself (@adminigloo/testing/forget), so a table added later is planted and
 * checked without anyone remembering to list it here.
 */

const A = "co_forget_a";
const B = "co_forget_b";
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function fresh() {
  const t = await createPgliteDb({ schema: { ...schema }, logQueries: false });
  close = () => t.close();
  return t.db;
}

describe("forgetTenant", () => {
  it("takes every row of one company from every table, children first, and leaves the other company's", async () => {
    const db = await fresh();
    const planted = await plantCompanyRows(db, [A, B], { links: {
      "assistant_eval_results.run_id": "assistant_eval_runs.id",
      "assistant_page_doc_versions.page_doc_id": "assistant_page_docs.id"
    } });
    expect(planted.companyTables.length).toBeGreaterThan(0);
    const before = await companyRowCounts(db, [A, B]);
    const counts = await forgetTenant(db, A);
    const report = await forgetReport(db, planted, { forgotten: A, before });
    expect(report.left, "tables still holding the forgotten company's rows").toEqual([]);
    expect(report.lost, "tables that lost the other company's rows").toEqual([]);
    // Every table it planted is one the forget answers for, with what it took.
    for (const table of [...planted.companyTables, ...planted.childTables]) {
      expect(counts[table], table).toBeGreaterThanOrEqual(1);
    }
    // Again: nothing left to take, and nothing of B's taken.
    const again = await forgetTenant(db, A);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
    expect(await companyRowCounts(db, [B])).toEqual(Object.fromEntries(Object.entries(before).map(([t, c]) => [t, { [B]: c[B] }])));
  });

  it("refuses the site's own rows (\"*\") and an empty id", async () => {
    const db = await fresh();
    await expect(forgetTenant(db, "*")).rejects.toThrow(/never forgotten/);
    await expect(forgetTenant(db, " ")).rejects.toThrow(/one company's id/);
  });
});

describe("assistant_config_version (review: keyed by the company's id, so the proof couldn't see it)", () => {
  it("the deleted company's counter goes; another company's and the site's own ('*') stay", async () => {
    const db = await fresh();
    await db.insert(schema.assistantConfigVersion).values([{ id: A }, { id: B }, { id: "*" }]);
    const counts = await forgetTenant(db, A);
    expect(counts["assistant_config_version"]).toBe(1);
    const left = (await db.select({ id: schema.assistantConfigVersion.id }).from(schema.assistantConfigVersion)).map((r) => r.id).sort();
    // NEGATIVE CONTROL: B's and the site's own are untouched.
    expect(left).toEqual(["*", B].sort());
  });
});

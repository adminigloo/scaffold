import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { FIRM_WIDE } from "@adminigloo/permissions";
import { billingSchema, entitlements, plans, subscriptions } from "../schema.js";

function columnsOf(table: PgTable) {
  return new Map(getTableConfig(table).columns.map((c) => [c.name, c]));
}

function uniqueIndexNames(table: PgTable) {
  return getTableConfig(table)
    .indexes.filter((i) => i.config.unique)
    .map((i) => i.config.name);
}

describe("plans.tenant_id", () => {
  it("has ONE spelling for catalog-wide, not NULL and a sentinel", () => {
    // Nullable, the same idea had two encodings: a query filtering
    // `tenant_id is null` alone hid every legacy row carrying '*', and the
    // missing plans read as a pricing decision rather than a bug.
    const tenantId = columnsOf(plans).get("tenant_id");
    expect(tenantId?.notNull).toBe(true);
    expect(tenantId?.hasDefault).toBe(true);
    expect(tenantId?.default).toBe(FIRM_WIDE);
  });

  it("uses the sentinel @adminigloo/permissions already defined", () => {
    // Not a second constant spelling the same '*'. Two of them is two things
    // to change when the sentinel moves, and half the schema then disagrees
    // with the other half about what firm-wide means.
    expect(FIRM_WIDE).toBe("*");
  });
});

describe("plans key uniqueness", () => {
  it("refuses two catalog-wide plans with the same key", () => {
    // The index is on `key` ALONE, so both rows collide whatever their
    // tenant_id says. Scoped to (tenant_id, key) over a nullable tenant_id it
    // would accept both, because Postgres treats NULLs as distinct — and a
    // webhook carrying plan=pro would then have two rows to choose from.
    const index = getTableConfig(plans).indexes.find((i) => i.config.unique);
    expect(index?.config.name).toBe("plans_key_idx");
    expect(index?.config.columns.map((c) => ("name" in c ? c.name : null))).toEqual(["key"]);
  });

  it("has exactly one unique index, so nothing else can reopen the hole", () => {
    expect(uniqueIndexNames(plans)).toEqual(["plans_key_idx"]);
  });
});

describe("entitlements", () => {
  it("keys the unique index on the full (tenant, feature, source, ref)", () => {
    // This is the identity planGrantDiff matches on. Drop `source` from either
    // side and a plan change reconciles against an add-on's row.
    expect(uniqueIndexNames(entitlements)).toContain(
      "entitlements_tenant_feature_source_ref_idx",
    );
  });
});

describe("billingSchema", () => {
  it("holds the same objects the module exports, not copies", () => {
    // Reference equality is what Drizzle relations and getTableConfig compare
    // on. Two objects for one physical table fail silently.
    expect(billingSchema.plans).toBe(plans);
    expect(billingSchema.subscriptions).toBe(subscriptions);
    expect(billingSchema.entitlements).toBe(entitlements);
  });
});

/**
 * DELETE A COMPANY (create-app 0.37): src/server/forget-company.ts and its
 * proof, generated for the packages THIS project installed.
 *
 * Tenancy forgets its own rows (the team, invitations, address history) and
 * keeps the company's row, emptied, so its web address stays reserved.
 * Everything the other packages keep is forget-company.ts's: one
 * `forgetTenant` per installed package that keeps company rows, each on the
 * deletion's transaction, children first — so a failure anywhere leaves
 * every row as it was. With file storage, the files' bytes go once that
 * transaction has committed. With plans for sale, a company still paying is
 * named, and deleting it needs a reason.
 *
 * The proof (src/server/__tests__/forget-company.test.ts) plants one row for
 * two companies in EVERY table that has a company column — read from the
 * database, so a package's new table is planted without anyone listing it —
 * deletes the first through the real tenancy service, and checks that none
 * of its rows are left (outside the tables kept on purpose, each with its
 * reason) and none of the second's are gone.
 *
 * Emitted variants, never a runtime `if`: a package that isn't installed has
 * no import, no line and no link here.
 */

import { tenantLabel, type Answers } from "./answers.js";
import { schemaOwners } from "./emit.js";

function isCompanies(answers: Answers): boolean {
  return answers.tenantNoun !== "none";
}

/** One package's forget step: where its `forgetTenant` is exported from, and the alias the emitted file gives it. */
export interface ForgetStep {
  readonly pkg: string;
  /** The entry, relative to the scope: "estimator", "billing/server". */
  readonly entry: string;
  readonly alias: string;
}

/**
 * The entry each package exports `forgetTenant` from, in the order the
 * emitted file calls them: the features first, then what they lean on
 * (customers, the store, payments, plans), then roles last. No foreign key
 * crosses two packages, so the order is for reading; within a package its own
 * forget goes children first.
 */
export const FORGET_ENTRIES: Readonly<Record<string, string>> = {
  estimator: "estimator",
  scheduling: "scheduling",
  invoicing: "invoicing",
  comms: "comms",
  booking: "booking",
  feedback: "feedback",
  assistant: "assistant",
  aeo: "aeo",
  "seo-reports": "seo-reports",
  analytics: "analytics",
  audience: "audience",
  notifications: "notifications",
  email: "email",
  ai: "ai/server",
  customers: "customers/server",
  commerce: "commerce/store",
  catalog: "catalog/server",
  stripe: "stripe",
  billing: "billing/server",
  storage: "storage",
  permissions: "permissions/server",
};

/** Packages that keep no company rows of their own to forget here: tenancy forgets its own; the rest keep none. */
export const FORGET_NOT_HERE: Readonly<Record<string, string>> = {
  auth: "people's accounts are a person's, not a company's; tenancy clears anyone's current company pointing at a deleted one",
  tenancy: "tenancy's own deleteCompany forgets the team, invitations and address history, and keeps the emptied company row",
  observability: "the site's own audit and error logs, kept on purpose: the deletion's record is one of their rows",
};

/**
 * Child tables with no foreign key to their parent, so the proof's planter
 * can't find them by itself: each one's parent column, per package.
 */
const FORGET_LINKS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  estimator: {
    "estimator_estimate_items.estimate_id": "estimator_estimates.id",
    "estimator_options.product_id": "estimator_products.id",
    "estimator_option_values.option_id": "estimator_options.id",
    "estimator_product_components.product_id": "estimator_products.id",
  },
  invoicing: { "invoice_items.invoice_id": "invoices.id", "invoice_payments.invoice_id": "invoices.id" },
  assistant: {
    "assistant_eval_results.run_id": "assistant_eval_runs.id",
    "assistant_page_doc_versions.page_doc_id": "assistant_page_docs.id",
  },
};

/** The tables a deleted company's rows stay in on purpose, and why (the proof allows exactly these). */
export const COMPANY_ROWS_KEPT: Readonly<Record<string, string>> = {
  tenants: "the company's own row stays, emptied and marked deleted, so its web address is never given to another business",
  tenant_retired_slugs: "its old web addresses stay reserved too, so old links, invitation emails and receipts never land on another business",
  audit_log: "the site's record of who did what — the deletion itself is one of these rows",
  error_log: "the site's own error log, about the site rather than the business",
};

function aliasOf(pkg: string): string {
  return `forget${pkg.replace(/(^|-)([a-z])/g, (_, __: string, c: string) => c.toUpperCase())}`;
}

/** The forget steps this project's packages take, in calling order. */
export function forgetSteps(answers: Answers): ForgetStep[] {
  const owners = new Set(schemaOwners(answers));
  return Object.entries(FORGET_ENTRIES)
    .filter(([pkg]) => owners.has(pkg))
    .map(([pkg, entry]) => ({ pkg, entry, alias: aliasOf(pkg) }));
}

/** Does this project sell plans a company can still be paying for? */
function sellsPlans(answers: Answers): boolean {
  return schemaOwners(answers).includes("billing");
}

export function renderForgetCompany(answers: Answers): string {
  const scope = answers.scope;
  const noun = tenantLabel(answers).toLowerCase();
  const steps = forgetSteps(answers);
  const storage = steps.some((s) => s.pkg === "storage");
  const billing = sellsPlans(answers);
  const imports = steps.map((s) => {
    if (s.pkg === "storage") return `import { forgetTenant as ${s.alias}, listTenantObjects } from "${scope}/storage";`;
    if (s.pkg === "billing") return `import { forgetTenant as ${s.alias}, livePaidSubscription } from "${scope}/billing/server";`;
    return `import { forgetTenant as ${s.alias} } from "${scope}/${s.entry}";`;
  });
  const calls = steps.map((s) =>
    s.pkg === "storage" ? `  add(await ${s.alias}(tx, tenantId, storageTables ? { tables: storageTables } : {}));` : `  add(await ${s.alias}(tx, tenantId));`,
  );
  const forget = storage
    ? `  async forget(tx, tenantId) {
    // The files glue, when first needed: it builds the stores, and this
    // module is reached from the tenancy service, which the glue reaches too.
    const { files, reportFilesError } = await import("./files");
    // Where the bytes are, read BEFORE their rows go, on the same transaction.
    const objects = await listTenantObjects(tx, tenantId, { tables: files.tables });
    const counts = await forgetCompanyRows(tx, tenantId, files.tables);
    return {
      counts,
      // Once the deletion has committed and no row points at them. A delete
      // that fails is reported and left in a store nothing reads.
      afterCommit: async () => {
        const out = await files.deleteObjects(objects);
        if (out.failed > 0) {
          reportFilesError(new Error(\`\${out.failed} of a deleted ${noun}'s files couldn't be deleted from the store\`), { tenantId, step: "forget-company" });
        }
      },
    };
  },`
    : `  async forget(tx, tenantId) {
    return { counts: await forgetCompanyRows(tx, tenantId) };
  },`;
  const live = billing
    ? `
  // A ${noun} still paying for a plan is named before anyone types its web
  // address, and deleting it needs a reason: deleting doesn't stop Stripe.
  async livePaidSubscription(tx, tenantId) {
    const live = await livePaidSubscription(tx, tenantId);
    return live ? \`\${live.planName}, \${PAYING_WORDS[live.status] ?? live.status}\` : null;
  },`
    : "";
  const payingWords = billing
    ? `
/** A live subscription's status, in an operator's words. */
const PAYING_WORDS: Readonly<Record<string, string>> = {
  active: "active",
  trialing: "on a free trial with a card on file",
  past_due: "past due",
  unpaid: "unpaid",
};
`
    : "";
  return `import type { CompanyDeletion, TenancyDb } from "${scope}/tenancy/server";
${imports.join("\n")}${storage ? `\nimport type { StorageTables } from "${scope}/storage";` : ""}

/**
 * DELETE A ${noun.toUpperCase()} (create-app 0.37): what every installed package
 * forgets when staff delete one at /admin/companies/{id} (typing its web
 * address again). The tenancy service runs \`companyDeletion.forget\` on the
 * deletion's own transaction, after its checks and before it forgets its own
 * rows: so a failure in any package leaves EVERY row as it was, and the one
 * audit row written beside it (who, when, the ${noun}'s name and these counts)
 * is never forgotten with it.
 *
 * Generated for this project's packages. Adding one that keeps ${noun} rows?
 * Call its \`forgetTenant\` in \`forgetCompanyRows\` below — the proof
 * (src/server/__tests__/forget-company.test.ts) plants a row in every table
 * that has a ${noun} column and fails, naming the table, until you do.
 */

/** The tables a deleted ${noun}'s rows stay in on purpose, each with why. The proof allows exactly these. */
export const COMPANY_ROWS_KEPT: Readonly<Record<string, string>> = {
${Object.entries(COMPANY_ROWS_KEPT)
  .map(([table, why]) => `  ${table}: ${JSON.stringify(why)},`)
  .join("\n")}
};
${payingWords}
/**
 * Every installed package's rows for one ${noun}, on \`tx\` (the deletion's
 * transaction). Returns the rows each table lost.
 */
export async function forgetCompanyRows(tx: TenancyDb, tenantId: string${storage ? ", storageTables?: StorageTables" : ""}): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const add = (part: Readonly<Record<string, number>>) => {
    for (const [table, n] of Object.entries(part)) counts[table] = (counts[table] ?? 0) + n;
  };
${calls.join("\n")}
  return counts;
}

/** What src/server/tenancy.ts hands the tenancy service as \`deletion\`. */
export const companyDeletion: CompanyDeletion = {
${forget}${live}
};
`;
}

export function renderForgetCompanyTest(answers: Answers): string {
  const scope = answers.scope;
  const companies = isCompanies(answers);
  const billing = sellsPlans(answers);
  const replay = billing
    ? `

  it("a Stripe event for the deleted ${tenantLabel(answers).toLowerCase()} afterwards writes nothing back", async () => {
    // A forced delete leaves the subscription live at Stripe: the cancel
    // staff make afterwards, or next month's invoice.paid, arrives as this.
    const row = plans.rows[0];
    for (const plan of plans.rows) {
      await db
        .insert(planTable)
        .values({ key: plan.key, name: plan.name, description: plan.description, interval: plan.interval, priceMinor: plan.priceMinor, currency: plan.currency, isActive: plan.isActive, sortOrder: plan.sortOrder })
        .onConflictDoNothing();
    }
    const now = new Date();
    const event = (tenantId: string, ref: string, status: "active" | "canceled") => ({
      tenantId,
      tierKey: row?.tierKey ?? "pro",
      planKey: row?.key ?? "pro:month:usd",
      stripeSubscriptionId: ref,
      stripeCustomerId: null,
      status,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: status === "canceled" ? now : null,
      trialEndsAt: null,
      observedAt: now,
      source: "stripe" as const,
    });
    for (const status of ["canceled", "active"] as const) {
      const out = await applySubscription(event(fx.aId, \`sub_forgetA\${status}\`, status));
      expect(out).toMatchObject({ applied: false, created: false, tenantGone: true });
    }
    const left = rowsOf(
      await db.execute(sql\`select (select count(*) from subscriptions where tenant_id = \${fx.aId})::int as subs, (select count(*) from entitlements where tenant_id = \${fx.aId})::int as grants\`),
    )[0];
    expect(left).toEqual({ subs: 0, grants: 0 });
    // NEGATIVE CONTROL: the same event for B, still here, goes past the guard.
    if (row) {
      const live = await applySubscription(event(fx.bId, "sub_forgetB1", "active"));
      expect(live.applied).toBe(true);
      expect(live.tenantGone).toBeUndefined();
    } else {
      await expect(applySubscription(event(fx.bId, "sub_forgetB1", "active"))).rejects.toThrow();
    }
  });`
    : "";
  const noun = tenantLabel(answers).toLowerCase();
  const steps = forgetSteps(answers);
  const links: Record<string, string> = {};
  for (const step of steps) Object.assign(links, FORGET_LINKS[step.pkg] ?? {});
  const linksText = Object.keys(links).length
    ? `{\n${Object.entries(links)
        .map(([from, to]) => `  ${JSON.stringify(from)}: ${JSON.stringify(to)},`)
        .join("\n")}\n}`
    : "{}";
  const companyOf = companies
    ? `/** Companies mode: each owner names their ${noun} in onboarding. */
async function companyOf(ownerId: string, name: string): Promise<string> {
  const out = await tenancy.createCompany({ userId: ownerId, name, requestKey: \`forget-\${ownerId}\`.slice(0, 64), purpose: "onboarding" });
  return out.company.id;
}`
    : `/** Single-business mode: each person's workspace was made when they were set up. */
async function companyOf(ownerId: string, _name: string): Promise<string> {
  return personalWorkspaceId(ownerId);
}`;
  return `import { beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { users } from "${scope}/auth/schema";
import { assignRoleTemplate } from "${scope}/permissions/server";
${companies ? "" : `import { personalWorkspaceId } from "${scope}/tenancy";\n`}import { companyRowCounts, forgetReport, plantCompanyRows } from "${scope}/testing/forget";
import { db } from "@/db";
import { seedPermissions } from "@/permissions/seed";${billing ? `\nimport { plans as planTable } from "${scope}/billing/schema";\nimport { plans } from "@/plans";\nimport { applySubscription } from "@/server/subscription";` : ""}
import { COMPANY_ROWS_KEPT, forgetCompanyRows } from "@/server/forget-company";
import { tenancy } from "@/server/tenancy";

/**
 * DELETING A ${noun.toUpperCase()} FORGETS EVERYTHING IT KEPT, AND NOTHING OF ANOTHER'S
 * (create-app 0.37) — proved on this project's own schema, in-process.
 *
 * Two ${noun}s, A and B. One row for each is planted in EVERY table that has
 * a ${noun} column (tenant_id), and in every table hanging off one — read from
 * the database itself, so a table a package adds later is planted and
 * checked without anyone listing it. Then staff delete A through the real
 * tenancy service, typing its web address. Afterwards:
 *
 *   - no table holds a row of A's, except the ones kept on purpose
 *     (COMPANY_ROWS_KEPT in src/server/forget-company.ts, each with its
 *     reason) — a package whose forget was never called fails here, naming
 *     its table;
 *   - every row of B's is still there — a forget that lost its ${noun} filter
 *     fails here, naming its table;
 *   - one audit row says who deleted A, when, its name and what went.${billing ? `
 *   - a Stripe event for A afterwards (its subscription is still live
 *     there after a forced delete) writes no subscription or plan back.` : ""}
 *
 * PGlite: a real Postgres in this process, built from src/db/schema.ts.
 */
vi.mock("@/db", async () => {
  const { createAppPglite } = await import("@/test/pglite");
  return { db: (await createAppPglite()).db };
});

/** Child tables with no foreign key to their parent (the planter can't see those links by itself). */
const LINKS: Readonly<Record<string, string>> = ${linksText};

const fx = {} as { staff: string; aOwner: string; bOwner: string; aId: string; bId: string; aSlug: string };

async function person(externalId: string, email: string, name: string): Promise<string> {
  const [row] = await db.insert(users).values({ externalId, email, displayName: name }).returning();
  if (!row) throw new Error("could not create the test person");
  await tenancy.provisionUser({ userId: row.id, email });
  return row.id;
}

${companyOf}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

beforeAll(async () => {
  await seedPermissions(db, { log: () => {} });
  fx.staff = await person("ext_forget_staff", "sam.staff@site.test", "Sam Staff");
  await assignRoleTemplate(db, { scope: "staff", principalId: fx.staff, templateKey: "admin", actor: { system: "test" } });
  fx.aOwner = await person("ext_forget_a", "ada.alpha@alpha-lawn.test", "Ada Alpha");
  fx.bOwner = await person("ext_forget_b", "ben.bravo@bravo-roofing.test", "Ben Bravo");
  fx.aId = await companyOf(fx.aOwner, "Alpha Lawn Care");
  fx.bId = await companyOf(fx.bOwner, "Bravo Roofing");
  // A new company's first settings are written after it commits: let them land first.
  await tenancy.settleEvents();
  fx.aSlug = String(rowsOf(await db.execute(sql\`select slug from tenants where id = \${fx.aId}\`))[0]?.["slug"]);
});

describe("deleting a ${noun}", () => {
  it("forgets A's rows in every table with a ${noun} column (the kept ones apart), and none of B's", async () => {
    const planted = await plantCompanyRows(db, [fx.aId, fx.bId], { links: LINKS });
    expect(planted.companyTables.length).toBeGreaterThan(5);
    const before = await companyRowCounts(db, [fx.aId, fx.bId]);

    const out = await tenancy.deleteCompany({ actorUserId: fx.staff, tenantId: fx.aId, confirmSlug: fx.aSlug });

    const report = await forgetReport(db, planted, { forgotten: fx.aId, kept: COMPANY_ROWS_KEPT, before });
    expect(report.left, "tables still holding the deleted ${noun}'s rows: call that package's forgetTenant in src/server/forget-company.ts").toEqual([]);
    expect(report.lost, "tables that lost the other ${noun}'s rows: a forget without its ${noun} filter").toEqual([]);
    expect(report.unknownKept, "COMPANY_ROWS_KEPT names a table that doesn't exist").toEqual([]);

    // Every planted table outside the kept ones is in the deletion's counts.
    const tenancyOwn = ["tenant_invitations", "tenant_members", "tenant_slug_changes"];
    for (const table of [...planted.companyTables, ...planted.childTables]) {
      if (table in COMPANY_ROWS_KEPT) continue;
      expect(out.counts[table] ?? 0, \`\${table} is in the deletion's counts\`).toBeGreaterThanOrEqual(tenancyOwn.includes(table) ? 0 : 1);
    }

    // The row stays, emptied and marked deleted; B's doesn't change.
    const [a] = rowsOf(await db.execute(sql\`select deleted_at, settings from tenants where id = \${fx.aId}\`));
    const [b] = rowsOf(await db.execute(sql\`select deleted_at from tenants where id = \${fx.bId}\`));
    expect(a?.["deleted_at"]).not.toBeNull();
    expect(a?.["settings"]).toEqual({});
    expect(b?.["deleted_at"]).toBeNull();

    // One audit row that outlives it: who, when, the name and what went.
    const audit = rowsOf(
      await db.execute(sql\`select actor_user_id, metadata from audit_log where action = 'company.deleted' and tenant_id = \${fx.aId}\`),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.["actor_user_id"]).toBe(fx.staff);
    expect(audit[0]?.["metadata"]).toMatchObject({ name: out.name, slug: fx.aSlug, rows: out.rows });
  });

  it("forgetCompanyRows never touches a ${noun} it wasn't given", async () => {
    const before = await companyRowCounts(db, [fx.bId]);
    await db.transaction(async (tx) => {
      await forgetCompanyRows(tx as never, fx.aId);
    });
    expect(await companyRowCounts(db, [fx.bId])).toEqual(before);
  });${replay}
});
`;
}

/** The `deletion` option src/server/tenancy.ts hands the tenancy service (both modes). */
export function tenancyDeletionOption(answers: Answers): string {
  const live = sellsPlans(answers)
    ? `
    livePaidSubscription: (tx, tenantId) =>
      import("./forget-company").then((m) => m.companyDeletion.livePaidSubscription?.(tx, tenantId) ?? null),`
    : "";
  return `
  // Delete a ${tenantLabel(answers).toLowerCase()} (tenancy 0.8, staff only, at /admin/companies/{id}): what
  // every installed package forgets, in src/server/forget-company.ts. Imported
  // when first needed, like onEvent: it reaches the files glue, which reaches
  // this module.
  deletion: {
    forget: (tx, tenantId) => import("./forget-company").then((m) => m.companyDeletion.forget(tx, tenantId)),${live}
  },`;
}

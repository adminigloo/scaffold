import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, IncompatibleAnswersError, type Answers } from "../answers.js";
import { planEmit, schemaOwners, writePlan } from "../emit.js";
import { buildManifest, MANIFEST_FILENAME, renderManifest } from "../manifest.js";
import { applyUpgrade, loadPreviousGenerator, planUpgrade, upgradeNextSteps, UpgradeLosesDataError } from "../upgrade.js";
import { PACKAGE_TABLES, SCHEMA_MODULE_PATH, schemaOwnersIn } from "../upgrade-losses.js";
import { upgradeNotesFor } from "../upgrade-notes.js";
import { TEMPLATE_DIR } from "./configurations.js";

/**
 * THE CONSUMER-FIT REVIEW, on the generator's side (create-app 0.39). Each
 * describe is one finding, proved on a real project directory, with its
 * negative control:
 *
 *   H  an answer switch dropped tables, ended companies and stopped plan
 *      checks with no warning, then said to run `pnpm db:migrate`
 *   M  the 0.38 to 0.39 upgrade of a project kept in git kept six untouched
 *      shop files (CRLF written, LF checked out) and the project didn't build
 *   L  a switch to consumers swapped an untouched src/plans.ts for other
 *      tiers; a kept team page was called dead though it is still served;
 *      the 0.39 note sold `free:` to companies projects
 *
 * The generated-code findings are proved in the projects themselves
 * (account-proofs-emit.ts, consumer-dashboard-emit.ts, conversions-emit.ts).
 */
const sep = (path: string) => join(...path.split("/"));
const REPO = join(__dirname, "..", "..", "..", "..");

const BASE: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "almanac",
  tenantNoun: "none",
  businessModel: "subscription",
  adminShell: "full",
  includeEmail: true,
  includeFeedback: true,
  includeAnalytics: true,
  includeMarketing: true,
};
const CONSUMERS: Answers = { ...BASE, audience: "consumers" };
const COMPANIES: Answers = { ...BASE, tenantNoun: "Company" };

let project: string;
let previousDir: string;
beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), "adminigloo-review-cf-"));
  previousDir = await mkdtemp(join(tmpdir(), "adminigloo-review-cf-prev-"));
});
afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(previousDir, { recursive: true, force: true });
});

async function generated(answers: Answers): Promise<void> {
  await writePlan(await planEmit(TEMPLATE_DIR, project, answers));
}
async function onDisk(path: string): Promise<string | null> {
  const full = join(project, sep(path));
  return existsSync(full) ? readFile(full, "utf8") : null;
}
async function writeFiles(files: ReadonlyMap<string, string>): Promise<void> {
  for (const [relPath, contents] of files) {
    await mkdir(dirname(join(project, relPath)), { recursive: true });
    await writeFile(join(project, relPath), contents, "utf8");
  }
}
/** A stand-in for the create-app that made the project: its planEmit answers `files`. */
async function previousGenerator(files: ReadonlyMap<string, string>, version: string): Promise<void> {
  await mkdir(join(previousDir, "dist"), { recursive: true });
  await mkdir(join(previousDir, "template"), { recursive: true });
  await writeFile(join(previousDir, "package.json"), JSON.stringify({ name: "@adminigloo/create-app", version }), "utf8");
  await writeFile(join(previousDir, "dist", "plan.json"), JSON.stringify(Object.fromEntries(files)), "utf8");
  await writeFile(
    join(previousDir, "dist", "index.js"),
    [
      'import { readFileSync } from "node:fs";',
      "export async function planEmit() {",
      '  return { files: new Map(Object.entries(JSON.parse(readFileSync(new URL("./plan.json", import.meta.url), "utf8")))) };',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}
/** This version's plan for `answers`, as an older create-app's: its own (older) manifest. */
async function olderPlan(answers: Answers, version: string): Promise<Map<string, string>> {
  const files = new Map((await planEmit(TEMPLATE_DIR, project, answers)).files);
  files.set(MANIFEST_FILENAME, renderManifest(buildManifest(answers, version)));
  return files;
}
async function refusal(promise: Promise<unknown>): Promise<UpgradeLosesDataError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "the upgrade should have been refused").toBeInstanceOf(UpgradeLosesDataError);
  return error as UpgradeLosesDataError;
}
const words = (text: string) => text.replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// H — what an upgrade loses
// ---------------------------------------------------------------------------

describe("the tables each package owns — what an upgrade can DROP", () => {
  it("PACKAGE_TABLES is exactly every table each package's built schema module exports", async () => {
    const NAME = Symbol.for("drizzle:Name");
    const IS_TABLE = Symbol.for("drizzle:IsDrizzleTable");
    const wrong: string[] = [];
    for (const [owner, tables] of Object.entries(PACKAGE_TABLES)) {
      const built = join(REPO, "packages", owner, "dist", "schema.js");
      expect(existsSync(built), `${built}: run pnpm build first`).toBe(true);
      const mod = (await import(pathToFileURL(built).href)) as Record<string, unknown>;
      const names = new Set<string>();
      for (const value of Object.values(mod)) {
        if (value && typeof value === "object" && (value as Record<symbol, unknown>)[IS_TABLE] === true) {
          names.add(String((value as Record<symbol, unknown>)[NAME]));
        }
      }
      if (JSON.stringify([...names].sort()) !== JSON.stringify([...tables].sort())) {
        wrong.push(`${owner}: the package exports ${[...names].sort().join(", ")}; PACKAGE_TABLES says ${[...tables].sort().join(", ")}`);
      }
    }
    expect(wrong.join("\n")).toBe("");
  });

  it("covers every package any project's schema module can name, read off that module the way upgrade reads it", async () => {
    const everything: Answers = {
      ...COMPANIES,
      businessModel: "both",
      includeAi: true,
      includeSeoReports: true,
      includeNotifications: true,
      includeStorage: true,
      includeAssistant: true,
      includeEstimator: true,
      includeScheduling: true,
      includeInvoicing: true,
      includeComms: true,
      includeAeo: true,
      includeBooking: true,
      includeStore: true,
      includeCustomers: true,
      // create-app 0.41: and social posts, whose queue is a table of its own.
      includeSocial: true,
    };
    for (const answers of [everything, BASE, CONSUMERS, { ...BASE, businessModel: "none" as const }]) {
      const plan = await planEmit(TEMPLATE_DIR, "/out", answers);
      const owners = schemaOwnersIn(plan.files.get(SCHEMA_MODULE_PATH), answers.scope);
      expect(owners).toEqual(schemaOwners(answers));
      for (const owner of owners) expect(PACKAGE_TABLES[owner], owner).toBeDefined();
    }
  });
});

describe("a switch that loses something is refused until --allow-data-loss, and then says exactly what (review)", () => {
  it("a feature off: refused, naming every one of its tables; nothing written", async () => {
    await generated(BASE);
    const before = await onDisk(MANIFEST_FILENAME);
    const error = await refusal(planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { includeFeedback: false } }));
    for (const table of PACKAGE_TABLES["feedback"]!) expect(error.message, table).toContain(table);
    expect(words(error.message)).toContain("It DROPS 9 tables");
    expect(error.message).toContain("--allow-data-loss");
    expect(await onDisk(MANIFEST_FILENAME)).toBe(before);

    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { includeFeedback: false }, allowDataLoss: true });
    expect(plan.losses.droppedTables).toEqual([{ owner: "feedback", tables: PACKAGE_TABLES["feedback"] }]);
    const steps = upgradeNextSteps(plan);
    expect(steps).toContain("WHAT THIS UPGRADE LOSES (you allowed it with --allow-data-loss):");
    for (const table of PACKAGE_TABLES["feedback"]!) expect(words(steps), table).toContain(table);
    expect(steps).not.toContain("db:generate && pnpm db:migrate");
    expect(steps).toContain("pnpm db:migrate        only once you have");
  });

  it("the model to none: refused, naming Stripe's and billing's tables", async () => {
    await generated(BASE);
    const error = await refusal(planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { businessModel: "none" } }));
    for (const table of ["subscriptions", "plans", "entitlements", "stripe_events", "stripe_connected_accounts"]) {
      expect(error.message, table).toContain(table);
    }
  });

  it("companies asked for --audience consumers: refused, without pointing at a tenantNoun switch", async () => {
    await generated(COMPANIES);
    const error = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "consumers" } }).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(IncompatibleAnswersError);
    expect(error?.message).toContain("their members and their plans would all be left behind");
    expect(error?.message).not.toMatch(/tenant-?noun|--set/i);
  });

  it("companies to one account per person: refused, saying what happens to the companies, their members and their plans", async () => {
    await generated(COMPANIES);
    const switching = { tenantNoun: "none", audience: "consumers" } as const;
    const error = await refusal(planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: switching }));
    expect(error.losses.accounts).toEqual({ from: "companies", to: "people" });
    expect(words(error.message)).toContain("It ends the companies");
    expect(words(error.message)).toContain("its members, its settings, its plan");
    expect(words(error.message)).toContain("keeps being charged at Stripe until you cancel it there");
    expect(words(error.message)).toContain("each company's plan stops being checked");

    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: switching, allowDataLoss: true });
    expect(words(upgradeNextSteps(plan))).toContain("It ends the companies");
    expect(plan.deletes.has(sep("app/(site)/onboarding/page.tsx")) || plan.deletes.size > 0).toBe(true);
  });

  it("consumers back to business: refused, because each person's plan check and one-person accounts would go", async () => {
    await generated(CONSUMERS);
    const error = await refusal(planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "business" } }));
    expect(words(error.message)).toContain("each person's plans stop being checked");
    expect(words(error.message)).toContain("accounts can be shared again");
    expect(words(error.message)).toContain("requireEntitlement, withEntitlement and <Entitled>");
    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "business" }, allowDataLoss: true });
    expect(words(upgradeNextSteps(plan))).toContain("Accounts can have teams again");
  });

  it("NEGATIVE CONTROLS: business to consumers, a feature on, and a rename of the companies lose nothing and go ahead", async () => {
    await generated(BASE);
    const toConsumers = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "consumers" } });
    expect(toConsumers.losses).toEqual({ droppedTables: [], accounts: null, planCheck: [] });
    // Never `generate && migrate`, even when nothing drops.
    expect(upgradeNextSteps(toConsumers)).not.toContain("db:generate && pnpm db:migrate");
    expect(words(upgradeNextSteps(toConsumers))).toContain("This upgrade drops no table, so it should only add");

    await rm(project, { recursive: true, force: true });
    await mkdir(project, { recursive: true });
    await generated({ ...BASE, includeFeedback: false });
    expect((await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { includeFeedback: true } })).losses.droppedTables).toEqual([]);

    await rm(project, { recursive: true, force: true });
    await mkdir(project, { recursive: true });
    await generated(COMPANIES);
    const renamed = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { tenantNoun: "Team" } });
    expect(renamed.losses).toEqual({ droppedTables: [], accounts: null, planCheck: [] });
  });

  it("a VERSION upgrade that drops a package's tables is refused the same way; one that drops none is not", async () => {
    const old = await olderPlan(BASE, "0.37.1");
    // The older version's schema module also handed drizzle-kit the shop's packages.
    const schema = old.get(SCHEMA_MODULE_PATH)!;
    old.set(
      SCHEMA_MODULE_PATH,
      schema.replace('export * from "@adminigloo/billing/schema";', 'export * from "@adminigloo/catalog/schema";\nexport * from "@adminigloo/commerce/schema";\nexport * from "@adminigloo/billing/schema";'),
    );
    await writeFiles(old);
    await previousGenerator(old, "0.37.1");
    const error = await refusal(planUpgrade(TEMPLATE_DIR, project, { previous: await loadPreviousGenerator(previousDir) }));
    for (const table of ["products", "orders", "discount_codes", "order_shipments"]) expect(error.message, table).toContain(table);
    expect(words(error.message)).toContain("keep the shop instead (`--set businessModel=both`)");
    // NEGATIVE CONTROL: the same upgrade, the same schema on both sides.
    old.set(SCHEMA_MODULE_PATH, schema);
    await writeFiles(old);
    await previousGenerator(old, "0.37.1");
    const fine = await planUpgrade(TEMPLATE_DIR, project, { previous: await loadPreviousGenerator(previousDir) });
    expect(fine.losses.droppedTables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M — line endings are never an edit
// ---------------------------------------------------------------------------

describe("a project kept in git: CRLF written, LF checked out, still untouched (review)", () => {
  it("retired files are deleted, changed ones rewritten, package.json merged — none of it called yours", async () => {
    const old = await olderPlan(BASE, "0.37.1");
    const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
    const lf = (text: string) => text.replace(/\r\n/g, "\n");
    // What 0.38 shipped with CRLF: two files this version retired, one it changed.
    old.set(sep("app/(site)/products/page.tsx"), crlf("export default function Products() {\n  return null;\n}\n"));
    old.set(sep("scripts/seed-shop.ts"), crlf("// the shop's seed\nexport {};\n"));
    const changed = sep("src/components/account/PlanChooser.tsx");
    old.set(changed, crlf(`${old.get(changed)}\n// 0.38's own line\n`));
    old.set("package.json", crlf(old.get("package.json")!));
    await previousGenerator(old, "0.37.1");
    // `git checkout .` under `* text=auto eol=lf`: every file comes back LF.
    await writeFiles(new Map([...old].map(([path, text]) => [path, lf(text)])));
    // NEGATIVE CONTROL: a real edit, in LF, is still yours.
    const edited = sep("src/components/account/SubscriptionActions.tsx");
    await writeFile(join(project, edited), `${old.get(edited)}\n// my change\n`, "utf8");

    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: await loadPreviousGenerator(previousDir) });
    expect([...plan.keptRetired]).toEqual([]);
    expect(plan.deletes.has(sep("app/(site)/products/page.tsx"))).toBe(true);
    expect(plan.deletes.has(sep("scripts/seed-shop.ts"))).toBe(true);
    expect(plan.rewrites.has(changed)).toBe(true);
    expect(plan.conflicts.has(changed)).toBe(false);
    expect(plan.packageJson).toBeNull();
    await applyUpgrade(plan);
    expect(await onDisk("app/(site)/products/page.tsx")).toBeNull();
    // The edit isn't touched: this version doesn't change that file, so there's nothing to merge.
    expect(await onDisk("src/components/account/SubscriptionActions.tsx")).toBe(`${old.get(edited)}\n// my change\n`);
  });

  it("NEGATIVE CONTROL: a retired file with a real edit is still kept and listed", async () => {
    const old = await olderPlan(BASE, "0.37.1");
    old.set(sep("scripts/seed-shop.ts"), "// the shop's seed\r\nexport {};\r\n");
    await previousGenerator(old, "0.37.1");
    await writeFiles(new Map([...old].map(([path, text]) => [path, text.replace(/\r\n/g, "\n")])));
    await writeFile(join(project, sep("scripts/seed-shop.ts")), "// the shop's seed\nexport {};\n// mine\n", "utf8");
    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: await loadPreviousGenerator(previousDir) });
    expect([...plan.keptRetired]).toEqual([sep("scripts/seed-shop.ts")]);
  });
});

// ---------------------------------------------------------------------------
// L — src/plans.ts, kept team pages, and the 0.39 note's free tier
// ---------------------------------------------------------------------------

describe("a switch never rewrites src/plans.ts (review: an untouched one was swapped for other tiers)", () => {
  it("to consumers: your tiers stay where they are, the consumer sample goes beside them, and the steps say why", async () => {
    await generated(BASE);
    const mine = await onDisk("src/plans.ts");
    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "consumers" } });
    expect(plan.rewrites.has(sep("src/plans.ts"))).toBe(false);
    expect(plan.conflicts.has(sep("src/plans.ts"))).toBe(true);
    await applyUpgrade(plan);
    expect(await onDisk("src/plans.ts")).toBe(mine);
    expect(await onDisk("src/plans.ts.new")).toContain("free: {");
    const steps = words(upgradeNextSteps(plan));
    expect(steps).toContain("src/plans.ts wasn't rewritten — a switch never does");
    expect(steps).toContain("a tier missing from it makes that person's next Stripe event fail");
  });

  it("NEGATIVE CONTROL: a switch that leaves the record as it is writes no src/plans.ts.new", async () => {
    await generated(BASE);
    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { includeAi: true } });
    expect(plan.conflicts.has(sep("src/plans.ts"))).toBe(false);
  });
});

describe("a kept team page is said to be served (review)", () => {
  it("to consumers, with the team page edited: told plainly it is still served and to delete it", async () => {
    await generated(BASE);
    await writeFile(join(project, sep("app/(site)/settings/team/page.tsx")), "export default function Team() { return null; }\n", "utf8");
    const plan = await planUpgrade(TEMPLATE_DIR, project, { previous: null, overrides: { audience: "consumers" } });
    expect(plan.keptRetired.has(sep("app/(site)/settings/team/page.tsx"))).toBe(true);
    const steps = words(upgradeNextSteps(plan));
    expect(steps).toContain("a page among them is still served at its address until you delete it");
    expect(steps).toContain(`Delete ${sep("app/(site)/settings/team/page.tsx")} now: it is still served`);
    expect(steps).not.toContain("They won't build against the new packages");
  });
});

describe("the 0.39 note offers `free:` only where something enforces it (review)", () => {
  const freeWords = (answers: Answers) =>
    upgradeNotesFor(answers, "0.38.0").some((note) => note.includes("what an account with no plan gets"));

  it("a companies project, whose plan gate pauses a company with no plan, is not sold a Free column", () => {
    expect(freeWords(COMPANIES)).toBe(false);
    expect(freeWords(BASE)).toBe(false);
  });

  it("NEGATIVE CONTROL: a consumers project, whose plan check grants it, is told about it", () => {
    expect(freeWords(CONSUMERS)).toBe(true);
  });
});

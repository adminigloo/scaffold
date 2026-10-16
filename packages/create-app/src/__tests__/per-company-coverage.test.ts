/**
 * WHICH PACKAGES RUN PER COMPANY, AND WHICH DON'T YET — one line for every
 * package in this repository.
 *
 * The table below is the record. Each package is one of:
 *
 *   - "per-company": in a companies project every row it keeps belongs to one
 *     company, and every route it serves refuses another company's ids;
 *   - "chunk:<name>": not per company yet — the named chunk makes it so;
 *   - "shared:<reason>": not about any one business, by design (the reason in
 *     plain words).
 *
 * It fails when a package directory is missing from the table (a new package
 * nobody decided about) or the table names one that doesn't exist; and, for
 * every "per-company" package that exports route tables (`*_ADMIN_ROUTES`,
 * `*_PUBLIC_ROUTES`), unless the emitted isolation proof
 * (src/server/__tests__/feature-isolation.test.ts in a companies project with
 * every feature) drives those tables. docs/per-company-coverage.md says the
 * same in plain words, and is checked against this table too.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, type Answers } from "../answers.js";
import { planEmit, type EmitPlan } from "../emit.js";
import { featureSuiteNames } from "../feature-proofs-emit.js";
import { TEMPLATE_DIR, TENANCY_2B1_CONFIGURATIONS } from "./configurations.js";

const REPO = join(__dirname, "..", "..", "..", "..");
const PACKAGES_DIR = join(REPO, "packages");

type Status = "per-company" | `chunk:${string}` | `shared:${string}`;

/** Every directory under packages/, and where it stands. */
export const PER_COMPANY_COVERAGE: Readonly<Record<string, Status>> = {
  // Per company today (Tenancy 1, 2a and 2b-1).
  tenancy: "per-company",
  "tenancy-widget": "per-company",
  permissions: "per-company",
  trpc: "per-company",
  auth: "per-company",
  testing: "per-company",
  estimator: "per-company",
  "estimator-widget": "per-company",
  scheduling: "per-company",
  "scheduling-widget": "per-company",
  invoicing: "per-company",
  "invoicing-widget": "per-company",
  comms: "per-company",
  "comms-widget": "per-company",
  email: "per-company",
  notifications: "per-company",
  "notifications-widget": "per-company",
  storage: "per-company",
  "storage-widget": "per-company",
  // Not yet: the chunk that makes each per company.
  feedback: "chunk:2b-2 feedback",
  "feedback-widget": "chunk:2b-2 feedback",
  assistant: "chunk:2b-3 assistant",
  "assistant-widget": "chunk:2b-3 assistant",
  ai: "chunk:2b-3 assistant",
  analytics: "chunk:2b-4 website",
  audience: "chunk:2b-4 website",
  seo: "chunk:2b-4 website",
  "seo-reports": "chunk:2b-4 website",
  aeo: "chunk:2b-4 website",
  booking: "chunk:2b-4 website",
  "booking-widget": "chunk:2b-4 website",
  billing: "chunk:billing",
  catalog: "chunk:billing",
  stripe: "chunk:billing",
  commerce: "chunk:getting-paid",
  // Not about any one business, by design.
  db: "shared:the database connection and migration tools every package uses; it keeps no business's records",
  env: "shared:reads the site's own settings when it starts; nothing in it belongs to a business",
  license: "shared:checks the site's own licence key with the seller; one per site, not per business",
  observability: "shared:the site owner's error log and health checks, across every business",
  "create-app": "shared:the generator itself; it writes the project and is never installed into it",
};

/** The package directories that exist (a folder with a package.json). */
function packageDirs(): string[] {
  return readdirSync(PACKAGES_DIR)
    .filter((name) => statSync(join(PACKAGES_DIR, name)).isDirectory())
    .filter((name) => existsSync(join(PACKAGES_DIR, name, "package.json")))
    .sort();
}

/** Every `.ts` file a package ships from (its tests apart). */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules" && entry.name !== "dist") walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** The route tables a package exports: `export const X_ADMIN_ROUTES` / `X_PUBLIC_ROUTES`. */
function routeTablesOf(pkg: string): string[] {
  return [
    ...new Set(
      sourceFiles(join(PACKAGES_DIR, pkg, "src")).flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(/^export const ([A-Z][A-Z0-9_]*_(?:ADMIN|PUBLIC)_ROUTES)\b/gm)].map((m) => m[1]!),
      ),
    ),
  ].sort();
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const COMPANY_EVERYTHING: Answers = {
  ...DEFAULT_ANSWERS,
  projectName: "igloo-back-office",
  ...TENANCY_2B1_CONFIGURATIONS.companyAll,
};

let planned: Promise<EmitPlan> | null = null;
function companyPlan(): Promise<EmitPlan> {
  planned ??= planEmit(TEMPLATE_DIR, "/out", COMPANY_EVERYTHING);
  return planned;
}

describe("per-company coverage: every package has one status", () => {
  it("names every package directory, and nothing that isn't one", () => {
    const dirs = packageDirs();
    const named = Object.keys(PER_COMPANY_COVERAGE).sort();
    const missing = dirs.filter((dir) => !(dir in PER_COMPANY_COVERAGE));
    const extra = named.filter((name) => !dirs.includes(name));
    expect(missing, `packages with no status — decide: per-company, chunk:<name> or shared:<reason>`).toEqual([]);
    expect(extra, `the table names packages that don't exist`).toEqual([]);
  });

  it("gives each a status of the three shapes, and a shared one its reason in words", () => {
    for (const [pkg, status] of Object.entries(PER_COMPANY_COVERAGE)) {
      expect(status === "per-company" || /^chunk:\S.*$/.test(status) || /^shared:\S.{10,}$/.test(status), `${pkg}: "${status}"`).toBe(true);
      // Plain words: a reason never says "tenant", "slug" or "blob".
      if (status.startsWith("shared:")) expect(status, pkg).not.toMatch(/tenant|slug|blob/i);
    }
  });

  it.each(
    Object.entries(PER_COMPANY_COVERAGE)
      .filter(([, status]) => status === "per-company")
      .flatMap(([pkg]) => routeTablesOf(pkg).map((table) => [pkg, table] as const)),
  )("%s's %s is driven by the emitted isolation proof in a companies project", async (pkg, table) => {
    const p = await companyPlan();
    const proof = p.files.get(join("src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof, "a companies project with every feature has its isolation proof").toBeDefined();
    const body = code(proof!);
    // Imported from the package itself…
    const imported = [...body.matchAll(/^import \{([^}]*)\} from "@adminigloo\/([a-z-]+)";$/gm)].some(
      (m) => m[2] === pkg && m[1]!.split(",").map((s) => s.trim()).includes(table),
    );
    expect(imported, `feature-isolation.test.ts imports ${table} from @adminigloo/${pkg}`).toBe(true);
    // …and DRIVEN: a suite's route table (every row of which the proof sends
    // as the other company and checks is exercised), or the public files
    // suite's own loop over it.
    const inSuite = new RegExp(`(adminRoutes|publicRoutes): (?:[^,\\n]*\\b)?${table}\\b`).test(body);
    const looped = new RegExp(`for \\(const route of ${table}\\)`).test(body);
    expect(inSuite || looped, `${table} is one of the proof's suites, or looped over by one`).toBe(true);
    if (/_ADMIN_ROUTES$/.test(table)) expect(featureSuiteNames(COMPANY_EVERYTHING)).toContain(pkg);
  });

  it("is said the same way, in plain words, in docs/per-company-coverage.md", () => {
    const doc = readFileSync(join(REPO, "docs", "per-company-coverage.md"), "utf8");
    for (const [pkg, status] of Object.entries(PER_COMPANY_COVERAGE)) {
      const row = doc.split("\n").find((line) => line.startsWith(`| \`${pkg}\` |`));
      expect(row, `docs/per-company-coverage.md has a row for ${pkg}`).toBeDefined();
      const words = status === "per-company" ? "Per company" : status.startsWith("chunk:") ? status.slice("chunk:".length) : status.slice("shared:".length);
      expect(row!, pkg).toContain(words);
    }
    const rows = doc.split("\n").filter((line) => /^\| `[a-z-]+` \|/.test(line));
    expect(rows.length).toBe(Object.keys(PER_COMPANY_COVERAGE).length);
  });
});


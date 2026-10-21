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
  // Per company today (Tenancy 1, 2a, 2b-1, 2b-2a, 2b-3, 2b-4a, 2b-4b and 2b-4c).
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
  feedback: "per-company",
  "feedback-widget": "per-company",
  assistant: "per-company",
  "assistant-widget": "per-company",
  ai: "per-company",
  // Billing 0.3: each company's plan and limits, checked at every checkpoint.
  billing: "per-company",
  // Tenancy 2b-4a: each company's website visits, who it leaves out of them,
  // and its public pages in search.
  analytics: "per-company",
  audience: "per-company",
  seo: "per-company",
  // Tenancy 2b-4b: each company's search check and its AI mentions.
  "seo-reports": "per-company",
  aeo: "per-company",
  // Tenancy 2b-4c: each company's calls and its booking page.
  booking: "per-company",
  "booking-widget": "per-company",
  // Getting paid, part 1: each company's own Stripe account (Connect), its
  // payments screen and its customers' card payments. The site's own plan
  // billing stays on the site's account.
  stripe: "per-company",
  // Getting paid, part 2: each company's own store — its products (catalog
  // rows under its id; the site's own plans and products stay under "*"), its
  // checkouts, orders and the store payments that need its owner.
  commerce: "per-company",
  catalog: "per-company",
  // The customer list (create-app 0.35): each company's customers and their timelines.
  customers: "per-company",
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
  // Tenancy 2b-2a: and the feedback board, whose route tables are per company.
  includeFeedback: true,
  // Tenancy 2b-3: and the assistant, whose route table is per company.
  includeAssistant: true,
  // Tenancy 2b-4a: and website visits and search basics, whose route tables are per company.
  includeAnalytics: true,
  includeSeo: true,
  // Tenancy 2b-4b: and the search check and AI mentions, whose route tables are per company.
  includeSeoReports: true,
  includeAeo: true,
  // Tenancy 2b-4c: and book a call, whose route tables are per company.
  includeBooking: true,
  // Getting paid, part 2: and the store, whose route tables are per company.
  includeStore: true,
  // The customer list (create-app 0.35), whose route table is per company.
  includeCustomers: true,
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

/**
 * DELETE A COMPANY (create-app 0.37): how each per-company package's rows go
 * when staff delete a company. Every per-company package declares one:
 *
 *   - "forgetTenant": it keeps company rows, exports `forgetTenant` (found in
 *     its source), and the emitted src/server/forget-company.ts calls it;
 *   - "own:<how>": it forgets them itself (tenancy's deleteCompany);
 *   - "none:<why>": it keeps no table with a company column — checked: no
 *     `text("tenant_id")` anywhere in its source.
 *
 * So a new package that keeps company rows can't be added without saying how
 * they are forgotten, and can't say "none" while it keeps some.
 */
export const FORGET_COVERAGE: Readonly<Record<string, string>> = {
  tenancy: "own:deleteCompany forgets the team, invitations and address history, and keeps the emptied company row",
  "tenancy-widget": "none:screens only",
  permissions: "forgetTenant",
  trpc: "none:the app's data calls, no tables",
  auth: "none:people's accounts are a person's; tenancy clears a current company pointing at a deleted one",
  testing: "none:test helpers, no tables",
  estimator: "forgetTenant",
  "estimator-widget": "none:screens only",
  scheduling: "forgetTenant",
  "scheduling-widget": "none:screens only",
  invoicing: "forgetTenant",
  "invoicing-widget": "none:screens only",
  comms: "forgetTenant",
  "comms-widget": "none:screens only",
  email: "forgetTenant",
  notifications: "forgetTenant",
  "notifications-widget": "none:screens only",
  storage: "forgetTenant",
  "storage-widget": "none:screens only",
  feedback: "forgetTenant",
  "feedback-widget": "none:screens only",
  assistant: "forgetTenant",
  "assistant-widget": "none:screens only",
  ai: "forgetTenant",
  billing: "forgetTenant",
  analytics: "forgetTenant",
  audience: "forgetTenant",
  seo: "none:keeps its words in the company's settings, which tenancy empties",
  "seo-reports": "forgetTenant",
  aeo: "forgetTenant",
  booking: "forgetTenant",
  "booking-widget": "none:screens only",
  stripe: "forgetTenant",
  commerce: "forgetTenant",
  catalog: "forgetTenant",
  customers: "forgetTenant",
};

let sellingPlan: Promise<EmitPlan> | null = null;

describe("per-company coverage: every per-company package says how a deleted company's rows go", () => {
  const perCompany = Object.entries(PER_COMPANY_COVERAGE)
    .filter(([, status]) => status === "per-company")
    .map(([pkg]) => pkg)
    .sort();

  it("names every per-company package, and nothing else", () => {
    expect(Object.keys(FORGET_COVERAGE).sort()).toEqual(perCompany);
    for (const [pkg, how] of Object.entries(FORGET_COVERAGE)) {
      expect(how === "forgetTenant" || /^own:\S.{5,}$/.test(how) || /^none:\S.{5,}$/.test(how), `${pkg}: "${how}"`).toBe(true);
    }
  });

  it.each(perCompany)("%s: keeps company rows only if it declares how they're forgotten", (pkg) => {
    const how = FORGET_COVERAGE[pkg]!;
    const sources = sourceFiles(join(PACKAGES_DIR, pkg, "src")).map((path) => code(readFileSync(path, "utf8")));
    const keepsRows = sources.some((source) => source.includes('text("tenant_id")'));
    if (how.startsWith("none:")) expect(keepsRows, `${pkg} says it keeps no company rows, but a table of its has tenant_id`).toBe(false);
    if (how === "forgetTenant") {
      expect(keepsRows, `${pkg} declares forgetTenant but keeps no company rows`).toBe(true);
      expect(
        sources.some((source) => /export async function forgetTenant\(/.test(source)),
        `${pkg} exports forgetTenant(db, tenantId)`,
      ).toBe(true);
    }
  });

  it.each(Object.entries(FORGET_COVERAGE).filter(([, how]) => how === "forgetTenant").map(([pkg]) => pkg))(
    "%s's forgetTenant is called by the emitted src/server/forget-company.ts of a companies project with every feature",
    async (pkg) => {
      // Every feature AND plans for sale, so billing is installed too.
      sellingPlan ??= planEmit(TEMPLATE_DIR, "/out", { ...COMPANY_EVERYTHING, businessModel: "subscription" });
      const p = await sellingPlan;
      const file = p.files.get(join("src", "server", "forget-company.ts"));
      expect(file, "a companies project has src/server/forget-company.ts").toBeDefined();
      const body = code(file!);
      const imported = [...body.matchAll(/^import \{([^}]*)\} from "@adminigloo\/([a-z-]+)(?:\/([a-z]+))?";$/gm)].find(
        (m) => m[2] === pkg && /\bforgetTenant as (\w+)/.test(m[1]!),
      );
      expect(imported, `forget-company.ts imports forgetTenant from @adminigloo/${pkg}`).toBeDefined();
      const alias = /\bforgetTenant as (\w+)/.exec(imported![1]!)![1]!;
      expect(body, `forget-company.ts calls ${alias}(tx, tenantId…)`).toMatch(new RegExp(`\\b${alias}\\(tx, tenantId\\b`));
    },
  );
});


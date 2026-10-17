/**
 * TENANCY 2a, AS THE GENERATOR WRITES IT (contract section 11.14).
 *
 * A companies project's field-service features — scheduling, the estimator,
 * invoicing and messages — are EACH COMPANY'S: its own screens under /app,
 * its own routes under /api/app/{company id} and /api/t/{web address}, its
 * own public pages under /t/{web address}, its own emails and crons, its own
 * roles. A single-business project keeps them on the one fixed business, at
 * today's paths, on the staff ladder — with invoicing and messages moved onto
 * the package handlers and widgets in both modes.
 *
 * Read from the PLAN as text, the way the capability evidence does: the
 * emitted modules reach `@/db` and the packages, so they run for real in a
 * generated project (its own feature-isolation, company-crons and
 * company-email tests, scripts/verify-generated.mjs) and in the browser
 * scenario (e2e/tests/tenancy-2a-scenario.spec.ts). The few emitted functions
 * that are pure — the company links, the switch route's `next` rule, an
 * invoice's due date — are transpiled and RUN here.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_ANSWERS, capabilitiesFor, overlayNamesFor, packagesFor, type Answers } from "../answers.js";
import { CAPABILITY_EVIDENCE } from "../capabilities.js";
import { planEmit, renderPermissionsCatalog, versionRangeFor, type EmitPlan } from "../emit.js";
import { FEATURE_ENTITIES } from "../feature-proofs-emit.js";
import { TENANCY_1_NOT_INCLUDED, TENANCY_2A_NOT_INCLUDED, TENANCY_2A_SUPERSEDED } from "../readme-emit.js";
import { ROUTER_SCOPES } from "../tenancy-proofs-emit.js";
import { EVERY_CONFIGURATION, TEMPLATE_DIR } from "./configurations.js";

const PACKAGES_DIR = join(__dirname, "..", "..", "..");
const OVERLAYS_DIR = join(TEMPLATE_DIR, "..", "overlays");

function answers(overrides: Partial<Answers> = {}): Answers {
  return { ...DEFAULT_ANSWERS, projectName: "igloo-back-office", ...overrides };
}

/** The founder's project: `--tenant-noun Company --admin full` with every field-service feature, email, storage and AI. */
const COMPANY_FULL: Partial<Answers> = {
  tenantNoun: "Company",
  adminShell: "full",
  includeEstimator: true,
  includeScheduling: true,
  includeInvoicing: true,
  includeComms: true,
  includeEmail: true,
  includeStorage: true,
  includeAi: true,
};

/** The same four features for one business: `--tenant-noun none --admin minimal`. */
const SINGLE_FULL: Partial<Answers> = {
  tenantNoun: "none",
  adminShell: "minimal",
  includeEstimator: true,
  includeScheduling: true,
  includeInvoicing: true,
  includeComms: true,
  includeEmail: true,
};

const NONE_OF_THEM: Partial<Answers> = {
  includeEstimator: false,
  includeScheduling: false,
  includeInvoicing: false,
  includeComms: false,
};

/** Each feature alone in a companies project (scheduling and the estimator need a shell). */
const COMPANY_EACH_ALONE: ReadonlyArray<readonly [string, Partial<Answers>]> = [
  ["scheduling", { ...COMPANY_FULL, ...NONE_OF_THEM, includeScheduling: true }],
  ["estimator", { ...COMPANY_FULL, ...NONE_OF_THEM, includeEstimator: true }],
  ["invoicing", { ...COMPANY_FULL, ...NONE_OF_THEM, includeInvoicing: true }],
  ["comms", { ...COMPANY_FULL, ...NONE_OF_THEM, includeComms: true }],
];

const cache = new Map<string, Promise<EmitPlan>>();
function plan(overrides: Partial<Answers> = {}): Promise<EmitPlan> {
  const key = JSON.stringify(answers(overrides));
  let found = cache.get(key);
  if (!found) {
    found = planEmit(TEMPLATE_DIR, "/out", answers(overrides));
    cache.set(key, found);
  }
  return found;
}

function file(p: EmitPlan, ...segments: string[]): string {
  const contents = p.files.get(join(...segments));
  if (contents === undefined) throw new Error(`the plan has no ${segments.join("/")}`);
  return contents;
}

function has(p: EmitPlan, ...segments: string[]): boolean {
  return p.files.has(join(...segments));
}

/** Source with comments removed, so a check can't be satisfied by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** A plan's paths, `/`-separated. */
function pathsOf(p: EmitPlan): string[] {
  return [...p.files.keys()].map((path) => path.split(sep).join("/"));
}

function contentsAt(p: EmitPlan, path: string): string {
  return p.files.get(path.split("/").join(sep)) ?? "";
}

/**
 * Run an emitted TypeScript module: transpiled to CommonJS, its imports
 * answered by `stubs` (anything else is an inert stand-in), its exports
 * returned. For the PURE functions only — what this proves is the emitted
 * logic, not the wiring.
 */
function loadEmitted(source: string, stubs: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === "then" || prop === "__esModule" ? undefined : inert),
    apply: () => inert,
  });
  const require = (id: string): unknown => (Object.prototype.hasOwnProperty.call(stubs, id) ? stubs[id] : inert);
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", js)(require, module, module.exports);
  return module.exports;
}

/** A field-service file: the feature glue, the company modules, the feature routes, pages, crons and proofs. */
function isFeatureFile(path: string): boolean {
  return (
    /(^|\/)(scheduling|estimator|invoicing|comms|company-)[^/]*\.(ts|tsx)$/.test(path) ||
    /(^|\/)(feature-isolation|company-crons|company-email)\.test\.ts$/.test(path) ||
    path.startsWith("app/(site)/app/") ||
    path.startsWith("app/(company)/t/") ||
    path.startsWith("app/api/app/") ||
    path.startsWith("app/api/t/") ||
    path.startsWith("app/api/cron/") ||
    path.startsWith("app/api/estimator/") ||
    path === "src/components/PublicCompanyGate.tsx" ||
    path === "src/test/company-rows.ts"
  );
}

// Tenancy 2b-1 (13.9) adds the alerts' and files' fixed business.
const FIXED_TENANT_NAMES = ["SCHEDULING_TENANT", "ESTIMATOR_TENANT", "INVOICING_TENANT", "COMMS_TENANT", "ALERTS_TENANT", "FILES_TENANT"];

// ---------------------------------------------------------------------------

describe("D12: a companies project contains no fixed business", () => {
  it.each([["every feature", COMPANY_FULL] as const, ...COMPANY_EACH_ALONE])(
    "%s: no \"primary\", no fixed-tenant constant, no platform-owner fallback in the feature glue",
    async (_label, overrides) => {
      const p = await plan(overrides);
      let featureFiles = 0;
      for (const path of pathsOf(p)) {
        const source = contentsAt(p, path);
        for (const name of FIXED_TENANT_NAMES) {
          expect(source.includes(name), `${path} names ${name}`).toBe(false);
        }
        if (!isFeatureFile(path)) continue;
        featureFiles += 1;
        expect(source.includes('"primary"'), `${path} contains "primary"`).toBe(false);
        // The single business's office fallback (BOOTSTRAP_ADMIN_EMAIL) would
        // send one company's leads to the platform owner (D8). The email
        // proof names it on purpose, to assert nothing ever goes there.
        if (!path.includes("__tests__")) {
          expect(source.includes("BOOTSTRAP_ADMIN_EMAIL"), `${path} falls back to BOOTSTRAP_ADMIN_EMAIL`).toBe(false);
        }
      }
      expect(featureFiles).toBeGreaterThan(5);
    },
  );

  it("and the single-business project still has its one business (the control)", async () => {
    const p = await plan(SINGLE_FULL);
    expect(file(p, "src", "server", "scheduling-staff.ts")).toContain('export const SCHEDULING_TENANT = "primary";');
    expect(file(p, "src", "server", "estimator-staff.ts")).toContain('export const ESTIMATOR_TENANT = "primary";');
    expect(file(p, "src", "server", "invoicing.ts")).toContain('export const INVOICING_TENANT = "primary";');
    expect(file(p, "src", "server", "comms-senders.ts")).toContain('export const COMMS_TENANT = "primary";');
  });

  it("keeps the shared config modules free of the fixed business, so both modes can carry them", async () => {
    for (const path of ["scheduling/src/server/scheduling-config.ts", "estimator/src/server/estimator-config.ts"]) {
      const source = await readFile(join(OVERLAYS_DIR, ...path.split("/")), "utf8");
      expect(source, path).not.toContain('"primary"');
      for (const name of [...FIXED_TENANT_NAMES, "STAFF_KEYS", "CREW_ROLE"]) {
        expect(code(source), `${path} declares ${name}`).not.toContain(name);
      }
    }
  });
});

describe("rule 1: no emitted file asks which mode or feature it is in", () => {
  it.each([["companies", COMPANY_FULL] as const, ["single", SINGLE_FULL] as const])("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    for (const path of pathsOf(p)) {
      if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
      const source = code(contentsAt(p, path));
      for (const word of ["tenantNoun", "includeScheduling", "includeEstimator", "includeInvoicing", "includeComms"]) {
        expect(source.includes(word), `${path} contains ${word}`).toBe(false);
      }
      // Asking the tenancy MODE at runtime (a test's own `mail.mode ===
      // "project"` is a stand-in's switch, not this question).
      expect(source, path).not.toMatch(/\bmode\s*===\s*"(companies|personal|single)"/);
    }
  });
});

describe("the overlays, re-cut (11.2)", () => {
  it("selects -companies only for companies, -single and -admin only for one business, across every configuration", () => {
    const features = [
      ["estimator", "includeEstimator"],
      ["scheduling", "includeScheduling"],
      ["invoicing", "includeInvoicing"],
      ["comms", "includeComms"],
    ] as const;
    for (const config of EVERY_CONFIGURATION) {
      const names = new Set(overlayNamesFor(config.answers));
      const companies = config.answers.tenantNoun !== "none";
      const shell = config.answers.adminShell !== "none";
      for (const [feature, key] of features) {
        const on = config.answers[key];
        expect(names.has(`${feature}-companies`), `${config.label}: ${feature}-companies`).toBe(on && companies);
        expect(names.has(`${feature}-single`), `${config.label}: ${feature}-single`).toBe(on && !companies);
        expect(names.has(`${feature}-admin`), `${config.label}: ${feature}-admin`).toBe(on && !companies && shell);
      }
      // The shared halves only where there is something to share.
      expect(names.has("scheduling")).toBe(config.answers.includeScheduling);
      expect(names.has("estimator")).toBe(config.answers.includeEstimator);
      expect(names.has("invoicing")).toBe(false);
      expect(names.has("comms")).toBe(false);
    }
  });

  it("retired the copied invoicing and comms overlays, and every selected overlay exists", () => {
    expect(existsSync(join(OVERLAYS_DIR, "invoicing"))).toBe(false);
    expect(existsSync(join(OVERLAYS_DIR, "comms"))).toBe(false);
    for (const name of [
      "scheduling-single",
      "scheduling-companies",
      "estimator-single",
      "estimator-companies",
      "invoicing-single",
      "invoicing-companies",
      "comms-single",
      "comms-companies",
    ]) {
      expect(existsSync(join(OVERLAYS_DIR, name)), name).toBe(true);
    }
  });

  it("moves no file the base owns and collides nowhere — every feature set, both modes", async () => {
    // planEmit throws OverlayCollisionError on a collision; a plan is the proof.
    for (const overrides of [COMPANY_FULL, SINGLE_FULL, ...COMPANY_EACH_ALONE.map(([, o]) => o)]) {
      await expect(plan(overrides)).resolves.toBeDefined();
    }
  });
});

describe("routes ↔ pages (11.3–11.4)", () => {
  it("every /app page's baseUrl names a company route that exists, mounting the staff handler", async () => {
    const p = await plan(COMPANY_FULL);
    const pages = pathsOf(p).filter((path) => path.startsWith("app/(site)/app/") && path.endsWith("page.tsx"));
    let checked = 0;
    for (const path of pages) {
      for (const match of contentsAt(p, path).matchAll(/\/api\/app\/\$\{company\.id\}\/([a-z-]+)/g)) {
        checked += 1;
        const route = `app/api/app/[tenantId]/${match[1]}/[...path]/route.ts`;
        expect(pathsOf(p), `${path} calls ${route}`).toContain(route);
        // Tenancy 2b-1: alerts and files mount their own builders
        // (buildAlertsHandlers, buildFilesHandlers), behind the same company gate.
        expect(contentsAt(p, route), route).toMatch(/build\w+?(Admin)?Handlers\(\)/);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
  });

  it("every public page's baseUrl names a /api/t route that exists, mounting the public handler", async () => {
    const p = await plan(COMPANY_FULL);
    const pages = pathsOf(p).filter((path) => path.startsWith("app/(company)/t/") && path.endsWith("page.tsx"));
    let checked = 0;
    for (const path of pages) {
      for (const match of contentsAt(p, path).matchAll(/\/api\/t\/\$\{company\.slug\}\/([a-z-]+)/g)) {
        checked += 1;
        const route = `app/api/t/[slug]/${match[1]}/[...path]/route.ts`;
        expect(pathsOf(p), `${path} calls ${route}`).toContain(route);
        expect(contentsAt(p, route), route).toMatch(/build\w+PublicHandlers\(\)/);
        expect(contentsAt(p, route), route).not.toContain("Admin");
      }
    }
    expect(checked).toBe(5);
  });

  it("gates every private page itself, with the table's permission (never in a layout)", async () => {
    const p = await plan(COMPANY_FULL);
    const table: ReadonlyArray<readonly [string, string, string]> = [
      ["app/(site)/app/schedule/page.tsx", "schedule.view", "<ScheduleCalendar"],
      ["app/(site)/app/schedule/today/page.tsx", "schedule.route", "<CrewDay"],
      ["app/(site)/app/schedule/settings/page.tsx", "schedule.view", "<SchedulingSettings"],
      ["app/(site)/app/estimates/page.tsx", "estimator.view", "<EstimatesQueue"],
      ["app/(site)/app/estimates/[id]/page.tsx", "estimator.view", "<EstimateEditor"],
      ["app/(site)/app/estimates/settings/page.tsx", "estimator.view", "<EstimatorSettings"],
      ["app/(site)/app/price-book/page.tsx", "estimator.view", "<PriceBook"],
      ["app/(site)/app/invoices/page.tsx", "invoices.view", "<InvoicesLedger"],
      ["app/(site)/app/invoices/[id]/page.tsx", "invoices.view", "<InvoiceEditor"],
      ["app/(site)/app/messages/page.tsx", "comms.view", "<MessagesConsole"],
    ];
    for (const [path, permission, component] of table) {
      const source = code(contentsAt(p, path));
      expect(source, path).toContain(`permission="${permission}"`);
      expect(source, path).toContain("<CompanyGate");
      expect(source, path).toContain(component);
      expect(source, path).toContain('export const dynamic = "force-dynamic"');
    }
    expect(pathsOf(p).some((path) => path.startsWith("app/(site)/app/") && path.endsWith("layout.tsx"))).toBe(false);
    // The pattern hrefs a server page can pass to a client component.
    expect(contentsAt(p, "app/(site)/app/estimates/page.tsx")).toContain('estimateHref="/app/estimates/{id}"');
    expect(contentsAt(p, "app/(site)/app/invoices/page.tsx")).toContain('invoiceHref="/app/invoices/{id}"');
    // Messages offers Edit only to a role that may edit — and so do the price
    // book, estimate settings (and its website keys) and schedule settings: a
    // member who quotes from the price book is never offered a Save the
    // server would refuse (contract 14 step 4). Each key is the one the
    // package's route table asks for that save.
    expect(contentsAt(p, "app/(site)/app/messages/page.tsx")).toContain('canManage={can.includes("comms.manage")}');
    expect(contentsAt(p, "app/(site)/app/price-book/page.tsx")).toContain('canManage={can.includes("estimator.pricebook.manage")}');
    const estimateSettings = contentsAt(p, "app/(site)/app/estimates/settings/page.tsx");
    expect(estimateSettings.match(/canManage=\{can\.includes\("estimator\.settings\.manage"\)\}/g)).toHaveLength(2);
    expect(contentsAt(p, "app/(site)/app/schedule/settings/page.tsx")).toContain('canManage={can.includes("schedule.resources.manage")}');
    // A VIEWER reads (acceptance item 4): the schedule, the estimates (list
    // and each one) and the ledger are shown read-only to a role without the
    // key their changes ask for — no Accept, no New visit, no Send quote, no
    // New invoice the server would refuse.
    expect(contentsAt(p, "app/(site)/app/schedule/page.tsx")).toContain('canManage={can.includes("schedule.manage")}');
    expect(contentsAt(p, "app/(site)/app/estimates/page.tsx")).toContain('canManage={can.includes("estimator.estimates.manage")}');
    expect(contentsAt(p, "app/(site)/app/estimates/[id]/page.tsx")).toContain('canManage={can.includes("estimator.estimates.manage")}');
    expect(contentsAt(p, "app/(site)/app/invoices/page.tsx")).toContain('canManage={can.includes("invoices.manage")}');
    // A crew member is invited on the Team page, then picked for a crew.
    expect(contentsAt(p, "app/(site)/app/schedule/settings/page.tsx")).toContain('inviteHref="/settings/team"');
  });

  it("wraps every public page in PublicCompanyGate, in the company's colour, and keeps token pages out of indexes and Referers", async () => {
    const p = await plan(COMPANY_FULL);
    const pages: ReadonlyArray<readonly [string, string, boolean]> = [
      ["app/(company)/t/[slug]/book-visit/page.tsx", "<VisitPicker", false],
      ["app/(company)/t/[slug]/visit/[token]/page.tsx", "<ManageVisit", true],
      ["app/(company)/t/[slug]/estimate/page.tsx", "<EstimateTool", false],
      ["app/(company)/t/[slug]/quote/[token]/page.tsx", "<QuoteView", true],
      ["app/(company)/t/[slug]/invoice/[token]/page.tsx", "<InvoiceView", true],
    ];
    for (const [path, component, token] of pages) {
      const source = contentsAt(p, path);
      expect(code(source), path).toContain("<PublicCompanyGate");
      expect(code(source), path).toContain(component);
      expect(code(source), path).toContain("accentColor={company.brandColor}");
      // Its title and link preview are the company's, never this site's; not
      // indexed; a token page sends no Referer (review T2A-BO-01).
      expect(code(source), path).toContain("export async function generateMetadata(");
      expect(code(source), path).toMatch(token ? /publicCompanyMetadata\(slug, "[^"]+", \{ noReferrer: true \}\)/ : /publicCompanyMetadata\(slug, "[^"]+"(, \{ path: "\/[a-z-]+" \})?\)/);
      expect(code(source), path).not.toContain("export const metadata");
    }
    // The estimate and quote pages offer the company's OWN booking page.
    expect(contentsAt(p, "app/(company)/t/[slug]/quote/[token]/page.tsx")).toContain("bookHref={estimateBookHref(company.publicPath)}");
    expect(code(file(p, "src", "server", "estimator-features.ts"))).toContain("return `${publicPath}/book-visit`;");
    const noScheduling = await plan(COMPANY_EACH_ALONE[1]![1]);
    expect(code(file(noScheduling, "src", "server", "estimator-features.ts"))).toContain("return undefined;");
    // A preview never counts as the customer reading their invoice.
    expect(contentsAt(p, "app/(company)/t/[slug]/invoice/[token]/page.tsx")).toContain('preview={query.preview === "1"}');
  });

  it("serves the estimate embed by key only, at its 0.2 address too", async () => {
    const p = await plan(COMPANY_FULL);
    expect(code(file(p, "app", "api", "estimator", "[...path]", "route.ts"))).toContain("buildEstimatorEmbedHandlers()");
    expect(file(p, "app", "api", "estimator", "embed", "[...path]", "route.ts")).toContain('from "../../[...path]/route"');
    const glue = code(file(p, "src", "server", "estimator.ts"));
    const embed = glue.slice(glue.indexOf("export function buildEstimatorEmbedHandlers"), glue.indexOf("export async function setupEstimatorFor"));
    expect(embed).not.toContain("resolveTenant");
    expect(embed).not.toContain("tenantId:");
    // Billing 0.3: the estimate request is admitted by the company AND its plan's monthly estimates.
    expect(embed).toContain("admit: admitEstimateRequest");
  });

  it("can reach every company page from somewhere: the nav, a page's link, or a pattern href", async () => {
    const p = await plan(COMPANY_FULL);
    const nav = code(file(p, "src", "nav.ts"));
    const hrefs = new Set<string>([...nav.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]!));
    for (const path of pathsOf(p)) {
      if (!path.startsWith("app/(site)/app/")) continue;
      for (const m of code(contentsAt(p, path)).matchAll(/[hH]ref="([^"#]+)/g)) hrefs.add(m[1]!.replace("{id}", "[id]"));
    }
    const checklist = file(p, "src", "server", "setup-checklist.ts");
    for (const m of checklist.matchAll(/"(\/app\/[^"#]+)/g)) hrefs.add(m[1]!);
    // Tenancy 2b-1: a visit's photos and files page is opened from the
    // calendar's visit panel and the crew's day, by the generated pattern
    // those pages pass the widgets (VISIT_FILES_HREF).
    if (pathsOf(p).includes("src/server/visit-files.ts")) {
      for (const m of file(p, "src", "server", "visit-files.ts").matchAll(/"(\/app\/[^"#?]+)/g)) hrefs.add(m[1]!.replace("{id}", "[id]"));
    }
    for (const path of pathsOf(p)) {
      if (!path.startsWith("app/(site)/app/") || !path.endsWith("page.tsx")) continue;
      const url = `/${path.slice("app/(site)/".length, -"/page.tsx".length)}`;
      if (url === "/app") continue; // a redirect to /dashboard
      expect(hrefs.has(url), `${url} is generated and nothing links to it`).toBe(true);
    }
  });
});

describe("the company modules (11.5)", () => {
  it("routes every private request through the company seam, and sets a company up only once the caller passed", async () => {
    const p = await plan(COMPANY_FULL);
    const routes = code(file(p, "src", "server", "company-routes.ts"));
    expect(routes).toContain("createCompanyRouteSeams({");
    expect(routes).toContain("createPublicCompanySeams({ tenancy, ...companyPlanOption })");
    const authorizer = routes.slice(routes.indexOf("export function companyAuthorizer"));
    expect(authorizer.indexOf("await seams.authorize(req, permission, tenantId)")).toBeLessThan(
      authorizer.indexOf("await ensureCompanySetup(tenantId)"),
    );
    expect(authorizer).toContain("if (verdict === false || verdict instanceof Response) return verdict;");
    // The public path: the web address resolved first, then setup.
    const resolver = routes.slice(routes.indexOf("export async function resolvePublicTenant"));
    expect(resolver.indexOf("if (tenantId === null) return null;")).toBeLessThan(resolver.indexOf("ensureCompanySetup"));
    // Not emitted for a single business.
    const single = await plan(SINGLE_FULL);
    for (const name of ["company-routes.ts", "company-links.ts", "company-setup.ts"]) {
      expect(has(single, "src", "server", name), name).toBe(false);
    }
    expect(has(single, "src", "components", "PublicCompanyGate.tsx")).toBe(false);
  });

  it("builds a company's links from its CURRENT web address, every token in one encoded segment", async () => {
    const p = await plan(COMPANY_FULL);
    const links = loadEmitted(file(p, "src", "server", "company-links.ts"), {
      "@/env": { env: { NEXT_PUBLIC_APP_URL: "https://igloo.example" } },
      "./tenancy": {
        tenancy: { companyProfile: async (id: string) => (id === "co_green" ? { slug: "green-acres" } : null) },
      },
    });
    type Links = {
      home: string;
      estimate: string;
      bookVisit: (id?: string) => string;
      manageVisit: (t: string) => string;
      quote: (t: string) => string;
      invoice: (t: string) => string;
      app: (path: string) => string;
    };
    const green = await (links.companyLinks as (id: string) => Promise<Links>)("co_green");
    expect(green.home).toBe("https://igloo.example/t/green-acres");
    expect(green.estimate).toBe("https://igloo.example/t/green-acres/estimate");
    expect(green.bookVisit()).toBe("https://igloo.example/t/green-acres/book-visit");
    expect(green.bookVisit("est 1")).toBe("https://igloo.example/t/green-acres/book-visit?estimate=est%201");
    expect(green.manageVisit("a/b?c")).toBe("https://igloo.example/t/green-acres/visit/a%2Fb%3Fc");
    expect(green.quote("tok")).toBe("https://igloo.example/t/green-acres/quote/tok");
    expect(green.invoice("tok")).toBe("https://igloo.example/t/green-acres/invoice/tok");
    expect(green.app("/app/schedule")).toBe("https://igloo.example/app/switch/green-acres?next=%2Fapp%2Fschedule");
    await expect((links.companyLinks as (id: string) => Promise<Links>)("nobody")).rejects.toThrow(/no company nobody/);
  });

  it("lets the switch route open only a page of the company area or the dashboard", async () => {
    const p = await plan(COMPANY_FULL);
    const { safeSwitchNext } = loadEmitted(file(p, "src", "server", "company-links.ts"), {
      "@/env": { env: {} },
      "./tenancy": { tenancy: {} },
    }) as { safeSwitchNext: (value: string | null) => string };
    expect(safeSwitchNext("/app/schedule")).toBe("/app/schedule");
    expect(safeSwitchNext("/app/estimates/e1?tab=lines")).toBe("/app/estimates/e1?tab=lines");
    expect(safeSwitchNext("/dashboard")).toBe("/dashboard");
    // Tenancy 2b-1 (13.5): an alert about the team opens the team page, and
    // the company's settings, through the switch route too.
    expect(safeSwitchNext("/settings/team")).toBe("/settings/team");
    expect(safeSwitchNext("/settings/company")).toBe("/settings/company");
    for (const hostile of [
      null,
      "",
      "https://evil.example/app/x",
      "//evil.example/app/x",
      "/admin",
      "/app/../admin",
      "/app\\..\\admin",
      "/app/x\nSet-Cookie: a=b",
      "/app/switch/other?next=/app/x",
      "/settings/billing",
      "/settings/team/../../admin",
    ]) {
      expect(safeSwitchNext(hostile), String(hostile)).toBe("/dashboard");
    }
    // And the route itself: sign-in first, membership decides, then `next`.
    const route = code(file(p, "app", "(site)", "app", "switch", "[slug]", "route.ts"));
    expect(route).toContain("safeSwitchNext(url.searchParams.get(\"next\"))");
    expect(route.indexOf("if (!principal) redirect(")).toBeLessThan(route.indexOf("tenancy.setActiveCompany("));
    expect(route).toContain('error.code === "not_found"');
    expect(route).toContain("tenancy.resolvePublicCompany(slug)");
  });

  it("sets each company up once per feature, lazily too, and only a real company", async () => {
    for (const [feature, overrides] of COMPANY_EACH_ALONE) {
      const setup = code(file(await plan(overrides), "src", "server", "company-setup.ts"));
      // comms adds no setup of its own (review T2A-BO-08): its starter
      // templates are sent by nothing here; every feature adds its own emails.
      const fn = { scheduling: "setupSchedulingFor", estimator: "setupEstimatorFor", invoicing: "setupInvoicingFor", comms: null }[feature];
      if (fn) expect(setup, feature).toContain(`{ name: "${feature}", run: (tenantId) => ${fn}(tenantId) }`);
      for (const other of ["setupSchedulingFor", "setupEstimatorFor", "setupInvoicingFor", "setupCommsFor"].filter((f) => f !== fn)) {
        expect(setup, `${feature} alone`).not.toContain(other);
      }
      expect(setup.includes("syncSchedulingCompany"), feature).toBe(feature === "scheduling");
    }
    const setup = code(file(await plan(COMPANY_FULL), "src", "server", "company-setup.ts"));
    expect(setup).toContain('if (!profile || profile.kind !== "org") return false;');
    expect(setup).toContain('if (event.type === "company.created") await ensureCompanySetup(event.tenantId);');
    expect(setup).toContain('event.changed.includes("timeZone")');
    // The service hands its events to it through a DYNAMIC import (the cycle).
    const service = code(file(await plan(COMPANY_FULL), "src", "server", "tenancy.ts"));
    expect(service).toContain('onEvent: (event) => import("./company-setup").then((m) => m.onCompanyEvent(event)),');
    expect(service).toContain("roles: TENANT_ROLES,");
    expect(service).not.toMatch(/import .* from "\.\/company-setup"/);
    const single = code(file(await plan(SINGLE_FULL), "src", "server", "tenancy.ts"));
    expect(single).not.toContain("onEvent:");
    expect(single).not.toContain("roles:");
  });

  it("renders a public company page through the gate: not found, old address redirected, suspended said plainly", async () => {
    const gate = code(file(await plan(COMPANY_FULL), "src", "components", "PublicCompanyGate.tsx"));
    // One lookup per render, shared by the page and its title (React's cache).
    expect(gate).toContain("const findPublicCompany = cache((slug: string) => tenancy.resolvePublicCompany(slug));");
    expect(gate).toContain("await findPublicCompany(props.slug)");
    expect(gate).toContain("if (!found) notFound();");
    expect(gate).toContain("permanentRedirect(");
    expect(gate).toContain("open ? props.children(company) : <CompanyUnavailable company={company} />");
    // Shut when suspended (the status) — the plan's standing joins it where plans are sold (website-2b4a.test.ts).
    expect(gate).toContain('if (!found || found.status !== "active") return false;');
    expect(gate).toContain("<CompanyBrandBar company={company} />");
    // The company's home lists the public pages this project has, and nothing else.
    const home = code(file(await plan(COMPANY_FULL), "app", "(company)", "t", "[slug]", "page.tsx"));
    expect(home).toContain("PUBLIC_COMPANY_PAGES.map(");
    const constants = file(await plan(COMPANY_FULL), "src", "tenancy.ts");
    expect(constants).toContain('{ path: "/estimate", label: "Get an instant estimate" },');
    expect(constants).toContain('{ path: "/book-visit", label: "Book a visit" },');
    const invoicingOnly = file(await plan(COMPANY_EACH_ALONE[2]![1]), "src", "tenancy.ts");
    expect(invoicingOnly).toContain("export const PUBLIC_COMPANY_PAGES: readonly { readonly path: string; readonly label: string }[] = [];");
    expect(file(await plan(SINGLE_FULL), "src", "tenancy.ts")).not.toContain("PUBLIC_COMPANY_PAGES");
  });
});

describe("the feature glue, companies variants (11.5)", () => {
  it("scheduling: the company seams, the company profile, the company's own people, no crew staff role", async () => {
    const glue = code(file(await plan(COMPANY_FULL), "src", "server", "scheduling.ts"));
    for (const option of [
      "resolveTenant: companyRoutes.resolveTenant",
      "authorize: companyAuthorizer(overrides)",
      "company: schedulingCompany",
      "companySettingsHref: COMPANY_DETAILS_HREF",
      "delivery: (tenantId) => schedulingDelivery(tenantId)",
      "(await tenancy.listMemberPeople(tenantId))",
      "resolveTenant: resolvePublicTenant",
      "admit: admitPublic",
      "manageUrl: async (token, tenantId) => (await companyLinks(tenantId)).manageVisit(token)",
      "rateLimit: schedulingRateLimit",
    ]) {
      expect(glue, option).toContain(option);
    }
    expect(glue).not.toContain("onCrewMemberChange");
    expect(glue).toContain("key: `scheduling:${tenantId}:${bucket}:${caller}`");
    // A company's first settings: its own zone and name, and only when it never saved any.
    expect(glue).toContain("firstSchedulingSettings({ timeZone: profile.timeZone ?? env.SCHEDULING_TIME_ZONE, businessName: profile.name })");
    expect(glue).toContain("if (!settings.saved) {");
    // No made-up crew taking a real company's customers.
    expect(glue).not.toContain("FIRST_CREW");
    expect(glue).toContain("await resolveSchedulingSettings(db, tenantId, {");
  });

  it("scheduling emails: the company's name and zone, the company's links, the company's inbox — never the platform owner", async () => {
    const notify = code(file(await plan(COMPANY_FULL), "src", "server", "scheduling-notify.ts"));
    expect(notify).toContain("company: (tenantId) => tenancy.companyProfile(tenantId)");
    expect(notify).toContain("bookUrl: async (tenantId) => (await companyLinks(tenantId)).bookVisit()");
    expect(notify).toContain('adminUrl: async (tenantId) => (await companyLinks(tenantId)).app("/app/schedule")');
    expect(notify).toContain("staffEmails: async (tenantId) => (await tenancy.companyProfile(tenantId))?.inbox ?? []");
    expect(notify).toContain("await schedulingComms.ensureTemplates(tenantId)");
    expect(notify).toContain("eq(commsMessages.tenantId, tenantId)");
    expect(notify).not.toContain("BOOTSTRAP_ADMIN_EMAIL");
    const noComms = code(file(await plan({ ...COMPANY_EACH_ALONE[0]![1] }), "src", "server", "scheduling-notify.ts"));
    expect(noComms).toContain("const LISTENERS: readonly SchedulingEventListener[] = [];");
    expect(noComms).toContain("export async function ensureSchedulingEmailTemplates(_tenantId: string): Promise<void> {}");
  });

  it("the estimator: the company seams, the AI ceiling on all three handlers, links via the company", async () => {
    const glue = code(file(await plan(COMPANY_FULL), "src", "server", "estimator.ts"));
    expect(glue.match(/aiBudgetCeilingCents: ESTIMATOR_AI_CEILING_CENTS/g)).toHaveLength(3);
    // Billing 0.3: both customer paths admit through the plan's monthly estimates too.
    expect(glue.match(/admit: admitEstimateRequest/g)).toHaveLength(2);
    expect(glue).toContain("if (!admitted.open || !isNewEstimateRequest(req)) return admitted;");
    expect(glue).toContain("quoteUrl: async (token, tenantId) => (await companyLinks(tenantId)).quote(token)");
    expect(glue).toContain("key: `estimator:${context.tenantId}:${bucket}:${caller}`");
    const config = await readFile(join(OVERLAYS_DIR, "estimator", "src", "server", "estimator-config.ts"), "utf8");
    expect(config).toContain("export const ESTIMATOR_AI_CEILING_CENTS = 100;");
    // The single-business estimator passes no ceiling (its owner IS the platform).
    expect(code(file(await plan(SINGLE_FULL), "src", "server", "estimator.ts"))).not.toContain("aiBudgetCeilingCents");
  });

  it("estimate emails and services: every tenant is the argument, every link the company's", async () => {
    const p = await plan(COMPANY_FULL);
    const notify = code(file(p, "src", "server", "estimator-notify.ts"));
    expect(notify).toContain("quoteUrl: async (token, tenantId) => (await companyLinks(tenantId)).quote(token)");
    expect(notify).toContain("(await companyLinks(tenantId)).app(`/app/estimates/${encodeURIComponent(estimateId)}`)");
    expect(notify).toContain("bookUrl: async (estimate, tenantId) => (await companyLinks(tenantId)).bookVisit(estimate.id)");
    expect(notify).toContain("staffEmails: async (tenantId) => (await tenancy.companyProfile(tenantId))?.inbox ?? []");
    const services = code(file(p, "src", "server", "estimator-services.ts"));
    expect(services).toContain("async function visitsForEstimate(estimateId: string, tenantId: string)");
    expect(services).toContain("eq(schedulingBookings.tenantId, tenantId)");
    expect(services).toContain("async function invoiceForEstimate(estimateId: string, tenantId: string)");
    expect(services).toContain("{ tenantId, ...invoiceInputFromEstimate(found.estimate, found.items), dueDate }");
    expect(services).toContain("url: `/app/invoices/${encodeURIComponent(invoice.id)}`");
    expect(services).toContain("bookVisitUrl: async (estimate, tenantId) => (await companyLinks(tenantId)).bookVisit(estimate.id)");
    expect(services).not.toContain("invoicePreviewPath");
  });

  it("invoicing: the company's business and details on every invoice, the email through comms, token reads inside the company", async () => {
    const glue = code(file(await plan(COMPANY_FULL), "src", "server", "invoicing.ts"));
    expect(glue).toContain("...readInvoicingDetails(profile.settings.invoicing)");
    expect(glue).toContain("sendInvoiceEmail: (input) => invoicingComms.sendInvoice(input)");
    expect(glue).toContain('detailsHref: "/settings/company#invoicing"');
    expect(glue).toContain("invoiceUrl: async (token, tenantId) => (await companyLinks(tenantId)).invoice(token)");
    expect(glue).toContain("resolveTenant: resolvePublicTenant");
    expect(glue).toContain("admit: admitPublic");
    // Without comms: no email, and "Send" says to copy the link.
    const noComms = code(file(await plan(COMPANY_EACH_ALONE[2]![1]), "src", "server", "invoicing.ts"));
    expect(noComms).not.toContain("sendInvoiceEmail");
    expect(noComms).not.toContain("@adminigloo/invoicing/comms");
    expect(noComms).toContain("This site was set up without customer emails");
  });

  it("an invoice from a quote is due at the end of the company's own day, its 'due after' days on", async () => {
    const glue = file(await plan(COMPANY_FULL), "src", "server", "invoicing.ts");
    const { dueDateFor } = loadEmitted(glue) as {
      dueDateFor: (b: { dueDays: number; timeZone: string | null }, now?: Date) => Date;
    };
    // 10:00 on 3 March in Denver (MST, UTC-7), 14 days: the end of 17 March there.
    expect(dueDateFor({ dueDays: 14, timeZone: "America/Denver" }, new Date("2031-03-03T17:00:00Z")).toISOString()).toBe(
      "2031-03-18T05:59:59.999Z",
    );
    // Late evening in Denver is still "today" there, not tomorrow (UTC already is).
    expect(dueDateFor({ dueDays: 0, timeZone: "America/Denver" }, new Date("2031-03-04T05:30:00Z")).toISOString()).toBe(
      "2031-03-04T06:59:59.999Z",
    );
    // Across the spring-forward change (9 March 2031): MDT, UTC-6.
    expect(dueDateFor({ dueDays: 7, timeZone: "America/Denver" }, new Date("2031-03-05T17:00:00Z")).toISOString()).toBe(
      "2031-03-13T05:59:59.999Z",
    );
    // No zone set yet: UTC.
    expect(dueDateFor({ dueDays: 1, timeZone: null }, new Date("2031-03-03T17:00:00Z")).toISOString()).toBe(
      "2031-03-04T23:59:59.999Z",
    );
  });

  it("messages: the console on the company seam, its templates through the company's setup", async () => {
    const glue = code(file(await plan(COMPANY_FULL), "src", "server", "comms.ts"));
    expect(glue).toContain("createCommsAdminHandlers({");
    expect(glue).toContain("authorize: companyAuthorizer(overrides)");
    expect(glue).toContain("ensureTemplates: (tenantId) => ensureCompanySetup(tenantId)");
    expect(glue).toContain("beforeSend: commsBeforeSend");
    expect(glue).toContain("afterRun: afterCommsRun");
    // Not comms' starter templates (review T2A-BO-08): nothing sends them.
    expect(glue).not.toContain("seedDefaultTemplates");
    expect(glue).not.toContain("setupCommsFor");
  });

  it("each company's email goes out as the company: its identity on the senders, a capture seam for the proof", async () => {
    const senders = code(file(await plan(COMPANY_FULL), "src", "server", "comms-senders.ts"));
    expect(senders).toContain("return profile ? { name: profile.name, replyTo: profile.replyTo } : null;");
    expect(senders).toContain("identity: companyIdentity,");
    expect(senders).toContain("fromName: message.fromName,");
    expect(senders).toContain("replyTo: message.replyTo,");
    expect(senders).toContain("export function buildCommsSenders(transport?: EmailTransport): CommsSenders");
    expect(senders).not.toContain("COMMS_TENANT");
    // Without email the log still records who it would have gone out as.
    const noEmail = code(file(await plan({ ...COMPANY_FULL, includeEmail: false }), "src", "server", "comms-senders.ts"));
    expect(noEmail).toContain("export const commsSenders: CommsSenders = { identity: companyIdentity };");
  });

  it("the comms hooks scrub invoice links after a drain, and add the invoice email with the others", async () => {
    const hooks = code(file(await plan(COMPANY_FULL), "src", "server", "comms-hooks.ts"));
    expect(hooks).toContain("const PRODUCERS: readonly QueueProducer[] = [schedulingComms, estimatorComms, invoicingProducer];");
    expect(hooks).toContain("redactSent: () => invoicingComms.redactSent(),");
    const commsOnly = code(file(await plan(COMPANY_EACH_ALONE[3]![1]), "src", "server", "comms-hooks.ts"));
    expect(commsOnly).toContain("const PRODUCERS: readonly QueueProducer[] = [];");
  });
});

describe("single-business mode (11.6, 11.9)", () => {
  it("keeps today's paths and the staff ladder for scheduling and the estimator", async () => {
    const p = await plan(SINGLE_FULL);
    for (const path of [
      ["app", "(site)", "book-visit", "page.tsx"],
      ["app", "(site)", "estimate", "page.tsx"],
      ["app", "api", "schedule", "[...path]", "route.ts"],
      ["app", "api", "admin", "schedule", "[...path]", "route.ts"],
      ["app", "api", "estimator", "[...path]", "route.ts"],
      ["app", "api", "admin", "estimator", "[...path]", "route.ts"],
      ["app", "admin", "schedule", "page.tsx"],
      ["app", "admin", "estimates", "page.tsx"],
    ]) {
      expect(has(p, ...path), path.join("/")).toBe(true);
    }
    expect(pathsOf(p).some((path) => path.startsWith("app/(site)/app/") || path.startsWith("app/api/app/") || path.startsWith("app/api/t/"))).toBe(false);
  });

  it("moves invoicing and messages onto the package handlers and widgets, on a staff key per job", async () => {
    const p = await plan(SINGLE_FULL);
    expect(code(file(p, "app", "admin", "invoices", "page.tsx"))).toMatch(
      /<InvoicesLedger\s+baseUrl="\/api\/admin\/invoices"\s+invoiceHref="\/admin\/invoices\/\{id\}"\s+canManage=\{can\?\.can\("staff\.invoices\.manage"\) \?\? false\}\s*\/>/,
    );
    expect(code(file(p, "app", "admin", "invoices", "[id]", "page.tsx"))).toContain('<InvoiceEditor baseUrl="/api/admin/invoices" invoiceId={id} backHref="/admin/invoices" />');
    expect(code(file(p, "app", "(site)", "invoice", "[token]", "page.tsx"))).toContain('<InvoiceView baseUrl="/api/invoices" token={token} preview={preview === "1"} returned={paid === "1"} />');
    expect(code(file(p, "app", "admin", "comms", "page.tsx"))).toContain('<MessagesConsole baseUrl="/api/admin/comms" canManage={can?.can("staff.comms.manage") ?? false} />');
    expect(code(file(p, "app", "api", "admin", "invoices", "[...path]", "route.ts"))).toContain("buildInvoicingAdminHandlers()");
    expect(code(file(p, "app", "api", "invoices", "[...path]", "route.ts"))).toContain("buildInvoicingPublicHandlers()");
    expect(code(file(p, "app", "api", "admin", "comms", "[...path]", "route.ts"))).toContain("buildCommsAdminHandlers()");
    const invoicing = code(file(p, "src", "server", "invoicing.ts"));
    expect(invoicing).toContain('authorize: authorizeStaffFor(INVOICING_STAFF_KEYS, "Sign in to see invoices.")');
    expect(invoicing).toContain('"invoices.view": "staff.invoices.view"');
    expect(invoicing).toContain('"invoices.payments.reverse": "staff.invoices.manage"');
    expect(invoicing).toContain("name: SITE_NAME,");
    expect(invoicing).toContain('timeZone: env.SCHEDULING_TIME_ZONE ?? env.ESTIMATOR_TIME_ZONE ?? "America/Denver",');
    expect(invoicing).toContain("contactEmail: env.EMAIL_REPLY_TO ?? null,");
    const comms = code(file(p, "src", "server", "comms.ts"));
    expect(comms).toContain('authorize: authorizeStaffFor(COMMS_STAFF_KEYS, "Sign in to see messages.")');
    expect(comms).toContain("tenantId: COMMS_TENANT,");
    const access = code(file(p, "src", "server", "staff-access.ts"));
    expect(access).toContain("if (!can || !can.can(keys[permission])) return false;");
    expect(access).toContain("status: 401");
    // The ladder file exists only where invoicing or messages climb it.
    expect(has(await plan({ ...SINGLE_FULL, includeInvoicing: false, includeComms: false }), "src", "server", "staff-access.ts")).toBe(false);
    expect(has(await plan(COMPANY_FULL), "src", "server", "staff-access.ts")).toBe(false);
  });

  it("an estimate's invoice opens on the ledger's own page, which needs no token", async () => {
    const services = code(file(await plan(SINGLE_FULL), "src", "server", "estimator-services.ts"));
    expect(services).toContain("url: `/admin/invoices/${encodeURIComponent(row.id)}`");
    expect(services).not.toContain("@/invoice-link");
    expect(services).toContain('import { SCHEDULING_TENANT } from "@/server/scheduling-staff";');
  });
});

describe("the retired routers (D3)", () => {
  it.each([["companies", COMPANY_FULL] as const, ["single", SINGLE_FULL] as const])("%s: no invoicing or comms router, call or scope row", async (_label, overrides) => {
    const p = await plan(overrides);
    expect(has(p, "src", "server", "routers", "invoicing.ts")).toBe(false);
    expect(has(p, "src", "server", "routers", "comms.ts")).toBe(false);
    expect(has(p, "src", "invoice-link.ts")).toBe(false);
    for (const path of pathsOf(p)) {
      const source = code(contentsAt(p, path));
      expect(source.includes("api.invoicing"), path).toBe(false);
      expect(source.includes("api.comms"), path).toBe(false);
    }
    const app = code(file(p, "src", "server", "routers", "_app.ts"));
    expect(app).not.toContain("invoicingRouter");
    expect(app).not.toContain("commsRouter");
    expect(ROUTER_SCOPES.map((row) => row.key).filter((key) => key.startsWith("invoicing") || key === "comms")).toEqual([]);
    expect(file(p, "src", "server", "__tests__", "procedure-scopes.test.ts")).not.toMatch(/"(invoicing|comms)/);
  });
});

/** The permission keys a package declares, read from its own fragment. */
async function packagePermissionKeys(pkg: string): Promise<string[]> {
  const source = await readFile(join(PACKAGES_DIR, pkg, "src", "permissions.ts"), "utf8");
  return [...source.matchAll(/^\s{2}"([a-z][a-z.]+)":\s*\{/gm)].map((m) => m[1]!);
}

/** The permissions a package's route tables ask for, when the package publishes them; else its fragment's keys. */
async function routePermissions(pkg: string): Promise<string[]> {
  const routes = join(PACKAGES_DIR, pkg, "src", "routes.ts");
  if (existsSync(routes)) {
    const found = [...(await readFile(routes, "utf8")).matchAll(/permission:\s*"([a-z][a-z.]+)"/g)].map((m) => m[1]!);
    if (found.length > 0) return [...new Set(found)];
  }
  return packagePermissionKeys(pkg);
}

const FEATURE_PACKAGES = [
  ["scheduling", "schedulingPermissions", "includeScheduling"],
  ["estimator", "estimatorPermissions", "includeEstimator"],
  ["invoicing", "invoicingPermissions", "includeInvoicing"],
  ["comms", "commsPermissions", "includeComms"],
] as const;

describe("catalogs, roles and the seed (11.7)", () => {
  it("companies: every feature's keys are the company's, every route's permission is declared, and no staff key is left", async () => {
    const catalog = renderPermissionsCatalog(answers(COMPANY_FULL));
    const tenantSpread = /definePermissions\(\s*"tenant",\s*\{([^}]*)\}/.exec(catalog)?.[1] ?? "";
    for (const [pkg, binding] of FEATURE_PACKAGES) {
      expect(tenantSpread, binding).toContain(`...${binding}`);
      expect(catalog).toContain(`import { ${binding} } from "@adminigloo/${pkg}";`);
      const declared = new Set(await packagePermissionKeys(pkg));
      for (const permission of await routePermissions(pkg)) {
        expect(declared.has(permission), `${pkg} routes ask for ${permission}, which ${binding} doesn't declare`).toBe(true);
      }
    }
    for (const prefix of ["staff.schedule.", "staff.estimates.", "staff.invoices.", "staff.comms."]) {
      expect(catalog, prefix).not.toContain(`"${prefix}`);
    }
  });

  it("single: every feature permission maps to a staff key the staff catalog declares", async () => {
    const p = await plan(SINGLE_FULL);
    const catalog = file(p, "src", "permissions", "catalog.ts");
    const tenantSpread = /definePermissions\(\s*"tenant",\s*\{([^}]*)\}/.exec(catalog)?.[1] ?? "";
    const maps: Record<string, string> = {
      scheduling: file(p, "src", "server", "scheduling-staff.ts"),
      estimator: file(p, "src", "server", "estimator-staff.ts"),
      invoicing: file(p, "src", "server", "invoicing.ts"),
      comms: file(p, "src", "server", "comms.ts"),
    };
    for (const [pkg, binding] of FEATURE_PACKAGES) {
      expect(tenantSpread, binding).not.toContain(binding);
      for (const permission of await routePermissions(pkg)) {
        const mapped = new RegExp(`"${permission.replace(/\./g, "\\.")}": "(staff\\.[a-z.]+)"`).exec(maps[pkg]!)?.[1];
        expect(mapped, `${pkg}: ${permission} has no staff key`).toBeDefined();
        expect(catalog, `${mapped} is not declared in the staff catalog`).toContain(`"${mapped}": {`);
      }
    }
    for (const key of ["staff.invoices.view", "staff.invoices.manage", "staff.comms.view", "staff.comms.manage"]) {
      expect(catalog).toContain(`"${key}": {`);
    }
    expect(catalog).not.toMatch(/"(invoices|comms)\.[a-z.]+": \{/);
  });

  it("composes Crew into the company roles exactly when scheduling runs per company", async () => {
    const roles = async (o: Partial<Answers>) => code(file(await plan(o), "src", "permissions", "roles.ts"));
    expect(await roles(COMPANY_FULL)).toContain("export const TENANT_ROLES = defineTenantRoles([SCHEDULING_CREW_ROLE]);");
    expect(await roles(COMPANY_EACH_ALONE[1]![1])).toContain("export const TENANT_ROLES = defineTenantRoles([]);");
    expect(await roles(SINGLE_FULL)).toContain("export const TENANT_ROLES = defineTenantRoles([]);");
    expect(await roles(SINGLE_FULL)).not.toContain("@adminigloo/scheduling");
    // The seed installs exactly these, in every project.
    const seed = code(file(await plan(COMPANY_FULL), "src", "permissions", "seed.ts"));
    expect(seed).toContain("tenant: { catalog: tenantCatalog, templates: TENANT_ROLES.templates }");
    expect(seed).toContain('import { TENANT_ROLES } from "./roles";');
    expect(seed).not.toContain("TENANT_ROLE_TEMPLATES");
    // And the project's own catalog test checks `defaultFor` against the same
    // set — against tenancy's four alone, scheduling's `schedule.route ->
    // "crew"` read as a template nobody seeds.
    const catalogTest = code(file(await plan(COMPANY_FULL), "src", "permissions", "__tests__", "catalog.test.ts"));
    // Tenancy 2b-1: it also reads the roles another package adds that this
    // project lacks (ROLES_NOT_IN_THIS_PROJECT), from the same module.
    expect(catalogTest).toContain('import { ROLES_NOT_IN_THIS_PROJECT, TENANT_ROLES } from "@/permissions/roles";');
    expect(catalogTest).toContain("const TENANT_TEMPLATE_KEYS = TENANT_ROLES.templates.map((template) => template.key);");
    // The single business keeps scheduling's crew STAFF role and its audit vocabulary.
    expect(code(file(await plan(SINGLE_FULL), "src", "server", "audit.ts"))).toContain('from "./scheduling-staff"');
    expect(code(file(await plan(COMPANY_FULL), "src", "server", "audit.ts"))).not.toContain("schedulingAuditedActions");
  });
});

describe("the settings registry and the checklist (11.10)", () => {
  const CHECKLIST_LINES = {
    scheduling:
      '...schedulingChecklistItems({ booking: "/app/schedule/settings#booking", crews: "/app/schedule/settings#crews" }),',
    estimator:
      '...estimatorChecklistItems({ priceBook: "/app/price-book", settings: "/app/estimates/settings", embed: "/app/estimates/settings#embed" }),',
    invoicing: '...invoicingChecklistItems({ details: "/settings/company#invoicing" }),',
  } as const;

  it.each([["every feature", COMPANY_FULL] as const, ...COMPANY_EACH_ALONE])("%s", async (_label, overrides) => {
    const p = await plan(overrides);
    const checklist = code(file(p, "src", "server", "setup-checklist.ts"));
    const settings = code(file(p, "src", "server", "tenant-settings.ts"));
    const a = answers(overrides);
    expect(checklist).toContain('...tenancyChecklistItems({ companySettings: "/settings/company", team: "/settings/team" }),');
    expect(checklist.includes(CHECKLIST_LINES.scheduling)).toBe(a.includeScheduling);
    expect(checklist.includes(CHECKLIST_LINES.estimator)).toBe(a.includeEstimator);
    expect(checklist.includes(CHECKLIST_LINES.invoicing)).toBe(a.includeInvoicing);
    expect(settings.includes("defineSettingsFragment(invoicingSettingsFragment)")).toBe(a.includeInvoicing);
    // Every item links to a page this project has.
    const pages = new Set(pathsOf(p).filter((path) => path.endsWith("page.tsx")).map((path) => `/${path.replace(/^app\/\(site\)\//, "").replace(/\/?page\.tsx$/, "")}`));
    for (const m of checklist.matchAll(/"(\/(?:app|settings)\/[^"#]*)/g)) {
      expect(pages.has(m[1]!), `${m[1]} is a checklist link with no page`).toBe(true);
    }
  });

  it("gives a single business no checklist and no invoicing section", async () => {
    const p = await plan(SINGLE_FULL);
    expect(code(file(p, "src", "server", "setup-checklist.ts"))).toContain("defineSetupChecklist([])");
    expect(code(file(p, "src", "server", "tenant-settings.ts"))).not.toContain("invoicing");
  });
});

describe("the header and the company links (11.11)", () => {
  it("lists the company area on the company's own keys, per feature set", async () => {
    const expected = (a: Answers) => [
      '{ href: "/dashboard", label: "Dashboard" }',
      ...(a.includeScheduling
        ? [
            '{ href: "/app/schedule", label: "Schedule", permission: "schedule.view" }',
            '{ href: "/app/schedule/today", label: "Today\'s route", permission: "schedule.route" }',
          ]
        : []),
      ...(a.includeEstimator ? ['{ href: "/app/estimates", label: "Estimates", permission: "estimator.view" }'] : []),
      ...(a.includeInvoicing
        ? [
            '{ href: "/app/invoices", label: "Invoices", permission: "invoices.view" }',
            // Getting paid, part 1: the company's own Stripe account.
            '{ href: "/app/payments", label: "Card payments", permission: "payments.view" }',
          ]
        : []),
      ...(a.includeComms ? ['{ href: "/app/messages", label: "Messages", permission: "comms.view" }'] : []),
      // Tenancy 2b-1: each company's files, with storage.
      ...(a.includeStorage ? ['{ href: "/app/files", label: "Files", permission: "files.view" }'] : []),
      '{ href: "/settings/team", label: "Team", permission: "members.view" }',
      '{ href: "/settings/company", label: "Settings", permission: "tenant.view" }',
      '{ href: "/admin", label: "Admin", audience: "staff" }',
    ];
    for (const overrides of [COMPANY_FULL, ...COMPANY_EACH_ALONE.map(([, o]) => o)]) {
      const nav = code(file(await plan(overrides), "src", "nav.ts"));
      const appLinks = nav.slice(nav.indexOf("export const APP_LINKS"), nav.indexOf("export const FOOTER_LINKS"));
      const entries = [...appLinks.matchAll(/\{ href: [^}]+\}/g)].map((m) => m[0]);
      expect(entries).toEqual(expected(answers(overrides)));
    }
  });

  it("names only keys a company role can hold", async () => {
    const nav = code(file(await plan(COMPANY_FULL), "src", "nav.ts"));
    const declared = new Set([
      ...(await packagePermissionKeys("tenancy")),
      ...(await packagePermissionKeys("scheduling")),
      ...(await packagePermissionKeys("estimator")),
      ...(await packagePermissionKeys("invoicing")),
      // Getting paid, part 1: the payments screen's keys.
      ...(await packagePermissionKeys("stripe")),
      ...(await packagePermissionKeys("comms")),
      // Tenancy 2b-1: files (and alerts) are company keys too.
      ...(await packagePermissionKeys("storage")),
      ...(await packagePermissionKeys("notifications")),
    ]);
    for (const m of nav.matchAll(/permission: "([^"]+)"/g)) {
      expect(declared.has(m[1]!), `${m[1]} is not a company key`).toBe(true);
    }
  });

  it("filters the header and the dashboard by the person's role in their active company", async () => {
    const p = await plan(COMPANY_FULL);
    const header = code(file(p, "src", "components", "AuthHeader.tsx"));
    expect(header).toContain("const session = await tenancy.resolveSession({ userId: principal.userId });");
    expect(header).toContain("await loadTenantPermissions({ principal, tenantId: session.company.id })");
    expect(header).toContain("<CompanySwitcherSlot principal={viewer.principal} session={viewer.session} />");
    expect(header).toContain("(link.permission === undefined || viewer.can.includes(link.permission))");
    const slot = code(file(p, "src", "components", "CompanySwitcherSlot.tsx"));
    expect(slot).toContain("sessionToWire(resolved ?? (await tenancy.resolveSession({ userId: principal.userId })))");
    const dashboard = code(file(p, "app", "(site)", "dashboard", "page.tsx"));
    expect(dashboard).toContain('<CompanyGate path="/dashboard">');
    expect(dashboard).not.toContain('permission="tenant.view"');
    expect(dashboard).toContain("(link.permission === undefined || can.includes(link.permission))");
  });

  it("takes the platform's own booking and estimate pages out of a companies project's public face", async () => {
    const companies = await plan(COMPANY_FULL);
    const single = await plan(SINGLE_FULL);
    for (const [label, p, present] of [["companies", companies, false], ["single", single, true]] as const) {
      const site = code(file(p, "src", "nav.ts"));
      const siteLinks = site.slice(site.indexOf("export const SITE_LINKS"), site.indexOf("export const APP_LINKS"));
      expect(siteLinks.includes('"/book-visit"'), label).toBe(present);
      expect(siteLinks.includes('"/estimate"'), label).toBe(present);
      expect(code(file(p, "app", "sitemap.ts")).includes('"/book-visit"'), label).toBe(present);
      expect(code(file(p, "app", "llms.txt", "route.ts")).includes("/book-visit"), label).toBe(present);
      const robots = code(file(p, "app", "robots.ts"));
      expect(robots.includes('"/quote/"'), label).toBe(present);
      expect(robots.includes('"/visit/"'), label).toBe(present);
      expect(robots.includes('"/invoice/"'), label).toBe(present);
      expect(robots.includes('"/app/"'), label).toBe(!present);
      expect(robots.includes('"/t/"'), label).toBe(!present);
      expect(code(file(p, "app", "sitemap.ts")), label).not.toContain('"/t/');
    }
  });

  it("gives the operator console no field-service screens in a companies project", async () => {
    const companies = code(file(await plan(COMPANY_FULL), "src", "components", "admin", "AdminNav.tsx"));
    for (const href of ["/admin/schedule", "/admin/estimates", "/admin/estimator", "/admin/invoices", "/admin/comms"]) {
      expect(companies, href).not.toContain(`href: "${href}"`);
    }
    const single = code(file(await plan({ ...SINGLE_FULL, adminShell: "full" }), "src", "components", "admin", "AdminNav.tsx"));
    expect(single).toContain('{ href: "/admin/invoices", label: "Invoices", permission: "staff.invoices.view" }');
    expect(single).toContain('{ href: "/admin/comms", label: "Messages", permission: "staff.comms.view" }');
    expect(single).not.toContain('href: "/admin/invoices", label: "Invoices", permission: "staff.dashboard.view"');
  });
});

describe("the crons (11.12)", () => {
  it("serve every active company in a companies project, and the one business in a single one", async () => {
    const companies = await plan(COMPANY_FULL);
    const scheduling = code(file(companies, "app", "api", "cron", "scheduling", "route.ts"));
    expect(scheduling).toContain("runForEachCompany(");
    expect(scheduling).toContain("await syncSchedulingCompany(tenantId);");
    expect(scheduling).toContain("expirePendingRequests(db, tenantId, { onEvent: onSchedulingEvent, limit: 25 })");
    // Left-out companies are logged and reported (review T2A-BO-13).
    expect(scheduling).toContain('reportDeferred("scheduling", report.deferred);');
    expect(scheduling).toContain("timeBudgetMs: 45_000");
    const estimator = code(file(companies, "app", "api", "cron", "estimator", "route.ts"));
    expect(estimator).toContain("expireQuotes(db, tenantId, { onEvent: onEstimatorEvent, timeBudgetMs: 5_000 })");
    expect(estimator).toContain("timeBudgetMs: 35_000");
    expect(estimator).toContain("purgeOrphanPhotos(db, estimatorPhotoStore, { timeBudgetMs: 15_000 })");
    const comms = code(file(companies, "app", "api", "cron", "comms", "route.ts"));
    expect(comms).toContain("tenantIds: await tenancy.activeCompanyIds(),");
    expect(comms).toMatch(/finally\s*\{\s*await afterCommsRun\(\);\s*\}/);
    for (const cron of [scheduling, estimator, comms]) {
      expect(cron).toContain("if (!secret || provided !== secret)");
      expect(cron).toContain("export const maxDuration = 60;");
    }
    const single = await plan(SINGLE_FULL);
    expect(code(file(single, "app", "api", "cron", "comms", "route.ts"))).not.toContain("tenantIds");
    expect(code(file(single, "app", "api", "cron", "scheduling", "route.ts"))).toContain("resolveSchedulingTenant()");
    // vercel.json: 2a's three crons, and Tenancy 2b-1's files cron with storage.
    const vercel = JSON.parse(file(companies, "vercel.json")) as { crons: Array<{ path: string }> };
    expect(vercel.crons.map((c) => c.path)).toEqual(["/api/cron/comms", "/api/cron/scheduling", "/api/cron/estimator", "/api/cron/files"]);
  });
});

describe("the emitted proofs (section 12)", () => {
  it("drives every installed feature's route tables, per feature, and plants every entity they name", async () => {
    for (const [feature, overrides] of [["every feature", COMPANY_FULL] as const, ...COMPANY_EACH_ALONE]) {
      const p = await plan(overrides);
      const a = answers(overrides);
      const test = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
      const rows = code(file(p, "src", "test", "company-rows.ts"));
      for (const [pkg, , key] of FEATURE_PACKAGES) {
        const on = a[key];
        expect(test.includes(`feature: "${pkg}"`), `${feature}: ${pkg} suite`).toBe(on);
        for (const entity of FEATURE_ENTITIES[pkg]!) {
          const planted = rows.includes(`rows["${entity}"] =`) || rows.includes(`rows.${entity} =`);
          expect(planted, `${feature}: the ${entity} row`).toBe(on);
        }
      }
      // The estimator's embed names its company by a website KEY, not a path:
      // its routes get their own pass, with B's key, whenever it's installed.
      expect(test.includes("await embedded.handle(requestFor(\"/api/estimator/\", route, fx.aRows, { [ESTIMATOR_KEY_HEADER]: fx.bKey }))"), `${feature}: the embed pass`).toBe(
        Boolean(a.includeEstimator),
      );
      expect(test.includes("embed:estimator:"), `${feature}: the embed kinds are counted`).toBe(Boolean(a.includeEstimator));
      expect(rows.includes('rows["embed-key"] = key.key;'), `${feature}: each company's website key`).toBe(Boolean(a.includeEstimator));
      expect(test).toContain("async function expectIsolated(res: Response, label: string, expectation: Expectation)");
      expect(test).toContain('await expect(expectIsolated(leak(200), "a leaking row route", "not-found")).rejects.toThrow();');
      expect(test).toContain("expect(await snapshotOfA()).toBe(before);");
      expect(test).toContain("Plant a ${entity} row for company A in src/test/company-rows.ts");
    }
  });

  it("emits the cron proof where a cron serves companies, and the email proof where email goes out", async () => {
    const full = await plan(COMPANY_FULL);
    expect(file(full, "src", "server", "__tests__", "company-crons.test.ts")).toContain("C is SUSPENDED");
    expect(file(full, "src", "server", "__tests__", "company-email.test.ts")).toContain("buildCommsSenders(capture)");
    expect(has(await plan(COMPANY_EACH_ALONE[2]![1]), "src", "server", "__tests__", "company-crons.test.ts")).toBe(false);
    expect(has(await plan({ ...COMPANY_FULL, includeEmail: false }), "src", "server", "__tests__", "company-email.test.ts")).toBe(false);
    const single = await plan(SINGLE_FULL);
    for (const name of ["feature-isolation.test.ts", "company-crons.test.ts", "company-email.test.ts"]) {
      expect(has(single, "src", "server", "__tests__", name), name).toBe(false);
    }
    // The crons proof breaks ONE company's run at the package function the
    // cron calls, and checks the rest still ran.
    const crons = code(file(full, "src", "server", "__tests__", "company-crons.test.ts"));
    expect(crons).toContain('vi.mock("@adminigloo/scheduling", async (importOriginal) => {');
    expect(crons).toContain("expect(report.failed.map((f) => f.tenantId)).toEqual([fx.A.tenantId]);");
    // The email proof asserts the office notice goes to the company, never to the platform owner.
    const email = code(file(full, "src", "server", "__tests__", "company-email.test.ts"));
    expect(email).toContain("expect(notices.map((n) => n.to)).toEqual([fx.A.contact]);");
    expect(email).toContain("expect(c.replyTo).toBe(fx.C.owner);");
  });

  // Each of these was found by RUNNING the emitted proofs against the 2a
  // packages' sources (a rendered project, PGlite, vitest), not by reading them.
  it("keeps the proofs runnable: hoisted mock values, valid keys and addresses, photos that reach the row check", async () => {
    const full = await plan(COMPANY_FULL);
    // vi.mock factories are hoisted above every import; a plain const they
    // read is still in its temporal dead zone when comms-senders imports.
    const email = code(file(full, "src", "server", "__tests__", "company-email.test.ts"));
    expect(email).toContain("const PLATFORM = vi.hoisted(() => ({");
    expect(email).not.toMatch(/^const PLATFORM_/m);
    // tenancy's request keys are [A-Za-z0-9-]{8,64}; email domains hold no spaces.
    for (const name of ["company-crons.test.ts", "company-email.test.ts"]) {
      const test = code(file(full, "src", "server", "__tests__", name));
      for (const [, id] of test.matchAll(/\("(ext[^"]*)"/g)) expect(id, name).toMatch(/^[A-Za-z0-9-]+$/);
    }
    const crons = code(file(full, "src", "server", "__tests__", "company-crons.test.ts"));
    expect(crons).toContain('const domain = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");');
    expect(crons).not.toContain("label.toLowerCase()}.test");
    // Without file storage the photo routes refuse before reading a row, so
    // the isolation proof keeps photos in memory whenever the estimator runs.
    for (const [feature, overrides] of [["every feature", COMPANY_FULL] as const, ...COMPANY_EACH_ALONE]) {
      const test = code(file(await plan(overrides), "src", "server", "__tests__", "feature-isolation.test.ts"));
      expect(test.includes('vi.mock("@/server/estimator-services"'), feature).toBe(Boolean(answers(overrides).includeEstimator));
    }
  });
});

describe("what the project claims and documents (11.13)", () => {
  it("claims the company capabilities with real evidence, and only in a companies project", async () => {
    const keys = ["companies.feature-area", "companies.public-pages", "companies.feature-isolation-proof", "companies.crons"];
    expect(capabilitiesFor(answers(COMPANY_FULL))).toEqual(expect.arrayContaining(keys));
    const single = await plan(SINGLE_FULL);
    for (const key of keys) {
      expect(capabilitiesFor(answers(SINGLE_FULL)), key).not.toContain(key);
      const row = CAPABILITY_EVIDENCE.find((r) => r.capability === key);
      expect(row, key).toBeDefined();
      expect(row!.provenBy(await plan(COMPANY_FULL)), key).toBe(true);
      expect(row!.provenBy(single), key).toBe(false);
    }
    // Invoicing alone has public pages and no cron; messages alone a cron and no public page.
    expect(capabilitiesFor(answers(COMPANY_EACH_ALONE[2]![1]))).toContain("companies.public-pages");
    expect(capabilitiesFor(answers(COMPANY_EACH_ALONE[2]![1]))).not.toContain("companies.crons");
    expect(capabilitiesFor(answers(COMPANY_EACH_ALONE[3]![1]))).toContain("companies.crons");
    expect(capabilitiesFor(answers(COMPANY_EACH_ALONE[3]![1]))).not.toContain("companies.public-pages");
    // The ledger and the console are claimed in both modes, by their widget pages.
    for (const o of [COMPANY_FULL, SINGLE_FULL]) {
      expect(capabilitiesFor(answers(o))).toEqual(expect.arrayContaining(["invoicing.ledger", "comms.console"]));
    }
  });

  it("installs the two new widgets and the 2b-1 lines of every package", async () => {
    const pkgs = packagesFor(answers(COMPANY_FULL));
    expect(pkgs).toContain("@adminigloo/invoicing-widget");
    expect(pkgs).toContain("@adminigloo/comms-widget");
    const manifest = JSON.parse(file(await plan(COMPANY_FULL), "package.json")) as { dependencies: Record<string, string> };
    for (const [pkg, range] of [
      // Tenancy 2b-1 moved every line it changed (versions.ts says why).
      ["tenancy", "^0.7.0"],
      ["tenancy-widget", "^0.2.2"],
      ["scheduling", "^0.6.0"],
      ["scheduling-widget", "^0.3.0"],
      ["estimator", "^0.5.0"],
      ["estimator-widget", "^0.5.0"],
      ["invoicing", "^0.5.0"],
      ["invoicing-widget", "^0.2.0"],
      ["comms", "^0.4.0"],
      ["comms-widget", "^0.1.1"],
      ["email", "^0.3.0"],
      ["storage", "^0.2.0"],
      ["storage-widget", "^0.1.0"],
    ] as const) {
      expect(versionRangeFor(`@adminigloo/${pkg}`), pkg).toBe(range);
      expect(manifest.dependencies[`@adminigloo/${pkg}`], pkg).toBe(range);
    }
  });

  it("says in the README what each company gets and what isn't included, word for word", async () => {
    const readme = file(await plan(COMPANY_FULL), "README.md");
    // Tenancy 2b-1 delivered or restated four of 2a's items (TENANCY_2A_SUPERSEDED);
    // the rest are still said word for word.
    const stillTrue = TENANCY_2A_NOT_INCLUDED.filter((item) => !TENANCY_2A_SUPERSEDED.has(item));
    expect(stillTrue.length).toBe(TENANCY_2A_NOT_INCLUDED.length - 4);
    for (const item of [...stillTrue, ...TENANCY_1_NOT_INCLUDED]) expect(readme).toContain(item);
    for (const item of TENANCY_2A_SUPERSEDED) expect(readme).not.toContain(item);
    expect(readme).toContain("### What each company runs itself");
    expect(readme).toContain("update scheduling_bookings set tenant_id = '<company id>' where tenant_id = 'primary';");
    expect(readme).toContain("$1.00 a day per company");
    const single = file(await plan(SINGLE_FULL), "README.md");
    expect(single).not.toContain("Moving a pre-2a project's feature rows");
    expect(single).not.toContain(TENANCY_2A_NOT_INCLUDED[0]!);
    expect(single).toContain(TENANCY_2A_NOT_INCLUDED[9]!);
  });

  it("lists the same Not included items in the generator's own README (15.2), so a buyer reads them before generating", async () => {
    // The package README wraps its bullets at 80 columns; the emitted list is
    // one line per item. Compare with every run of whitespace collapsed.
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const own = flat(await readFile(join(__dirname, "..", "..", "README.md"), "utf8"));
    expect(own).toContain("### Not included (Tenancy 2a)");
    for (const item of TENANCY_2A_NOT_INCLUDED.filter((entry) => !TENANCY_2A_SUPERSEDED.has(entry))) {
      expect(own, item).toContain(flat(item));
    }
  });

  it("tells the operator in DEPLOYMENT.md that the crons serve every company and each company sends as itself", async () => {
    const companies = file(await plan(COMPANY_FULL), "DEPLOYMENT.md");
    expect(companies).toContain("**Every company, every run.**");
    expect(companies).toContain("**Each company's emails go out as the company.**");
    expect(companies).not.toContain("<!-- adminigloo:company");
    const single = file(await plan(SINGLE_FULL), "DEPLOYMENT.md");
    expect(single).not.toContain("Every company, every run");
    expect(single).not.toContain("<!-- adminigloo:company");
    expect(file(await plan(COMPANY_FULL), "src", "env.ts")).toContain("nothing drains the queue automatically for every company.");
  });
});

/**
 * The Tenancy 2a review's findings, each a check on what the generator now
 * writes (the packages' own tests and the emitted proofs hold the behaviour).
 */
describe("Tenancy 2a review: what the generated project does now", () => {
  it("T2A-BO-01: a company's public pages are outside the site's chrome, titled and previewed as the company", async () => {
    for (const overrides of [COMPANY_FULL, ...COMPANY_EACH_ALONE.map(([, o]) => o)]) {
      const p = await plan(overrides);
      const publicPages = pathsOf(p).filter((path) => path.includes("/t/[slug]") && path.endsWith("page.tsx"));
      expect(publicPages.length).toBeGreaterThan(0);
      for (const path of publicPages) {
        expect(path.startsWith("app/(company)/t/[slug]"), path).toBe(true);
        expect(code(contentsAt(p, path)), path).toContain("generateMetadata(");
        expect(code(contentsAt(p, path)), path).toContain("publicCompanyMetadata(slug,");
      }
      expect(pathsOf(p).some((path) => path.startsWith("app/(site)/t/")), "a /t page under the site's chrome").toBe(false);
    }
    const p = await plan(COMPANY_FULL);
    const layout = code(file(p, "app", "(company)", "layout.tsx"));
    for (const chrome of ["AuthHeader", "SiteFooter", 'href="/"', "SITE_NAME"]) expect(layout, chrome).not.toContain(chrome);
    const gate = code(file(p, "src", "components", "PublicCompanyGate.tsx"));
    expect(gate).toContain("title: { absolute: title }");
    expect(gate).toContain("siteName: name");
    // X/Twitter has its own block; without it the site-wide one (this site's
    // name and description) is what a shared company link shows there.
    expect(gate).toContain('twitter: {\n      card: "summary",\n      title,');
    expect(gate).toContain("images: [found.company.logoUrl]");
    expect(gate).toContain("robots: { index: false, follow: false }");
    expect(gate).toContain('referrer: "no-referrer" as const');
  });

  it("SEC-2A-01 / TB-5: the comms drain lets companies take turns, has room, and says when it stops early", async () => {
    const comms = code(file(await plan(COMPANY_FULL), "app", "api", "cron", "comms", "route.ts"));
    expect(comms).toContain("tenantIds: await tenancy.activeCompanyIds(),");
    expect(comms).toContain("limit: 1000,");
    expect(comms).toContain("if (result.stoppedEarly) {");
    expect(comms).toContain("void reportError({");
    const single = code(file(await plan(SINGLE_FULL), "app", "api", "cron", "comms", "route.ts"));
    expect(single).not.toContain("tenantIds");
    const deployment = file(await plan(COMPANY_FULL), "DEPLOYMENT.md");
    expect(deployment).toContain("**Once a day is not enough for many companies.**");
    expect(deployment).toContain("x-cron-secret");
  });

  it("SEC-2A-03: each company's email is held to a sending allowance, and only in a companies project", async () => {
    const senders = code(file(await plan(COMPANY_FULL), "src", "server", "comms-senders.ts"));
    expect(senders).toContain("allowance: companySendAllowance,");
    expect(senders).toContain("established: { hour: 100, day: 500 },");
    expect(senders).toContain("newCompany: { hour: 20, day: 100 },");
    // Tenancy 2b-1 (review BO-10): the team's own emails count in their own bucket.
    expect(senders).toContain("const key = team ? `comms-out-team:${bucket}:${tenantId}` : `comms-out:${bucket}:${tenantId}`;");
    expect(senders).toContain("limiter.limit({ key, policy: { limit, windowMs } })");
    expect(senders).toContain("team: { hour: 60, day: 300 },");
    expect(code(file(await plan(SINGLE_FULL), "src", "server", "comms-senders.ts"))).not.toContain("allowance");
  });

  it("SEC-2A-02: turning a quote into an invoice asks the invoice permission, in both modes", async () => {
    const companies = await plan(COMPANY_FULL);
    expect(code(file(companies, "src", "server", "estimator-services.ts"))).toContain(
      'authorize(req, need === "manage" ? "invoices.manage" : "invoices.view", tenantId)',
    );
    expect(code(file(companies, "src", "server", "estimator.ts"))).toContain("invoiceAccess: estimatorInvoiceAccess(overrides),");
    const single = await plan(SINGLE_FULL);
    expect(code(file(single, "src", "server", "estimator-services.ts"))).toContain(
      'authorizeStaffFor(INVOICING_STAFF_KEYS, "Sign in to see invoices.")',
    );
    expect(code(file(single, "app", "api", "admin", "estimator", "[...path]", "route.ts"))).toContain("invoiceAccess: estimatorInvoiceAccess(),");
    const withoutInvoicing = await plan(COMPANY_EACH_ALONE[1]![1]);
    expect(code(file(withoutInvoicing, "src", "server", "estimator-services.ts"))).toContain("return undefined;");
  });

  it("SEC-2A-07 / TB-8: photo reading has a site-wide ceiling, and the README says where both ceilings are set", async () => {
    const p = await plan(COMPANY_FULL);
    expect(code(file(p, "src", "server", "estimator-config.ts"))).toContain("export const ESTIMATOR_AI_SITE_CEILING_CENTS = 500;");
    expect(code(file(p, "src", "server", "estimator.ts")).split("aiSiteBudgetCents: ESTIMATOR_AI_SITE_CEILING_CENTS,").length - 1).toBe(2);
    const readme = file(p, "README.md");
    expect(readme).toContain("ESTIMATOR_AI_SITE_CEILING_CENTS in src/server/estimator-config.ts (code, not environment variables)");
    expect(file(p, ".env.example")).not.toContain("ESTIMATOR_AI_CEILING_CENTS");
  });

  it("T2A-BO-02 / T2A-BO-06: Estimate settings offers the company's own page as a button, and shows the notices once", async () => {
    const page = code(file(await plan(COMPANY_FULL), "app", "(site)", "app", "estimates", "settings", "page.tsx"));
    expect(page).toContain("publicPageUrl={companyLinksFor(company.slug).estimate}");
    expect(page).toContain("buttonColor={company.brandColor}");
    expect(page).toContain("notices={false}");
  });

  it("T2A-BO-04: a crew member joining is put on the only free crew, and the schedule names one who isn't on a crew", async () => {
    const p = await plan(COMPANY_FULL);
    const setup = code(file(p, "src", "server", "company-setup.ts"));
    expect(setup).toContain('if (event.type === "member.joined" || event.type === "member.role.changed") {');
    expect(setup).toContain("await linkNewCrewMember(event.tenantId, event.userId);");
    const glue = code(file(p, "src", "server", "scheduling.ts"));
    expect(glue).toContain("roleKey: person.roleKey,");
    expect(glue).toContain('settingsHref: "/app/schedule/settings",');
    expect(glue).toContain("if (crews.length !== 1 || crews[0]!.userId !== null) return;");
    expect(code(file(await plan(COMPANY_EACH_ALONE[1]![1]), "src", "server", "company-setup.ts"))).not.toContain("linkNewCrewMember");
  });

  it("T2A-BO-05: a company never reads this site's environment variables in its notices", async () => {
    const p = await plan(COMPANY_FULL);
    expect(code(file(p, "src", "server", "estimator.ts"))).toContain('siteNotices: "company",');
    for (const module of ["scheduling-notify.ts", "estimator-notify.ts"]) {
      expect(code(file(p, "src", "server", module)), module).toContain('audience: "company",');
    }
    for (const module of ["invoicing.ts", "comms.ts"]) {
      const source = code(file(p, "src", "server", module));
      const reasons = source.match(/emailsOffReason[^;]*;/g)?.join("") ?? "";
      for (const key of ["RESEND_API_KEY", "CRON_SECRET", "ANTHROPIC_API_KEY"]) expect(reasons, `${module} ${key}`).not.toContain(key);
    }
    // A single business owns its deployment: its notices still name the fix.
    expect(code(file(await plan(SINGLE_FULL), "src", "server", "comms.ts"))).toContain("RESEND_API_KEY");
  });

  it("T2A-BO-07 / T2A-BO-11: invoices fall back to the starting zone, and a single business's invoices read its own saved details", async () => {
    const invoicing = code(file(await plan(COMPANY_FULL), "src", "server", "invoicing.ts"));
    expect(invoicing).toContain("timeZone: profile.timeZone ?? STARTING_TIME_ZONE,");
    expect(invoicing).toContain('const STARTING_TIME_ZONE: string = env.SCHEDULING_TIME_ZONE ?? env.ESTIMATOR_TIME_ZONE ?? "America/Denver";');
    const single = code(file(await plan(SINGLE_FULL), "src", "server", "invoicing.ts"));
    expect(single).toContain("const settings = await getSchedulingSettings(db, SCHEDULING_TENANT);");
    expect(single).toContain("business: () => invoicingBusiness(),");
    expect(single).not.toContain("business: () => INVOICING_BUSINESS");
  });

  it("T2A-BO-12 / T2A-BO-14: the invitation names the site, and Estimates links to Estimate settings", async () => {
    const p = await plan(COMPANY_FULL);
    expect(code(file(p, "src", "server", "invitation-mail.ts"))).toContain("productName: SITE_NAME,");
    const estimates = file(p, "app", "(site)", "app", "estimates", "page.tsx");
    expect(estimates).toContain("Estimate settings");
    expect(estimates).not.toMatch(/>\s*Settings\s*</);
  });

  it("TB-6: a companies project's DEPLOYMENT.md speaks of its own pages and roles; a single business's keeps its own", async () => {
    const companies = file(await plan(COMPANY_FULL), "DEPLOYMENT.md");
    for (const stale of ["/admin/schedule", "/admin/estimator", "staff.schedule.route", "<!-- adminigloo:"]) {
      expect(companies, stale).not.toContain(stale);
    }
    for (const fresh of ["/app/schedule/today", "/app/estimates/settings", "/settings/team", '"/api/cron/estimator"']) {
      expect(companies, fresh).toContain(fresh);
    }
    const single = file(await plan(SINGLE_FULL), "DEPLOYMENT.md");
    expect(single).toContain("/admin/schedule/settings");
    expect(single).toContain("staff.schedule.route");
    expect(single).not.toContain("<!-- adminigloo:");
  });

  it("TB-1 / TB-4: the isolation proof plants rows every list route can leak, mixes owners, and checks each role", async () => {
    const p = await plan(COMPANY_FULL);
    const rows = code(file(p, "src", "test", "company-rows.ts"));
    expect(rows).toContain('status: "pending",');
    expect(rows).toContain("await database.insert(estimatorTakeoffs).values({");
    expect(rows).toContain("await sendNow(database,");
    expect(rows).toContain("await enqueueMessage(database,");
    const proof = code(file(p, "src", "server", "__tests__", "feature-isolation.test.ts"));
    expect(proof).toContain("function mixesOf(route: FeatureRoute)");
    expect(proof).toContain('"refused"');
    expect(proof).toContain('{ role: "crew", person: fx.A4 },');
    expect(proof).toContain("an empty table proves nothing");
    expect(proof).toContain("with A's website key under B's web address");
    const crons = code(file(p, "src", "server", "__tests__", "company-crons.test.ts"));
    expect(crons).toContain("they take turns (review SEC-2A-01)");
  });
});
